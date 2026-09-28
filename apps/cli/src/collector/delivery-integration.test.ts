import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { ArtifactReference } from '@blackbox/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { DeliveryCoordinator } from './coordinator.js';
import type { DeliveryConfig } from './delivery-config.js';
import { CollectorSession, CollectorWorkSpool } from './index.js';

const roots: string[] = [];
const servers: ReturnType<typeof createServer>[] = [];

function root(): string {
  const directory = mkdtempSync(join(tmpdir(), 'bbx-delivery-'));
  roots.push(directory);
  return join(directory, 'spool');
}

function files(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('missing address');
  return `http://127.0.0.1:${address.port}`;
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function deliveryConfig(
  base: string,
  repositoryId: string,
  token: string,
): DeliveryConfig {
  return {
    apiBaseUrl: base,
    apiToken: token,
    connectTimeoutMs: 100,
    drainMaxAttempts: 20,
    drainMaxElapsedMs: 2_000,
    drainMaxItems: 20,
    overallTimeoutMs: 1_000,
    repositoryId,
    requestTimeoutMs: 200,
    retryBaseMs: 1,
    retryMaxMs: 20,
  };
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

function accepted(batch: { batchId: string; runId: string }) {
  return {
    outcome: 'accepted' as const,
    batchId: batch.batchId,
    runId: batch.runId,
    receivedAt: '2026-09-28T10:00:00.000Z',
  };
}

function seedBoundArtifact(spoolRoot: string): {
  declaration: ArtifactReference;
  uploadId: string;
} {
  const session = CollectorSession.open({
    captureClasses: ['stdout'],
    spoolRoot,
  });
  const event = session.observeCommandFinished({
    commandId: randomUUID(),
    outcome: 'succeeded',
    stdout: Buffer.from('attempt-bound-artifact'),
  });
  session.observeRunFinished({ outcome: 'succeeded' });
  session.close();
  if (
    event.kind !== 'command.finished' ||
    event.payload.stdout.state !== 'captured' ||
    !event.payload.stdout.artifact
  )
    throw new Error('expected artifact');
  const declaration = event.payload.stdout.artifact;
  const uploadId = randomUUID();
  using work = CollectorWorkSpool.open({ spoolRoot });
  work.prepareBatches();
  const batchClaim = work.claimBatch()!;
  const batch = JSON.parse(batchClaim.body) as {
    batchId: string;
    runId: string;
  };
  work.acknowledgeBatchDelivery(batch.batchId, batchClaim.leaseToken, {
    outcome: 'accepted',
    batchId: batch.batchId,
    runId: batch.runId,
    receivedAt: '2026-09-28T10:00:00.000Z',
  });
  const artifactClaim = work.claimArtifact()!;
  work.bindArtifactUpload(artifactClaim.id, artifactClaim.leaseToken, uploadId);
  work.releaseArtifact(artifactClaim.id, artifactClaim.leaseToken);
  return { declaration, uploadId };
}

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
  for (const directory of roots.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('bounded delivery coordinator', () => {
  it('delivers an exact batch, gates its artifact, streams TUS, and verifies without persisting credentials', async () => {
    const spoolRoot = root();
    const repositoryId = randomUUID();
    const bearer = `bearer-${randomUUID()}`;
    const capability = `capability-${randomUUID()}`;
    const artifactBytes = Buffer.from(
      `safe artifact ${bearer} ${capability} bytes`,
    );
    let declaration:
      { artifactId: string; byteLength: number; sha256: string } | undefined;
    const uploadId = randomUUID();
    let uploaded = Buffer.alloc(0);
    const requests: {
      authorization?: string;
      body: Buffer;
      capability?: string;
      path: string;
    }[] = [];
    let base = '';
    base = await listen((request, response) => {
      void (async () => {
        const requestBody = await readBody(request);
        requests.push({
          ...(request.headers.authorization
            ? { authorization: request.headers.authorization }
            : {}),
          body: requestBody,
          ...(request.headers['x-signature']
            ? { capability: String(request.headers['x-signature']) }
            : {}),
          path: request.url ?? '',
        });
        if (request.url?.endsWith('/evidence-batches')) {
          const batch = JSON.parse(requestBody.toString('utf8')) as {
            batchId: string;
            runId: string;
            events: Array<{
              payload: { stdout?: { artifact?: typeof declaration } };
            }>;
          };
          declaration = batch.events
            .map((event) => event.payload.stdout?.artifact)
            .find(Boolean);
          json(response, 202, accepted(batch));
          return;
        }
        if (request.url?.endsWith('/storage')) {
          json(response, 200, {
            schemaVersion: 1,
            artifactId: declaration!.artifactId,
            state: 'declared',
          });
          return;
        }
        if (request.url?.endsWith('/uploads')) {
          json(response, 201, {
            schemaVersion: 1,
            outcome: 'upload_authorized',
            artifactId: declaration!.artifactId,
            uploadId,
            protocol: 'tus',
            endpoint: `${base}/tus/${uploadId}`,
            capabilityToken: capability,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            requiredChunkSize: 5,
            maximumBytes: declaration!.byteLength,
          });
          return;
        }
        if (request.url === `/tus/${uploadId}`) {
          expect(request.headers.authorization).toBeUndefined();
          expect(request.headers['x-signature']).toBe(capability);
          uploaded = Buffer.concat([uploaded, requestBody]);
          response.writeHead(204, {
            'tus-resumable': '1.0.0',
            'upload-offset': String(uploaded.byteLength),
          });
          response.end();
          return;
        }
        if (request.url?.endsWith(`/uploads/${uploadId}/complete`)) {
          json(response, 200, {
            schemaVersion: 1,
            outcome: 'verified',
            artifactId: declaration!.artifactId,
            verification: {
              uploadId,
              byteLength: declaration!.byteLength,
              sha256: declaration!.sha256,
              verifiedAt: '2026-09-28T10:00:01.000Z',
            },
          });
          return;
        }
        response.writeHead(404).end();
      })();
    });
    const session = CollectorSession.open(
      { captureClasses: ['stdout'], spoolRoot },
      { collectorCredentials: [bearer, capability], environment: {} },
    );
    session.observeCommandFinished({
      commandId: randomUUID(),
      outcome: 'succeeded',
      stdout: artifactBytes,
    });
    session.observeRunFinished({ outcome: 'succeeded' });
    session.close();

    using work = CollectorWorkSpool.open({ spoolRoot });
    const result = await new DeliveryCoordinator(
      work,
      deliveryConfig(base, repositoryId, bearer),
    ).drain();
    expect(result).toMatchObject({
      batches: { delivered: 1 },
      artifacts: { verified: 1 },
      remaining: { blocked: 0, readyOrDelayed: 0 },
    });
    expect(uploaded).not.toEqual(artifactBytes);
    expect(uploaded.includes(Buffer.from(bearer))).toBe(false);
    expect(uploaded.includes(Buffer.from(capability))).toBe(false);
    expect(createHash('sha256').update(uploaded).digest('hex')).toBe(
      declaration!.sha256,
    );
    expect(requests.filter((item) => item.path.includes('/tus/'))).toHaveLength(
      Math.ceil(declaration!.byteLength / 5),
    );
    for (const request of requests) {
      if (request.path.includes('/tus/')) {
        expect(request.authorization).toBeUndefined();
        expect(request.capability).toBe(capability);
      } else {
        expect(request.authorization).toBe(`Bearer ${bearer}`);
        expect(request.capability).toBeUndefined();
      }
      expect(request.body.includes(Buffer.from(bearer))).toBe(false);
      expect(request.body.includes(Buffer.from(capability))).toBe(false);
    }
    for (const request of requests.filter(
      (item) =>
        item.path.endsWith('/uploads') || item.path.endsWith('/complete'),
    ))
      expect(request.body.toString('utf8')).toBe('{}');
    for (const file of files(spoolRoot)) {
      const bytes = readFileSync(file);
      expect(bytes.includes(Buffer.from(bearer))).toBe(false);
      expect(bytes.includes(Buffer.from(capability))).toBe(false);
    }
    expect(JSON.stringify(result)).not.toContain(bearer);
    expect(JSON.stringify(result)).not.toContain(capability);
    expect(JSON.stringify(work.status())).not.toContain(bearer);
    expect(JSON.stringify(work.status())).not.toContain(capability);
  });

  it('atomically splits only explicit oversized batches and blocks one-event batches', async () => {
    const spoolRoot = root();
    const repositoryId = randomUUID();
    let requests = 0;
    let rejectSingles = false;
    const base = await listen((request, response) => {
      void (async () => {
        const batch = JSON.parse(
          (await readBody(request)).toString('utf8'),
        ) as {
          batchId: string;
          runId: string;
          events: unknown[];
        };
        requests += 1;
        if (batch.events.length > 1 || rejectSingles)
          json(response, 413, {
            error: { code: 'payload_too_large', message: 'too large' },
          });
        else json(response, 202, accepted(batch));
      })();
    });
    const session = CollectorSession.open({ spoolRoot });
    for (let index = 0; index < 2; index += 1) session.observeRunStarted({});
    session.observeRunFinished({ outcome: 'succeeded' });
    session.close();
    using work = CollectorWorkSpool.open({ spoolRoot });
    const result = await new DeliveryCoordinator(
      work,
      deliveryConfig(base, repositoryId, 'token'),
    ).drain();
    expect(result.batches).toMatchObject({
      blocked: 0,
      delivered: 3,
      superseded: 1,
    });
    expect(requests).toBe(4);

    const singleRoot = root();
    const single = CollectorSession.open({ spoolRoot: singleRoot });
    single.observeRunFinished({ outcome: 'succeeded' });
    single.close();
    rejectSingles = true;
    using singleWork = CollectorWorkSpool.open({ spoolRoot: singleRoot });
    const blocked = await new DeliveryCoordinator(
      singleWork,
      deliveryConfig(base, repositoryId, 'token'),
    ).drain();
    expect(blocked.batches.blocked).toBe(1);
    expect(blocked.remaining.blocked).toBe(1);
  });

  it('retries the identical batch after an ambiguous disconnect', async () => {
    const spoolRoot = root();
    const bodies: Buffer[] = [];
    let first = true;
    const base = await listen((request, response) => {
      void (async () => {
        const value = await readBody(request);
        bodies.push(value);
        if (first) {
          first = false;
          request.socket.destroy();
          return;
        }
        const batch = JSON.parse(value.toString('utf8')) as {
          batchId: string;
          runId: string;
        };
        json(response, 200, {
          ...accepted(batch),
          outcome: 'already_accepted',
        });
      })();
    });
    const session = CollectorSession.open({ spoolRoot });
    session.observeRunStarted({});
    session.observeRunFinished({ outcome: 'succeeded' });
    session.close();
    using work = CollectorWorkSpool.open({ spoolRoot });
    const result = await new DeliveryCoordinator(
      work,
      deliveryConfig(base, randomUUID(), 'token'),
    ).drain();
    expect(result.batches).toMatchObject({ delivered: 1, retried: 1 });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
  });

  it.each(['mismatched-success', 'retry-after'] as const)(
    'retains work without false acknowledgement for %s',
    async (mode) => {
      const spoolRoot = root();
      const base = await listen((request, response) => {
        void (async () => {
          const batch = JSON.parse(
            (await readBody(request)).toString('utf8'),
          ) as { batchId: string; runId: string };
          if (mode === 'mismatched-success')
            json(response, 202, {
              ...accepted(batch),
              batchId: randomUUID(),
            });
          else {
            response.setHeader('retry-after', '999999');
            json(response, 429, {
              error: { code: 'internal_error', message: 'later' },
            });
          }
        })();
      });
      const session = CollectorSession.open({ spoolRoot });
      session.observeRunFinished({ outcome: 'succeeded' });
      session.close();
      using work = CollectorWorkSpool.open({ spoolRoot });
      const settings = {
        ...deliveryConfig(base, randomUUID(), 'token'),
        drainMaxAttempts: 1,
        retryMaxMs: 20,
      };
      const before = Date.now();
      const result = await new DeliveryCoordinator(work, settings).drain();
      expect(result.batches).toMatchObject({ delivered: 0, retried: 1 });
      const status = work.status();
      expect(status.batches.pending).toBe(1);
      expect(status.batches.delivered).toBe(0);
      expect(Date.parse(status.nextRetryAt!)).toBeGreaterThan(before);
      expect(Date.parse(status.nextRetryAt!)).toBeLessThanOrEqual(
        Date.now() + settings.retryMaxMs,
      );
    },
  );

  it('keeps run-filtered drains isolated and concurrent drainers converge', async () => {
    const spoolRoot = root();
    const deliveredRuns: string[] = [];
    const base = await listen((request, response) => {
      void (async () => {
        const batch = JSON.parse(
          (await readBody(request)).toString('utf8'),
        ) as {
          batchId: string;
          runId: string;
        };
        deliveredRuns.push(batch.runId);
        json(response, 202, accepted(batch));
      })();
    });
    const first = CollectorSession.open({ spoolRoot });
    first.observeRunStarted({});
    first.observeRunFinished({ outcome: 'succeeded' });
    const firstRun = first.runId;
    first.close();
    const second = CollectorSession.open({ spoolRoot });
    second.observeRunStarted({});
    second.observeRunFinished({ outcome: 'succeeded' });
    const secondRun = second.runId;
    second.close();
    const settings = deliveryConfig(base, randomUUID(), 'token');
    using firstWork = CollectorWorkSpool.open({ spoolRoot });
    using contender = CollectorWorkSpool.open({ spoolRoot });
    const [one, two] = await Promise.all([
      new DeliveryCoordinator(firstWork, settings).drain(firstRun),
      new DeliveryCoordinator(contender, settings).drain(firstRun),
    ]);
    expect(one.batches.delivered + two.batches.delivered).toBe(1);
    expect(deliveredRuns).toEqual([firstRun]);
    using remaining = CollectorWorkSpool.open({ spoolRoot });
    expect(remaining.status(secondRun).batches.delivered).toBe(0);
    const final = await new DeliveryCoordinator(remaining, settings).drain(
      secondRun,
    );
    expect(final.batches.delivered).toBe(1);
    expect(deliveredRuns).toEqual([firstRun, secondRun]);
  });

  it('stops at the distinct-item bound with remaining work recoverable', async () => {
    const spoolRoot = root();
    const base = await listen((request, response) => {
      void (async () => {
        const batch = JSON.parse(
          (await readBody(request)).toString('utf8'),
        ) as { batchId: string; runId: string };
        json(response, 202, accepted(batch));
      })();
    });
    for (let index = 0; index < 2; index += 1) {
      const session = CollectorSession.open({ spoolRoot });
      session.observeRunFinished({ outcome: 'succeeded' });
      session.close();
    }
    using work = CollectorWorkSpool.open({ spoolRoot });
    const result = await new DeliveryCoordinator(work, {
      ...deliveryConfig(base, randomUUID(), 'token'),
      drainMaxItems: 1,
    }).drain();
    expect(result).toMatchObject({
      batches: { delivered: 1 },
      claimedItems: 1,
      remaining: { readyOrDelayed: 1 },
      stopped: 'bounds-reached',
    });
  });

  it('does not claim new work when the remaining drain budget is insufficient', async () => {
    const spoolRoot = root();
    let requests = 0;
    const base = await listen((request, response) => {
      void (async () => {
        requests += 1;
        const batch = JSON.parse(
          (await readBody(request)).toString('utf8'),
        ) as { batchId: string; runId: string };
        json(response, 202, accepted(batch));
      })();
    });
    const session = CollectorSession.open({ spoolRoot });
    session.observeRunFinished({ outcome: 'succeeded' });
    session.close();
    const times = [0, 1];
    using work = CollectorWorkSpool.open({ spoolRoot });
    const result = await new DeliveryCoordinator(
      work,
      {
        ...deliveryConfig(base, randomUUID(), 'token'),
        drainMaxElapsedMs: 100,
      },
      { now: () => times.shift() ?? 1 },
    ).drain();
    expect(result).toMatchObject({
      batches: { delivered: 0 },
      claimedItems: 0,
      remaining: { readyOrDelayed: 1 },
      stopped: 'bounds-reached',
    });
    expect(requests).toBe(0);
    const claim = work.claimBatch();
    expect(claim?.attemptCount).toBe(1);
    work.releaseBatch(claim!.id, claim!.leaseToken);
  });

  it('cancels an in-flight request at the drain deadline without acknowledging it', async () => {
    const spoolRoot = root();
    let immediate = false;
    let cancelledAt: number | undefined;
    let leaseExpiresAt: number | undefined;
    let requests = 0;
    let resolveCancellation!: () => void;
    const cancellation = new Promise<void>((resolve) => {
      resolveCancellation = resolve;
    });
    const base = await listen((request, response) => {
      void (async () => {
        requests += 1;
        const batch = JSON.parse(
          (await readBody(request)).toString('utf8'),
        ) as { batchId: string; runId: string };
        using database = new DatabaseSync(join(spoolRoot, 'spool.sqlite3'), {
          readOnly: true,
        });
        leaseExpiresAt = (
          database
            .prepare(
              'SELECT lease_expires_at_ms FROM batch_work WHERE batch_id=?',
            )
            .get(batch.batchId) as { lease_expires_at_ms: number }
        ).lease_expires_at_ms;
        response.on('close', () => {
          if (!immediate && cancelledAt === undefined) {
            cancelledAt = Date.now();
            resolveCancellation();
          }
        });
        if (immediate) json(response, 202, accepted(batch));
        else
          setTimeout(() => {
            json(response, 202, accepted(batch));
          }, 300);
      })();
    });
    const session = CollectorSession.open({ spoolRoot });
    session.observeRunFinished({ outcome: 'succeeded' });
    session.close();
    using work = CollectorWorkSpool.open({ spoolRoot });
    const settings = {
      ...deliveryConfig(base, randomUUID(), 'token'),
      drainMaxAttempts: 1,
      drainMaxElapsedMs: 150,
      overallTimeoutMs: 5_000,
      requestTimeoutMs: 5_000,
      retryBaseMs: 1,
      retryMaxMs: 1,
    };
    const startedAt = Date.now();
    const first = await new DeliveryCoordinator(work, settings).drain();
    const finishedAt = Date.now();
    await Promise.race([
      cancellation,
      new Promise((resolve) => setTimeout(resolve, 100)),
    ]);
    expect(finishedAt - startedAt).toBeLessThan(500);
    expect(first).toMatchObject({
      batches: { delivered: 0, retried: 1 },
      remaining: { readyOrDelayed: 1 },
      stopped: 'bounds-reached',
    });
    expect(cancelledAt).toBeDefined();
    expect(leaseExpiresAt).toBeDefined();
    expect(cancelledAt!).toBeLessThan(leaseExpiresAt!);
    expect(leaseExpiresAt! - startedAt).toBeGreaterThanOrEqual(1_000);
    expect(work.status().batches).toMatchObject({ delivered: 0, pending: 1 });

    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(work.status().batches).toMatchObject({ delivered: 0, pending: 1 });
    immediate = true;
    const second = await new DeliveryCoordinator(work, settings).drain();
    expect(second.batches.delivered).toBe(1);
    expect(work.status().batches.delivered).toBe(1);
    expect(requests).toBe(2);
  });

  it.each(['missing', 'corrupt'] as const)(
    'blocks %s immutable artifact bytes without uploading or false verification',
    async (failure) => {
      const spoolRoot = root();
      let declaration:
        { artifactId: string; byteLength: number; sha256: string } | undefined;
      let base = '';
      let tusRequests = 0;
      const uploadId = randomUUID();
      base = await listen((request, response) => {
        void (async () => {
          const value = await readBody(request);
          if (request.url?.endsWith('/evidence-batches')) {
            const batch = JSON.parse(value.toString('utf8')) as {
              batchId: string;
              runId: string;
              events: Array<{
                payload: { stdout?: { artifact?: typeof declaration } };
              }>;
            };
            declaration = batch.events
              .map((event) => event.payload.stdout?.artifact)
              .find(Boolean);
            json(response, 202, accepted(batch));
          } else if (request.url?.endsWith('/uploads')) {
            json(response, 201, {
              schemaVersion: 1,
              outcome: 'upload_authorized',
              artifactId: declaration!.artifactId,
              uploadId,
              protocol: 'tus',
              endpoint: `${base}/tus`,
              capabilityToken: 'capability',
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              requiredChunkSize: 4,
              maximumBytes: declaration!.byteLength,
            });
          } else {
            tusRequests += 1;
            response.writeHead(204, { 'upload-offset': '0' }).end();
          }
        })();
      });
      const session = CollectorSession.open({
        captureClasses: ['stdout'],
        spoolRoot,
      });
      session.observeCommandFinished({
        commandId: randomUUID(),
        outcome: 'succeeded',
        stdout: Buffer.from('artifact'),
      });
      session.observeRunFinished({ outcome: 'succeeded' });
      session.close();
      const artifactFile = readdirSync(join(spoolRoot, 'artifacts')).find(
        (file) => file.endsWith('.artifact'),
      );
      const artifactPath = join(spoolRoot, 'artifacts', artifactFile!);
      if (failure === 'missing') unlinkSync(artifactPath);
      else appendFileSync(artifactPath, 'corrupt');
      using work = CollectorWorkSpool.open({ spoolRoot });
      const result = await new DeliveryCoordinator(
        work,
        deliveryConfig(base, randomUUID(), 'token'),
      ).drain();
      expect(result).toMatchObject({
        artifacts: { blocked: 1, verified: 0 },
        remaining: { blocked: 1 },
      });
      expect(tusRequests).toBe(0);
    },
  );

  it.each(['expired', 'rejected'] as const)(
    'replaces a remotely %s attempt and resumes verification after restart',
    async (remoteState) => {
      const spoolRoot = root();
      const session = CollectorSession.open({
        captureClasses: ['stdout'],
        spoolRoot,
      });
      const event = session.observeCommandFinished({
        commandId: randomUUID(),
        outcome: 'succeeded',
        stdout: Buffer.from('restart-safe-artifact'),
      });
      session.observeRunFinished({ outcome: 'succeeded' });
      session.close();
      if (
        event.kind !== 'command.finished' ||
        event.payload.stdout.state !== 'captured' ||
        !event.payload.stdout.artifact
      )
        throw new Error('expected artifact');
      const declaration = event.payload.stdout.artifact;
      const oldUpload = randomUUID();
      const freshUpload = randomUUID();
      using work = CollectorWorkSpool.open({ spoolRoot });
      work.prepareBatches();
      const batchClaim = work.claimBatch()!;
      const batch = JSON.parse(batchClaim.body) as {
        batchId: string;
        runId: string;
      };
      work.acknowledgeBatchDelivery(batch.batchId, batchClaim.leaseToken, {
        outcome: 'accepted',
        batchId: batch.batchId,
        runId: batch.runId,
        receivedAt: '2026-09-28T10:00:00.000Z',
      });
      const seeded = work.claimArtifact()!;
      expect('relativePath' in seeded).toBe(false);
      expect(Object.isFrozen(seeded)).toBe(true);
      expect(Object.isFrozen(seeded.declaration)).toBe(true);
      work.bindArtifactUpload(seeded.id, seeded.leaseToken, oldUpload);
      work.releaseArtifact(seeded.id, seeded.leaseToken);

      let base = '';
      let sessionRequests = 0;
      let completionRequests = 0;
      let patchRequests = 0;
      let replacementIssued = false;
      base = await listen((request, response) => {
        void (async () => {
          await readBody(request);
          if (request.url?.endsWith('/storage')) {
            json(
              response,
              200,
              replacementIssued
                ? {
                    schemaVersion: 1,
                    artifactId: declaration.artifactId,
                    uploadId: freshUpload,
                    state: 'verifying',
                    expiresAt: new Date(Date.now() + 60_000).toISOString(),
                  }
                : remoteState === 'expired'
                  ? {
                      schemaVersion: 1,
                      artifactId: declaration.artifactId,
                      uploadId: oldUpload,
                      state: 'expired',
                      expiresAt: new Date(Date.now() - 1_000).toISOString(),
                    }
                  : {
                      schemaVersion: 1,
                      artifactId: declaration.artifactId,
                      uploadId: oldUpload,
                      state: 'rejected',
                      reason: 'integrity_mismatch',
                    },
            );
          } else if (request.url?.endsWith('/uploads')) {
            sessionRequests += 1;
            replacementIssued = true;
            json(response, 201, {
              schemaVersion: 1,
              outcome: 'upload_authorized',
              artifactId: declaration.artifactId,
              uploadId: freshUpload,
              protocol: 'tus',
              endpoint: `${base}/tus/${freshUpload}`,
              capabilityToken: 'fresh-capability',
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              requiredChunkSize: declaration.byteLength,
              maximumBytes: declaration.byteLength,
            });
          } else if (request.url === `/tus/${freshUpload}`) {
            patchRequests += 1;
            response.writeHead(204, {
              'tus-resumable': '1.0.0',
              'upload-offset': String(declaration.byteLength),
            });
            response.end();
          } else if (
            request.url?.endsWith(`/uploads/${freshUpload}/complete`)
          ) {
            completionRequests += 1;
            json(
              response,
              completionRequests === 1 ? 202 : 200,
              completionRequests === 1
                ? {
                    schemaVersion: 1,
                    outcome: 'verification_in_progress',
                    artifactId: declaration.artifactId,
                    uploadId: freshUpload,
                    retryable: true,
                  }
                : {
                    schemaVersion: 1,
                    outcome: 'verified',
                    artifactId: declaration.artifactId,
                    verification: {
                      uploadId: freshUpload,
                      byteLength: declaration.byteLength,
                      sha256: declaration.sha256,
                      verifiedAt: '2026-09-28T10:00:02.000Z',
                    },
                  },
            );
          } else response.writeHead(404).end();
        })();
      });
      const settings = {
        ...deliveryConfig(base, randomUUID(), 'token'),
        drainMaxAttempts: 1,
      };
      const first = await new DeliveryCoordinator(work, settings).drain();
      expect(first.artifacts).toMatchObject({ retried: 1, verified: 0 });
      expect(work.status().artifacts.pending).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 25));
      const second = await new DeliveryCoordinator(work, settings).drain();
      expect(second.artifacts.verified).toBe(1);
      expect(work.status().artifacts.verified).toBe(1);
      expect({ completionRequests, patchRequests, sessionRequests }).toEqual({
        completionRequests: 2,
        patchRequests: 1,
        sessionRequests: 1,
      });
    },
  );

  it.each(['issued', 'verifying'] as const)(
    'rejects an already-verified upload identity after status %s for the bound attempt',
    async (remoteState) => {
      const spoolRoot = root();
      const { declaration, uploadId: boundUploadId } =
        seedBoundArtifact(spoolRoot);
      const contradictoryUploadId = randomUUID();
      const base = await listen((request, response) => {
        void (async () => {
          await readBody(request);
          if (request.url?.endsWith('/storage'))
            json(response, 200, {
              schemaVersion: 1,
              artifactId: declaration.artifactId,
              uploadId: boundUploadId,
              state: remoteState,
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            });
          else if (request.url?.endsWith('/uploads'))
            json(response, 200, {
              schemaVersion: 1,
              outcome: 'already_verified',
              artifactId: declaration.artifactId,
              verification: {
                uploadId: contradictoryUploadId,
                byteLength: declaration.byteLength,
                sha256: declaration.sha256,
                verifiedAt: '2026-09-28T10:00:03.000Z',
              },
            });
          else if (request.url?.endsWith(`/${boundUploadId}/complete`))
            json(response, 200, {
              schemaVersion: 1,
              outcome: 'already_verified',
              artifactId: declaration.artifactId,
              verification: {
                uploadId: contradictoryUploadId,
                byteLength: declaration.byteLength,
                sha256: declaration.sha256,
                verifiedAt: '2026-09-28T10:00:03.000Z',
              },
            });
          else response.writeHead(404).end();
        })();
      });
      using work = CollectorWorkSpool.open({ spoolRoot });
      const result = await new DeliveryCoordinator(work, {
        ...deliveryConfig(base, randomUUID(), 'token'),
        drainMaxAttempts: 1,
        retryBaseMs: 1,
        retryMaxMs: 1,
      }).drain();
      expect(result.artifacts).toMatchObject({ retried: 1, verified: 0 });
      expect(work.status().artifacts).toMatchObject({
        pending: 1,
        verified: 0,
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const retained = work.claimArtifact()!;
      expect(retained.uploadId).toBe(boundUploadId);
      work.releaseArtifact(retained.id, retained.leaseToken);
    },
  );

  it.each(['issued', 'verifying'] as const)(
    'accepts matching terminal evidence after status %s for the bound attempt',
    async (remoteState) => {
      const spoolRoot = root();
      const { declaration, uploadId } = seedBoundArtifact(spoolRoot);
      const base = await listen((request, response) => {
        void (async () => {
          await readBody(request);
          if (request.url?.endsWith('/storage'))
            json(response, 200, {
              schemaVersion: 1,
              artifactId: declaration.artifactId,
              uploadId,
              state: remoteState,
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            });
          else if (request.url?.endsWith('/uploads'))
            json(response, 200, {
              schemaVersion: 1,
              outcome: 'already_verified',
              artifactId: declaration.artifactId,
              verification: {
                uploadId,
                byteLength: declaration.byteLength,
                sha256: declaration.sha256,
                verifiedAt: '2026-09-28T10:00:03.000Z',
              },
            });
          else if (request.url?.endsWith(`/${uploadId}/complete`))
            json(response, 200, {
              schemaVersion: 1,
              outcome: 'verified',
              artifactId: declaration.artifactId,
              verification: {
                uploadId,
                byteLength: declaration.byteLength,
                sha256: declaration.sha256,
                verifiedAt: '2026-09-28T10:00:03.000Z',
              },
            });
          else response.writeHead(404).end();
        })();
      });
      using work = CollectorWorkSpool.open({ spoolRoot });
      const result = await new DeliveryCoordinator(
        work,
        deliveryConfig(base, randomUUID(), 'token'),
      ).drain();
      expect(result.artifacts).toMatchObject({ retried: 0, verified: 1 });
      expect(work.status().artifacts.verified).toBe(1);
    },
  );

  it('accepts only matching already-verified session evidence', async () => {
    const spoolRoot = root();
    const session = CollectorSession.open({
      captureClasses: ['stdout'],
      spoolRoot,
    });
    const event = session.observeCommandFinished({
      commandId: randomUUID(),
      outcome: 'succeeded',
      stdout: Buffer.from('already verified'),
    });
    session.observeRunFinished({ outcome: 'succeeded' });
    session.close();
    if (
      event.kind !== 'command.finished' ||
      event.payload.stdout.state !== 'captured' ||
      !event.payload.stdout.artifact
    )
      throw new Error('expected artifact');
    const declaration = event.payload.stdout.artifact;
    const uploadId = randomUUID();
    const base = await listen((request, response) => {
      void (async () => {
        const value = await readBody(request);
        if (request.url?.endsWith('/evidence-batches')) {
          const batch = JSON.parse(value.toString('utf8')) as {
            batchId: string;
            runId: string;
          };
          json(response, 202, accepted(batch));
        } else if (request.url?.endsWith('/uploads'))
          json(response, 200, {
            schemaVersion: 1,
            outcome: 'already_verified',
            artifactId: declaration.artifactId,
            verification: {
              uploadId,
              byteLength: declaration.byteLength,
              sha256: declaration.sha256,
              verifiedAt: '2026-09-28T10:00:03.000Z',
            },
          });
        else response.writeHead(500).end();
      })();
    });
    using work = CollectorWorkSpool.open({ spoolRoot });
    const result = await new DeliveryCoordinator(
      work,
      deliveryConfig(base, randomUUID(), 'token'),
    ).drain();
    expect(result.artifacts.verified).toBe(1);
    expect(work.status().artifacts.verified).toBe(1);
  });
});
