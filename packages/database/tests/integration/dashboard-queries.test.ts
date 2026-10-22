import { createHash, randomUUID } from 'node:crypto';

import { EvidenceBatchSchema } from '@blackbox/contracts';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  authorizeArtifactUpload,
  claimArtifactVerification,
  createDatabaseClient,
  finalizeArtifactVerification,
  ingestEvidenceBatch,
  listDashboardRuns,
  listDashboardTimeline,
  resolveDashboardEvidence,
} from '../../src/index.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString)
  throw new Error(
    'TEST_DATABASE_URL is required for database integration tests.',
  );
const configuredSchema = new URL(connectionString).searchParams.get('schema');
let pool: Pool;
const cursorSigningKey = Buffer.alloc(32, 7);

beforeAll(() => {
  pool = new Pool({
    connectionString,
    max: 8,
    options: `-c search_path=${configuredSchema ?? 'public'}`,
  });
});
afterAll(() => pool.end());

async function organization() {
  const organizationId = (
    await pool.query<{ id: string }>(
      'INSERT INTO organizations DEFAULT VALUES RETURNING id',
    )
  ).rows[0]!.id;
  const firstRepositoryId = (
    await pool.query<{ id: string }>(
      'INSERT INTO repositories (organization_id) VALUES ($1) RETURNING id',
      [organizationId],
    )
  ).rows[0]!.id;
  const secondRepositoryId = (
    await pool.query<{ id: string }>(
      'INSERT INTO repositories (organization_id) VALUES ($1) RETURNING id',
      [organizationId],
    )
  ).rows[0]!.id;
  return { organizationId, firstRepositoryId, secondRepositoryId };
}

function runBatch(
  runId = randomUUID(),
  eventIds = [randomUUID(), randomUUID()],
) {
  return EvidenceBatchSchema.parse({
    schemaVersion: 1,
    batchId: randomUUID(),
    runId,
    sentAt: '2026-10-15T10:00:00.000Z',
    events: [
      {
        schemaVersion: 1,
        eventId: eventIds[0],
        runId,
        sequence: 0,
        kind: 'run.started',
        observedAt: '2026-10-15T10:00:00.000Z',
        source: { component: 'collector' },
        payload: { adapter: 'codex-jsonl', provider: 'codex' },
      },
      {
        schemaVersion: 1,
        eventId: eventIds[1],
        runId,
        sequence: 10,
        kind: 'run.finished',
        observedAt: '2026-10-15T10:00:00.000Z',
        source: { component: 'collector' },
        payload: { outcome: 'succeeded', durationMs: 100 },
      },
    ],
  });
}

