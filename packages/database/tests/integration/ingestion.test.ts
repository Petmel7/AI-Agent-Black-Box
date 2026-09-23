import { randomUUID } from 'node:crypto';

import { EvidenceBatchSchema, type EvidenceBatch } from '@blackbox/contracts';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createDatabaseClient,
  EvidenceConflictError,
  ingestEvidenceBatch,
  RepositoryNotFoundError,
} from '../../src/index.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString)
  throw new Error(
    'TEST_DATABASE_URL is required for database integration tests.',
  );

const configuredSchema = new URL(connectionString).searchParams.get('schema');
let pool: Pool;

function makeBatch(
  options: {
    batchId?: string;
    runId?: string;
    eventId?: string;
    sequence?: number;
    artifactId?: string;
    artifactHash?: string;
  } = {},
): EvidenceBatch {
  const runId = options.runId ?? randomUUID();
  const artifact = {
    artifactId: options.artifactId ?? randomUUID(),
    kind: 'test-report',
    mediaType: 'application/json',
    byteLength: 2,
    sha256: options.artifactHash ?? 'a'.repeat(64),
    redaction: { applied: false },
    characterEncoding: 'utf-8',
  } as const;
  return EvidenceBatchSchema.parse({
    schemaVersion: 1,
    batchId: options.batchId ?? randomUUID(),
    runId,
    sentAt: '2026-09-23T12:00:00.000Z',
    events: [
      {
        schemaVersion: 1,
        eventId: options.eventId ?? randomUUID(),
        runId,
        sequence: options.sequence ?? 0,
        kind: 'test.run.finished',
        observedAt: '2026-09-23T12:00:00.000Z',
        source: { component: 'collector' },
        payload: {
          testRunId: randomUUID(),
          framework: 'vitest',
          outcome: 'passed',
          reportArtifact: artifact,
        },
      },
    ],
  });
}

async function seedRepository(organizationId?: string) {
  const organization =
    organizationId ??
    (
      await pool.query<{ id: string }>(
        'INSERT INTO organizations DEFAULT VALUES RETURNING id',
      )
    ).rows[0]!.id;
  const repository = (
    await pool.query<{ id: string }>(
      'INSERT INTO repositories (organization_id) VALUES ($1) RETURNING id',
      [organization],
    )
  ).rows[0]!.id;
  return { organizationId: organization, repositoryId: repository };
}

async function counts(organizationId: string) {
  const result = await pool.query<Record<string, string>>(
    `
    SELECT
      (SELECT count(*) FROM runs WHERE organization_id = $1) AS runs,
      (SELECT count(*) FROM evidence_batches WHERE organization_id = $1) AS batches,
      (SELECT count(*) FROM evidence_events WHERE organization_id = $1) AS events,
      (SELECT count(*) FROM evidence_batch_events WHERE organization_id = $1) AS memberships,
      (SELECT count(*) FROM artifact_declarations WHERE organization_id = $1) AS artifacts,
      (SELECT count(*) FROM evidence_event_artifacts WHERE organization_id = $1) AS links,
      (SELECT count(*) FROM processing_intents WHERE organization_id = $1) AS intents
  `,
    [organizationId],
  );
  return result.rows[0]!;
}

beforeAll(() => {
  pool = new Pool({
    connectionString,
    max: 4,
    options: `-c search_path=${configuredSchema ?? 'public'}`,
  });
});
afterAll(() => pool.end());

