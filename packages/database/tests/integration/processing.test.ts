import { randomUUID } from 'node:crypto';
import { EvidenceBatchSchema } from '@blackbox/contracts';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDatabaseClient,
  claimProcessingIntents,
  completeIntentDelivery,
  getCoreRunDetail,
  ingestEvidenceBatch,
  listCoreRuns,
  listFindings,
  listSummaryClaims,
  listSummarySupports,
  processCoreIntent,
  processFindingsIntent,
  processSummaryIntent,
  relayProcessingCycle,
  replayCoreIntent,
  replayFindingsIntent,
  replaySummaryIntent,
  type ProcessingQueue,
} from '../../src/index.js';

const connectionString = process.env.TEST_DATABASE_URL!;
let pool: Pool;
beforeAll(() => {
  pool = new Pool({ connectionString, max: 4 });
});
afterAll(() => pool.end());

async function seed() {
  const organizationId = (
    await pool.query<{ id: string }>(
      'INSERT INTO organizations DEFAULT VALUES RETURNING id',
    )
  ).rows[0]!.id;
  const repositoryId = (
    await pool.query<{ id: string }>(
      'INSERT INTO repositories (organization_id) VALUES ($1) RETURNING id',
      [organizationId],
    )
  ).rows[0]!.id;
  return { organizationId, repositoryId };
}

function batch(runId = randomUUID()) {
  return EvidenceBatchSchema.parse({
    schemaVersion: 1,
    batchId: randomUUID(),
    runId,
    sentAt: '2026-10-01T00:00:00.000Z',
    events: [
      {
        schemaVersion: 1,
        eventId: randomUUID(),
        runId,
        sequence: 0,
        kind: 'run.started',
        observedAt: '2026-10-01T00:00:00.000Z',
        source: { component: 'collector' },
        payload: { adapter: 'codex-jsonl', provider: 'codex' },
      },
      {
        schemaVersion: 1,
        eventId: randomUUID(),
        runId,
        sequence: 1,
        kind: 'run.finished',
        observedAt: '2026-10-01T00:00:01.000Z',
        source: { component: 'collector' },
        payload: { outcome: 'succeeded', durationMs: 1 },
      },
    ],
  });
}

function incrementalBatch(
  runId: string,
  events: Array<ReturnType<typeof batch>['events'][number]>,
) {
  return EvidenceBatchSchema.parse({
    schemaVersion: 1,
    batchId: randomUUID(),
    runId,
    sentAt: '2026-10-01T00:00:02.000Z',
    events,
  });
}

function errorEvent(runId: string, sequence: number, code: string) {
  return {
    schemaVersion: 1 as const,
    eventId: randomUUID(),
    runId,
    sequence,
    kind: 'error.observed' as const,
    observedAt: '2026-10-01T00:00:02.000Z',
    source: { component: 'collector' as const },
    payload: {
      errorId: randomUUID(),
      category: 'agent',
      code,
      message: { state: 'omitted' as const },
    },
  };
}

const options = {
  eventPageSize: 1,
  maxEvents: 100,
  maxProjectedChildren: 100,
  leaseSeconds: 30,
  attemptTimeoutMs: 20_000,
  transitionMarginMs: 1_000,
  maxAttempts: 3,
  retryBaseSeconds: 1,
  retryMaxSeconds: 5,
};
const relayOptions = {
  batchSize: 10,
  leaseSeconds: 30,
  maxAttempts: 5,
  retryBaseSeconds: 1,
  retryMaxSeconds: 2,
};
const findingsOptions = {
  leaseSeconds: 10,
  attemptTimeoutMs: 2_000,
  transitionMarginMs: 100,
  maxAttempts: 2,
  retryBaseSeconds: 1,
  retryMaxSeconds: 1,
};
const summaryOptions = {
  leaseSeconds: 10,
  attemptTimeoutMs: 2_000,
  transitionMarginMs: 100,
  maxAttempts: 2,
  retryBaseSeconds: 1,
  retryMaxSeconds: 1,
};

async function readySummaryFixture(
  requestedScope?: Awaited<ReturnType<typeof seed>>,
) {
  const scope = requestedScope ?? (await seed());
  const handle = createDatabaseClient({ connectionString });
  const accepted = batch();
  await ingestEvidenceBatch(handle.client, { ...scope, batch: accepted });
  const run = await handle.client.run.findUniqueOrThrow({
    where: {
      organizationId_canonicalRunId: {
        organizationId: scope.organizationId,
        canonicalRunId: accepted.runId,
      },
    },
    select: { id: true },
  });
  const intent = await handle.client.processingIntent.findFirstOrThrow({
    where: { organizationId: scope.organizationId, runId: run.id },
    select: { id: true },
  });
  await processCoreIntent(handle.client, intent.id, options);
  await processFindingsIntent(handle.client, intent.id, findingsOptions);
  await processSummaryIntent(handle.client, intent.id, summaryOptions);
  return { scope, handle, accepted, runId: run.id, intentId: intent.id };
}

async function failedFindingsFixture() {
  const scope = await seed();
  const handle = createDatabaseClient({ connectionString });
  const accepted = batch();
  await ingestEvidenceBatch(handle.client, { ...scope, batch: accepted });
  const run = await handle.client.run.findUniqueOrThrow({
    where: {
      organizationId_canonicalRunId: {
        organizationId: scope.organizationId,
        canonicalRunId: accepted.runId,
      },
    },
    select: { id: true },
  });
  const first = await handle.client.processingIntent.findFirstOrThrow({
    where: {
      organizationId: scope.organizationId,
      runId: run.id,
      batch: { canonicalBatchId: accepted.batchId },
    },
    select: { id: true },
  });
  await processCoreIntent(handle.client, first.id, options);
  const singleAttempt = { ...findingsOptions, maxAttempts: 1 };
  const result = await processFindingsIntent(
    handle.client,
    first.id,
    singleAttempt,
    {
      hooks: {
        afterDependenciesRead: () => {
          throw new Error('forced findings failure');
        },
      },
    },
  );
  if (result !== 'failed')
    throw new Error('Expected exhausted findings state.');
  const failedState = await handle.client.runProcessingState.findUniqueOrThrow({
    where: {
      organizationId_runId_projectorName: {
        organizationId: scope.organizationId,
        runId: run.id,
        projectorName: 'findings',
      },
    },
    select: { attemptFingerprint: true },
  });
  if (!failedState.attemptFingerprint)
    throw new Error('Expected failed findings fingerprint.');
  return {
    scope,
    handle,
    accepted,
    runId: run.id,
    firstIntentId: first.id,
    singleAttempt,
    failedFingerprint: failedState.attemptFingerprint,
  };
}

async function createSameSourceIntent(
  fixture: Awaited<ReturnType<typeof failedFindingsFixture>>,
) {
  const duplicate = EvidenceBatchSchema.parse({
    ...fixture.accepted,
    batchId: randomUUID(),
    sentAt: '2026-10-01T00:00:03.000Z',
  });
  await ingestEvidenceBatch(fixture.handle.client, {
    ...fixture.scope,
    batch: duplicate,
  });
  return fixture.handle.client.processingIntent.findFirstOrThrow({
    where: {
      organizationId: fixture.scope.organizationId,
      runId: fixture.runId,
      batch: { canonicalBatchId: duplicate.batchId },
    },
    select: { id: true },
  });
}

