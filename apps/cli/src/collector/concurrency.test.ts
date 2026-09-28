import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { validateCollectorConfig } from './config.js';
import { LocalSpool } from './spool.js';

const roots: string[] = [];
const timestamp = '2026-09-24T10:00:00.000Z';

function temporarySpool(): string {
  const directory = mkdtempSync(join(tmpdir(), 'bbx-contention-'));
  roots.push(directory);
  return join(directory, 'spool');
}

afterEach(() => {
  for (const path of roots.splice(0))
    rmSync(path, { recursive: true, force: true });
});

const workerSource = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  const { LocalSpool } = await import(workerData.spoolModule);
  const { validateCollectorConfig } = await import(workerData.configModule);
  const spool = new LocalSpool(validateCollectorConfig({ spoolRoot: workerData.root })).open({ busyTimeoutMs: 10000 });
  parentPort.postMessage({ ready: true });
  Atomics.wait(workerData.barrier, 0, 0);
  if (workerData.mode === 'events') {
    const sequences = [];
    for (let index = 0; index < workerData.count; index += 1) {
      const event = spool.recordRunStarted(workerData.handle, {}, 2000 + index);
      sequences.push(event.sequence);
    }
    parentPort.postMessage({ sequences });
  } else {
    const claims = [];
    for (;;) {
      const claim = spool.claimBatch(1000, 10000);
      if (!claim) break;
      claims.push({ id: claim.id, leaseToken: claim.leaseToken });
    }
    parentPort.postMessage({ claims });
  }
  spool.close();
})().catch((error) => parentPort.postMessage({ error: String(error && error.stack || error) }));
`;

const lockWorkerSource = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const database = new DatabaseSync(workerData.databasePath, { timeout: 10000 });
database.exec('BEGIN IMMEDIATE');
parentPort.postMessage({ locked: true });
setTimeout(() => {
  database.exec('COMMIT');
  database.close();
  parentPort.postMessage({ released: true });
}, workerData.holdMs);
`;

async function holdWriterLock(
  databasePath: string,
  holdMs: number,
): Promise<{ done: Promise<void> }> {
  const worker = new Worker(lockWorkerSource, {
    eval: true,
    workerData: { databasePath, holdMs },
  });
  let resolveDone!: () => void;
  let rejectDone!: (error: Error) => void;
  const done = new Promise<void>((resolvePromise, reject) => {
    resolveDone = resolvePromise;
    rejectDone = reject;
  });
  await new Promise<void>((resolvePromise, reject) => {
    worker.on('error', (error) => {
      reject(error);
      rejectDone(error);
    });
    worker.on(
      'message',
      (message: { locked?: boolean; released?: boolean }) => {
        if (message.locked) resolvePromise();
        if (message.released) resolveDone();
      },
    );
  });
  return { done };
}

function createBatchWork(spool: LocalSpool, eventCount = 1) {
  const now = Date.now();
  const handle = spool.createRun(60_000, now);
  for (let index = 0; index < eventCount; index += 1)
    spool.recordRunStarted(handle, {}, now + index + 1);
  const batch = spool.createBatch(handle.runId, now + eventCount + 1)!;
  return { batch, handle };
}

function createArtifactWork(spool: LocalSpool) {
  const now = Date.now();
  const handle = spool.createRun(60_000, now);
  const event = spool.recordCommandFinished(
    handle,
    {
      commandId: randomUUID(),
      outcome: 'succeeded',
      stdout: Buffer.from('contention-artifact'),
    },
    now + 1,
  );
  if (
    event.kind !== 'command.finished' ||
    event.payload.stdout.state !== 'captured' ||
    !event.payload.stdout.artifact
  )
    throw new Error('expected artifact');
  const batch = spool.createBatch(handle.runId, now + 2)!;
  const batchClaim = spool.claimBatch(1_000, now + 3)!;
  spool.acknowledgeBatchDelivery(
    batch.batchId,
    batchClaim.leaseToken,
    {
      outcome: 'accepted',
      batchId: batch.batchId,
      runId: handle.runId,
      receivedAt: timestamp,
    },
    now + 4,
  );
  return { handle, reference: event.payload.stdout.artifact };
}