describe('dashboard tenant-wide run list', () => {
  it('paginates across repositories and binds cursors to filter, tenant, and snapshot', async () => {
    const scope = await organization();
    const foreign = await organization();
    const handle = createDatabaseClient({ connectionString });
    const first = runBatch();
    const second = runBatch();
    await ingestEvidenceBatch(handle.client, {
      organizationId: scope.organizationId,
      repositoryId: scope.firstRepositoryId,
      batch: first,
    });
    await ingestEvidenceBatch(handle.client, {
      organizationId: scope.organizationId,
      repositoryId: scope.secondRepositoryId,
      batch: second,
    });
    await ingestEvidenceBatch(handle.client, {
      organizationId: foreign.organizationId,
      repositoryId: foreign.firstRepositoryId,
      batch: runBatch(),
    });
    await handle.client.run.updateMany({
      where: { organizationId: scope.organizationId },
      data: { createdAt: new Date('2026-10-15T12:00:00.000Z') },
    });

    const expected = [first.runId, second.runId].sort().reverse();
    const page = await listDashboardRuns(handle.client, {
      organizationId: scope.organizationId,
      cursorSigningKey,
      limit: 1,
    });
    expect(page.items.map((item) => item.runId)).toEqual([expected[0]]);
    expect(page.items[0]!.repositoryId).toMatch(
      new RegExp(
        `^(?:${scope.firstRepositoryId}|${scope.secondRepositoryId})$`,
      ),
    );
    expect(page.items[0]!.testCounts).toBeNull();
    expect(page.items[0]!.tokenAggregates).toBeNull();
    const next = await listDashboardRuns(handle.client, {
      organizationId: scope.organizationId,
      cursorSigningKey,
      limit: 1,
      cursor: page.nextCursor!,
    });
    expect(next.items.map((item) => item.runId)).toEqual([expected[1]]);

    const filtered = await listDashboardRuns(handle.client, {
      organizationId: scope.organizationId,
      cursorSigningKey,
      repositoryId: scope.firstRepositoryId,
      limit: 10,
    });
    expect(filtered.items.map((item) => item.repositoryId)).toEqual([
      scope.firstRepositoryId,
    ]);
    await expect(
      listDashboardRuns(handle.client, {
        organizationId: scope.organizationId,
        cursorSigningKey,
        repositoryId: scope.firstRepositoryId,
        limit: 1,
        cursor: page.nextCursor!,
      }),
    ).rejects.toMatchObject({
      code: 'cursor_scope_mismatch',
    });
    await expect(
      listDashboardRuns(handle.client, {
        organizationId: foreign.organizationId,
        cursorSigningKey,
        limit: 1,
        cursor: page.nextCursor!,
      }),
    ).rejects.toMatchObject({
      code: 'cursor_scope_mismatch',
    });
    for (const cursor of ['not+base64url', 'a'.repeat(2_049)])
      await expect(
        listDashboardRuns(handle.client, {
          organizationId: scope.organizationId,
          cursorSigningKey,
          limit: 1,
          cursor,
        }),
      ).rejects.toMatchObject({ code: 'invalid_cursor' });

    await handle.client.run.create({
      data: {
        organizationId: scope.organizationId,
        repositoryId: scope.firstRepositoryId,
        canonicalRunId: randomUUID(),
      },
    });
    await expect(
      listDashboardRuns(handle.client, {
        organizationId: scope.organizationId,
        cursorSigningKey,
        limit: 1,
        cursor: page.nextCursor!,
      }),
    ).rejects.toMatchObject({
      code: 'stale_cursor',
    });
    expect(
      await listDashboardRuns(handle.client, {
        organizationId: randomUUID(),
        cursorSigningKey,
        limit: 10,
      }),
    ).toEqual({ items: [], nextCursor: null });
    await handle.dispose();
  });

  it('keeps concurrent inserts outside the repeatable-read page snapshot', async () => {
    const scope = await organization();
    const reader = createDatabaseClient({ connectionString });
    const writer = createDatabaseClient({ connectionString });
    for (const batch of [runBatch(), runBatch()])
      await ingestEvidenceBatch(reader.client, {
        organizationId: scope.organizationId,
        repositoryId: scope.firstRepositoryId,
        batch,
      });
    const insertedRunId = randomUUID();
    const page = await listDashboardRuns(
      reader.client,
      { organizationId: scope.organizationId, cursorSigningKey, limit: 10 },
      {
        afterBaseRead: async () => {
          await writer.client.run.create({
            data: {
              organizationId: scope.organizationId,
              repositoryId: scope.firstRepositoryId,
              canonicalRunId: insertedRunId,
            },
          });
        },
      },
    );
    expect(page.items).toHaveLength(2);
    expect(page.items.some((item) => item.runId === insertedRunId)).toBe(false);
    expect(
      (
        await listDashboardRuns(reader.client, {
          organizationId: scope.organizationId,
          cursorSigningKey,
          limit: 10,
        })
      ).items,
    ).toHaveLength(3);
    await Promise.all([reader.dispose(), writer.dispose()]);
  });
});

