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
  processCoreIntent,
  relayProcessingCycle,
  replayCoreIntent,
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

describe('processing migration and core persistence', () => {
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
});
