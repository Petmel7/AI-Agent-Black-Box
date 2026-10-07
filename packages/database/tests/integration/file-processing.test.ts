import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { EvidenceBatchSchema } from '@blackbox/contracts';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  authorizeArtifactUpload,
  claimArtifactVerification,
  createDatabaseClient,
  FileProcessingError,
  finalizeArtifactVerification,
  getCoreRunDetail,
  ingestEvidenceBatch,
  listFindings,
  listCoreRuns,
  listFileChanges,
  processCoreIntent,
  processFilesIntent,
  processFindingsIntent,
  replayFilesIntent,
} from '../../src/index.js';
import { inspectFileSourceSnapshot } from '../../src/file-processing.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString)
  throw new Error(
    'TEST_DATABASE_URL is required for database integration tests.',
  );
const configuredSchema = new URL(connectionString).searchParams.get('schema');
let pool: Pool;

beforeAll(() => {
  pool = new Pool({
    connectionString,
    max: 8,
    options: `-c search_path=${configuredSchema ?? 'public'}`,
  });
});
afterAll(() => pool.end());

const fileOptions = {
  maxArtifacts: 20,
  maxCumulativeBytes: 20_000_000,
  maxEntries: 100,
  maxProjectedRows: 100,
  storageConcurrency: 4,
  leaseSeconds: 10,
  attemptTimeoutMs: 2_000,
  transitionMarginMs: 100,
  maxAttempts: 2,
  retryBaseSeconds: 1,
  retryMaxSeconds: 1,
};
const coreOptions = {
  leaseSeconds: 10,
  attemptTimeoutMs: 2_000,
  transitionMarginMs: 100,
  maxAttempts: 2,
  retryBaseSeconds: 1,
  retryMaxSeconds: 1,
  eventPageSize: 100,
  maxEvents: 100,
  maxProjectedChildren: 1_000,
};
const findingsOptions = {
  leaseSeconds: 10,
  attemptTimeoutMs: 2_000,
  transitionMarginMs: 100,
  maxAttempts: 2,
  retryBaseSeconds: 1,
  retryMaxSeconds: 1,
};

async function repository() {
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
  return { organizationId, repositoryId, runId: randomUUID() };
}

async function addVerifiedFileSource(
  handle: ReturnType<typeof createDatabaseClient>,
  scope: Awaited<ReturnType<typeof repository>>,
  sequence: number,
  path: string | string[],
) {
  const diffId = randomUUID();
  const fromSnapshotId = randomUUID();
  const toSnapshotId = randomUUID();
  const artifactId = randomUUID();
  const bytes = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      diffId,
      fromSnapshotId,
      toSnapshotId,
      attributionIsTemporalNotCausal: true,
      files: (Array.isArray(path) ? path : [path]).map((displayPath) => ({
        entryId: createHash('sha256').update(displayPath).digest('hex'),
        path: displayPath,
        attribution: 'observed-during-run',
        before: null,
        after: {
          entryId: createHash('sha256').update(displayPath).digest('hex'),
          path: displayPath,
          kind: 'untracked',
          indexStatus: '?',
          worktreeStatus: '?',
          submodule: 'N...',
        },
      })),
    }),
  );
  const reference = {
    artifactId,
    kind: 'git-file-list',
    mediaType: 'application/json',
    byteLength: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    redaction: { applied: false },
    characterEncoding: 'utf-8',
  } as const;
  await ingestEvidenceBatch(handle.client, {
    organizationId: scope.organizationId,
    repositoryId: scope.repositoryId,
    batch: EvidenceBatchSchema.parse({
      schemaVersion: 1,
      batchId: randomUUID(),
      runId: scope.runId,
      sentAt: new Date().toISOString(),
      events: [
        {
          schemaVersion: 1,
          eventId: randomUUID(),
          runId: scope.runId,
          sequence,
          kind: 'git.diff.captured',
          observedAt: new Date().toISOString(),
          source: { component: 'git' },
          payload: {
            diffId,
            fromSnapshotId,
            toSnapshotId,
            diffArtifact: {
              ...reference,
              artifactId: randomUUID(),
              kind: 'git-diff',
            },
            fileListArtifact: reference,
          },
        },
      ],
    }),
  });
  const now = new Date();
  const authorized = await authorizeArtifactUpload(
    handle.client,
    {
      organizationId: scope.organizationId,
      repositoryId: scope.repositoryId,
      artifactId,
      now,
      maximumBytes: 20_000_000n,
    },
    async (target) => ({
      expiresAt: new Date(now.getTime() + 60_000),
      value: target,
    }),
  );
  const claim = await claimArtifactVerification(handle.client, {
    organizationId: scope.organizationId,
    repositoryId: scope.repositoryId,
    artifactId,
    uploadId: authorized.attempt.id,
    leaseDurationMs: 60_000,
  });
  if (claim.outcome !== 'claimed') throw new Error('Expected artifact claim.');
  await finalizeArtifactVerification(handle.client, {
    uploadId: authorized.attempt.id,
    leaseId: claim.leaseId,
    byteLength: BigInt(bytes.length),
    sha256: reference.sha256,
    verifiedAt: new Date(),
  });
  const intent = await handle.client.processingIntent.findFirstOrThrow({
    where: { artifactDeclarationId: claim.declaration.id },
    select: { id: true },
  });
  return {
    bytes,
    objectKey: authorized.attempt.objectKey,
    intentId: intent.id,
  };
}

async function addUnverifiedFileSource(
  handle: ReturnType<typeof createDatabaseClient>,
  scope: Awaited<ReturnType<typeof repository>>,
  sequence: number,
) {
  const diffId = randomUUID();
  const fromSnapshotId = randomUUID();
  const toSnapshotId = randomUUID();
  const bytes = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      diffId,
      fromSnapshotId,
      toSnapshotId,
      attributionIsTemporalNotCausal: true,
      files: [],
    }),
  );
  const reference = {
    artifactId: randomUUID(),
    kind: 'git-file-list',
    mediaType: 'application/json',
    byteLength: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    redaction: { applied: false },
    characterEncoding: 'utf-8',
  } as const;
  await ingestEvidenceBatch(handle.client, {
    organizationId: scope.organizationId,
    repositoryId: scope.repositoryId,
    batch: EvidenceBatchSchema.parse({
      schemaVersion: 1,
      batchId: randomUUID(),
      runId: scope.runId,
      sentAt: new Date().toISOString(),
      events: [
        {
          schemaVersion: 1,
          eventId: randomUUID(),
          runId: scope.runId,
          sequence,
          kind: 'git.diff.captured',
          observedAt: new Date().toISOString(),
          source: { component: 'git' },
          payload: {
            diffId,
            fromSnapshotId,
            toSnapshotId,
            diffArtifact: {
              ...reference,
              artifactId: randomUUID(),
              kind: 'git-diff',
            },
            fileListArtifact: reference,
          },
        },
      ],
    }),
  });
}

