import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

import { EvidenceBatchSchema, type EvidenceBatch } from '@blackbox/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CollectorSession,
  CollectorWorkSpool,
  type PrepareBatchesResult,
} from './index.js';

const roots: string[] = [];

function spoolRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), 'bbx-public-workflow-'));
  roots.push(directory);
  return join(directory, 'spool');
}

function accept(work: CollectorWorkSpool, batch: EvidenceBatch, token: string) {
  work.acknowledgeBatchDelivery(batch.batchId, token, {
    outcome: 'accepted',
    batchId: batch.batchId,
    runId: batch.runId,
    receivedAt: new Date().toISOString(),
  });
}

function claimAll(work: CollectorWorkSpool): EvidenceBatch[] {
  const batches: EvidenceBatch[] = [];
  for (;;) {
    const claim = work.claimBatch();
    if (!claim) return batches;
    const batch = EvidenceBatchSchema.parse(JSON.parse(claim.body ?? ''));
    expect(claim.id).toBe(batch.batchId);
    expect(claim.body).toBe(JSON.stringify(batch));
    batches.push(batch);
    accept(work, batch, claim.leaseToken);
  }
}

const prepareWorker = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  const { CollectorWorkSpool } = await import(workerData.collectorModule);
  const work = CollectorWorkSpool.open({ spoolRoot: workerData.spoolRoot });
  parentPort.postMessage({ ready: true });
  Atomics.wait(workerData.barrier, 0, 0);
  const result = work.prepareBatches({ maximumBatches: 1000 });
  work.close();
  parentPort.postMessage(result);
})().catch((error) => parentPort.postMessage({ error: String(error && error.stack || error) }));
`;

function concurrentPreparation(root: string): Promise<PrepareBatchesResult[]> {
  const barrier = new Int32Array(new SharedArrayBuffer(4));
  const workers = Array.from(
    { length: 2 },
    () =>
      new Worker(prepareWorker, {
        eval: true,
        workerData: {
          barrier,
          collectorModule: pathToFileURL(
            resolve(import.meta.dirname, '../../dist/collector/index.js'),
          ).href,
          spoolRoot: root,
        },
      }),
  );
  return new Promise((resolvePromise, reject) => {
    const results: PrepareBatchesResult[] = [];
    let ready = 0;
    for (const worker of workers) {
      worker.on('error', reject);
      worker.on(
        'message',
        (
          message: PrepareBatchesResult & { error?: string; ready?: boolean },
        ) => {
          if (message.error) return reject(new Error(message.error));
          if (message.ready) {
            ready += 1;
            if (ready === workers.length) {
              Atomics.store(barrier, 0, 1);
              Atomics.notify(barrier, 0, workers.length);
            }
            return;
          }
          results.push(message);
          if (results.length === workers.length) {
            for (const item of workers) void item.terminate();
            resolvePromise(results);
          }
        },
      );
    }
  });
}

afterEach(() => {
  for (const path of roots.splice(0))
    rmSync(path, { recursive: true, force: true });
});

describe('public collector workflow', () => {
  it('forms and claims the exact stable batch through the public barrel only', () => {
    const root = spoolRoot();
    const session = CollectorSession.open({ spoolRoot: root });
    const runId = session.runId;
    const started = session.observeRunStarted({
      taskDescription: Buffer.from('safe task'),
    });
    const command = session.observeCommandFinished({
      commandId: randomUUID(),
      outcome: 'succeeded',
      stdout: Buffer.from('metadata only by default'),
    });
    const finished = session.observeRunFinished({ outcome: 'succeeded' });
    session.close();

    using work = CollectorWorkSpool.open({ spoolRoot: root });
    expect(work.prepareBatches()).toEqual({
      batchesCreated: 1,
      eventsBatched: 3,
    });
    expect(work.prepareBatches()).toEqual({
      batchesCreated: 0,
      eventsBatched: 0,
    });
    const firstClaim = work.claimBatch();
    expect(firstClaim).toBeDefined();
    const firstBody = firstClaim!.body!;
    const batch = EvidenceBatchSchema.parse(JSON.parse(firstBody));
    expect(batch.runId).toBe(runId);
    expect(batch.events).toEqual([started, command, finished]);
    expect(firstBody).toBe(JSON.stringify(batch));
    work.releaseBatch(batch.batchId, firstClaim!.leaseToken);
    const secondClaim = work.claimBatch();
    expect(secondClaim).toMatchObject({ id: batch.batchId, body: firstBody });
    accept(work, batch, secondClaim!.leaseToken);
  });

  it('returns zero for an empty spool and rejects unsafe scheduling options without mutation', () => {
    const root = spoolRoot();
    using work = CollectorWorkSpool.open({ spoolRoot: root });
    expect(work.prepareBatches()).toEqual({
      batchesCreated: 0,
      eventsBatched: 0,
    });
    const badValues: unknown[] = [
      { maximumBatches: 0 },
      { maximumBatches: 1.5 },
      { maximumBatches: Number.NaN },
      { maximumBatches: 1_001 },
      { runId: 'not-a-uuid' },
      { events: [] },
      Object.assign(Object.create({ maximumBatches: 1 }), {}),
      Object.defineProperty({}, 'runId', { get: () => randomUUID() }),
    ];
    for (const value of badValues)
      expect(() => work.prepareBatches(value as never)).toThrow();
    let propertyReads = 0;
    const proxy = new Proxy(
      { maximumBatches: 1 },
      {
        get(target, property, receiver) {
          propertyReads += 1;
          return Reflect.get(target, property, receiver);
        },
      },
    );
    expect(work.prepareBatches(proxy)).toEqual({
      batchesCreated: 0,
      eventsBatched: 0,
    });
    expect(propertyReads).toBe(0);
    expect(work.status().batches.pending).toBe(0);
  });

  it('prepares active and closed runs independently and honors a safe run filter', () => {
    const root = spoolRoot();
    using active = CollectorSession.open({ spoolRoot: root });
    active.observeRunStarted({});
    const closed = CollectorSession.open({ spoolRoot: root });
    closed.observeRunStarted({});
    closed.observeRunFinished({ outcome: 'succeeded' });
    closed.close();

    using work = CollectorWorkSpool.open({ spoolRoot: root });
    expect(work.prepareBatches({ runId: active.runId })).toEqual({
      batchesCreated: 1,
      eventsBatched: 1,
    });
    expect(work.prepareBatches()).toEqual({
      batchesCreated: 1,
      eventsBatched: 2,
    });
    const batches = claimAll(work);
    expect(new Set(batches.map((batch) => batch.runId))).toEqual(
      new Set([active.runId, closed.runId]),
    );
    expect(
      batches.every((batch) =>
        batch.events.every(
          (event, index) =>
            index === 0 || event.sequence > batch.events[index - 1]!.sequence,
        ),
      ),
    ).toBe(true);
  });

  it('splits at the fixed event-count limit', () => {
    const root = spoolRoot();
    using session = CollectorSession.open({ spoolRoot: root });
    for (let index = 0; index < 501; index += 1) session.observeRunStarted({});
    using work = CollectorWorkSpool.open({ spoolRoot: root });
    expect(work.prepareBatches({ maximumBatches: 1 })).toEqual({
      batchesCreated: 1,
      eventsBatched: 500,
    });
    expect(work.prepareBatches({ maximumBatches: 1 })).toEqual({
      batchesCreated: 1,
      eventsBatched: 1,
    });
    expect(claimAll(work).map((batch) => batch.events.length)).toEqual([
      500, 1,
    ]);
  }, 20_000);

  it('splits at the fixed serialized-byte limit', () => {
    const root = spoolRoot();
    using session = CollectorSession.open({
      captureClasses: ['stderr', 'stdout'],
      spoolRoot: root,
    });
    const excerpt = Buffer.from('x'.repeat(4_096));
    for (let index = 0; index < 130; index += 1)
      session.observeCommandFinished({
        commandId: randomUUID(),
        outcome: 'succeeded',
        stderr: excerpt,
        stdout: excerpt,
      });
    using work = CollectorWorkSpool.open({ spoolRoot: root });
    const result = work.prepareBatches({ maximumBatches: 10 });
    expect(result.eventsBatched).toBe(130);
    expect(result.batchesCreated).toBeGreaterThan(1);
    const batches = claimAll(work);
    expect(batches.flatMap((batch) => batch.events)).toHaveLength(130);
    for (const batch of batches)
      expect(Buffer.byteLength(JSON.stringify(batch))).toBeLessThanOrEqual(
        1_000_000,
      );
  }, 30_000);

  it('converges under concurrent public preparation without duplicate membership', async () => {
    const root = spoolRoot();
    using session = CollectorSession.open({ spoolRoot: root });
    for (let index = 0; index < 501; index += 1) session.observeRunStarted({});
    const results = await concurrentPreparation(root);
    expect(results.reduce((sum, item) => sum + item.batchesCreated, 0)).toBe(2);
    expect(results.reduce((sum, item) => sum + item.eventsBatched, 0)).toBe(
      501,
    );
    using work = CollectorWorkSpool.open({ spoolRoot: root });
    expect(work.prepareBatches()).toEqual({
      batchesCreated: 0,
      eventsBatched: 0,
    });
    const batches = claimAll(work);
    const events = batches.flatMap((batch) => batch.events);
    expect(events).toHaveLength(501);
    expect(new Set(events.map((event) => event.eventId)).size).toBe(501);
    expect(events.map((event) => event.sequence)).toEqual(
      Array.from({ length: 501 }, (_, index) => index),
    );
  }, 30_000);
});