function runWorkers(
  count: number,
  data: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
  const barrier = new Int32Array(new SharedArrayBuffer(4));
  const workers = Array.from(
    { length: count },
    () =>
      new Worker(workerSource, {
        eval: true,
        workerData: {
          ...data,
          barrier,
          spoolModule: pathToFileURL(resolve('dist/collector/spool.js')).href,
          configModule: pathToFileURL(resolve('dist/collector/config.js')).href,
          timestamp,
        },
      }),
  );
  return new Promise((resolvePromise, reject) => {
    const results: Record<string, unknown>[] = [];
    let ready = 0;
    for (const worker of workers) {
      worker.on('error', reject);
      worker.on('message', (message: Record<string, unknown>) => {
        if (message.error) return reject(new Error(String(message.error)));
        if (message.ready) {
          ready += 1;
          if (ready === workers.length) {
            Atomics.store(barrier, 0, 1);
            Atomics.notify(barrier, 0, workers.length);
          }
          return;
        }
        results.push(message);
        if (results.length === workers.length) resolvePromise(results);
      });
    }
  });
}

describe('multi-connection SQLite contention', () => {
  it('allocates concurrent sequences without duplicates or lost events', async () => {
    const root = temporarySpool();
    using spool = new LocalSpool(
      validateCollectorConfig({ spoolRoot: root }),
    ).open();
    const handle = spool.createRun(60_000, 1_000);
    const results = await runWorkers(4, {
      mode: 'events',
      root,
      handle,
      count: 10,
    });
    const sequences = results
      .flatMap((item) => item.sequences as number[])
      .sort((a, b) => a - b);
    expect(sequences).toEqual(Array.from({ length: 40 }, (_, index) => index));
    expect(spool.status().bytes.events).toBeGreaterThan(0);
  }, 20_000);

  it('claims concurrent work once and rejects every stale owner', async () => {
    const root = temporarySpool();
    using spool = new LocalSpool(
      validateCollectorConfig({ spoolRoot: root }),
    ).open();
    for (let index = 0; index < 8; index += 1) {
      const handle = spool.createRun(60_000, 1_000 + index);
      spool.recordRunStarted(handle, {}, 2_000 + index);
      spool.createBatch(handle.runId, 3_000 + index);
    }
    const results = await runWorkers(4, { mode: 'claims', root });
    const claims = results.flatMap(
      (item) => item.claims as { id: string; leaseToken: string }[],
    );
    expect(new Set(claims.map((claim) => claim.id)).size).toBe(8);
    expect(claims).toHaveLength(8);
    expect(spool.recoverExpired(11_000).batches).toBe(8);
    for (const claim of claims)
      expect(() =>
        spool.releaseBatch(claim.id, claim.leaseToken, undefined, 11_001),
      ).toThrow();
    const reclaimed = new Set<string>();
    for (;;) {
      const claim = spool.claimBatch(1_000, 11_002);
      if (!claim) break;
      reclaimed.add(claim.id);
      spool.blockBatch(
        claim.id,
        claim.leaseToken,
        'validation-rejected',
        11_003,
      );
    }
    expect(reclaimed.size).toBe(8);
  }, 20_000);

  it.each(['batch', 'artifact'] as const)(
    'bounds %s claim writer-lock waiting and preserves recoverable work',
    async (kind) => {
      const root = temporarySpool();
      using spool = new LocalSpool(
        validateCollectorConfig({
          captureClasses: ['stdout'],
          spoolRoot: root,
        }),
      ).open({ busyTimeoutMs: 1_000 });
      if (kind === 'batch') createBatchWork(spool);
      else createArtifactWork(spool);
      const lock = await holdWriterLock(spool.databasePath, 300);
      const startedAt = Date.now();
      const claim =
        kind === 'batch'
          ? spool.claimBatch(1_000, undefined, undefined, 60)
          : spool.claimArtifact(1_000, undefined, undefined, 60);
      const elapsed = Date.now() - startedAt;
      expect(claim).toBeUndefined();
      expect(elapsed).toBeLessThan(250);
      await lock.done;
      const recovered =
        kind === 'batch' ? spool.claimBatch() : spool.claimArtifact();
      expect(recovered).toBeDefined();
    },
  );

  it.each([
    'batch-release',
    'batch-block',
    'batch-retry',
    'batch-supersede',
    'batch-acknowledge',
    'artifact-bind',
    'artifact-replace',
    'artifact-release',
    'artifact-block',
    'artifact-retry',
    'artifact-acknowledge',
  ] as const)(
    'rejects stale ownership for %s after writer-lock contention',
    async (operation) => {
      const root = temporarySpool();
      using spool = new LocalSpool(
        validateCollectorConfig({
          captureClasses: ['stdout'],
          spoolRoot: root,
        }),
      ).open({ busyTimeoutMs: 1_000 });
      const isArtifact = operation.startsWith('artifact-');
      let id: string;
      let token: string;
      let runId: string;
      let uploadId: string | undefined;
      let byteLength = 0;
      let hash = '';
      if (isArtifact) {
        const seeded = createArtifactWork(spool);
        const claim = spool.claimArtifact(1_000)!;
        id = claim.id;
        token = claim.leaseToken;
        runId = seeded.handle.runId;
        byteLength = claim.declaration.byteLength;
        hash = claim.declaration.sha256;
        if (
          operation === 'artifact-replace' ||
          operation === 'artifact-acknowledge'
        ) {
          uploadId = randomUUID();
          spool.bindArtifactUpload(id, token, uploadId);
        }
      } else {
        const seeded = createBatchWork(
          spool,
          operation === 'batch-supersede' ? 2 : 1,
        );
        const claim = spool.claimBatch(1_000)!;
        id = claim.id;
        token = claim.leaseToken;
        runId = seeded.handle.runId;
      }
      using database = new DatabaseSync(spool.databasePath);
      database
        .prepare(
          `UPDATE ${isArtifact ? 'artifact_work' : 'batch_work'} SET lease_expires_at_ms=? WHERE ${isArtifact ? 'artifact_id' : 'batch_id'}=?`,
        )
        .run(Date.now() + 50, id);
      const lock = await holdWriterLock(spool.databasePath, 120);
      const action = () => {
        switch (operation) {
          case 'batch-release':
            return spool.releaseBatch(id, token);
          case 'batch-block':
            return spool.blockBatch(id, token, 'validation-rejected');
          case 'batch-retry':
            return spool.scheduleBatchRetry(
              id,
              token,
              Date.now() + 10_000,
              'network-failed',
            );
          case 'batch-supersede':
            return spool.supersedeOversizedBatch(
              id,
              token,
              { batchId: id, code: 'payload_too_large', runId },
              1,
            );
          case 'batch-acknowledge':
            return spool.acknowledgeBatchDelivery(id, token, {
              outcome: 'accepted',
              batchId: id,
              runId,
              receivedAt: timestamp,
            });
          case 'artifact-bind':
            return spool.bindArtifactUpload(id, token, randomUUID());
          case 'artifact-replace':
            return spool.replaceArtifactUpload(
              id,
              token,
              uploadId!,
              randomUUID(),
            );
          case 'artifact-release':
            return spool.releaseArtifact(id, token);
          case 'artifact-block':
            return spool.blockArtifact(id, token, 'validation-rejected');
          case 'artifact-retry':
            return spool.scheduleArtifactRetry(
              id,
              token,
              Date.now() + 10_000,
              'network-failed',
            );
          case 'artifact-acknowledge':
            return spool.acknowledgeArtifactVerification(id, token, {
              schemaVersion: 1,
              outcome: 'verified',
              artifactId: id,
              verification: {
                uploadId: uploadId!,
                byteLength,
                sha256: hash,
                verifiedAt: timestamp,
              },
            });
        }
      };
      expect(action).toThrowError(
        expect.objectContaining({ code: 'lease-lost' }),
      );
      await lock.done;
      const recovered = spool.recoverExpired();
      expect(isArtifact ? recovered.artifacts : recovered.batches).toBe(1);
    },
    20_000,
  );
});