async function addClaimedNonFileArtifact(
  handle: ReturnType<typeof createDatabaseClient>,
  scope: Awaited<ReturnType<typeof repository>>,
  sequence: number,
) {
  const bytes = Buffer.from('report');
  const artifactId = randomUUID();
  await ingestEvidenceBatch(handle.client, {
    organizationId: scope.organizationId,
    repositoryId: scope.repositoryId,
    batch: EvidenceBatchSchema.parse({
      schemaVersion: 1,
      batchId: randomUUID(),
      runId: scope.runId,
      sentAt: new Date().toISOString(),
      events: [
        {
          schemaVersion: 1,
          eventId: randomUUID(),
          runId: scope.runId,
          sequence,
          kind: 'test.run.finished',
          observedAt: new Date().toISOString(),
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
              sha256: createHash('sha256').update(bytes).digest('hex'),
              redaction: { applied: false },
              characterEncoding: 'utf-8',
            },
          },
        },
      ],
    }),
  });
  const now = new Date();
  const authorization = await authorizeArtifactUpload(
    handle.client,
    {
      organizationId: scope.organizationId,
      repositoryId: scope.repositoryId,
      artifactId,
      now,
      maximumBytes: 20_000_000n,
    },
    async (target) => ({
      expiresAt: new Date(now.getTime() + 60_000),
      value: target,
    }),
  );
  const claim = await claimArtifactVerification(handle.client, {
    organizationId: scope.organizationId,
    repositoryId: scope.repositoryId,
    artifactId,
    uploadId: authorization.attempt.id,
    leaseDurationMs: 60_000,
  });
  if (claim.outcome !== 'claimed') throw new Error('Expected artifact claim.');
  return { bytes, authorization, claim };
}

const readerFor = (sources: Array<{ objectKey: string; bytes: Buffer }>) => {
  const values = new Map(
    sources.map((source) => [source.objectKey, source.bytes]),
  );
  return vi.fn(async ({ objectKey }: { objectKey: string }) => {
    const value = values.get(objectKey);
    if (!value) throw new Error('unexpected object key');
    return value;
  });
};

