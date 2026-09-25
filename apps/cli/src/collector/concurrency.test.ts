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
});
