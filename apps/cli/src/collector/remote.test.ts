import { randomUUID } from 'node:crypto';
import { createServer, type RequestListener, type Server } from 'node:http';
import { performance } from 'node:perf_hooks';
import { Readable } from 'node:stream';

import type { ArtifactReference } from '@blackbox/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import type { ArtifactWorkClaim, BatchWorkClaim } from './delivery.js';
import type { DeliveryConfig } from './delivery-config.js';
import { CollectorError } from './errors.js';
import { BlackBoxClient, TusClient } from './remote.js';

const servers: Server[] = [];

async function listen(
  handler: RequestListener,
): Promise<{ server: Server; url: string }> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('missing address');
  return { server, url: `http://127.0.0.1:${address.port}` };
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
});

function config(apiBaseUrl: string, token = 'bearer-sentinel'): DeliveryConfig {
  return {
    apiBaseUrl,
    apiToken: token,
    connectTimeoutMs: 100,
    drainMaxAttempts: 10,
    drainMaxElapsedMs: 1_000,
    drainMaxItems: 10,
    overallTimeoutMs: 500,
    repositoryId: randomUUID(),
    requestTimeoutMs: 100,
    retryBaseMs: 10,
    retryMaxMs: 100,
  };
}

function batchClaim(body: string): BatchWorkClaim {
  return {
    attemptCount: 1,
    body,
    id: randomUUID(),
    leaseExpiresAt: new Date(Date.now() + 10_000).toISOString(),
    leaseToken: randomUUID(),
  };
}