describe('idempotent ingestion transaction', () => {
  it('has the processing-intent migration and durable constraints deployed', async () => {
    const migration = await pool.query(
      `SELECT 1 FROM _prisma_migrations WHERE migration_name = '20260923120000_processing_intents' AND finished_at IS NOT NULL`,
    );
    expect(migration.rows).toHaveLength(1);
    const invalid = await seedRepository();
    await expect(
      pool.query(
        `INSERT INTO processing_intents (organization_id, run_id, batch_id, kind, attempt_count) VALUES ($1, gen_random_uuid(), gen_random_uuid(), 'evidence_batch.accepted', -1)`,
        [invalid.organizationId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('persists the complete graph and returns the original receipt on an exact retry', async () => {
    const seed = await seedRepository();
    const batch = makeBatch();
    const handle = createDatabaseClient({ connectionString });
    const first = await ingestEvidenceBatch(handle.client, { ...seed, batch });
    const beforeRetry = await counts(seed.organizationId);
    const retry = await ingestEvidenceBatch(handle.client, {
      ...seed,
      batch: JSON.parse(JSON.stringify(batch)) as EvidenceBatch,
    });
    expect(first.outcome).toBe('accepted');
    expect(retry).toMatchObject({
      outcome: 'already_accepted',
      batchId: batch.batchId,
      runId: batch.runId,
    });
    expect(retry.receivedAt).toEqual(first.receivedAt);
    expect(await counts(seed.organizationId)).toEqual(beforeRetry);
    expect(beforeRetry).toEqual({
      runs: '1',
      batches: '1',
      events: '1',
      memberships: '1',
      artifacts: '1',
      links: '1',
      intents: '1',
    });
    await handle.dispose();
  });

  it('reuses identical events and artifacts in a later batch without duplicating raw records', async () => {
    const seed = await seedRepository();
    const first = makeBatch();
    const second = EvidenceBatchSchema.parse({
      ...first,
      batchId: randomUUID(),
      sentAt: '2026-09-23T12:01:00.000Z',
    });
    const handle = createDatabaseClient({ connectionString });
    await ingestEvidenceBatch(handle.client, { ...seed, batch: first });
    await ingestEvidenceBatch(handle.client, { ...seed, batch: second });
    expect(await counts(seed.organizationId)).toEqual({
      runs: '1',
      batches: '2',
      events: '1',
      memberships: '2',
      artifacts: '1',
      links: '1',
      intents: '2',
    });
    await handle.dispose();
  });

  it('rejects batch, event, sequence, artifact, and run/repository identity conflicts atomically', async () => {
    const seed = await seedRepository();
    const otherRepository = await seedRepository(seed.organizationId);
    const original = makeBatch();
    const handle = createDatabaseClient({ connectionString });
    await ingestEvidenceBatch(handle.client, { ...seed, batch: original });
    const originalCounts = await counts(seed.organizationId);
    const originalEvent = original.events[0]!;
    if (
      originalEvent.kind !== 'test.run.finished' ||
      !originalEvent.payload.reportArtifact
    ) {
      throw new Error('Test fixture must contain a report artifact.');
    }
    const originalArtifact = originalEvent.payload.reportArtifact;
    const conflicts = [
      makeBatch({ batchId: original.batchId, runId: original.runId }),
      makeBatch({
        runId: original.runId,
        eventId: originalEvent.eventId,
        sequence: 1,
      }),
      makeBatch({ runId: original.runId, sequence: originalEvent.sequence }),
      makeBatch({
        runId: original.runId,
        sequence: 2,
        artifactId: originalArtifact.artifactId,
        artifactHash: 'b'.repeat(64),
      }),
    ];
    for (const batch of conflicts) {
      await expect(
        ingestEvidenceBatch(handle.client, { ...seed, batch }),
      ).rejects.toBeInstanceOf(EvidenceConflictError);
      expect(await counts(seed.organizationId)).toEqual(originalCounts);
    }
    await expect(
      ingestEvidenceBatch(handle.client, {
        organizationId: seed.organizationId,
        repositoryId: otherRepository.repositoryId,
        batch: EvidenceBatchSchema.parse({
          ...original,
          batchId: randomUUID(),
        }),
      }),
    ).rejects.toBeInstanceOf(EvidenceConflictError);
    expect(await counts(seed.organizationId)).toEqual(originalCounts);
    await handle.dispose();
  });

  it.each(['beforeIntent', 'beforeCommit'] as const)(
    'rolls back an injected failure %s',
    async (hook) => {
      const seed = await seedRepository();
      const handle = createDatabaseClient({ connectionString });
      await expect(
        ingestEvidenceBatch(
          handle.client,
          { ...seed, batch: makeBatch() },
          {
            [hook]: () => {
              throw new Error('injected');
            },
          },
        ),
      ).rejects.toThrow('injected');
      expect(await counts(seed.organizationId)).toEqual({
        runs: '0',
        batches: '0',
        events: '0',
        memberships: '0',
        artifacts: '0',
        links: '0',
        intents: '0',
      });
      await handle.dispose();
    },
  );

  it('converges concurrent identical requests and gives conflicting requests one winner', async () => {
    const seed = await seedRepository();
    const left = createDatabaseClient({ connectionString });
    const right = createDatabaseClient({ connectionString });
    const identical = makeBatch();
    const identicalResults = await Promise.all([
      ingestEvidenceBatch(left.client, { ...seed, batch: identical }),
      ingestEvidenceBatch(right.client, { ...seed, batch: identical }),
    ]);
    expect(identicalResults.map((result) => result.outcome).sort()).toEqual([
      'accepted',
      'already_accepted',
    ]);

    const batchId = randomUUID();
    const competing = await Promise.allSettled([
      ingestEvidenceBatch(left.client, {
        ...seed,
        batch: makeBatch({ batchId }),
      }),
      ingestEvidenceBatch(right.client, {
        ...seed,
        batch: makeBatch({ batchId }),
      }),
    ]);
    expect(
      competing.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = competing.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({
      reason: expect.any(EvidenceConflictError),
    });
    await Promise.all([left.dispose(), right.dispose()]);
  });

  it('accepts concurrent disjoint batches that create the same run and preserves its repository binding', async () => {
    const seed = await seedRepository();
    const canonicalRunId = randomUUID();
    const left = createDatabaseClient({ connectionString });
    const right = createDatabaseClient({ connectionString });
    let arrivals = 0;
    let releaseRunCreation!: () => void;
    const runCreationGate = new Promise<void>((resolve) => {
      releaseRunCreation = resolve;
    });
    const synchronizeRunCreation = async () => {
      arrivals += 1;
      if (arrivals === 2) releaseRunCreation();
      await runCreationGate;
    };
    const results = await Promise.all([
      ingestEvidenceBatch(
        left.client,
        {
          ...seed,
          batch: makeBatch({ runId: canonicalRunId, sequence: 0 }),
        },
        { beforeRunCreate: synchronizeRunCreation },
      ),
      ingestEvidenceBatch(
        right.client,
        {
          ...seed,
          batch: makeBatch({ runId: canonicalRunId, sequence: 1 }),
        },
        { beforeRunCreate: synchronizeRunCreation },
      ),
    ]);
    expect(arrivals).toBe(2);
    expect(results.map((result) => result.outcome)).toEqual([
      'accepted',
      'accepted',
    ]);
    expect(await counts(seed.organizationId)).toEqual({
      runs: '1',
      batches: '2',
      events: '2',
      memberships: '2',
      artifacts: '2',
      links: '2',
      intents: '2',
    });

    const otherRepository = await seedRepository(seed.organizationId);
    await expect(
      ingestEvidenceBatch(left.client, {
        organizationId: seed.organizationId,
        repositoryId: otherRepository.repositoryId,
        batch: makeBatch({ runId: canonicalRunId, sequence: 2 }),
      }),
    ).rejects.toBeInstanceOf(EvidenceConflictError);
    expect(await counts(seed.organizationId)).toEqual({
      runs: '1',
      batches: '2',
      events: '2',
      memberships: '2',
      artifacts: '2',
      links: '2',
      intents: '2',
    });
    await Promise.all([left.dispose(), right.dispose()]);
  });

  it('hides repositories outside the authenticated organization', async () => {
    const own = await seedRepository();
    const foreign = await seedRepository();
    const handle = createDatabaseClient({ connectionString });
    await expect(
      ingestEvidenceBatch(handle.client, {
        organizationId: own.organizationId,
        repositoryId: foreign.repositoryId,
        batch: makeBatch(),
      }),
    ).rejects.toBeInstanceOf(RepositoryNotFoundError);
    await handle.dispose();
  });
});