describe('processing migration and core persistence', () => {
  it('publishes and exactly replays a complete conservative findings catalog without mutating evidence', async () => {
    const migration = await pool.query(
      `SELECT 1 FROM _prisma_migrations WHERE migration_name = '20261006120000_deterministic_findings' AND finished_at IS NOT NULL`,
    );
    expect(migration.rows).toHaveLength(1);
    const scope = await seed();
    const handle = createDatabaseClient({ connectionString });
    const accepted = batch();
    await ingestEvidenceBatch(handle.client, {
      ...scope,
      batch: accepted,
    });
    const run = await handle.client.run.findUniqueOrThrow({
      where: {
        organizationId_canonicalRunId: {
          organizationId: scope.organizationId,
          canonicalRunId: accepted.runId,
        },
      },
      select: { id: true },
    });
    const intent = await handle.client.processingIntent.findFirstOrThrow({
      where: {
        organizationId: scope.organizationId,
        runId: run.id,
        batch: { canonicalBatchId: accepted.batchId },
      },
    });
    expect(await processCoreIntent(handle.client, intent.id, options)).toBe(
      'applied',
    );
    const before = await handle.client.evidenceEvent.count({
      where: { runId: run.id },
    });
    expect(
      await processFindingsIntent(handle.client, intent.id, findingsOptions),
    ).toBe('applied');
    expect(
      await processFindingsIntent(handle.client, intent.id, findingsOptions),
    ).toBe('already_applied');
    expect(
      await handle.client.evidenceEvent.count({
        where: { runId: run.id },
      }),
    ).toBe(before);
    const page = await listFindings(handle.client, {
      ...scope,
      canonicalRunId: accepted.runId,
      limit: 5,
    });
    expect(page).toMatchObject({
      processingState: 'ready',
      deterministicOutcome: 'unknown',
      coverage: 'partial',
    });
    expect(page?.items).toHaveLength(5);
    expect(page?.nextCursor).not.toBeNull();
    const second = await listFindings(handle.client, {
      ...scope,
      canonicalRunId: accepted.runId,
      limit: 5,
      cursor: page!.nextCursor!,
    });
    expect(second?.items).toHaveLength(4);
    expect(
      await listFindings(handle.client, {
        organizationId: randomUUID(),
        repositoryId: scope.repositoryId,
        canonicalRunId: accepted.runId,
        limit: 9,
      }),
    ).toBeNull();
    await handle.dispose();
  });

  it('rebuilds findings after persisted analyzer identity or dependency fingerprint changes', async () => {
    const scope = await seed();
    const handle = createDatabaseClient({ connectionString });
    const initialBatch = batch();
    const accepted = EvidenceBatchSchema.parse({
      ...initialBatch,
      events: [
        ...initialBatch.events,
        errorEvent(initialBatch.runId, 10, 'initial-high-sequence'),
      ],
    });
    await ingestEvidenceBatch(handle.client, { ...scope, batch: accepted });
    const run = await handle.client.run.findUniqueOrThrow({
      where: {
        organizationId_canonicalRunId: {
          organizationId: scope.organizationId,
          canonicalRunId: accepted.runId,
        },
      },
      select: { id: true },
    });
    const first = await handle.client.processingIntent.findFirstOrThrow({
      where: { organizationId: scope.organizationId, runId: run.id },
      select: { id: true },
    });
    await processCoreIntent(handle.client, first.id, options);
    await processFindingsIntent(handle.client, first.id, findingsOptions);
    const initial = await handle.client.findingsRunProjection.findUniqueOrThrow(
      {
        where: { runId: run.id },
        select: { sourceFingerprint: true },
      },
    );

    await pool.query(
      'UPDATE findings_run_projections SET analyzer_version = 999 WHERE run_id = $1',
      [run.id],
    );
    await expect(
      replayFindingsIntent(handle.client, first.id, findingsOptions),
    ).resolves.toBe('applied');
    expect(
      await handle.client.findingsRunProjection.findUniqueOrThrow({
        where: { runId: run.id },
        select: { analyzerVersion: true },
      }),
    ).toEqual({ analyzerVersion: 1 });
    await expect(
      processSummaryIntent(handle.client, first.id, summaryOptions),
    ).resolves.toBe('applied');
    const initialSummary =
      await handle.client.summaryRunProjection.findUniqueOrThrow({
        where: { runId: run.id },
        select: { summaryKey: true },
      });

    await ingestEvidenceBatch(handle.client, {
      ...scope,
      batch: incrementalBatch(accepted.runId, [
        errorEvent(accepted.runId, 5, 'late-lower-findings-source'),
      ]),
    });
    const second = await handle.client.processingIntent.findFirstOrThrow({
      where: {
        organizationId: scope.organizationId,
        runId: run.id,
        id: { not: first.id },
      },
      select: { id: true },
    });
    await processCoreIntent(handle.client, second.id, options);
    await expect(
      replayFindingsIntent(handle.client, first.id, findingsOptions),
    ).resolves.toBe('applied');
    const rebuilt = await handle.client.findingsRunProjection.findUniqueOrThrow(
      {
        where: { runId: run.id },
        select: { sourceFingerprint: true },
      },
    );
    expect(rebuilt.sourceFingerprint).not.toBe(initial.sourceFingerprint);
    expect(
      await handle.client.summaryRunProjection.count({
        where: { runId: run.id },
      }),
    ).toBe(0);
    await expect(
      processSummaryIntent(handle.client, first.id, summaryOptions),
    ).resolves.toBe('applied');
    const rebuiltSummary =
      await handle.client.summaryRunProjection.findUniqueOrThrow({
        where: { runId: run.id },
        select: { summaryKey: true },
      });
    expect(rebuiltSummary.summaryKey).not.toBe(initialSummary.summaryKey);
    await expect(
      replayFindingsIntent(handle.client, first.id, findingsOptions),
    ).resolves.toBe('already_applied');
    await handle.dispose();
  });

  it('lets a later non-exhausted intent recover failed findings on the same fingerprint', async () => {
    const fixture = await failedFindingsFixture();
    const evidenceCount = await fixture.handle.client.evidenceEvent.count({
      where: { runId: fixture.runId },
    });

    await expect(
      processFindingsIntent(
        fixture.handle.client,
        fixture.firstIntentId,
        fixture.singleAttempt,
      ),
    ).resolves.toBe('failed');

    const later = await createSameSourceIntent(fixture);
    await expect(
      processCoreIntent(fixture.handle.client, later.id, options),
    ).resolves.toBe('already_applied');
    await expect(
      processFindingsIntent(
        fixture.handle.client,
        later.id,
        fixture.singleAttempt,
      ),
    ).resolves.toBe('applied');

    expect(
      await fixture.handle.client.findingsRunProjection.findUniqueOrThrow({
        where: { runId: fixture.runId },
        select: { sourceFingerprint: true },
      }),
    ).toEqual({ sourceFingerprint: fixture.failedFingerprint });
    expect(
      await fixture.handle.client.evidenceEvent.count({
        where: { runId: fixture.runId },
      }),
    ).toBe(evidenceCount);
    expect(
      await fixture.handle.client.runProcessingState.findUniqueOrThrow({
        where: {
          organizationId_runId_projectorName: {
            organizationId: fixture.scope.organizationId,
            runId: fixture.runId,
            projectorName: 'findings',
          },
        },
        select: { state: true, activeIntentId: true, attemptCount: true },
      }),
    ).toEqual({ state: 'READY', activeIntentId: null, attemptCount: 0 });
    await expect(
      processFindingsIntent(
        fixture.handle.client,
        fixture.firstIntentId,
        fixture.singleAttempt,
      ),
    ).resolves.toBe('failed');
    expect(
      await fixture.handle.client.processingAttemptFailure.count({
        where: { intentId: fixture.firstIntentId, projectorName: 'findings' },
      }),
    ).toBe(1);
    await fixture.handle.dispose();
  });

  it('allows explicit replay of an exhausted intent on the same fingerprint', async () => {
    const fixture = await failedFindingsFixture();

    await expect(
      processFindingsIntent(
        fixture.handle.client,
        fixture.firstIntentId,
        fixture.singleAttempt,
      ),
    ).resolves.toBe('failed');
    await expect(
      replayFindingsIntent(
        fixture.handle.client,
        fixture.firstIntentId,
        fixture.singleAttempt,
      ),
    ).resolves.toBe('applied');
    expect(
      await fixture.handle.client.processingAttemptFailure.count({
        where: { intentId: fixture.firstIntentId, projectorName: 'findings' },
      }),
    ).toBe(0);
    expect(
      await fixture.handle.client.processingApplicationReceipt.count({
        where: { intentId: fixture.firstIntentId, projectorName: 'findings' },
      }),
    ).toBe(1);
    expect(
      await fixture.handle.client.runProcessingState.findUniqueOrThrow({
        where: {
          organizationId_runId_projectorName: {
            organizationId: fixture.scope.organizationId,
            runId: fixture.runId,
            projectorName: 'findings',
          },
        },
        select: { state: true, activeIntentId: true, attemptCount: true },
      }),
    ).toEqual({ state: 'READY', activeIntentId: null, attemptCount: 0 });
    await fixture.handle.dispose();
  });

  it('allows only one live owner during concurrent same-fingerprint recovery', async () => {
    const fixture = await failedFindingsFixture();
    const firstLater = await createSameSourceIntent(fixture);
    const secondLater = await createSameSourceIntent(fixture);
    await processCoreIntent(fixture.handle.client, firstLater.id, options);
    await processCoreIntent(fixture.handle.client, secondLater.id, options);

    let enterOwner!: () => void;
    const ownerEntered = new Promise<void>((resolve) => {
      enterOwner = resolve;
    });
    let releaseOwner!: () => void;
    const ownerRelease = new Promise<void>((resolve) => {
      releaseOwner = resolve;
    });
    const owner = processFindingsIntent(
      fixture.handle.client,
      firstLater.id,
      fixture.singleAttempt,
      {
        hooks: {
          afterDependenciesRead: async () => {
            enterOwner();
            await ownerRelease;
          },
        },
      },
    );
    await ownerEntered;
    try {
      await expect(
        processFindingsIntent(
          fixture.handle.client,
          secondLater.id,
          fixture.singleAttempt,
        ),
      ).resolves.toBe('busy');
      expect(
        await fixture.handle.client.runProcessingState.findUniqueOrThrow({
          where: {
            organizationId_runId_projectorName: {
              organizationId: fixture.scope.organizationId,
              runId: fixture.runId,
              projectorName: 'findings',
            },
          },
          select: { state: true, activeIntentId: true },
        }),
      ).toEqual({ state: 'PROCESSING', activeIntentId: firstLater.id });
    } finally {
      releaseOwner();
    }
    await expect(owner).resolves.toBe('applied');
    expect(
      await fixture.handle.client.findingRuleResult.count({
        where: { runId: fixture.runId },
      }),
    ).toBe(9);
    await fixture.handle.dispose();
  });

  it('keeps result identity tenant-scoped for identical canonical run IDs', async () => {
    const firstScope = await seed();
    const secondScope = await seed();
    const canonicalRunId = randomUUID();
    const handle = createDatabaseClient({ connectionString });
    for (const scope of [firstScope, secondScope]) {
      await ingestEvidenceBatch(handle.client, {
        ...scope,
        batch: batch(canonicalRunId),
      });
      const intent = await handle.client.processingIntent.findFirstOrThrow({
        where: { organizationId: scope.organizationId },
        select: { id: true },
      });
      await processCoreIntent(handle.client, intent.id, options);
      await processFindingsIntent(handle.client, intent.id, findingsOptions);
    }
    const firstKeys = await handle.client.findingRuleResult.findMany({
      where: { organizationId: firstScope.organizationId },
      orderBy: { catalogOrder: 'asc' },
      select: { resultKey: true },
    });
    const secondKeys = await handle.client.findingRuleResult.findMany({
      where: { organizationId: secondScope.organizationId },
      orderBy: { catalogOrder: 'asc' },
      select: { resultKey: true },
    });
    expect(firstKeys).toHaveLength(9);
    expect(secondKeys).toHaveLength(9);
    expect(firstKeys).not.toEqual(secondKeys);
    await handle.dispose();
  });

  it('rejects stale findings ownership before publication', async () => {
    const scope = await seed();
    const handle = createDatabaseClient({ connectionString });
    const accepted = batch();
    await ingestEvidenceBatch(handle.client, { ...scope, batch: accepted });
    const run = await handle.client.run.findUniqueOrThrow({
      where: {
        organizationId_canonicalRunId: {
          organizationId: scope.organizationId,
          canonicalRunId: accepted.runId,
        },
      },
      select: { id: true },
    });
    const intent = await handle.client.processingIntent.findFirstOrThrow({
      where: { runId: run.id },
      select: { id: true },
    });
    await processCoreIntent(handle.client, intent.id, options);
    await expect(
      processFindingsIntent(handle.client, intent.id, findingsOptions, {
        hooks: {
          afterDependenciesRead: async () => {
            await pool.query(
              `UPDATE run_processing_states SET lease_id = $1
               WHERE organization_id = $2 AND run_id = $3 AND projector_name = 'findings'`,
              [randomUUID(), scope.organizationId, run.id],
            );
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'processing_lease_lost' });
    expect(
      await handle.client.findingsRunProjection.count({
        where: { runId: run.id },
      }),
    ).toBe(0);
    await handle.dispose();
  });

  it('deploys without pgmq and enforces intent lease/state coherence', async () => {
    const migration = await pool.query(
      `SELECT 1 FROM _prisma_migrations WHERE migration_name = '20261001120000_processing_relay_core_projections' AND finished_at IS NOT NULL`,
    );
    expect(migration.rows).toHaveLength(1);
    const seedData = await seed();
    const handle = createDatabaseClient({ connectionString });
    const accepted = batch();
    await ingestEvidenceBatch(handle.client, { ...seedData, batch: accepted });
    await expect(
      pool.query(
        `UPDATE processing_intents SET state = 'leased', lease_expires_at = clock_timestamp() + interval '1 minute' WHERE organization_id = $1`,
        [seedData.organizationId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await handle.dispose();
  });

  it('atomically projects, deduplicates receipts, and exposes tenant-safe fresh queries', async () => {
    const own = await seed();
    const foreign = await seed();
    const accepted = batch();
    const handle = createDatabaseClient({ connectionString });
    await ingestEvidenceBatch(handle.client, { ...own, batch: accepted });
    const intent = await handle.client.processingIntent.findFirstOrThrow({
      where: { organizationId: own.organizationId },
      select: { id: true },
    });
    expect(await processCoreIntent(handle.client, intent.id, options)).toBe(
      'applied',
    );
    expect(await processCoreIntent(handle.client, intent.id, options)).toBe(
      'already_applied',
    );
    expect(
      await handle.client.processingApplicationReceipt.count({
        where: { intentId: intent.id },
      }),
    ).toBe(1);
    const list = await listCoreRuns(handle.client, { ...own, limit: 10 });
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({
      runId: accepted.runId,
      processingState: 'incomplete',
      observedOutcome: 'succeeded',
    });
    const detail = await getCoreRunDetail(handle.client, {
      ...own,
      canonicalRunId: accepted.runId,
      childLimit: 10,
    });
    expect(detail).toMatchObject({
      runId: accepted.runId,
      processingState: 'incomplete',
      projection: { evidenceCompleteness: 'incomplete' },
    });
    await expect(
      getCoreRunDetail(handle.client, {
        organizationId: foreign.organizationId,
        repositoryId: foreign.repositoryId,
        canonicalRunId: accepted.runId,
        childLimit: 10,
      }),
    ).resolves.toBeNull();
    await handle.dispose();
  });

  it('serializes concurrent consumers for the same run', async () => {
    const own = await seed();
    const runId = randomUUID();
    const handle = createDatabaseClient({ connectionString });
    await ingestEvidenceBatch(handle.client, { ...own, batch: batch(runId) });
    await ingestEvidenceBatch(handle.client, {
      ...own,
      batch: EvidenceBatchSchema.parse({
        ...batch(runId),
        events: [
          {
            schemaVersion: 1,
            eventId: randomUUID(),
            runId,
            sequence: 2,
            kind: 'usage.observed',
            observedAt: '2026-10-01T00:00:02.000Z',
            source: { component: 'collector' },
            payload: {
              inputTokens: { state: 'reported', value: 1 },
              outputTokens: { state: 'unavailable', reason: 'not-reported' },
              cachedInputTokens: {
                state: 'unavailable',
                reason: 'not-reported',
              },
              reasoningTokens: { state: 'unavailable', reason: 'not-reported' },
              totalTokens: { state: 'unavailable', reason: 'not-reported' },
            },
          },
        ],
      }),
    });
    const intents = await handle.client.processingIntent.findMany({
      where: { organizationId: own.organizationId },
      select: { id: true },
    });
    const results = await Promise.all(
      intents.map((intent) =>
        processCoreIntent(handle.client, intent.id, options),
      ),
    );
    expect(
      results.filter((value) => value === 'busy').length,
    ).toBeLessThanOrEqual(1);
    expect(
      await handle.client.coreRunProjection.count({
        where: { organizationId: own.organizationId },
      }),
    ).toBe(1);
    await handle.dispose();
  });

  it('recovers every relay crash window and exposes only the allowed duplicate send', async () => {
    const own = await seed();
    const handle = createDatabaseClient({ connectionString });
    await ingestEvidenceBatch(handle.client, { ...own, batch: batch() });
    const target = await handle.client.processingIntent.findFirstOrThrow({
      where: { organizationId: own.organizationId },
      select: { id: true },
    });
    const targetRelayOptions = { ...relayOptions, batchSize: 1 };
    const makeTargetAvailable = () =>
      pool.query(
        `UPDATE processing_intents SET available_at = to_timestamp(0) WHERE id = $1`,
        [target.id],
      );
    const sent: Array<{ schemaVersion: 1; intentId: string }> = [];
    let failSend = false;
    const queue: ProcessingQueue = {
      verify: async () => undefined,
      send: async (payload) => {
        if (failSend) throw new Error('queue outage');
        sent.push(payload);
        return sent.length;
      },
      read: async () => [],
      archive: async () => true,
    };

    await makeTargetAvailable();
    await relayProcessingCycle(handle.client, queue, targetRelayOptions, {
      beforeSend: (claim) => {
        if (claim.intentId === target.id) throw new Error('before send');
      },
    });
    expect(sent.filter(({ intentId }) => intentId === target.id)).toHaveLength(
      0,
    );
    await makeTargetAvailable();
    failSend = true;
    await relayProcessingCycle(handle.client, queue, targetRelayOptions);
    expect(sent.filter(({ intentId }) => intentId === target.id)).toHaveLength(
      0,
    );
    failSend = false;
    await makeTargetAvailable();
    await relayProcessingCycle(handle.client, queue, targetRelayOptions, {
      afterSend: (claim) => {
        if (claim.intentId === target.id) throw new Error('after send');
      },
    });
    expect(sent.filter(({ intentId }) => intentId === target.id)).toHaveLength(
      1,
    );
    await makeTargetAvailable();
    await relayProcessingCycle(handle.client, queue, targetRelayOptions);
    const targetSends = sent.filter(({ intentId }) => intentId === target.id);
    expect(targetSends).toHaveLength(2);
    const state = await handle.client.processingIntent.findUniqueOrThrow({
      where: { id: target.id },
      select: { state: true, queueMessageId: true },
    });
    expect(state).toMatchObject({ state: 'DELIVERED', queueMessageId: 2n });
    expect(targetSends[0]).toEqual(targetSends[1]);
    await handle.dispose();
  });

  it('claims disjoint work concurrently and rejects a stale lease owner', async () => {
    const own = await seed();
    const first = createDatabaseClient({ connectionString });
    const second = createDatabaseClient({ connectionString });
    await ingestEvidenceBatch(first.client, { ...own, batch: batch() });
    await ingestEvidenceBatch(first.client, { ...own, batch: batch() });
    const small = { ...relayOptions, batchSize: 1 };
    const [left, right] = await Promise.all([
      claimProcessingIntents(first.client, small),
      claimProcessingIntents(second.client, small),
    ]);
    expect(left).toHaveLength(1);
    expect(right).toHaveLength(1);
    expect(left[0]!.intentId).not.toBe(right[0]!.intentId);
    await pool.query(
      `UPDATE processing_intents SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1`,
      [left[0]!.intentId],
    );
    const replacement = await claimProcessingIntents(second.client, small);
    expect(replacement[0]?.intentId).toBe(left[0]!.intentId);
    expect(await completeIntentDelivery(first.client, left[0]!, 10)).toBe(
      false,
    );
    expect(
      await completeIntentDelivery(second.client, replacement[0]!, 11),
    ).toBe(true);
    expect(await completeIntentDelivery(first.client, right[0]!, 12)).toBe(
      true,
    );
    await Promise.all([first.dispose(), second.dispose()]);
  });

  it('resets attempt budget for a new intent after successful work', async () => {
    const own = await seed();
    const handle = createDatabaseClient({ connectionString });
    const accepted = batch();
    await ingestEvidenceBatch(handle.client, { ...own, batch: accepted });
    const first = await handle.client.processingIntent.findFirstOrThrow({
      where: { organizationId: own.organizationId },
      select: { id: true },
    });
    const singleAttempt = { ...options, maxAttempts: 1 };
    expect(
      await processCoreIntent(handle.client, first.id, singleAttempt),
    ).toBe('applied');
    await ingestEvidenceBatch(handle.client, {
      ...own,
      batch: incrementalBatch(accepted.runId, [
        errorEvent(accepted.runId, 10, 'new-intent'),
      ]),
    });
    const second = await handle.client.processingIntent.findFirstOrThrow({
      where: { organizationId: own.organizationId, id: { not: first.id } },
      select: { id: true },
    });
    expect(
      await processCoreIntent(handle.client, second.id, singleAttempt),
    ).toBe('applied');
    const state = await handle.client.runProcessingState.findFirstOrThrow({
      where: { organizationId: own.organizationId },
      select: { state: true, attemptCount: true, activeIntentId: true },
    });
    expect(state).toEqual({
      state: 'READY',
      attemptCount: 0,
      activeIntentId: null,
    });
    await handle.dispose();
  });

  it('scopes durable retry exhaustion to the fingerprint actually attempted', async () => {
    const own = await seed();
    const handle = createDatabaseClient({ connectionString });
    const accepted = batch();
    await ingestEvidenceBatch(handle.client, { ...own, batch: accepted });
    const first = await handle.client.processingIntent.findFirstOrThrow({
      where: { organizationId: own.organizationId },
      select: { id: true },
    });
    const failAfterProjection = {
      hooks: {
        afterChildrenReplaced: () => {
          throw new Error('injected projection failure');
        },
      },
    };
    const makeAvailable = () =>
      pool.query(
        `UPDATE run_processing_states SET available_at = clock_timestamp()
          WHERE organization_id = $1 AND run_id = (SELECT id FROM runs WHERE canonical_run_id = $2)`,
        [own.organizationId, accepted.runId],
      );

    await expect(
      processCoreIntent(handle.client, first.id, options, failAfterProjection),
    ).rejects.toThrow('projection_failed');
    const fingerprintA =
      await handle.client.runProcessingState.findFirstOrThrow({
        where: { organizationId: own.organizationId },
        select: { attemptFingerprint: true, attemptCount: true, state: true },
      });
    expect(fingerprintA).toMatchObject({ attemptCount: 1, state: 'RETRYING' });
    expect(fingerprintA.attemptFingerprint).not.toBeNull();

    await makeAvailable();
    await expect(
      processCoreIntent(handle.client, first.id, options, failAfterProjection),
    ).rejects.toThrow('projection_failed');
    await makeAvailable();
    await expect(
      processCoreIntent(handle.client, first.id, options, failAfterProjection),
    ).resolves.toBe('failed');
    expect(
      await handle.client.processingAttemptFailure.findFirstOrThrow({
        where: { intentId: first.id },
        select: { sourceFingerprint: true, attemptCount: true },
      }),
    ).toEqual({
      sourceFingerprint: fingerprintA.attemptFingerprint,
      attemptCount: 3,
    });

    await ingestEvidenceBatch(handle.client, {
      ...own,
      batch: incrementalBatch(accepted.runId, [
        errorEvent(accepted.runId, 5, 'fingerprint-b'),
      ]),
    });
    const second = await handle.client.processingIntent.findFirstOrThrow({
      where: { organizationId: own.organizationId, id: { not: first.id } },
      select: { id: true },
    });
    await expect(
      replayCoreIntent(handle.client, first.id, options, failAfterProjection),
    ).rejects.toThrow('projection_failed');
    const firstFailureB =
      await handle.client.runProcessingState.findFirstOrThrow({
        where: { organizationId: own.organizationId },
        select: { attemptFingerprint: true, attemptCount: true, state: true },
      });
    expect(firstFailureB).toMatchObject({ attemptCount: 1, state: 'RETRYING' });
    expect(firstFailureB.attemptFingerprint).not.toBe(
      fingerprintA.attemptFingerprint,
    );
    expect(
      await handle.client.processingAttemptFailure.count({
        where: { intentId: first.id },
      }),
    ).toBe(0);

    await makeAvailable();
    await expect(
      processCoreIntent(handle.client, first.id, options, failAfterProjection),
    ).rejects.toThrow('projection_failed');
    expect(
      await handle.client.runProcessingState.findFirstOrThrow({
        where: { organizationId: own.organizationId },
        select: { attemptFingerprint: true, attemptCount: true, state: true },
      }),
    ).toEqual({
      attemptFingerprint: firstFailureB.attemptFingerprint,
      attemptCount: 2,
      state: 'RETRYING',
    });

    await makeAvailable();
    const replacementLeaseId = randomUUID();
    await expect(
      processCoreIntent(handle.client, first.id, options, {
        hooks: {
          afterChildrenReplaced: async () => {
            await pool.query(
              `UPDATE run_processing_states
                  SET lease_id = $1, active_intent_id = $2
                WHERE organization_id = $3
                  AND run_id = (SELECT id FROM runs WHERE canonical_run_id = $4)`,
              [
                replacementLeaseId,
                second.id,
                own.organizationId,
                accepted.runId,
              ],
            );
            throw new Error('replaced owner');
          },
        },
      }),
    ).rejects.toThrow('projection_failed');
    expect(
      await handle.client.runProcessingState.findFirstOrThrow({
        where: { organizationId: own.organizationId },
        select: {
          state: true,
          leaseId: true,
          activeIntentId: true,
          attemptFingerprint: true,
          attemptCount: true,
          lastErrorCode: true,
        },
      }),
    ).toEqual({
      state: 'PROCESSING',
      leaseId: replacementLeaseId,
      activeIntentId: second.id,
      attemptFingerprint: firstFailureB.attemptFingerprint,
      attemptCount: 3,
      lastErrorCode: null,
    });
    await handle.dispose();
  });

  it('preserves durable failed state and rolls back an oversized projection', async () => {
    const own = await seed();
    const handle = createDatabaseClient({ connectionString });
    await ingestEvidenceBatch(handle.client, { ...own, batch: batch() });
    const intent = await handle.client.processingIntent.findFirstOrThrow({
      where: { organizationId: own.organizationId },
      select: { id: true },
    });
    const bounded = { ...options, maxEvents: 1 };
    expect(await processCoreIntent(handle.client, intent.id, bounded)).toBe(
      'failed',
    );
    expect(await processCoreIntent(handle.client, intent.id, bounded)).toBe(
      'failed',
    );
    expect(
      await handle.client.processingApplicationReceipt.count({
        where: { intentId: intent.id },
      }),
    ).toBe(0);
    expect(
      await handle.client.coreRunProjection.count({
        where: { organizationId: own.organizationId },
      }),
    ).toBe(0);
    expect(
      await handle.client.runProcessingState.findFirstOrThrow({
        where: { organizationId: own.organizationId },
        select: { state: true, lastErrorCode: true, activeIntentId: true },
      }),
    ).toEqual({
      state: 'FAILED',
      lastErrorCode: 'event_limit_exceeded',
      activeIntentId: intent.id,
    });
    const run = await handle.client.run.findFirstOrThrow({
      where: { organizationId: own.organizationId },
      select: { canonicalRunId: true },
    });
    await ingestEvidenceBatch(handle.client, {
      ...own,
      batch: incrementalBatch(run.canonicalRunId, [
        errorEvent(run.canonicalRunId, 5, 'unrelated-new-work'),
      ]),
    });
    const next = await handle.client.processingIntent.findFirstOrThrow({
      where: { organizationId: own.organizationId, id: { not: intent.id } },
      select: { id: true },
    });
    expect(await processCoreIntent(handle.client, next.id, options)).toBe(
      'applied',
    );
    expect(await processCoreIntent(handle.client, intent.id, bounded)).toBe(
      'failed',
    );
    expect(
      await handle.client.processingAttemptFailure.count({
        where: { intentId: intent.id },
      }),
    ).toBe(1);
    await handle.dispose();
  });

  it('reports late evidence and projector version mismatches as stale', async () => {
    const own = await seed();
    const handle = createDatabaseClient({ connectionString });
    const accepted = batch();
    await ingestEvidenceBatch(handle.client, { ...own, batch: accepted });
    const intent = await handle.client.processingIntent.findFirstOrThrow({
      where: { organizationId: own.organizationId },
      select: { id: true },
    });
    await processCoreIntent(handle.client, intent.id, options);
    await ingestEvidenceBatch(handle.client, {
      ...own,
      batch: incrementalBatch(accepted.runId, [
        errorEvent(accepted.runId, 5, 'late-lower-sequence'),
      ]),
    });
    expect(
      (await listCoreRuns(handle.client, { ...own, limit: 10 })).items[0]
        ?.processingState,
    ).toBe('stale');
    const next = await handle.client.processingIntent.findFirstOrThrow({
      where: { organizationId: own.organizationId, id: { not: intent.id } },
      select: { id: true },
    });
    await processCoreIntent(handle.client, next.id, options);
    await pool.query(
      'UPDATE core_run_projections SET projector_version = 999 WHERE organization_id = $1',
      [own.organizationId],
    );
    expect(
      (await listCoreRuns(handle.client, { ...own, limit: 10 })).items[0]
        ?.processingState,
    ).toBe('stale');
    await handle.dispose();
  });

  it('paginates projected children without duplicates or omissions', async () => {
    const own = await seed();
    const handle = createDatabaseClient({ connectionString });
    const accepted = batch();
    await ingestEvidenceBatch(handle.client, {
      ...own,
      batch: EvidenceBatchSchema.parse({
        ...accepted,
        events: [
          ...accepted.events,
          errorEvent(accepted.runId, 2, 'first'),
          errorEvent(accepted.runId, 3, 'second'),
        ],
      }),
    });
    const intent = await handle.client.processingIntent.findFirstOrThrow({
      where: { organizationId: own.organizationId },
      select: { id: true },
    });
    await processCoreIntent(handle.client, intent.id, options);
    const first = await getCoreRunDetail(handle.client, {
      ...own,
      canonicalRunId: accepted.runId,
      childLimit: 1,
    });
    const cursor = first?.projection?.errors.nextCursor;
    expect(first?.projection?.errors.items).toHaveLength(1);
    expect(cursor).not.toBeNull();
    const second = await getCoreRunDetail(handle.client, {
      ...own,
      canonicalRunId: accepted.runId,
      childLimit: 1,
      childCursors: { errors: cursor! },
    });
    expect(second?.projection?.errors.items).toHaveLength(1);
    expect(second?.projection?.errors.items[0]?.errorId).not.toBe(
      first?.projection?.errors.items[0]?.errorId,
    );
    expect(second?.projection?.errors.nextCursor).toBeNull();
    await handle.dispose();
  });

  it('paginates run lists stably across equal and adjacent timestamps', async () => {
    const own = await seed();
    const foreign = await seed();
    const handle = createDatabaseClient({ connectionString });
    const ownBatches = Array.from({ length: 6 }, () => batch());
    for (const accepted of ownBatches)
      await ingestEvidenceBatch(handle.client, { ...own, batch: accepted });
    const foreignBatch = batch();
    await ingestEvidenceBatch(handle.client, {
      ...foreign,
      batch: foreignBatch,
    });

    const timestamps = [
      '2026-10-01T12:00:01.000Z',
      '2026-10-01T12:00:00.000Z',
      '2026-10-01T12:00:00.000Z',
      '2026-10-01T12:00:00.000Z',
      '2026-10-01T11:59:59.999Z',
      '2026-10-01T11:59:59.998Z',
    ];
    for (const [index, accepted] of ownBatches.entries())
      await pool.query(
        'UPDATE runs SET created_at = $1 WHERE organization_id = $2 AND canonical_run_id = $3',
        [timestamps[index], own.organizationId, accepted!.runId],
      );
    await pool.query(
      'UPDATE runs SET created_at = $1 WHERE organization_id = $2 AND canonical_run_id = $3',
      [timestamps[1], foreign.organizationId, foreignBatch.runId],
    );

    const expected = (
      await pool.query<{ canonical_run_id: string }>(
        `SELECT canonical_run_id
           FROM runs
          WHERE organization_id = $1 AND repository_id = $2
          ORDER BY created_at DESC, id DESC`,
        [own.organizationId, own.repositoryId],
      )
    ).rows.map((row) => row.canonical_run_id);

    const traverse = async () => {
      const ids: string[] = [];
      const cursors: Array<string | null> = [];
      let cursor: string | undefined;
      do {
        const page = await listCoreRuns(handle.client, {
          ...own,
          limit: 2,
          ...(cursor ? { cursor } : {}),
        });
        ids.push(...page.items.map((item) => item.runId));
        cursors.push(page.nextCursor);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return { ids, cursors };
    };

    const firstTraversal = await traverse();
    const secondTraversal = await traverse();
    expect(firstTraversal.ids).toEqual(expected);
    expect(new Set(firstTraversal.ids).size).toBe(expected.length);
    expect(firstTraversal).toEqual(secondTraversal);
    expect(firstTraversal.cursors.at(-1)).toBeNull();
    expect(firstTraversal.ids).not.toContain(foreignBatch.runId);

    const wrongTenant = await listCoreRuns(handle.client, {
      organizationId: foreign.organizationId,
      repositoryId: own.repositoryId,
      limit: 2,
    });
    const missing = await listCoreRuns(handle.client, {
      organizationId: randomUUID(),
      repositoryId: own.repositoryId,
      limit: 2,
    });
    expect(wrongTenant).toEqual({ items: [], nextCursor: null });
    expect(missing).toEqual(wrongTenant);
    await handle.dispose();
  });

  it('keeps the old projection atomically visible until replacement commits', async () => {
    const own = await seed();
    const writer = createDatabaseClient({ connectionString });
    const reader = createDatabaseClient({ connectionString });
    const accepted = batch();
    await ingestEvidenceBatch(writer.client, { ...own, batch: accepted });
    const first = await writer.client.processingIntent.findFirstOrThrow({
      where: { organizationId: own.organizationId },
      select: { id: true },
    });
    await processCoreIntent(writer.client, first.id, options);
    await ingestEvidenceBatch(writer.client, {
      ...own,
      batch: incrementalBatch(accepted.runId, [
        errorEvent(accepted.runId, 5, 'replacement'),
      ]),
    });
    const second = await writer.client.processingIntent.findFirstOrThrow({
      where: { organizationId: own.organizationId, id: { not: first.id } },
      select: { id: true },
    });
    let release!: () => void;
    let reached!: () => void;
    const atReplacement = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const continueCommit = new Promise<void>((resolve) => {
      release = resolve;
    });
    const processing = processCoreIntent(writer.client, second.id, options, {
      hooks: {
        afterChildrenReplaced: async () => {
          reached();
          await continueCommit;
        },
      },
    });
    await atReplacement;
    const during = await getCoreRunDetail(reader.client, {
      ...own,
      canonicalRunId: accepted.runId,
      childLimit: 10,
    });
    expect(during?.projection?.source.eventCount).toBe(2);
    expect(during?.projection?.errors.items).toHaveLength(0);
    release();
    await expect(processing).resolves.toBe('applied');
    const after = await getCoreRunDetail(reader.client, {
      ...own,
      canonicalRunId: accepted.runId,
      childLimit: 10,
    });
    expect(after?.projection?.source.eventCount).toBe(3);
    expect(after?.projection?.errors.items).toHaveLength(1);
    await Promise.all([writer.dispose(), reader.dispose()]);
  });

  it('converges duplicate messages on one exact application receipt', async () => {
    const own = await seed();
    const first = createDatabaseClient({ connectionString });
    const second = createDatabaseClient({ connectionString });
    await ingestEvidenceBatch(first.client, { ...own, batch: batch() });
    const intent = await first.client.processingIntent.findFirstOrThrow({
      where: { organizationId: own.organizationId },
      select: { id: true },
    });
    const concurrent = await Promise.all([
      processCoreIntent(first.client, intent.id, options),
      processCoreIntent(second.client, intent.id, options),
    ]);
    expect(concurrent).toContain('applied');
    expect(await processCoreIntent(second.client, intent.id, options)).toBe(
      'already_applied',
    );
    expect(
      await first.client.processingApplicationReceipt.count({
        where: { intentId: intent.id },
      }),
    ).toBe(1);
    await Promise.all([first.dispose(), second.dispose()]);
  });

  it('rolls back publication and receipt after the absolute attempt deadline', async () => {
    const own = await seed();
    const handle = createDatabaseClient({ connectionString });
    await ingestEvidenceBatch(handle.client, { ...own, batch: batch() });
    const intent = await handle.client.processingIntent.findFirstOrThrow({
      where: { organizationId: own.organizationId },
      select: { id: true },
    });
    const result = await processCoreIntent(
      handle.client,
      intent.id,
      {
        ...options,
        leaseSeconds: 1,
        attemptTimeoutMs: 50,
        transitionMarginMs: 50,
        maxAttempts: 1,
      },
      {
        hooks: {
          afterChildrenReplaced: () =>
            new Promise((resolve) => setTimeout(resolve, 75)),
        },
      },
    );
    expect(result).toBe('failed');
    expect(
      await handle.client.processingApplicationReceipt.count({
        where: { intentId: intent.id },
      }),
    ).toBe(0);
    expect(
      await handle.client.coreRunProjection.count({
        where: { organizationId: own.organizationId },
      }),
    ).toBe(0);
    await handle.dispose();
  });

  it('publishes, exactly replays, and tenant-safely pages a conservative summary', async () => {
    const migration = await pool.query(
      `SELECT 1 FROM _prisma_migrations WHERE migration_name = '20261013120000_evidence_backed_summaries' AND finished_at IS NOT NULL`,
    );
    expect(migration.rows).toHaveLength(1);
    const own = await seed();
    const other = await seed();
    const handle = createDatabaseClient({ connectionString });
    const accepted = batch();
    await ingestEvidenceBatch(handle.client, { ...own, batch: accepted });
    const run = await handle.client.run.findUniqueOrThrow({
      where: {
        organizationId_canonicalRunId: {
          organizationId: own.organizationId,
          canonicalRunId: accepted.runId,
        },
      },
      select: { id: true },
    });
    const intent = await handle.client.processingIntent.findFirstOrThrow({
      where: { organizationId: own.organizationId, runId: run.id },
      select: { id: true },
    });
    await expect(
      processCoreIntent(handle.client, intent.id, options),
    ).resolves.toBe('applied');
    await expect(
      processFindingsIntent(handle.client, intent.id, findingsOptions),
    ).resolves.toBe('applied');
    await expect(
      processSummaryIntent(handle.client, intent.id, summaryOptions),
    ).resolves.toBe('applied');
    const first = await handle.client.summaryRunProjection.findUniqueOrThrow({
      where: { runId: run.id },
      include: {
        claims: { orderBy: [{ sectionOrder: 'asc' }, { claimOrder: 'asc' }] },
      },
    });
    await expect(
      processSummaryIntent(handle.client, intent.id, summaryOptions),
    ).resolves.toBe('already_applied');
    const replayed = await handle.client.summaryRunProjection.findUniqueOrThrow(
      {
        where: { runId: run.id },
        include: {
          claims: { orderBy: [{ sectionOrder: 'asc' }, { claimOrder: 'asc' }] },
        },
      },
    );
    expect(replayed.summaryKey).toBe(first.summaryKey);
    expect(replayed.claims.map((claim) => claim.claimKey)).toEqual(
      first.claims.map((claim) => claim.claimKey),
    );
    expect(replayed.summaryOutcome).toBe('unknown');
    expect(
      replayed.claims.some((claim) => claim.claimClass === 'limitation'),
    ).toBe(true);

    const page = await listSummaryClaims(handle.client, {
      ...own,
      canonicalRunId: accepted.runId,
      limit: 2,
    });
    expect(page?.processingState).toBe('ready');
    expect(page?.items).toHaveLength(2);
    expect(page?.nextCursor).not.toBeNull();
    const next = await listSummaryClaims(handle.client, {
      ...own,
      canonicalRunId: accepted.runId,
      limit: 100,
      cursor: page!.nextCursor!,
    });
    expect(next?.items.length).toBe(first.claimCount - 2);
    const supported = first.claims.find((claim) => claim.supportCount > 0)!;
    const supportPage = await listSummarySupports(handle.client, {
      ...own,
      canonicalRunId: accepted.runId,
      claimKey: supported.claimKey,
      limit: 1,
    });
    expect(supportPage?.items).toHaveLength(1);
    await expect(
      listSummaryClaims(handle.client, {
        ...other,
        canonicalRunId: accepted.runId,
        limit: 10,
      }),
    ).resolves.toBeNull();
    await handle.dispose();
  });

  it('keeps a current summary available after an exact-source replay attempt fails', async () => {
    const fixture = await readySummaryFixture();
    const foreign = await seed();
    try {
      const before =
        await fixture.handle.client.summaryRunProjection.findUniqueOrThrow({
          where: { runId: fixture.runId },
          include: {
            claims: {
              orderBy: [{ sectionOrder: 'asc' }, { claimOrder: 'asc' }],
              include: { supports: { orderBy: { ordinal: 'asc' } } },
            },
          },
        });
      await expect(
        replaySummaryIntent(
          fixture.handle.client,
          fixture.intentId,
          { ...summaryOptions, maxAttempts: 1 },
          {
            hooks: {
              afterDependenciesRead: () => {
                throw new Error('forced exact-source replay failure');
              },
            },
          },
        ),
      ).resolves.toBe('failed');

      const after =
        await fixture.handle.client.summaryRunProjection.findUniqueOrThrow({
          where: { runId: fixture.runId },
          include: {
            claims: {
              orderBy: [{ sectionOrder: 'asc' }, { claimOrder: 'asc' }],
              include: { supports: { orderBy: { ordinal: 'asc' } } },
            },
          },
        });
      expect(after).toEqual(before);

      const claims = await listSummaryClaims(fixture.handle.client, {
        ...fixture.scope,
        canonicalRunId: fixture.accepted.runId,
        limit: 100,
      });
      expect(claims).toMatchObject({
        processingState: 'failed',
        summaryAvailability: 'current',
        processingErrorCode: 'summary_projection_failed',
        outcome: before.summaryOutcome,
        claimCount: before.claimCount,
      });
      expect(claims?.items).toHaveLength(before.claimCount);
      const supported = claims!.items.find((claim) => claim.supportCount > 0)!;
      const supports = await listSummarySupports(fixture.handle.client, {
        ...fixture.scope,
        canonicalRunId: fixture.accepted.runId,
        claimKey: supported.claimKey,
        limit: 100,
      });
      expect(supports).toMatchObject({
        processingState: 'failed',
        summaryAvailability: 'current',
        processingErrorCode: 'summary_projection_failed',
        claimKey: supported.claimKey,
      });
      expect(supports?.items).toHaveLength(supported.supportCount);

      const detail = await getCoreRunDetail(fixture.handle.client, {
        ...fixture.scope,
        canonicalRunId: fixture.accepted.runId,
        childLimit: 10,
      });
      expect(detail).toMatchObject({
        summaryProcessingState: 'failed',
        summaryAvailability: 'current',
        summaryProcessingErrorCode: 'summary_projection_failed',
        summaryOutcome: before.summaryOutcome,
      });
      const list = await listCoreRuns(fixture.handle.client, {
        ...fixture.scope,
        limit: 10,
      });
      expect(list.items[0]).toMatchObject({
        summaryProcessingState: 'failed',
        summaryAvailability: 'current',
        summaryProcessingErrorCode: 'summary_projection_failed',
        summaryOutcome: before.summaryOutcome,
      });

      const changed = incrementalBatch(fixture.accepted.runId, [
        errorEvent(fixture.accepted.runId, 2, 'summary-dependency-changed'),
      ]);
      await ingestEvidenceBatch(fixture.handle.client, {
        ...fixture.scope,
        batch: changed,
      });
      const intent =
        await fixture.handle.client.processingIntent.findFirstOrThrow({
          where: {
            runId: fixture.runId,
            batch: { canonicalBatchId: changed.batchId },
          },
          select: { id: true },
        });
      await processCoreIntent(fixture.handle.client, intent.id, options);
      const stale = await listSummaryClaims(fixture.handle.client, {
        ...fixture.scope,
        canonicalRunId: fixture.accepted.runId,
        limit: 100,
      });
      expect(stale).toMatchObject({
        processingState: 'failed',
        summaryAvailability: 'stale',
        outcome: null,
        items: [],
      });
      await expect(
        listSummaryClaims(fixture.handle.client, {
          organizationId: foreign.organizationId,
          repositoryId: foreign.repositoryId,
          canonicalRunId: fixture.accepted.runId,
          limit: 10,
        }),
      ).resolves.toBeNull();
    } finally {
      await fixture.handle.dispose();
    }
  });

  it('allows only one live summary owner and rejects stale ownership before publication', async () => {
    const own = await seed();
    const first = createDatabaseClient({ connectionString });
    const second = createDatabaseClient({ connectionString });
    const accepted = batch();
    await ingestEvidenceBatch(first.client, { ...own, batch: accepted });
    const run = await first.client.run.findUniqueOrThrow({
      where: {
        organizationId_canonicalRunId: {
          organizationId: own.organizationId,
          canonicalRunId: accepted.runId,
        },
      },
      select: { id: true },
    });
    const intent = await first.client.processingIntent.findFirstOrThrow({
      where: { runId: run.id },
      select: { id: true },
    });
    await processCoreIntent(first.client, intent.id, options);
    await processFindingsIntent(first.client, intent.id, findingsOptions);

    let ownerEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      ownerEntered = resolve;
    });
    let releaseOwner!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseOwner = resolve;
    });
    const owner = processSummaryIntent(
      first.client,
      intent.id,
      summaryOptions,
      {
        hooks: {
          afterDependenciesRead: async () => {
            ownerEntered();
            await release;
          },
        },
      },
    );
    await entered;
    try {
      await expect(
        processSummaryIntent(second.client, intent.id, summaryOptions),
      ).resolves.toBe('busy');
    } finally {
      releaseOwner();
    }
    await expect(owner).resolves.toBe('applied');
    await expect(
      processSummaryIntent(second.client, intent.id, summaryOptions, {
        hooks: {
          afterDependenciesRead: async () => {
            await pool.query(
              `UPDATE run_processing_states SET lease_id = $1
               WHERE organization_id = $2 AND run_id = $3 AND projector_name = 'summary'`,
              [randomUUID(), own.organizationId, run.id],
            );
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'processing_lease_lost' });
    expect(
      await first.client.summaryRunProjection.count({
        where: { runId: run.id },
      }),
    ).toBe(1);
    await Promise.all([first.dispose(), second.dispose()]);
  });

  it('atomically rolls back findings-to-summary invalidation and rebuilds after replacement', async () => {
    const own = await seed();
    const handle = createDatabaseClient({ connectionString });
    const accepted = batch();
    await ingestEvidenceBatch(handle.client, { ...own, batch: accepted });
    const run = await handle.client.run.findUniqueOrThrow({
      where: {
        organizationId_canonicalRunId: {
          organizationId: own.organizationId,
          canonicalRunId: accepted.runId,
        },
      },
      select: { id: true },
    });
    const first = await handle.client.processingIntent.findFirstOrThrow({
      where: { runId: run.id },
      select: { id: true },
    });
    await processCoreIntent(handle.client, first.id, options);
    await processFindingsIntent(handle.client, first.id, findingsOptions);
    await processSummaryIntent(handle.client, first.id, summaryOptions);
    const old = await handle.client.summaryRunProjection.findUniqueOrThrow({
      where: { runId: run.id },
      select: { summaryKey: true },
    });

    const late = incrementalBatch(accepted.runId, [
      errorEvent(accepted.runId, 2, 'late-summary-source'),
    ]);
    await ingestEvidenceBatch(handle.client, { ...own, batch: late });
    const second = await handle.client.processingIntent.findFirstOrThrow({
      where: { runId: run.id, batch: { canonicalBatchId: late.batchId } },
      select: { id: true },
    });
    await processCoreIntent(handle.client, second.id, options);
    await expect(
      processFindingsIntent(
        handle.client,
        second.id,
        { ...findingsOptions, maxAttempts: 1 },
        {
          hooks: {
            afterSummaryInvalidated: () => {
              throw new Error('crash after summary invalidation');
            },
          },
        },
      ),
    ).resolves.toBe('failed');
    await expect(
      handle.client.summaryRunProjection.findUniqueOrThrow({
        where: { runId: run.id },
        select: { summaryKey: true },
      }),
    ).resolves.toEqual(old);

    await expect(
      replayFindingsIntent(handle.client, second.id, findingsOptions),
    ).resolves.toBe('applied');
    expect(
      await handle.client.summaryRunProjection.count({
        where: { runId: run.id },
      }),
    ).toBe(0);
    await expect(
      processSummaryIntent(handle.client, second.id, summaryOptions),
    ).resolves.toBe('applied');
    const current = await handle.client.summaryRunProjection.findUniqueOrThrow({
      where: { runId: run.id },
      select: { summaryKey: true },
    });
    expect(current.summaryKey).not.toBe(old.summaryKey);
    await handle.dispose();
  });

  it('rolls back a crash after claim replacement and recovers by explicit replay', async () => {
    const own = await seed();
    const handle = createDatabaseClient({ connectionString });
    const accepted = batch();
    await ingestEvidenceBatch(handle.client, { ...own, batch: accepted });
    const run = await handle.client.run.findUniqueOrThrow({
      where: {
        organizationId_canonicalRunId: {
          organizationId: own.organizationId,
          canonicalRunId: accepted.runId,
        },
      },
      select: { id: true },
    });
    const intent = await handle.client.processingIntent.findFirstOrThrow({
      where: { runId: run.id },
      select: { id: true },
    });
    await processCoreIntent(handle.client, intent.id, options);
    await processFindingsIntent(handle.client, intent.id, findingsOptions);
    await expect(
      processSummaryIntent(
        handle.client,
        intent.id,
        { ...summaryOptions, maxAttempts: 1 },
        {
          hooks: {
            afterClaimsReplaced: () => {
              throw new Error('crash after claims');
            },
          },
        },
      ),
    ).resolves.toBe('failed');
    expect(
      await handle.client.summaryRunProjection.count({
        where: { runId: run.id },
      }),
    ).toBe(0);
    expect(
      await handle.client.processingApplicationReceipt.count({
        where: { intentId: intent.id, projectorName: 'summary' },
      }),
    ).toBe(0);
    await expect(
      replaySummaryIntent(handle.client, intent.id, summaryOptions),
    ).resolves.toBe('applied');
    await handle.dispose();
  });

  it('changes summary identity when the material findings graph changes without changing its dependency fingerprint', async () => {
    const fixture = await readySummaryFixture();
    try {
      const candidates = (
        await pool.query<{
          id: string;
          rule_id: string;
        }>(
          `SELECT id, rule_id FROM finding_rule_results
            WHERE run_id = $1 AND severity = 'high'
            ORDER BY catalog_order LIMIT 2`,
          [fixture.runId],
        )
      ).rows;
      expect(candidates).toHaveLength(2);
      const eventId = (
        await pool.query<{ id: string }>(
          'SELECT id FROM evidence_events WHERE run_id = $1 ORDER BY sequence LIMIT 1',
          [fixture.runId],
        )
      ).rows[0]!.id;
      const prepare = await pool.connect();
      try {
        await prepare.query('BEGIN');
        await prepare.query(
          'DELETE FROM finding_evidence_references WHERE result_id = ANY($1::uuid[])',
          [candidates.map((candidate) => candidate.id)],
        );
        await prepare.query(
          `UPDATE finding_rule_results SET
             outcome = CASE WHEN id = $2 THEN 'triggered' ELSE 'clear' END,
             coverage = 'complete'
           WHERE run_id = $1 AND id IN ($2, $3)`,
          [fixture.runId, candidates[0]!.id, candidates[1]!.id],
        );
        await prepare.query(
          `INSERT INTO finding_evidence_references
            (organization_id, run_id, result_id, ordinal, event_id)
           VALUES ($1, $2, $3, 0, $4)`,
          [
            fixture.scope.organizationId,
            fixture.runId,
            candidates[0]!.id,
            eventId,
          ],
        );
        await prepare.query(
          `UPDATE findings_run_projections projection SET
             deterministic_outcome = 'review',
             coverage = CASE WHEN EXISTS (
               SELECT 1 FROM finding_rule_results result
                WHERE result.run_id = projection.run_id
                  AND result.coverage = 'partial'
             ) THEN 'partial' ELSE 'complete' END,
             triggered_count = (SELECT count(*) FROM finding_rule_results result WHERE result.run_id = projection.run_id AND result.outcome = 'triggered'),
             unknown_count = (SELECT count(*) FROM finding_rule_results result WHERE result.run_id = projection.run_id AND result.outcome = 'unknown'),
             high_count = (SELECT count(*) FROM finding_rule_results result WHERE result.run_id = projection.run_id AND result.outcome = 'triggered' AND result.severity = 'high'),
             medium_count = (SELECT count(*) FROM finding_rule_results result WHERE result.run_id = projection.run_id AND result.outcome = 'triggered' AND result.severity = 'medium')
           WHERE run_id = $1`,
          [fixture.runId],
        );
        await prepare.query('COMMIT');
      } finally {
        await prepare.query('ROLLBACK').catch(() => undefined);
        prepare.release();
      }
      await expect(
        processSummaryIntent(
          fixture.handle.client,
          fixture.intentId,
          summaryOptions,
        ),
      ).resolves.toBe('applied');
      const before =
        await fixture.handle.client.summaryRunProjection.findUniqueOrThrow({
          where: { runId: fixture.runId },
          select: { summaryKey: true, sourceFingerprint: true },
        });
      const findingsBefore =
        await fixture.handle.client.findingsRunProjection.findUniqueOrThrow({
          where: { runId: fixture.runId },
          select: { sourceFingerprint: true },
        });
      const claimPage = await listSummaryClaims(fixture.handle.client, {
        ...fixture.scope,
        canonicalRunId: fixture.accepted.runId,
        limit: 1,
      });
      expect(claimPage?.nextCursor).not.toBeNull();
      const allClaims = await listSummaryClaims(fixture.handle.client, {
        ...fixture.scope,
        canonicalRunId: fixture.accepted.runId,
        limit: 100,
      });
      const multiSupportClaim = allClaims!.items.find(
        (claim) => claim.supportCount > 1,
      )!;
      expect(multiSupportClaim).toBeDefined();
      const supportPage = await listSummarySupports(fixture.handle.client, {
        ...fixture.scope,
        canonicalRunId: fixture.accepted.runId,
        claimKey: multiSupportClaim.claimKey,
        limit: 1,
      });
      expect(supportPage?.nextCursor).not.toBeNull();

      const swap = await pool.connect();
      try {
        await swap.query('BEGIN');
        await swap.query(
          `INSERT INTO finding_evidence_references
            (organization_id, run_id, result_id, ordinal, event_id)
           VALUES ($1, $2, $3, 0, $4)`,
          [
            fixture.scope.organizationId,
            fixture.runId,
            candidates[1]!.id,
            eventId,
          ],
        );
        await swap.query(
          `UPDATE finding_rule_results SET outcome = CASE
             WHEN id = $2 THEN 'clear'
             WHEN id = $3 THEN 'triggered'
             ELSE outcome END
           WHERE run_id = $1 AND id IN ($2, $3)`,
          [fixture.runId, candidates[0]!.id, candidates[1]!.id],
        );
        await swap.query('COMMIT');
      } catch (error) {
        await swap.query('ROLLBACK');
        throw error;
      } finally {
        swap.release();
      }
      expect(
        await fixture.handle.client.summaryRunProjection.count({
          where: { runId: fixture.runId },
        }),
      ).toBe(0);
      await expect(
        processFindingsIntent(
          fixture.handle.client,
          fixture.intentId,
          findingsOptions,
        ),
      ).resolves.toBe('already_applied');
      expect(
        await fixture.handle.client.findingsRunProjection.findUniqueOrThrow({
          where: { runId: fixture.runId },
          select: { sourceFingerprint: true },
        }),
      ).toEqual(findingsBefore);

      await expect(
        processSummaryIntent(
          fixture.handle.client,
          fixture.intentId,
          summaryOptions,
        ),
      ).resolves.toBe('applied');
      const after =
        await fixture.handle.client.summaryRunProjection.findUniqueOrThrow({
          where: { runId: fixture.runId },
          select: { summaryKey: true, sourceFingerprint: true },
        });
      expect(after.summaryKey).not.toBe(before.summaryKey);
      expect(after.sourceFingerprint).not.toBe(before.sourceFingerprint);
      const incompatible = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM summary_claim_supports support
           JOIN finding_rule_results result ON result.id = support.finding_result_id
           JOIN findings_run_projections projection ON projection.run_id = support.run_id
          WHERE support.run_id = $1 AND support.support_kind = 'finding'
            AND (support.finding_result_key IS DISTINCT FROM result.result_key
              OR support.finding_rule_id IS DISTINCT FROM result.rule_id
              OR support.finding_rule_version IS DISTINCT FROM result.rule_version
              OR support.findings_source_fingerprint IS DISTINCT FROM projection.source_fingerprint)`,
        [fixture.runId],
      );
      expect(incompatible.rows[0]!.count).toBe('0');
      await expect(
        listSummaryClaims(fixture.handle.client, {
          ...fixture.scope,
          canonicalRunId: fixture.accepted.runId,
          limit: 1,
          cursor: claimPage!.nextCursor!,
        }),
      ).rejects.toThrow('stale snapshot');
      await expect(
        listSummarySupports(fixture.handle.client, {
          ...fixture.scope,
          canonicalRunId: fixture.accepted.runId,
          claimKey: multiSupportClaim.claimKey,
          limit: 1,
          cursor: supportPage!.nextCursor!,
        }),
      ).rejects.toThrow('stale snapshot');

      const rebuilt =
        await fixture.handle.client.summaryRunProjection.findUniqueOrThrow({
          where: { runId: fixture.runId },
          include: {
            claims: {
              orderBy: [{ sectionOrder: 'asc' }, { claimOrder: 'asc' }],
              include: { supports: { orderBy: { ordinal: 'asc' } } },
            },
          },
        });
      await expect(
        processSummaryIntent(
          fixture.handle.client,
          fixture.intentId,
          summaryOptions,
        ),
      ).resolves.toBe('already_applied');
      expect(
        await fixture.handle.client.summaryRunProjection.findUniqueOrThrow({
          where: { runId: fixture.runId },
          include: {
            claims: {
              orderBy: [{ sectionOrder: 'asc' }, { claimOrder: 'asc' }],
              include: { supports: { orderBy: { ordinal: 'asc' } } },
            },
          },
        }),
      ).toEqual(rebuilt);
    } finally {
      await fixture.handle.dispose();
    }
  });

  it('binds claim pagination to one summary snapshot and keeps exact replay traversal stable', async () => {
    const first = await readySummaryFixture();
    const secondRun = await readySummaryFixture(first.scope);
    const foreign = await readySummaryFixture();
    try {
      const firstPage = await listSummaryClaims(first.handle.client, {
        ...first.scope,
        canonicalRunId: first.accepted.runId,
        limit: 1,
      });
      expect(firstPage?.nextCursor).not.toBeNull();
      const cursor = firstPage!.nextCursor!;

      await expect(
        processSummaryIntent(
          first.handle.client,
          first.intentId,
          summaryOptions,
        ),
      ).resolves.toBe('already_applied');
      const replayPage = await listSummaryClaims(first.handle.client, {
        ...first.scope,
        canonicalRunId: first.accepted.runId,
        limit: 100,
        cursor,
      });
      expect(replayPage?.items.length).toBeGreaterThan(0);
      expect(replayPage?.nextCursor).toBeNull();

      for (const malformed of ['%%%', 'a'.repeat(1_025)])
        await expect(
          listSummaryClaims(first.handle.client, {
            ...first.scope,
            canonicalRunId: first.accepted.runId,
            limit: 1,
            cursor: malformed,
          }),
        ).rejects.toThrow('Invalid summary claim pagination cursor');

      await expect(
        listSummaryClaims(secondRun.handle.client, {
          ...first.scope,
          canonicalRunId: secondRun.accepted.runId,
          limit: 1,
          cursor,
        }),
      ).rejects.toThrow('stale snapshot');
      await expect(
        listSummaryClaims(foreign.handle.client, {
          ...foreign.scope,
          canonicalRunId: foreign.accepted.runId,
          limit: 1,
          cursor,
        }),
      ).rejects.toThrow('stale snapshot');
      await expect(
        listSummaryClaims(foreign.handle.client, {
          ...foreign.scope,
          canonicalRunId: first.accepted.runId,
          limit: 1,
          cursor,
        }),
      ).resolves.toBeNull();

      const traverse = async () => {
        const keys: string[] = [];
        let nextCursor: string | undefined;
        do {
          const page = await listSummaryClaims(first.handle.client, {
            ...first.scope,
            canonicalRunId: first.accepted.runId,
            limit: 2,
            ...(nextCursor ? { cursor: nextCursor } : {}),
          });
          keys.push(...page!.items.map((item) => item.claimKey));
          nextCursor = page!.nextCursor ?? undefined;
        } while (nextCursor);
        return keys;
      };
      expect(await traverse()).toEqual(await traverse());
    } finally {
      await Promise.all([
        first.handle.dispose(),
        secondRun.handle.dispose(),
        foreign.handle.dispose(),
      ]);
    }
  });

  it('binds support pagination to the exact summary and claim with stable complete traversal', async () => {
    const first = await readySummaryFixture();
    const secondRun = await readySummaryFixture(first.scope);
    const foreign = await readySummaryFixture();
    try {
      const claimsFor = async (
        fixture: Awaited<ReturnType<typeof readySummaryFixture>>,
      ) =>
        listSummaryClaims(fixture.handle.client, {
          ...fixture.scope,
          canonicalRunId: fixture.accepted.runId,
          limit: 100,
        });
      const firstClaims = await claimsFor(first);
      const claim = firstClaims!.items.find((item) => item.supportCount > 1)!;
      const otherClaim = firstClaims!.items.find(
        (item) => item.claimKey !== claim.claimKey,
      )!;
      expect(claim).toBeDefined();
      expect(otherClaim).toBeDefined();
      const firstPage = await listSummarySupports(first.handle.client, {
        ...first.scope,
        canonicalRunId: first.accepted.runId,
        claimKey: claim.claimKey,
        limit: 1,
      });
      expect(firstPage).toMatchObject({
        summaryAvailability: 'current',
        claimKey: claim.claimKey,
      });
      expect(firstPage?.items).toHaveLength(1);
      expect(firstPage?.nextCursor).not.toBeNull();
      const cursor = firstPage!.nextCursor!;

      await expect(
        processSummaryIntent(
          first.handle.client,
          first.intentId,
          summaryOptions,
        ),
      ).resolves.toBe('already_applied');
      const continued = await listSummarySupports(first.handle.client, {
        ...first.scope,
        canonicalRunId: first.accepted.runId,
        claimKey: claim.claimKey,
        limit: 100,
        cursor,
      });
      expect(continued?.items).toHaveLength(claim.supportCount - 1);
      expect(continued?.nextCursor).toBeNull();

      const traverse = async () => {
        const ordinals: number[] = [];
        let nextCursor: string | undefined;
        do {
          const page = await listSummarySupports(first.handle.client, {
            ...first.scope,
            canonicalRunId: first.accepted.runId,
            claimKey: claim.claimKey,
            limit: 1,
            ...(nextCursor ? { cursor: nextCursor } : {}),
          });
          ordinals.push(...page!.items.map((item) => item.ordinal));
          nextCursor = page!.nextCursor ?? undefined;
        } while (nextCursor);
        return ordinals;
      };
      const traversal = await traverse();
      expect(traversal).toHaveLength(claim.supportCount);
      expect(new Set(traversal).size).toBe(claim.supportCount);
      expect(traversal).toEqual(
        Array.from({ length: claim.supportCount }, (_, ordinal) => ordinal),
      );
      expect(await traverse()).toEqual(traversal);

      for (const malformed of ['%%%', 'a'.repeat(1_025)])
        await expect(
          listSummarySupports(first.handle.client, {
            ...first.scope,
            canonicalRunId: first.accepted.runId,
            claimKey: claim.claimKey,
            limit: 1,
            cursor: malformed,
          }),
        ).rejects.toThrow('Invalid summary support pagination cursor');
      await expect(
        listSummarySupports(first.handle.client, {
          ...first.scope,
          canonicalRunId: first.accepted.runId,
          claimKey: otherClaim.claimKey,
          limit: 1,
          cursor,
        }),
      ).rejects.toThrow('stale snapshot');

      const secondClaims = await claimsFor(secondRun);
      const secondClaim = secondClaims!.items.find(
        (item) => item.supportCount > 1,
      )!;
      await expect(
        listSummarySupports(secondRun.handle.client, {
          ...secondRun.scope,
          canonicalRunId: secondRun.accepted.runId,
          claimKey: secondClaim.claimKey,
          limit: 1,
          cursor,
        }),
      ).rejects.toThrow('stale snapshot');
      const foreignClaims = await claimsFor(foreign);
      const foreignClaim = foreignClaims!.items.find(
        (item) => item.supportCount > 1,
      )!;
      await expect(
        listSummarySupports(foreign.handle.client, {
          ...foreign.scope,
          canonicalRunId: foreign.accepted.runId,
          claimKey: foreignClaim.claimKey,
          limit: 1,
          cursor,
        }),
      ).rejects.toThrow('stale snapshot');
      await expect(
        listSummarySupports(foreign.handle.client, {
          ...foreign.scope,
          canonicalRunId: first.accepted.runId,
          claimKey: claim.claimKey,
          limit: 1,
          cursor,
        }),
      ).resolves.toBeNull();
    } finally {
      await Promise.all([
        first.handle.dispose(),
        secondRun.handle.dispose(),
        foreign.handle.dispose(),
      ]);
    }
  });

  it('rejects a claim cursor after replacement between pages', async () => {
    const fixture = await readySummaryFixture();
    try {
      const highSequence = incrementalBatch(fixture.accepted.runId, [
        errorEvent(fixture.accepted.runId, 4, 'higher-sequence-first'),
      ]);
      await ingestEvidenceBatch(fixture.handle.client, {
        ...fixture.scope,
        batch: highSequence,
      });
      const highIntent =
        await fixture.handle.client.processingIntent.findFirstOrThrow({
          where: {
            runId: fixture.runId,
            batch: { canonicalBatchId: highSequence.batchId },
          },
          select: { id: true },
        });
      await processCoreIntent(fixture.handle.client, highIntent.id, options);
      await processFindingsIntent(
        fixture.handle.client,
        highIntent.id,
        findingsOptions,
      );
      await processSummaryIntent(
        fixture.handle.client,
        highIntent.id,
        summaryOptions,
      );
      const page = await listSummaryClaims(fixture.handle.client, {
        ...fixture.scope,
        canonicalRunId: fixture.accepted.runId,
        limit: 1,
      });
      const cursor = page!.nextCursor!;
      const prior =
        await fixture.handle.client.summaryRunProjection.findUniqueOrThrow({
          where: { runId: fixture.runId },
          select: { summaryKey: true },
        });
      const late = incrementalBatch(fixture.accepted.runId, [
        errorEvent(fixture.accepted.runId, 2, 'late-lower-sequence'),
      ]);
      await ingestEvidenceBatch(fixture.handle.client, {
        ...fixture.scope,
        batch: late,
      });
      const intent =
        await fixture.handle.client.processingIntent.findFirstOrThrow({
          where: {
            runId: fixture.runId,
            batch: { canonicalBatchId: late.batchId },
          },
          select: { id: true },
        });
      await processCoreIntent(fixture.handle.client, intent.id, options);
      await processFindingsIntent(
        fixture.handle.client,
        intent.id,
        findingsOptions,
      );
      await processSummaryIntent(
        fixture.handle.client,
        intent.id,
        summaryOptions,
      );
      const current =
        await fixture.handle.client.summaryRunProjection.findUniqueOrThrow({
          where: { runId: fixture.runId },
          select: { summaryKey: true },
        });
      expect(current.summaryKey).not.toBe(prior.summaryKey);
      await expect(
        listSummaryClaims(fixture.handle.client, {
          ...fixture.scope,
          canonicalRunId: fixture.accepted.runId,
          limit: 1,
          cursor,
        }),
      ).rejects.toThrow('stale snapshot');
    } finally {
      await fixture.handle.dispose();
    }
  });

  it('rejects a support cursor after summary replacement between pages', async () => {
    const fixture = await readySummaryFixture();
    try {
      const claims = await listSummaryClaims(fixture.handle.client, {
        ...fixture.scope,
        canonicalRunId: fixture.accepted.runId,
        limit: 100,
      });
      const claim = claims!.items.find((item) => item.supportCount > 1)!;
      const page = await listSummarySupports(fixture.handle.client, {
        ...fixture.scope,
        canonicalRunId: fixture.accepted.runId,
        claimKey: claim.claimKey,
        limit: 1,
      });
      expect(page?.nextCursor).not.toBeNull();
      const late = incrementalBatch(fixture.accepted.runId, [
        errorEvent(fixture.accepted.runId, 2, 'support-page-replacement'),
      ]);
      await ingestEvidenceBatch(fixture.handle.client, {
        ...fixture.scope,
        batch: late,
      });
      const intent =
        await fixture.handle.client.processingIntent.findFirstOrThrow({
          where: {
            runId: fixture.runId,
            batch: { canonicalBatchId: late.batchId },
          },
          select: { id: true },
        });
      await processCoreIntent(fixture.handle.client, intent.id, options);
      await processFindingsIntent(
        fixture.handle.client,
        intent.id,
        findingsOptions,
      );
      await processSummaryIntent(
        fixture.handle.client,
        intent.id,
        summaryOptions,
      );
      await expect(
        listSummarySupports(fixture.handle.client, {
          ...fixture.scope,
          canonicalRunId: fixture.accepted.runId,
          claimKey: claim.claimKey,
          limit: 1,
          cursor: page!.nextCursor!,
        }),
      ).rejects.toThrow('stale snapshot');
    } finally {
      await fixture.handle.dispose();
    }
  });

  it('keeps one repeatable-read support page coherent while replacement commits', async () => {
    const fixture = await readySummaryFixture();
    const writer = createDatabaseClient({ connectionString });
    try {
      const claims = await listSummaryClaims(fixture.handle.client, {
        ...fixture.scope,
        canonicalRunId: fixture.accepted.runId,
        limit: 100,
      });
      const claim = claims!.items.find((item) => item.supportCount > 1)!;
      const prior =
        await fixture.handle.client.summaryRunProjection.findUniqueOrThrow({
          where: { runId: fixture.runId },
          select: { summaryKey: true },
        });
      let replacementKey: string | null = null;
      const page = await listSummarySupports(
        fixture.handle.client,
        {
          ...fixture.scope,
          canonicalRunId: fixture.accepted.runId,
          claimKey: claim.claimKey,
          limit: 1,
        },
        {
          afterBaseRead: async () => {
            const late = incrementalBatch(fixture.accepted.runId, [
              errorEvent(
                fixture.accepted.runId,
                2,
                'repeatable-read-support-late',
              ),
            ]);
            await ingestEvidenceBatch(writer.client, {
              ...fixture.scope,
              batch: late,
            });
            const intent =
              await writer.client.processingIntent.findFirstOrThrow({
                where: {
                  runId: fixture.runId,
                  batch: { canonicalBatchId: late.batchId },
                },
                select: { id: true },
              });
            await processCoreIntent(writer.client, intent.id, options);
            await processFindingsIntent(
              writer.client,
              intent.id,
              findingsOptions,
            );
            await processSummaryIntent(
              writer.client,
              intent.id,
              summaryOptions,
            );
            replacementKey = (
              await writer.client.summaryRunProjection.findUniqueOrThrow({
                where: { runId: fixture.runId },
                select: { summaryKey: true },
              })
            ).summaryKey;
          },
        },
      );
      expect(page).toMatchObject({
        summaryAvailability: 'current',
        claimKey: claim.claimKey,
      });
      expect(page?.items).toHaveLength(1);
      expect(page?.nextCursor).not.toBeNull();
      expect(replacementKey).not.toBeNull();
      expect(replacementKey).not.toBe(prior.summaryKey);
      await expect(
        listSummarySupports(fixture.handle.client, {
          ...fixture.scope,
          canonicalRunId: fixture.accepted.runId,
          claimKey: claim.claimKey,
          limit: 1,
          cursor: page!.nextCursor!,
        }),
      ).rejects.toThrow('stale snapshot');
    } finally {
      await Promise.all([fixture.handle.dispose(), writer.dispose()]);
    }
  });

  it('keeps one repeatable-read claim page coherent while replacement commits', async () => {
    const fixture = await readySummaryFixture();
    const writer = createDatabaseClient({ connectionString });
    try {
      let replacementKey: string | null = null;
      const page = await listSummaryClaims(
        fixture.handle.client,
        {
          ...fixture.scope,
          canonicalRunId: fixture.accepted.runId,
          limit: 1,
        },
        {
          afterBaseRead: async () => {
            const late = incrementalBatch(fixture.accepted.runId, [
              errorEvent(fixture.accepted.runId, 2, 'repeatable-read-late'),
            ]);
            await ingestEvidenceBatch(writer.client, {
              ...fixture.scope,
              batch: late,
            });
            const intent =
              await writer.client.processingIntent.findFirstOrThrow({
                where: {
                  runId: fixture.runId,
                  batch: { canonicalBatchId: late.batchId },
                },
                select: { id: true },
              });
            await processCoreIntent(writer.client, intent.id, options);
            await processFindingsIntent(
              writer.client,
              intent.id,
              findingsOptions,
            );
            await processSummaryIntent(
              writer.client,
              intent.id,
              summaryOptions,
            );
            replacementKey = (
              await writer.client.summaryRunProjection.findUniqueOrThrow({
                where: { runId: fixture.runId },
                select: { summaryKey: true },
              })
            ).summaryKey;
          },
        },
      );
      expect(page?.processingState).toBe('ready');
      expect(page?.items).toHaveLength(1);
      expect(replacementKey).not.toBeNull();
      await expect(
        listSummaryClaims(fixture.handle.client, {
          ...fixture.scope,
          canonicalRunId: fixture.accepted.runId,
          limit: 1,
          cursor: page!.nextCursor!,
        }),
      ).rejects.toThrow('stale snapshot');
    } finally {
      await Promise.all([fixture.handle.dispose(), writer.dispose()]);
    }
  });

  it('recovers a failed summary from a later valid intent with the current source', async () => {
    const fixture = await readySummaryFixture();
    try {
      await fixture.handle.client.summaryRunProjection.delete({
        where: { runId: fixture.runId },
      });
      await fixture.handle.client.processingApplicationReceipt.deleteMany({
        where: {
          intentId: fixture.intentId,
          projectorName: 'summary',
        },
      });
      await expect(
        processSummaryIntent(
          fixture.handle.client,
          fixture.intentId,
          { ...summaryOptions, maxAttempts: 1 },
          {
            hooks: {
              afterDependenciesRead: () => {
                throw new Error('exhaust first summary intent');
              },
            },
          },
        ),
      ).resolves.toBe('failed');
      const duplicate = EvidenceBatchSchema.parse({
        ...fixture.accepted,
        batchId: randomUUID(),
        sentAt: '2026-10-01T00:00:04.000Z',
      });
      await ingestEvidenceBatch(fixture.handle.client, {
        ...fixture.scope,
        batch: duplicate,
      });
      const later =
        await fixture.handle.client.processingIntent.findFirstOrThrow({
          where: {
            runId: fixture.runId,
            batch: { canonicalBatchId: duplicate.batchId },
          },
          select: { id: true },
        });
      await processCoreIntent(fixture.handle.client, later.id, options);
      await processFindingsIntent(
        fixture.handle.client,
        later.id,
        findingsOptions,
      );
      await expect(
        processSummaryIntent(fixture.handle.client, later.id, summaryOptions),
      ).resolves.toBe('applied');
    } finally {
      await fixture.handle.dispose();
    }
  });

  it.each([
    ['deadline expiry', false],
    ['cancellation', true],
  ] as const)('rolls back summary publication on %s', async (_name, cancel) => {
    const fixture = await readySummaryFixture();
    const controller = new AbortController();
    try {
      await fixture.handle.client.summaryRunProjection.delete({
        where: { runId: fixture.runId },
      });
      await fixture.handle.client.processingApplicationReceipt.deleteMany({
        where: {
          intentId: fixture.intentId,
          projectorName: 'summary',
        },
      });
      const result = await processSummaryIntent(
        fixture.handle.client,
        fixture.intentId,
        {
          ...summaryOptions,
          leaseSeconds: 1,
          attemptTimeoutMs: 50,
          transitionMarginMs: 50,
          maxAttempts: 1,
        },
        {
          signal: controller.signal,
          hooks: {
            afterDependenciesRead: async () => {
              if (cancel) controller.abort();
              else await new Promise((resolve) => setTimeout(resolve, 75));
            },
          },
        },
      );
      expect(result).toBe('failed');
      expect(
        await fixture.handle.client.summaryRunProjection.count({
          where: { runId: fixture.runId },
        }),
      ).toBe(0);
      expect(
        await fixture.handle.client.processingApplicationReceipt.count({
          where: {
            intentId: fixture.intentId,
            projectorName: 'summary',
          },
        }),
      ).toBe(0);
    } finally {
      await fixture.handle.dispose();
    }
  });

  it('serializes summary publication with a concurrent upstream findings replacement', async () => {
    const fixture = await readySummaryFixture();
    const second = createDatabaseClient({ connectionString });
    try {
      const previous =
        await fixture.handle.client.summaryRunProjection.findUniqueOrThrow({
          where: { runId: fixture.runId },
          select: { summaryKey: true },
        });
      const late = incrementalBatch(fixture.accepted.runId, [
        errorEvent(fixture.accepted.runId, 2, 'concurrent-findings-source'),
      ]);
      await ingestEvidenceBatch(fixture.handle.client, {
        ...fixture.scope,
        batch: late,
      });
      const intent =
        await fixture.handle.client.processingIntent.findFirstOrThrow({
          where: {
            runId: fixture.runId,
            batch: { canonicalBatchId: late.batchId },
          },
          select: { id: true },
        });
      await processCoreIntent(fixture.handle.client, intent.id, options);
      let invalidated!: () => void;
      const atInvalidation = new Promise<void>((resolve) => {
        invalidated = resolve;
      });
      let release!: () => void;
      const continueReplacement = new Promise<void>((resolve) => {
        release = resolve;
      });
      const replacement = processFindingsIntent(
        fixture.handle.client,
        intent.id,
        findingsOptions,
        {
          hooks: {
            afterSummaryInvalidated: async () => {
              invalidated();
              await continueReplacement;
            },
          },
        },
      );
      await atInvalidation;
      const summary = processSummaryIntent(
        second.client,
        intent.id,
        summaryOptions,
      );
      let processing = false;
      for (let attempt = 0; attempt < 50 && !processing; attempt += 1) {
        processing =
          (
            await second.client.runProcessingState.findUnique({
              where: {
                organizationId_runId_projectorName: {
                  organizationId: fixture.scope.organizationId,
                  runId: fixture.runId,
                  projectorName: 'summary',
                },
              },
              select: { state: true },
            })
          )?.state === 'PROCESSING';
        if (!processing)
          await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(processing).toBe(true);
      release();
      await expect(replacement).resolves.toBe('applied');
      await expect(summary).resolves.toBe('applied');
      const current =
        await second.client.summaryRunProjection.findUniqueOrThrow({
          where: { runId: fixture.runId },
          select: { summaryKey: true, findingsFingerprint: true },
        });
      const findings =
        await second.client.findingsRunProjection.findUniqueOrThrow({
          where: { runId: fixture.runId },
          select: { sourceFingerprint: true },
        });
      expect(current.summaryKey).not.toBe(previous.summaryKey);
      expect(current.findingsFingerprint).toBe(findings.sourceFingerprint);
    } finally {
      await Promise.all([fixture.handle.dispose(), second.dispose()]);
    }
  });
});