describe('files projector PostgreSQL lifecycle', () => {
  it('holds ingestion and verification behind the publisher run lock through commit', async () => {
    const scope = await repository();
    const publisher = createDatabaseClient({ connectionString });
    const ingester = createDatabaseClient({ connectionString });
    const verifier = createDatabaseClient({ connectionString });
    const first = await addVerifiedFileSource(publisher, scope, 0, 'one.txt');
    await processFilesIntent(
      publisher.client,
      first.intentId,
      readerFor([first]),
      fileOptions,
    );
    const second = await addVerifiedFileSource(publisher, scope, 1, 'two.txt');
    const nonFile = await addClaimedNonFileArtifact(publisher, scope, 2);
    let release!: () => void;
    let publisherLocked!: () => void;
    const locked = new Promise<void>((resolve) => (publisherLocked = resolve));
    const resume = new Promise<void>((resolve) => (release = resolve));
    const publication = processFilesIntent(
      publisher.client,
      second.intentId,
      readerFor([first, second]),
      fileOptions,
      {
        hooks: {
          afterRunSourceLock: async () => {
            publisherLocked();
            await resume;
          },
        },
      },
    );
    await locked;
    let ingestionOwnedLock = false;
    let verificationOwnedLock = false;
    let ingestionWaiting!: () => void;
    let verificationWaiting!: () => void;
    const ingestionStarted = new Promise<void>(
      (resolve) => (ingestionWaiting = resolve),
    );
    const verificationStarted = new Promise<void>(
      (resolve) => (verificationWaiting = resolve),
    );
    const ingestion = ingestEvidenceBatch(
      ingester.client,
      {
        organizationId: scope.organizationId,
        repositoryId: scope.repositoryId,
        batch: EvidenceBatchSchema.parse({
          schemaVersion: 1,
          batchId: randomUUID(),
          runId: scope.runId,
          sentAt: new Date().toISOString(),
          events: [
            {
              schemaVersion: 1,
              eventId: randomUUID(),
              runId: scope.runId,
              sequence: 3,
              kind: 'test.run.finished',
              observedAt: new Date().toISOString(),
              source: { component: 'test-parser' },
              payload: {
                testRunId: randomUUID(),
                framework: 'vitest',
                outcome: 'passed',
              },
            },
          ],
        }),
      },
      {
        beforeRunSourceLock: ingestionWaiting,
        afterRunSourceLock: () => {
          ingestionOwnedLock = true;
        },
      },
    );
    const verification = finalizeArtifactVerification(
      verifier.client,
      {
        uploadId: nonFile.authorization.attempt.id,
        leaseId: nonFile.claim.leaseId,
        byteLength: BigInt(nonFile.bytes.length),
        sha256: createHash('sha256').update(nonFile.bytes).digest('hex'),
        verifiedAt: new Date(),
      },
      {
        beforeRunSourceLock: verificationWaiting,
        afterRunSourceLock: () => {
          verificationOwnedLock = true;
        },
      },
    );
    await Promise.all([ingestionStarted, verificationStarted]);
    await delay(50);
    expect({ ingestionOwnedLock, verificationOwnedLock }).toEqual({
      ingestionOwnedLock: false,
      verificationOwnedLock: false,
    });
    release();
    await expect(publication).resolves.toBe('applied');
    await expect(Promise.all([ingestion, verification])).resolves.toHaveLength(
      2,
    );
    expect({ ingestionOwnedLock, verificationOwnedLock }).toEqual({
      ingestionOwnedLock: true,
      verificationOwnedLock: true,
    });
    await Promise.all([
      publisher.dispose(),
      ingester.dispose(),
      verifier.dispose(),
    ]);
  });

  it('serializes same-run consumers and gives different intents receipts without rewriting equal projections', async () => {
    const scope = await repository();
    const firstClient = createDatabaseClient({ connectionString });
    const secondClient = createDatabaseClient({ connectionString });
    const first = await addVerifiedFileSource(firstClient, scope, 0, 'one.txt');
    const second = await addVerifiedFileSource(
      firstClient,
      scope,
      1,
      'two.txt',
    );
    let release!: () => void;
    let reached!: () => void;
    const paused = new Promise<void>((resolve) => (reached = resolve));
    const resume = new Promise<void>((resolve) => (release = resolve));
    const active = processFilesIntent(
      firstClient.client,
      first.intentId,
      readerFor([first, second]),
      fileOptions,
      {
        hooks: {
          beforePublish: async () => {
            reached();
            await resume;
          },
        },
      },
    );
    await paused;
    await expect(
      processFilesIntent(
        secondClient.client,
        second.intentId,
        readerFor([first, second]),
        fileOptions,
      ),
    ).resolves.toBe('busy');
    release();
    await expect(active).resolves.toBe('applied');
    const run = await firstClient.client.run.findFirstOrThrow({
      where: {
        organizationId: scope.organizationId,
        canonicalRunId: scope.runId,
      },
      select: { id: true },
    });
    const before = await firstClient.client.fileRunProjection.findUniqueOrThrow(
      {
        where: { runId: run.id },
        select: { updatedAt: true },
      },
    );
    const rowIds = (
      await firstClient.client.fileChangeProjection.findMany({
        where: { runId: run.id },
        orderBy: [{ sourceSequence: 'asc' }, { ordinal: 'asc' }],
        select: { id: true },
      })
    ).map(({ id }) => id);
    await expect(
      processFilesIntent(
        secondClient.client,
        second.intentId,
        readerFor([first, second]),
        fileOptions,
      ),
    ).resolves.toBe('already_applied');
    expect(
      await firstClient.client.fileRunProjection.findUniqueOrThrow({
        where: { runId: run.id },
        select: { updatedAt: true },
      }),
    ).toEqual(before);
    expect(
      (
        await firstClient.client.fileChangeProjection.findMany({
          where: { runId: run.id },
          orderBy: [{ sourceSequence: 'asc' }, { ordinal: 'asc' }],
          select: { id: true },
        })
      ).map(({ id }) => id),
    ).toEqual(rowIds);
    expect(
      await firstClient.client.processingApplicationReceipt.count({
        where: { runId: run.id, projectorName: 'files' },
      }),
    ).toBe(2);
    await Promise.all([firstClient.dispose(), secondClient.dispose()]);
  });

  it('returns already_applied for the exact same intent without storage or projection mutation', async () => {
    const scope = await repository();
    const handle = createDatabaseClient({ connectionString });
    const source = await addVerifiedFileSource(handle, scope, 0, [
      'one.txt',
      'two.txt',
    ]);
    await expect(
      processFilesIntent(
        handle.client,
        source.intentId,
        readerFor([source]),
        fileOptions,
      ),
    ).resolves.toBe('applied');
    const run = await handle.client.run.findFirstOrThrow({
      where: {
        organizationId: scope.organizationId,
        canonicalRunId: scope.runId,
      },
      select: { id: true },
    });
    const [beforeReceiptCount, beforeProjection, beforeRows] =
      await Promise.all([
        handle.client.processingApplicationReceipt.count({
          where: { intentId: source.intentId, projectorName: 'files' },
        }),
        handle.client.fileRunProjection.findUniqueOrThrow({
          where: { runId: run.id },
          select: { updatedAt: true, sourceFingerprint: true },
        }),
        handle.client.fileChangeProjection.findMany({
          where: { runId: run.id },
          orderBy: [{ sourceSequence: 'asc' }, { ordinal: 'asc' }],
        }),
      ]);
    expect(beforeReceiptCount).toBe(1);
    const unexpectedReader = vi.fn(async () => {
      throw new Error('same-intent replay must not read artifact storage');
    });
    await expect(
      processFilesIntent(
        handle.client,
        source.intentId,
        unexpectedReader,
        fileOptions,
      ),
    ).resolves.toBe('already_applied');
    expect(unexpectedReader).not.toHaveBeenCalled();
    const [afterReceiptCount, afterProjection, afterRows] = await Promise.all([
      handle.client.processingApplicationReceipt.count({
        where: { intentId: source.intentId, projectorName: 'files' },
      }),
      handle.client.fileRunProjection.findUniqueOrThrow({
        where: { runId: run.id },
        select: { updatedAt: true, sourceFingerprint: true },
      }),
      handle.client.fileChangeProjection.findMany({
        where: { runId: run.id },
        orderBy: [{ sourceSequence: 'asc' }, { ordinal: 'asc' }],
      }),
    ]);
    expect(afterReceiptCount).toBe(beforeReceiptCount);
    expect(afterProjection).toEqual(beforeProjection);
    expect(afterRows).toEqual(beforeRows);
    await handle.dispose();
  });

  it('persists fingerprint-scoped exhaustion and recovers only through explicit replay', async () => {
    const scope = await repository();
    const handle = createDatabaseClient({ connectionString });
    const contender = createDatabaseClient({ connectionString });
    const source = await addVerifiedFileSource(handle, scope, 0, 'one.txt');
    const outage = vi.fn(async () => {
      throw new FileProcessingError('artifact_provider_unavailable', true);
    });
    await expect(
      processFilesIntent(handle.client, source.intentId, outage, fileOptions),
    ).rejects.toMatchObject({ code: 'artifact_provider_unavailable' });
    await expect(
      processFilesIntent(handle.client, source.intentId, outage, fileOptions),
    ).resolves.toBe('busy');
    await pool.query(
      "UPDATE run_processing_states SET available_at = clock_timestamp() WHERE projector_name = 'files' AND organization_id = $1",
      [scope.organizationId],
    );
    await expect(
      processFilesIntent(handle.client, source.intentId, outage, fileOptions),
    ).resolves.toBe('failed');
    const failure =
      await handle.client.processingAttemptFailure.findFirstOrThrow({
        where: { intentId: source.intentId, projectorName: 'files' },
      });
    expect(failure).toMatchObject({
      attemptCount: 2,
      errorCode: 'artifact_provider_unavailable',
    });
    expect(failure.sourceFingerprint).toMatch(/^[0-9a-f]{64}$/);
    await expect(
      listFileChanges(handle.client, {
        organizationId: scope.organizationId,
        repositoryId: scope.repositoryId,
        canonicalRunId: scope.runId,
        limit: 10,
      }),
    ).resolves.toMatchObject({ processingState: 'failed', items: [] });
    await expect(
      processFilesIntent(
        handle.client,
        source.intentId,
        readerFor([source]),
        fileOptions,
      ),
    ).resolves.toBe('failed');
    let releaseReplay!: () => void;
    let replayOwned!: () => void;
    const replayPaused = new Promise<void>(
      (resolve) => (replayOwned = resolve),
    );
    const resumeReplay = new Promise<void>(
      (resolve) => (releaseReplay = resolve),
    );
    const replay = replayFilesIntent(
      handle.client,
      source.intentId,
      readerFor([source]),
      fileOptions,
      {
        hooks: {
          beforePublish: async () => {
            replayOwned();
            await resumeReplay;
          },
        },
      },
    );
    await replayPaused;
    await expect(
      processFilesIntent(
        contender.client,
        source.intentId,
        readerFor([source]),
        fileOptions,
      ),
    ).resolves.toBe('busy');
    await expect(
      replayFilesIntent(
        contender.client,
        source.intentId,
        readerFor([source]),
        fileOptions,
      ),
    ).resolves.toBe('busy');
    expect(
      await handle.client.runProcessingState.findFirstOrThrow({
        where: { organizationId: scope.organizationId, projectorName: 'files' },
        select: { state: true, attemptCount: true },
      }),
    ).toEqual({ state: 'PROCESSING', attemptCount: 1 });
    releaseReplay();
    await expect(replay).resolves.toBe('applied');
    expect(
      await handle.client.processingAttemptFailure.count({
        where: { intentId: source.intentId },
      }),
    ).toBe(0);
    const page = await listFileChanges(handle.client, {
      organizationId: scope.organizationId,
      repositoryId: scope.repositoryId,
      canonicalRunId: scope.runId,
      limit: 10,
    });
    expect(page).toMatchObject({
      processingState: 'ready',
      items: [{ displayPath: 'one.txt' }],
    });
    expect(
      await listFileChanges(handle.client, {
        organizationId: randomUUID(),
        repositoryId: scope.repositoryId,
        canonicalRunId: scope.runId,
        limit: 10,
      }),
    ).toBeNull();
    await Promise.all([handle.dispose(), contender.dispose()]);
  });

  it('resets exhaustion for a changed fingerprint and cancels sibling reads on first failure', async () => {
    const scope = await repository();
    const handle = createDatabaseClient({ connectionString });
    const first = await addVerifiedFileSource(handle, scope, 0, 'one.txt');
    const outage = async () => {
      throw new FileProcessingError('artifact_provider_unavailable', true);
    };
    await expect(
      processFilesIntent(handle.client, first.intentId, outage, fileOptions),
    ).rejects.toBeTruthy();
    await pool.query(
      "UPDATE run_processing_states SET available_at = clock_timestamp() WHERE projector_name = 'files' AND organization_id = $1",
      [scope.organizationId],
    );
    await expect(
      processFilesIntent(handle.client, first.intentId, outage, fileOptions),
    ).resolves.toBe('failed');
    const second = await addVerifiedFileSource(handle, scope, 1, 'two.txt');
    let siblingCancelled = false;
    let siblingStarted!: () => void;
    const started = new Promise<void>((resolve) => (siblingStarted = resolve));
    const reader = async ({
      objectKey,
      signal,
    }: {
      objectKey: string;
      signal?: AbortSignal;
    }) => {
      if (objectKey === second.objectKey) {
        siblingStarted();
        await new Promise<void>((resolve) =>
          signal?.addEventListener(
            'abort',
            () => {
              siblingCancelled = true;
              resolve();
            },
            { once: true },
          ),
        );
        throw new FileProcessingError('processing_cancelled', true);
      }
      await started;
      throw new FileProcessingError('artifact_provider_unavailable', true);
    };
    await expect(
      processFilesIntent(handle.client, first.intentId, reader, fileOptions),
    ).rejects.toBeTruthy();
    expect(siblingCancelled).toBe(true);
    const state = await handle.client.runProcessingState.findFirstOrThrow({
      where: { organizationId: scope.organizationId, projectorName: 'files' },
    });
    expect(state.attemptCount).toBe(1);
    expect(state.state).toBe('RETRYING');
    await handle.dispose();
  });

  it('rejects stale-owner publication and never records its failure over a successor lease', async () => {
    const scope = await repository();
    const handle = createDatabaseClient({ connectionString });
    const source = await addVerifiedFileSource(handle, scope, 0, 'one.txt');
    let release!: () => void;
    let reached!: () => void;
    const paused = new Promise<void>((resolve) => (reached = resolve));
    const resume = new Promise<void>((resolve) => (release = resolve));
    const pending = processFilesIntent(
      handle.client,
      source.intentId,
      readerFor([source]),
      fileOptions,
      {
        hooks: {
          beforePublish: async () => {
            reached();
            await resume;
          },
        },
      },
    );
    await paused;
    const successor = await pool.query<{ lease_id: string }>(
      "UPDATE run_processing_states SET lease_id = gen_random_uuid() WHERE organization_id = $1 AND projector_name = 'files' RETURNING lease_id",
      [scope.organizationId],
    );
    release();
    await expect(pending).rejects.toMatchObject({
      code: 'processing_lease_lost',
    });
    expect(
      await handle.client.processingAttemptFailure.count({
        where: { intentId: source.intentId },
      }),
    ).toBe(0);
    expect(
      await handle.client.runProcessingState.findFirstOrThrow({
        where: { organizationId: scope.organizationId, projectorName: 'files' },
        select: { state: true, leaseId: true, lastErrorCode: true },
      }),
    ).toEqual({
      state: 'PROCESSING',
      leaseId: successor.rows[0]!.lease_id,
      lastErrorCode: null,
    });
    await handle.dispose();
  });

  it('rejects publication after the files attempt deadline expires', async () => {
    const scope = await repository();
    const handle = createDatabaseClient({ connectionString });
    const source = await addVerifiedFileSource(handle, scope, 0, 'one.txt');
    let release!: () => void;
    let reached!: () => void;
    const paused = new Promise<void>((resolve) => (reached = resolve));
    const resume = new Promise<void>((resolve) => (release = resolve));
    const pending = processFilesIntent(
      handle.client,
      source.intentId,
      readerFor([source]),
      { ...fileOptions, attemptTimeoutMs: 50 },
      {
        hooks: {
          beforePublish: async () => {
            reached();
            await resume;
          },
        },
      },
    );
    await paused;
    await delay(75);
    release();
    await expect(pending).rejects.toMatchObject({
      code: 'projection_attempt_deadline_exceeded',
    });
    const run = await handle.client.run.findFirstOrThrow({
      where: {
        organizationId: scope.organizationId,
        canonicalRunId: scope.runId,
      },
      select: { id: true },
    });
    expect(
      await handle.client.fileRunProjection.count({ where: { runId: run.id } }),
    ).toBe(0);
    expect(
      await handle.client.processingApplicationReceipt.count({
        where: { intentId: source.intentId, projectorName: 'files' },
      }),
    ).toBe(0);
    await handle.dispose();
  });

  it('replays a projector-version mismatch and restores the current projection version', async () => {
    const scope = await repository();
    const handle = createDatabaseClient({ connectionString });
    const source = await addVerifiedFileSource(handle, scope, 0, 'one.txt');
    await expect(
      processFilesIntent(
        handle.client,
        source.intentId,
        readerFor([source]),
        fileOptions,
      ),
    ).resolves.toBe('applied');
    const run = await handle.client.run.findFirstOrThrow({
      where: {
        organizationId: scope.organizationId,
        canonicalRunId: scope.runId,
      },
      select: { id: true },
    });
    await handle.client.$transaction([
      handle.client.fileRunProjection.update({
        where: { runId: run.id },
        data: { projectorVersion: 2 },
      }),
      handle.client.runProcessingState.updateMany({
        where: { runId: run.id, projectorName: 'files' },
        data: { projectorVersion: 2 },
      }),
    ]);
    await expect(
      listFileChanges(handle.client, {
        organizationId: scope.organizationId,
        repositoryId: scope.repositoryId,
        canonicalRunId: scope.runId,
        limit: 10,
      }),
    ).resolves.toMatchObject({ processingState: 'stale', items: [] });
    const reader = readerFor([source]);
    await expect(
      replayFilesIntent(handle.client, source.intentId, reader, fileOptions),
    ).resolves.toBe('applied');
    expect(reader).toHaveBeenCalledOnce();
    expect(
      await handle.client.fileRunProjection.findUniqueOrThrow({
        where: { runId: run.id },
        select: { projectorVersion: true },
      }),
    ).toEqual({ projectorVersion: 1 });
    expect(
      await handle.client.processingApplicationReceipt.count({
        where: { intentId: source.intentId, projectorName: 'files' },
      }),
    ).toBe(1);
    await handle.dispose();
  });

  it('rejects a source change during download and exposes atomic old-or-new replacement', async () => {
    const scope = await repository();
    const writer = createDatabaseClient({ connectionString });
    const observer = createDatabaseClient({ connectionString });
    const first = await addVerifiedFileSource(writer, scope, 0, 'one.txt');
    await processFilesIntent(
      writer.client,
      first.intentId,
      readerFor([first]),
      fileOptions,
    );
    const second = await addVerifiedFileSource(writer, scope, 1, 'two.txt');
    let releaseRead!: () => void;
    let readStarted!: () => void;
    const reading = new Promise<void>((resolve) => (readStarted = resolve));
    const resumeRead = new Promise<void>((resolve) => (releaseRead = resolve));
    const pendingStale = processFilesIntent(
      writer.client,
      second.intentId,
      async ({ objectKey }) => {
        readStarted();
        await resumeRead;
        if (objectKey === first.objectKey) return first.bytes;
        return second.bytes;
      },
      fileOptions,
    );
    await reading;
    const third = await addVerifiedFileSource(writer, scope, 2, 'three.txt');
    releaseRead();
    await expect(pendingStale).rejects.toMatchObject({
      code: 'file_source_changed',
    });
    await pool.query(
      "UPDATE run_processing_states SET available_at = clock_timestamp() WHERE projector_name = 'files' AND organization_id = $1",
      [scope.organizationId],
    );
    let releaseReplace!: () => void;
    let rowsReplaced!: () => void;
    const replaced = new Promise<void>((resolve) => (rowsReplaced = resolve));
    const resumeReplace = new Promise<void>(
      (resolve) => (releaseReplace = resolve),
    );
    const publication = processFilesIntent(
      writer.client,
      third.intentId,
      readerFor([first, second, third]),
      fileOptions,
      {
        hooks: {
          afterRowsReplaced: async () => {
            rowsReplaced();
            await resumeReplace;
          },
        },
      },
    );
    await replaced;
    const internalRun = await observer.client.run.findFirstOrThrow({
      where: {
        organizationId: scope.organizationId,
        canonicalRunId: scope.runId,
      },
      select: { id: true },
    });
    expect(
      await observer.client.fileChangeProjection.count({
        where: { runId: internalRun.id },
      }),
    ).toBe(1);
    releaseReplace();
    await expect(publication).resolves.toBe('applied');
    expect(
      await observer.client.fileChangeProjection.count({
        where: { runId: internalRun.id },
      }),
    ).toBe(3);
    await Promise.all([writer.dispose(), observer.dispose()]);
  });

  it('keeps list, detail, and file pagination on one snapshot across a source commit', async () => {
    const scope = await repository();
    const writer = createDatabaseClient({ connectionString });
    const reader = createDatabaseClient({ connectionString });
    const first = await addVerifiedFileSource(writer, scope, 0, 'one.txt');
    await processFilesIntent(
      writer.client,
      first.intentId,
      readerFor([first]),
      fileOptions,
    );
    const coreIntent = await writer.client.processingIntent.findFirstOrThrow({
      where: {
        organizationId: scope.organizationId,
        kind: 'EVIDENCE_BATCH_ACCEPTED',
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    await processCoreIntent(writer.client, coreIntent.id, coreOptions);
    const beforeRuns = await listCoreRuns(reader.client, {
      organizationId: scope.organizationId,
      repositoryId: scope.repositoryId,
      limit: 10,
    });
    const beforeDetail = await getCoreRunDetail(reader.client, {
      organizationId: scope.organizationId,
      repositoryId: scope.repositoryId,
      canonicalRunId: scope.runId,
      childLimit: 10,
    });
    const beforeFiles = await listFileChanges(reader.client, {
      organizationId: scope.organizationId,
      repositoryId: scope.repositoryId,
      canonicalRunId: scope.runId,
      limit: 10,
    });
    expect(beforeRuns.items[0]).toMatchObject({
      processingState: 'incomplete',
      filesProcessingState: 'ready',
      filesChanged: 1,
    });
    const beforeDetailFilesChanged = beforeDetail?.projection?.filesChanged;
    expect(beforeDetailFilesChanged).toBe(1);
    expect(beforeDetail).toMatchObject({
      processingState: 'incomplete',
      filesProcessingState: 'ready',
      projection: { filesChanged: beforeDetailFilesChanged },
    });
    expect(beforeFiles).toMatchObject({
      processingState: 'ready',
      items: [{ displayPath: 'one.txt' }],
    });
    let arrivals = 0;
    let allArrived!: () => void;
    let release!: () => void;
    const arrived = new Promise<void>((resolve) => (allArrived = resolve));
    const resume = new Promise<void>((resolve) => (release = resolve));
    const hooks = {
      afterBaseRead: async () => {
        arrivals += 1;
        if (arrivals === 3) allArrived();
        await resume;
      },
    };
    const pending = [
      listCoreRuns(
        reader.client,
        {
          organizationId: scope.organizationId,
          repositoryId: scope.repositoryId,
          limit: 10,
        },
        hooks,
      ),
      getCoreRunDetail(
        reader.client,
        {
          organizationId: scope.organizationId,
          repositoryId: scope.repositoryId,
          canonicalRunId: scope.runId,
          childLimit: 10,
        },
        hooks,
      ),
      listFileChanges(
        reader.client,
        {
          organizationId: scope.organizationId,
          repositoryId: scope.repositoryId,
          canonicalRunId: scope.runId,
          limit: 10,
        },
        hooks,
      ),
    ] as const;
    await arrived;
    await addVerifiedFileSource(writer, scope, 1, 'two.txt');
    release();
    const [runs, detail, files] = await Promise.all(pending);
    expect(runs.items[0]).toMatchObject({
      processingState: beforeRuns.items[0]!.processingState,
      filesProcessingState: beforeRuns.items[0]!.filesProcessingState,
      filesChanged: beforeRuns.items[0]!.filesChanged,
    });
    expect(detail).toMatchObject({
      processingState: beforeDetail!.processingState,
      filesProcessingState: beforeDetail!.filesProcessingState,
      projection: { filesChanged: beforeDetailFilesChanged },
    });
    expect(files).toMatchObject({
      processingState: beforeFiles!.processingState,
      items: beforeFiles!.items,
    });
    await Promise.all([writer.dispose(), reader.dispose()]);
  });

  it('paginates equal-sequence rows by deterministic ordinal without tenant leakage', async () => {
    const scope = await repository();
    const handle = createDatabaseClient({ connectionString });
    const source = await addVerifiedFileSource(handle, scope, 0, [
      'a.txt',
      'b.txt',
    ]);
    await processFilesIntent(
      handle.client,
      source.intentId,
      readerFor([source]),
      fileOptions,
    );
    const first = await listFileChanges(handle.client, {
      organizationId: scope.organizationId,
      repositoryId: scope.repositoryId,
      canonicalRunId: scope.runId,
      limit: 1,
    });
    expect(first).toMatchObject({
      items: [{ displayPath: 'a.txt', sourceSequence: 0 }],
    });
    expect(first?.nextCursor).toBeTruthy();
    const second = await listFileChanges(handle.client, {
      organizationId: scope.organizationId,
      repositoryId: scope.repositoryId,
      canonicalRunId: scope.runId,
      limit: 1,
      cursor: first!.nextCursor!,
    });
    expect(second).toMatchObject({
      items: [{ displayPath: 'b.txt', sourceSequence: 0 }],
      nextCursor: null,
    });
    await handle.dispose();
  });

  it('rebuilds and paginates a late lower-sequence source in canonical order', async () => {
    const scope = await repository();
    const handle = createDatabaseClient({ connectionString });
    const higher = await addVerifiedFileSource(handle, scope, 10, [
      'higher-a.txt',
      'higher-b.txt',
    ]);
    await expect(
      processFilesIntent(
        handle.client,
        higher.intentId,
        readerFor([higher]),
        fileOptions,
      ),
    ).resolves.toBe('applied');
    const run = await handle.client.run.findFirstOrThrow({
      where: {
        organizationId: scope.organizationId,
        canonicalRunId: scope.runId,
      },
      select: { id: true },
    });
    const initialSource = await inspectFileSourceSnapshot(
      handle.client,
      scope.organizationId,
      run.id,
    );
    const initialProjection =
      await handle.client.fileRunProjection.findUniqueOrThrow({
        where: { runId: run.id },
        select: { sourceFingerprint: true },
      });
    const initialRowIds = (
      await handle.client.fileChangeProjection.findMany({
        where: { runId: run.id },
        orderBy: [{ sourceSequence: 'asc' }, { ordinal: 'asc' }],
        select: { id: true },
      })
    ).map(({ id }) => id);
    expect(initialSource).toMatchObject({
      count: 1,
      maxSequence: 10n,
      fingerprint: initialProjection.sourceFingerprint,
      complete: true,
    });

    const lower = await addVerifiedFileSource(handle, scope, 5, [
      'lower-a.txt',
      'lower-b.txt',
    ]);
    await expect(
      processFilesIntent(
        handle.client,
        lower.intentId,
        readerFor([higher, lower]),
        fileOptions,
      ),
    ).resolves.toBe('applied');
    const [currentSource, rebuiltProjection, readyState, rebuiltRows] =
      await Promise.all([
        inspectFileSourceSnapshot(handle.client, scope.organizationId, run.id),
        handle.client.fileRunProjection.findUniqueOrThrow({
          where: { runId: run.id },
          select: {
            sourceFingerprint: true,
            sourceEventCount: true,
            sourceMaxSequence: true,
            fileCount: true,
            completeness: true,
          },
        }),
        handle.client.runProcessingState.findUniqueOrThrow({
          where: {
            organizationId_runId_projectorName: {
              organizationId: scope.organizationId,
              runId: run.id,
              projectorName: 'files',
            },
          },
          select: {
            state: true,
            sourceFingerprint: true,
            sourceEventCount: true,
            sourceMaxSequence: true,
          },
        }),
        handle.client.fileChangeProjection.findMany({
          where: { runId: run.id },
          orderBy: [{ sourceSequence: 'asc' }, { ordinal: 'asc' }],
          select: {
            id: true,
            sourceSequence: true,
            ordinal: true,
            displayPath: true,
          },
        }),
      ]);
    expect(currentSource.fingerprint).not.toBe(initialSource.fingerprint);
    expect(currentSource).toMatchObject({
      count: 2,
      maxSequence: 10n,
      complete: true,
    });
    expect(rebuiltProjection).toEqual({
      sourceFingerprint: currentSource.fingerprint,
      sourceEventCount: 2,
      sourceMaxSequence: 10n,
      fileCount: 4,
      completeness: 'complete',
    });
    expect(readyState).toEqual({
      state: 'READY',
      sourceFingerprint: currentSource.fingerprint,
      sourceEventCount: 2,
      sourceMaxSequence: 10n,
    });
    const expectedOrder = [
      { sourceSequence: 5, ordinal: 0, displayPath: 'lower-a.txt' },
      { sourceSequence: 5, ordinal: 1, displayPath: 'lower-b.txt' },
      { sourceSequence: 10, ordinal: 0, displayPath: 'higher-a.txt' },
      { sourceSequence: 10, ordinal: 1, displayPath: 'higher-b.txt' },
    ];
    expect(
      rebuiltRows.map(({ sourceSequence, ordinal, displayPath }) => ({
        sourceSequence: Number(sourceSequence),
        ordinal,
        displayPath,
      })),
    ).toEqual(expectedOrder);
    expect(rebuiltRows.map(({ id }) => id)).not.toEqual(initialRowIds);
    expect(rebuiltRows.some(({ id }) => initialRowIds.includes(id))).toBe(
      false,
    );

    const pagedRows: typeof expectedOrder = [];
    let cursor: string | undefined;
    do {
      const page = await listFileChanges(handle.client, {
        organizationId: scope.organizationId,
        repositoryId: scope.repositoryId,
        canonicalRunId: scope.runId,
        limit: 1,
        ...(cursor ? { cursor } : {}),
      });
      expect(page?.processingState).toBe('ready');
      expect(page?.items).toHaveLength(1);
      const item = page!.items[0]!;
      pagedRows.push({
        sourceSequence: item.sourceSequence,
        ordinal: item.ordinal,
        displayPath: item.displayPath,
      });
      cursor = page!.nextCursor ?? undefined;
    } while (cursor);
    expect(pagedRows).toEqual(expectedOrder);
    expect(new Set(pagedRows.map((row) => JSON.stringify(row))).size).toBe(4);
    await handle.dispose();
  });

  it('enforces migration ownership, artifact/upload coherence, uniqueness, ordering, and partial intent keys', async () => {
    const scope = await repository();
    const handle = createDatabaseClient({ connectionString });
    const first = await addVerifiedFileSource(handle, scope, 0, 'a.txt');
    const second = await addVerifiedFileSource(handle, scope, 1, 'b.txt');
    await processFilesIntent(
      handle.client,
      second.intentId,
      readerFor([first, second]),
      fileOptions,
    );
    const run = await handle.client.run.findFirstOrThrow({
      where: {
        organizationId: scope.organizationId,
        canonicalRunId: scope.runId,
      },
      select: { id: true },
    });
    const rows = await handle.client.fileChangeProjection.findMany({
      where: { runId: run.id },
      orderBy: { sourceSequence: 'asc' },
      select: {
        id: true,
        artifactDeclarationId: true,
        uploadAttemptId: true,
      },
    });
    expect(rows).toHaveLength(2);
    await expect(
      pool.query(
        'UPDATE file_change_projections SET upload_attempt_id = $1 WHERE id = $2',
        [rows[1]!.uploadAttemptId, rows[0]!.id],
      ),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      pool.query(
        'UPDATE file_change_projections SET organization_id = $1 WHERE id = $2',
        [randomUUID(), rows[0]!.id],
      ),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      pool.query(
        'UPDATE file_change_projections SET ordinal = -1 WHERE id = $1',
        [rows[0]!.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query(
        `INSERT INTO file_change_projections
          (organization_id, repository_id, run_id, source_event_id, source_sequence,
           diff_id, from_snapshot_id, to_snapshot_id, artifact_declaration_id,
           upload_attempt_id, ordinal, entry_id, original_entry_id, display_path,
           original_display_path, display_ambiguous, display_reason, before_state,
           after_state, attribution, reason)
         SELECT organization_id, repository_id, run_id, source_event_id, source_sequence,
           diff_id, from_snapshot_id, to_snapshot_id, artifact_declaration_id,
           upload_attempt_id, ordinal, entry_id, original_entry_id, display_path,
           original_display_path, display_ambiguous, display_reason, before_state,
           after_state, attribution, reason
         FROM file_change_projections WHERE id = $1`,
        [rows[0]!.id],
      ),
    ).rejects.toMatchObject({ code: '23505' });
    const intents = await handle.client.processingIntent.findMany({
      where: { runId: run.id },
      select: {
        id: true,
        kind: true,
        batchId: true,
        artifactDeclarationId: true,
      },
    });
    const batchIntent = intents.find((intent) => intent.batchId !== null)!;
    const artifactIntent = intents.find(
      (intent) => intent.artifactDeclarationId !== null,
    )!;
    await expect(
      pool.query(
        `INSERT INTO processing_intents
          (organization_id, run_id, batch_id, artifact_declaration_id, kind)
         SELECT organization_id, run_id, batch_id, artifact_declaration_id, kind
         FROM processing_intents WHERE id = $1`,
        [batchIntent.id],
      ),
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      pool.query(
        `INSERT INTO processing_intents
          (organization_id, run_id, batch_id, artifact_declaration_id, kind)
         SELECT organization_id, run_id, batch_id, artifact_declaration_id, kind
         FROM processing_intents WHERE id = $1`,
        [artifactIntent.id],
      ),
    ).rejects.toMatchObject({ code: '23505' });
    const cursorIndex = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = current_schema()
            AND indexname = 'file_changes_org_run_cursor_idx'
       ) AS exists`,
    );
    expect(cursorIndex.rows[0]?.exists).toBe(true);
    await handle.dispose();
  });

  it('reports unverified required file evidence as incomplete with unknown counts', async () => {
    const scope = await repository();
    const handle = createDatabaseClient({ connectionString });
    const source = await addVerifiedFileSource(handle, scope, 0, 'one.txt');
    await processFilesIntent(
      handle.client,
      source.intentId,
      readerFor([source]),
      fileOptions,
    );
    await addUnverifiedFileSource(handle, scope, 1);
    const files = await listFileChanges(handle.client, {
      organizationId: scope.organizationId,
      repositoryId: scope.repositoryId,
      canonicalRunId: scope.runId,
      limit: 10,
    });
    const runs = await listCoreRuns(handle.client, {
      organizationId: scope.organizationId,
      repositoryId: scope.repositoryId,
      limit: 10,
    });
    expect(files).toMatchObject({
      processingState: 'incomplete',
      items: [],
      nextCursor: null,
    });
    expect(runs.items[0]).toMatchObject({
      filesProcessingState: 'incomplete',
      filesChanged: null,
      filesCompletenessReason: 'files_incomplete',
    });
    await handle.dispose();
  });

  it('atomically replaces missing-file findings after late verified file projection', async () => {
    const scope = await repository();
    const writer = createDatabaseClient({ connectionString });
    const reader = createDatabaseClient({ connectionString });
    const source = await addVerifiedFileSource(
      writer,
      scope,
      0,
      'src/auth/session.ts',
    );
    const coreIntent = await writer.client.processingIntent.findFirstOrThrow({
      where: {
        organizationId: scope.organizationId,
        kind: 'EVIDENCE_BATCH_ACCEPTED',
      },
      select: { id: true },
    });
    await processCoreIntent(writer.client, coreIntent.id, coreOptions);
    await expect(
      processFindingsIntent(writer.client, coreIntent.id, findingsOptions),
    ).resolves.toBe('applied');
    const run = await writer.client.run.findUniqueOrThrow({
      where: {
        organizationId_canonicalRunId: {
          organizationId: scope.organizationId,
          canonicalRunId: scope.runId,
        },
      },
      select: { id: true },
    });
    const before = await writer.client.findingsRunProjection.findUniqueOrThrow({
      where: { runId: run.id },
      select: { deterministicOutcome: true, sourceFingerprint: true },
    });
    expect(before.deterministicOutcome).toBe('unknown');
    const oldResultIds = (
      await writer.client.findingRuleResult.findMany({
        where: { runId: run.id },
        orderBy: { catalogOrder: 'asc' },
        select: { id: true },
      })
    ).map(({ id }) => id);
    expect(oldResultIds).toHaveLength(9);

    await processFilesIntent(
      writer.client,
      source.intentId,
      readerFor([source]),
      fileOptions,
    );
    const upstreamBefore = await Promise.all([
      writer.client.evidenceEvent.count({ where: { runId: run.id } }),
      writer.client.coreRunProjection.count({ where: { runId: run.id } }),
      writer.client.fileChangeProjection.count({ where: { runId: run.id } }),
    ]);
    let reached!: () => void;
    let release!: () => void;
    const replaced = new Promise<void>((resolve) => (reached = resolve));
    const continueCommit = new Promise<void>((resolve) => (release = resolve));
    const processing = processFindingsIntent(
      writer.client,
      source.intentId,
      findingsOptions,
      {
        hooks: {
          afterResultsReplaced: async () => {
            reached();
            await continueCommit;
          },
        },
      },
    );
    await replaced;
    const during = await Promise.all([
      reader.client.findingsRunProjection.findUniqueOrThrow({
        where: { runId: run.id },
        select: { deterministicOutcome: true, sourceFingerprint: true },
      }),
      reader.client.findingRuleResult.findMany({
        where: { runId: run.id },
        orderBy: { catalogOrder: 'asc' },
        select: { id: true },
      }),
    ]);
    expect(during[0]).toEqual(before);
    expect(during[1].map(({ id }) => id)).toEqual(oldResultIds);
    release();
    await expect(processing).resolves.toBe('applied');

    const page = await listFindings(writer.client, {
      organizationId: scope.organizationId,
      repositoryId: scope.repositoryId,
      canonicalRunId: scope.runId,
      limit: 9,
    });
    expect(page).toMatchObject({
      processingState: 'ready',
      deterministicOutcome: 'review',
      items: expect.arrayContaining([
        expect.objectContaining({
          ruleId: 'bbx.sensitive-area-change',
          outcome: 'triggered',
          references: [
            expect.objectContaining({
              eventArtifactPointer: '/payload/fileListArtifact',
              jsonPointer: '/files/0',
              fileOrdinal: 0,
            }),
          ],
        }),
      ]),
    });
    const storedReference =
      await writer.client.findingEvidenceReference.findFirstOrThrow({
        where: {
          runId: run.id,
          result: { ruleId: 'bbx.sensitive-area-change' },
        },
        select: {
          resultId: true,
          eventId: true,
          artifactDeclarationId: true,
          eventArtifactPointer: true,
          jsonPointer: true,
          fileOrdinal: true,
          entryId: true,
        },
      });
    const unrelatedArtifact =
      await writer.client.artifactDeclaration.findFirstOrThrow({
        where: {
          runId: run.id,
          id: { not: storedReference.artifactDeclarationId! },
        },
        select: { id: true },
      });
    const insertReference = (
      organizationId: string,
      runId: string,
      artifactId: string,
      eventArtifactPointer: string,
      ordinal: number,
      entryId: string,
    ) =>
      pool.query(
        `INSERT INTO finding_evidence_references
          (organization_id, run_id, result_id, ordinal, event_id,
           artifact_declaration_id, event_artifact_pointer, json_pointer,
           file_ordinal, entry_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          organizationId,
          runId,
          storedReference.resultId,
          ordinal,
          storedReference.eventId,
          artifactId,
          eventArtifactPointer,
          storedReference.jsonPointer,
          storedReference.fileOrdinal,
          entryId,
        ],
      );
    await expect(
      insertReference(
        scope.organizationId,
        run.id,
        unrelatedArtifact.id,
        storedReference.eventArtifactPointer!,
        96,
        storedReference.entryId!,
      ),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      insertReference(
        scope.organizationId,
        run.id,
        storedReference.artifactDeclarationId!,
        '/payload/diffArtifact',
        97,
        storedReference.entryId!,
      ),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      insertReference(
        randomUUID(),
        run.id,
        storedReference.artifactDeclarationId!,
        storedReference.eventArtifactPointer!,
        98,
        `${storedReference.entryId!}-cross-tenant`,
      ),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      insertReference(
        scope.organizationId,
        randomUUID(),
        storedReference.artifactDeclarationId!,
        storedReference.eventArtifactPointer!,
        99,
        `${storedReference.entryId!}-cross-run`,
      ),
    ).rejects.toMatchObject({ code: '23503' });
    const newResultIds = (
      await writer.client.findingRuleResult.findMany({
        where: { runId: run.id },
        orderBy: { catalogOrder: 'asc' },
        select: { id: true },
      })
    ).map(({ id }) => id);
    expect(newResultIds).toHaveLength(9);
    expect(newResultIds.some((id) => oldResultIds.includes(id))).toBe(false);
    expect(
      await Promise.all([
        writer.client.evidenceEvent.count({ where: { runId: run.id } }),
        writer.client.coreRunProjection.count({ where: { runId: run.id } }),
        writer.client.fileChangeProjection.count({ where: { runId: run.id } }),
      ]),
    ).toEqual(upstreamBefore);
    await Promise.all([writer.dispose(), reader.dispose()]);
  });
});