async function body(request: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe('strict Black Box HTTP client', () => {
  it.each([
    [202, 'accepted'],
    [200, 'already_accepted'],
  ] as const)(
    'posts exact stable bytes and headers for %s',
    async (status, outcome) => {
      const requestBody = '{"stable":true}';
      const claim = batchClaim(requestBody);
      let observed: {
        authorization: string | undefined;
        contentType: string | undefined;
        value: string | undefined;
      } = {
        authorization: undefined,
        contentType: undefined,
        value: undefined,
      };
      const remote = await listen(async (request, response) => {
        observed = {
          authorization: request.headers.authorization,
          contentType: request.headers['content-type'],
          value: (await body(request)).toString('utf8'),
        };
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            outcome,
            batchId: claim.id,
            runId: randomUUID(),
            receivedAt: '2026-09-28T10:00:00.000Z',
          }),
        );
      });
      const client = new BlackBoxClient(config(remote.url));
      expect(await client.deliverBatch(claim, Date.now(), 500)).toMatchObject({
        kind: 'success',
        value: { batchId: claim.id, outcome },
      });
      expect(observed).toEqual({
        authorization: 'Bearer bearer-sentinel',
        contentType: 'application/json',
        value: requestBody,
      });
    },
  );

  it('classifies strict oversized, bounded Retry-After, and blocking responses', async () => {
    const responses = [
      {
        status: 413,
        headers: { 'content-type': 'application/json' },
        body: { error: { code: 'payload_too_large', message: 'too large' } },
      },
      {
        status: 429,
        headers: {
          'content-type': 'application/json',
          'retry-after': '999999',
        },
        body: { error: { code: 'internal_error', message: 'later' } },
      },
      {
        status: 401,
        headers: { 'content-type': 'application/json' },
        body: { error: { code: 'unauthorized', message: 'no' } },
      },
    ];
    const remote = await listen((_request, response) => {
      const item = responses.shift()!;
      response.writeHead(item.status, item.headers);
      response.end(JSON.stringify(item.body));
    });
    const client = new BlackBoxClient(config(remote.url));
    const claim = batchClaim('{}');
    expect(await client.deliverBatch(claim, 0, 500)).toEqual({
      kind: 'oversized',
    });
    expect(await client.deliverBatch(claim, 0, 500)).toEqual({
      kind: 'retry',
      code: 'network-failed',
      retryAfterMs: 999_999_000,
    });
    expect(await client.deliverBatch(claim, 0, 500)).toEqual({
      kind: 'block',
      code: 'authentication-failed',
    });
  });

  it.each([301, 302, 303, 307, 308])(
    'blocks redirect %s without following it',
    async (status) => {
      let requests = 0;
      const remote = await listen((_request, response) => {
        requests += 1;
        response.writeHead(status, { location: '/secret-target' });
        response.end();
      });
      const client = new BlackBoxClient(config(remote.url));
      expect(
        await client.deliverBatch(batchClaim('{}'), Date.now(), 500),
      ).toEqual({
        kind: 'block',
        code: 'validation-rejected',
      });
      expect(requests).toBe(1);
    },
  );

  it('fails closed on malformed, mismatched media, oversized, and timed-out responses', async () => {
    const modes = ['malformed', 'media', 'oversized', 'timeout'];
    const remote = await listen((_request, response) => {
      const mode = modes.shift();
      if (mode === 'timeout') return;
      if (mode === 'oversized') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('x'.repeat(70_000));
        return;
      }
      response.writeHead(200, {
        'content-type': mode === 'media' ? 'text/plain' : 'application/json',
      });
      response.end(mode === 'malformed' ? '{' : '{}');
    });
    const client = new BlackBoxClient(config(remote.url));
    for (const expected of [
      'response-invalid',
      'response-invalid',
      'response-invalid',
      'network-failed',
    ])
      expect(
        await client.deliverBatch(batchClaim('{}'), Date.now(), 500),
      ).toEqual({
        kind: 'retry',
        code: expected,
      });
  });

  it('requires strict error envelopes before classifying non-success responses', async () => {
    const responses = [
      { status: 401, mediaType: 'text/plain', value: 'unauthorized' },
      { status: 404, mediaType: 'application/json', value: '{}' },
      {
        status: 401,
        mediaType: 'application/json',
        value: JSON.stringify({
          error: { code: 'unauthorized', message: 'no', extra: true },
        }),
      },
    ];
    const remote = await listen((_request, response) => {
      const item = responses.shift()!;
      response.writeHead(item.status, { 'content-type': item.mediaType });
      response.end(item.value);
    });
    const client = new BlackBoxClient(config(remote.url));
    for (let index = 0; index < 3; index += 1)
      expect(
        await client.deliverBatch(batchClaim('{}'), Date.now(), 500),
      ).toEqual({
        kind: 'retry',
        code: 'response-invalid',
      });
  });

  it('classifies completion progress, integrity rejection, and mismatched verification', async () => {
    const artifactId = randomUUID();
    const uploadId = randomUUID();
    const responses = [
      {
        status: 202,
        value: {
          schemaVersion: 1,
          outcome: 'verification_in_progress',
          artifactId,
          uploadId,
          retryable: true,
        },
      },
      {
        status: 409,
        value: {
          schemaVersion: 1,
          outcome: 'rejected',
          artifactId,
          uploadId,
          reason: 'integrity_mismatch',
          retryable: false,
        },
      },
      {
        status: 200,
        value: {
          schemaVersion: 1,
          outcome: 'verified',
          artifactId,
          verification: {
            uploadId: randomUUID(),
            byteLength: 1,
            sha256: '0'.repeat(64),
            verifiedAt: '2026-09-28T10:00:00.000Z',
          },
        },
      },
      {
        status: 409,
        value: {
          error: { code: 'illegal_state', message: 'wrong state' },
        },
      },
    ];
    const remote = await listen((_request, response) => {
      const item = responses.shift()!;
      jsonResponse(response, item.status, item.value);
    });
    const client = new BlackBoxClient(config(remote.url));
    expect(
      await client.completeArtifact(artifactId, uploadId, Date.now(), 500),
    ).toEqual({
      kind: 'retry',
      code: 'network-failed',
    });
    expect(
      await client.completeArtifact(artifactId, uploadId, Date.now(), 500),
    ).toEqual({
      kind: 'block',
      code: 'integrity-rejected',
    });
    expect(
      await client.completeArtifact(artifactId, uploadId, Date.now(), 500),
    ).toEqual({
      kind: 'retry',
      code: 'response-invalid',
    });
    expect(
      await client.completeArtifact(artifactId, uploadId, Date.now(), 500),
    ).toEqual({
      kind: 'block',
      code: 'validation-rejected',
    });
  });
});

function jsonResponse(
  response: import('node:http').ServerResponse,
  status: number,
  value: unknown,
): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

function artifactClaim(bytes: Buffer): ArtifactWorkClaim {
  const declaration: ArtifactReference = {
    artifactId: randomUUID(),
    kind: 'command-output',
    mediaType: 'text/plain',
    byteLength: bytes.byteLength,
    sha256: '0'.repeat(64),
    redaction: { applied: true, rulesetVersion: 'collector-redaction-v1' },
    characterEncoding: 'utf-8',
  };
  return {
    attemptCount: 1,
    declaration,
    id: declaration.artifactId,
    leaseExpiresAt: new Date(Date.now() + 10_000).toISOString(),
    leaseToken: randomUUID(),
    readRange: async (offset, length) =>
      Readable.from(bytes.subarray(offset, offset + length)),
    runId: randomUUID(),
  };
}