describe('dashboard canonical timeline', () => {
  it('orders by sequence and rejects late lower-sequence evidence under an old cursor', async () => {
    const scope = await organization();
    const handle = createDatabaseClient({ connectionString });
    const accepted = runBatch();
    await ingestEvidenceBatch(handle.client, {
      organizationId: scope.organizationId,
      repositoryId: scope.firstRepositoryId,
      batch: accepted,
    });
    const first = await listDashboardTimeline(handle.client, {
      organizationId: scope.organizationId,
      cursorSigningKey,
      repositoryId: scope.firstRepositoryId,
      canonicalRunId: accepted.runId,
      limit: 1,
    });
    expect(first?.items.map((event) => event.sequence)).toEqual([0]);
    await expect(
      listDashboardTimeline(handle.client, {
        organizationId: scope.organizationId,
        cursorSigningKey,
        repositoryId: scope.secondRepositoryId,
        canonicalRunId: accepted.runId,
        limit: 1,
        cursor: first!.nextCursor!,
      }),
    ).rejects.toMatchObject({ code: 'cursor_scope_mismatch' });
    await ingestEvidenceBatch(handle.client, {
      organizationId: scope.organizationId,
      repositoryId: scope.firstRepositoryId,
      batch: EvidenceBatchSchema.parse({
        schemaVersion: 1,
        batchId: randomUUID(),
        runId: accepted.runId,
        sentAt: '2026-10-15T10:00:01.000Z',
        events: [
          {
            schemaVersion: 1,
            eventId: randomUUID(),
            runId: accepted.runId,
            sequence: 5,
            kind: 'error.observed',
            observedAt: '2026-10-15T10:00:00.000Z',
            source: { component: 'collector' },
            payload: {
              errorId: randomUUID(),
              category: 'agent',
              code: 'dashboard_late_evidence',
              message: { state: 'omitted' },
            },
          },
        ],
      }),
    });
    await expect(
      listDashboardTimeline(handle.client, {
        organizationId: scope.organizationId,
        cursorSigningKey,
        repositoryId: scope.firstRepositoryId,
        canonicalRunId: accepted.runId,
        limit: 1,
        cursor: first!.nextCursor!,
      }),
    ).rejects.toMatchObject({
      code: 'stale_cursor',
    });
    const complete = await listDashboardTimeline(handle.client, {
      organizationId: scope.organizationId,
      cursorSigningKey,
      repositoryId: scope.firstRepositoryId,
      canonicalRunId: accepted.runId,
      limit: 10,
    });
    expect(complete?.items.map((event) => event.sequence)).toEqual([0, 5, 10]);
    expect(new Set(complete?.items.map((event) => event.observedAt))).toEqual(
      new Set(['2026-10-15T10:00:00.000Z']),
    );
    await handle.dispose();
  });

  it('does not admit a concurrent event into an established repeatable-read snapshot', async () => {
    const scope = await organization();
    const reader = createDatabaseClient({ connectionString });
    const writer = createDatabaseClient({ connectionString });
    const accepted = runBatch();
    await ingestEvidenceBatch(reader.client, {
      organizationId: scope.organizationId,
      repositoryId: scope.firstRepositoryId,
      batch: accepted,
    });
    const concurrentId = randomUUID();
    const page = await listDashboardTimeline(
      reader.client,
      {
        organizationId: scope.organizationId,
        cursorSigningKey,
        repositoryId: scope.firstRepositoryId,
        canonicalRunId: accepted.runId,
        limit: 10,
      },
      {
        afterBaseRead: async () => {
          await ingestEvidenceBatch(writer.client, {
            organizationId: scope.organizationId,
            repositoryId: scope.firstRepositoryId,
            batch: EvidenceBatchSchema.parse({
              schemaVersion: 1,
              batchId: randomUUID(),
              runId: accepted.runId,
              sentAt: '2026-10-15T10:00:01.000Z',
              events: [
                {
                  schemaVersion: 1,
                  eventId: concurrentId,
                  runId: accepted.runId,
                  sequence: 4,
                  kind: 'error.observed',
                  observedAt: '2026-10-15T10:00:00.000Z',
                  source: { component: 'collector' },
                  payload: {
                    errorId: randomUUID(),
                    category: 'agent',
                    code: 'dashboard_concurrent_evidence',
                    message: { state: 'omitted' },
                  },
                },
              ],
            }),
          });
        },
      },
    );
    expect(page?.items.map((event) => event.eventId)).not.toContain(
      concurrentId,
    );
    expect(page?.items).toHaveLength(2);
    await Promise.all([reader.dispose(), writer.dispose()]);
  });
});

describe('dashboard evidence resolution', () => {
  it('keeps event lookup tenant/repository/run scoped and exposes canonical data only', async () => {
    const scope = await organization();
    const foreign = await organization();
    const handle = createDatabaseClient({ connectionString });
    const accepted = runBatch();
    await ingestEvidenceBatch(handle.client, {
      organizationId: scope.organizationId,
      repositoryId: scope.firstRepositoryId,
      batch: accepted,
    });
    const locator = {
      kind: 'event' as const,
      eventId: accepted.events[0]!.eventId,
    };
    const resolved = await resolveDashboardEvidence(handle.client, {
      organizationId: scope.organizationId,
      repositoryId: scope.firstRepositoryId,
      canonicalRunId: accepted.runId,
      locator,
    });
    expect(resolved).toMatchObject({
      locatorKind: 'event',
      event: { eventId: locator.eventId, sequence: 0 },
      artifact: null,
    });
    expect(JSON.stringify(resolved)).not.toMatch(
      /objectKey|storage|databaseUrl/,
    );
    for (const wrong of [
      {
        organizationId: foreign.organizationId,
        repositoryId: foreign.firstRepositoryId,
        canonicalRunId: accepted.runId,
      },
      {
        organizationId: scope.organizationId,
        repositoryId: scope.secondRepositoryId,
        canonicalRunId: accepted.runId,
      },
      {
        organizationId: scope.organizationId,
        repositoryId: scope.firstRepositoryId,
        canonicalRunId: randomUUID(),
      },
    ])
      await expect(
        resolveDashboardEvidence(handle.client, { ...wrong, locator }),
      ).resolves.toBeNull();
    await handle.dispose();
  });

  it('requires an exact declared pointer and winning verified upload before preview', async () => {
    const scope = await organization();
    const handle = createDatabaseClient({ connectionString });
    const runId = randomUUID();
    const eventId = randomUUID();
    const artifactId = randomUUID();
    const bytes = Buffer.from('verified evidence');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await ingestEvidenceBatch(handle.client, {
      organizationId: scope.organizationId,
      repositoryId: scope.firstRepositoryId,
      batch: EvidenceBatchSchema.parse({
        schemaVersion: 1,
        batchId: randomUUID(),
        runId,
        sentAt: '2026-10-15T10:00:00.000Z',
        events: [
          {
            schemaVersion: 1,
            eventId,
            runId,
            sequence: 0,
            kind: 'test.run.finished',
            observedAt: '2026-10-15T10:00:00.000Z',
            source: { component: 'test-parser' },
            payload: {
              testRunId: randomUUID(),
              framework: 'vitest',
              outcome: 'passed',
              reportArtifact: {
                artifactId,
                kind: 'test-report',
                mediaType: 'text/plain',
                byteLength: bytes.length,
                sha256,
                redaction: { applied: false },
                characterEncoding: 'utf-8',
              },
            },
          },
        ],
      }),
    });
    const locator = {
      kind: 'artifact' as const,
      eventId,
      artifactId,
      eventArtifactPointer: '/payload/reportArtifact',
    };
    const before = await resolveDashboardEvidence(handle.client, {
      organizationId: scope.organizationId,
      repositoryId: scope.firstRepositoryId,
      canonicalRunId: runId,
      locator,
    });
    expect(before?.artifact?.preview).toEqual({
      state: 'unavailable',
      reason: 'artifact_not_verified',
    });

    const now = new Date();
    const authorization = await authorizeArtifactUpload(
      handle.client,
      {
        organizationId: scope.organizationId,
        repositoryId: scope.firstRepositoryId,
        artifactId,
        now,
        maximumBytes: 1_000n,
      },
      async (target) => ({
        expiresAt: new Date(now.getTime() + 60_000),
        value: target,
      }),
    );
    const claim = await claimArtifactVerification(handle.client, {
      organizationId: scope.organizationId,
      repositoryId: scope.firstRepositoryId,
      artifactId,
      uploadId: authorization.attempt.id,
      leaseDurationMs: 60_000,
    });
    if (claim.outcome !== 'claimed') throw new Error('Expected claim.');
    await finalizeArtifactVerification(handle.client, {
      uploadId: authorization.attempt.id,
      leaseId: claim.leaseId,
      byteLength: BigInt(bytes.length),
      sha256,
      verifiedAt: new Date(),
    });
    const preview = vi.fn(async () => ({
      state: 'available' as const,
      mediaType: 'text/plain' as const,
      text: bytes.toString('utf8'),
      byteLength: bytes.length,
    }));
    const resolved = await resolveDashboardEvidence(
      handle.client,
      {
        organizationId: scope.organizationId,
        repositoryId: scope.firstRepositoryId,
        canonicalRunId: runId,
        locator,
      },
      preview,
    );
    expect(preview).toHaveBeenCalledWith(
      expect.objectContaining({
        objectKey: authorization.attempt.objectKey,
        expectedBytes: bytes.length,
        expectedSha256: sha256,
      }),
      undefined,
    );
    expect(resolved?.artifact?.preview).toMatchObject({ state: 'available' });
    expect(JSON.stringify(resolved)).not.toContain(
      authorization.attempt.objectKey,
    );
    await expect(
      resolveDashboardEvidence(handle.client, {
        organizationId: scope.organizationId,
        repositoryId: scope.firstRepositoryId,
        canonicalRunId: runId,
        locator: {
          ...locator,
          eventArtifactPointer: '/payload/not-the-declared-pointer',
        },
      }),
    ).resolves.toBeNull();
    await expect(
      resolveDashboardEvidence(handle.client, {
        organizationId: scope.organizationId,
        repositoryId: scope.firstRepositoryId,
        canonicalRunId: runId,
        locator: { ...locator, artifactId: randomUUID() },
      }),
    ).resolves.toBeNull();
    await expect(
      resolveDashboardEvidence(handle.client, {
        organizationId: scope.organizationId,
        repositoryId: scope.firstRepositoryId,
        canonicalRunId: runId,
        locator: { kind: 'artifact', eventId, artifactId } as never,
      }),
    ).rejects.toMatchObject({
      code: 'invalid_locator',
    });
    await expect(
      resolveDashboardEvidence(handle.client, {
        organizationId: scope.organizationId,
        repositoryId: scope.firstRepositoryId,
        canonicalRunId: runId,
        locator: {
          kind: 'event',
          eventId: 'x'.repeat(10_000),
        },
      }),
    ).rejects.toMatchObject({ code: 'invalid_locator' });
    await handle.dispose();
  });
});