describe('strict TUS client', () => {
  it('streams exact bounded chunks with capability isolation', async () => {
    const bytes = Buffer.from('abcdefghij');
    const claim = artifactClaim(bytes);
    let offset = 0;
    const chunks: Buffer[] = [];
    const headers: Record<string, string | undefined>[] = [];
    const remote = await listen(async (request, response) => {
      headers.push({
        authorization: request.headers.authorization,
        capability: request.headers['x-signature'] as string | undefined,
        tus: request.headers['tus-resumable'] as string | undefined,
      });
      const chunk = await body(request);
      chunks.push(chunk);
      expect(Number(request.headers['upload-offset'])).toBe(offset);
      offset += chunk.byteLength;
      response.writeHead(204, {
        'tus-resumable': '1.0.0',
        'upload-offset': String(offset),
      });
      response.end();
    });
    const client = new TusClient(config(remote.url, 'api-secret'));
    const result = await client.upload(
      claim,
      {
        schemaVersion: 1,
        outcome: 'upload_authorized',
        artifactId: claim.id,
        uploadId: randomUUID(),
        protocol: 'tus',
        endpoint: remote.url,
        capabilityToken: 'capability-sentinel',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        requiredChunkSize: 4,
        maximumBytes: bytes.byteLength,
      },
      Date.now,
      Date.now() + 500,
    );
    expect(result).toEqual({ kind: 'success', value: undefined });
    expect(Buffer.concat(chunks)).toEqual(bytes);
    expect(chunks.map((chunk) => chunk.byteLength)).toEqual([4, 4, 2]);
    expect(headers).toEqual(
      Array.from({ length: 3 }, () => ({
        authorization: undefined,
        capability: 'capability-sentinel',
        tus: '1.0.0',
      })),
    );
  });

  it('allows a required chunk larger than the artifact and streams one bounded final chunk', async () => {
    const bytes = Buffer.from('tiny');
    const claim = artifactClaim(bytes);
    let uploaded: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    const remote = await listen(async (request, response) => {
      uploaded = await body(request);
      response.writeHead(204, {
        'tus-resumable': '1.0.0',
        'upload-offset': String(uploaded.byteLength),
      });
      response.end();
    });
    const client = new TusClient(config(remote.url));
    expect(
      await client.upload(
        claim,
        {
          schemaVersion: 1,
          outcome: 'upload_authorized',
          artifactId: claim.id,
          uploadId: randomUUID(),
          protocol: 'tus',
          endpoint: remote.url,
          capabilityToken: 'capability',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          requiredChunkSize: 8,
          maximumBytes: bytes.byteLength,
        },
        Date.now,
        Date.now() + 500,
      ),
    ).toEqual({ kind: 'success', value: undefined });
    expect(uploaded).toEqual(bytes);
  });

  it('cancels an in-flight TUS patch at the shared operation deadline', async () => {
    const bytes = Buffer.from('deadline');
    const claim = artifactClaim(bytes);
    const remote = await listen(async (request, response) => {
      await body(request);
      setTimeout(() => {
        if (!response.destroyed)
          response
            .writeHead(204, {
              'tus-resumable': '1.0.0',
              'upload-offset': String(bytes.byteLength),
            })
            .end();
      }, 300);
    });
    const settings = {
      ...config(remote.url),
      overallTimeoutMs: 5_000,
      requestTimeoutMs: 5_000,
    };
    const client = new TusClient(settings);
    const startedAt = Date.now();
    const outcome = await client.upload(
      claim,
      {
        schemaVersion: 1,
        outcome: 'upload_authorized',
        artifactId: claim.id,
        uploadId: randomUUID(),
        protocol: 'tus',
        endpoint: remote.url,
        capabilityToken: 'capability',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        requiredChunkSize: bytes.byteLength,
        maximumBytes: bytes.byteLength,
      },
      Date.now,
      Date.now() + 100,
    );
    expect(Date.now() - startedAt).toBeLessThan(300);
    expect(outcome).toEqual({ kind: 'retry', code: 'network-failed' });
  });

  it('does not start TUS PATCH when local range preparation misses the deadline', async () => {
    const bytes = Buffer.from('local-deadline');
    const claim = artifactClaim(bytes);
    let patches = 0;
    claim.readRange = async (_offset, _length, signal) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(Readable.from(bytes)), 500);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(
              new CollectorError(
                'lease-lost',
                'artifact range preparation was cancelled',
              ),
            );
          },
          { once: true },
        );
      });
    const remote = await listen((_request, response) => {
      patches += 1;
      response.writeHead(500).end();
    });
    const client = new TusClient(config(remote.url));
    const controller = new AbortController();
    const deadline = performance.now() + 50;
    const timer = setTimeout(() => controller.abort(), 50);
    const outcome = await client.upload(
      claim,
      {
        schemaVersion: 1,
        outcome: 'upload_authorized',
        artifactId: claim.id,
        uploadId: randomUUID(),
        protocol: 'tus',
        endpoint: remote.url,
        capabilityToken: 'capability',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        requiredChunkSize: bytes.byteLength,
        maximumBytes: bytes.byteLength,
      },
      Date.now,
      () => performance.now(),
      deadline,
      controller.signal,
    );
    clearTimeout(timer);
    expect(outcome).toEqual({ kind: 'retry', code: 'network-failed' });
    expect(patches).toBe(0);
  });

  it('reconciles one ambiguous interruption and resumes in the same process', async () => {
    const bytes = Buffer.from('abcdefgh');
    const claim = artifactClaim(bytes);
    let offset = 0;
    let interrupted = false;
    const remote = await listen(async (request, response) => {
      if (request.method === 'HEAD') {
        response.writeHead(200, {
          'tus-resumable': '1.0.0',
          'upload-offset': String(offset),
        });
        response.end();
        return;
      }
      const chunk = await body(request);
      offset += chunk.byteLength;
      if (!interrupted) {
        interrupted = true;
        request.socket.destroy();
        return;
      }
      response.writeHead(204, {
        'tus-resumable': '1.0.0',
        'upload-offset': String(offset),
      });
      response.end();
    });
    const client = new TusClient(config(remote.url));
    const outcome = await client.upload(
      claim,
      {
        schemaVersion: 1,
        outcome: 'upload_authorized',
        artifactId: claim.id,
        uploadId: randomUUID(),
        protocol: 'tus',
        endpoint: remote.url,
        capabilityToken: 'capability',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        requiredChunkSize: 4,
        maximumBytes: bytes.byteLength,
      },
      Date.now,
      Date.now() + 500,
    );
    expect(outcome).toEqual({ kind: 'success', value: undefined });
    expect(offset).toBe(bytes.byteLength);
  });

  it.each([301, 302, 303, 307, 308])(
    'blocks TUS redirect %s',
    async (status) => {
      const bytes = Buffer.from('abcd');
      const claim = artifactClaim(bytes);
      const remote = await listen((_request, response) => {
        response.writeHead(status, { location: '/elsewhere' });
        response.end();
      });
      const client = new TusClient(config(remote.url));
      expect(
        await client.upload(
          claim,
          {
            schemaVersion: 1,
            outcome: 'upload_authorized',
            artifactId: claim.id,
            uploadId: randomUUID(),
            protocol: 'tus',
            endpoint: remote.url,
            capabilityToken: 'capability',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            requiredChunkSize: 4,
            maximumBytes: 4,
          },
          Date.now,
          Date.now() + 500,
        ),
      ).toEqual({ kind: 'block', code: 'validation-rejected' });
    },
  );

  it('rejects zero chunk size, expired capability, small maximum, and invalid offsets', async () => {
    const claim = artifactClaim(Buffer.from('abcd'));
    const remote = await listen((_request, response) => {
      response.writeHead(204, {
        'tus-resumable': '1.0.0',
        'upload-offset': '3',
      });
      response.end();
    });
    const client = new TusClient(config(remote.url));
    const base = {
      schemaVersion: 1 as const,
      outcome: 'upload_authorized' as const,
      artifactId: claim.id,
      uploadId: randomUUID(),
      protocol: 'tus' as const,
      endpoint: remote.url,
      capabilityToken: 'capability',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      maximumBytes: 4,
    };
    expect(
      await client.upload(
        claim,
        { ...base, requiredChunkSize: 0 },
        Date.now,
        Date.now() + 500,
      ),
    ).toEqual({ kind: 'block', code: 'validation-rejected' });
    expect(
      await client.upload(
        claim,
        { ...base, expiresAt: new Date(Date.now() - 1).toISOString() },
        Date.now,
        Date.now() + 500,
      ),
    ).toEqual({ kind: 'block', code: 'validation-rejected' });
    expect(
      await client.upload(
        claim,
        { ...base, maximumBytes: 3 },
        Date.now,
        Date.now() + 500,
      ),
    ).toEqual({ kind: 'block', code: 'validation-rejected' });
    expect(
      await client.upload(
        claim,
        { ...base, requiredChunkSize: 4 },
        Date.now,
        Date.now() + 500,
      ),
    ).toEqual({ kind: 'retry', code: 'response-invalid' });
  });

  it.each(['2', '5', '-1', 'NaN'])(
    'rejects invalid resumed offset %s',
    async (offset) => {
      const claim = artifactClaim(Buffer.from('abcd'));
      const remote = await listen((_request, response) => {
        response.writeHead(200, {
          'tus-resumable': '1.0.0',
          'upload-offset': offset,
        });
        response.end();
      });
      const client = new TusClient(config(remote.url));
      expect(
        await client.upload(
          claim,
          {
            schemaVersion: 1,
            outcome: 'already_authorized',
            artifactId: claim.id,
            uploadId: randomUUID(),
            protocol: 'tus',
            endpoint: remote.url,
            capabilityToken: 'capability',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            requiredChunkSize: 4,
            maximumBytes: 4,
          },
          Date.now,
          Date.now() + 500,
        ),
      ).toEqual({ kind: 'retry', code: 'response-invalid' });
    },
  );
});
