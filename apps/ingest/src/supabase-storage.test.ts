import {
  createServer,
  type IncomingHttpHeaders,
  type RequestListener,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { SupabaseArtifactStorage } from './supabase-storage.js';

const now = new Date('2026-09-24T12:00:00.000Z');
const expiresAt = new Date('2026-09-24T12:15:00.000Z');

function token(expiry = expiresAt): string {
  return [
    Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url'),
    Buffer.from(
      JSON.stringify({ exp: Math.floor(expiry.getTime() / 1000) }),
    ).toString('base64url'),
    'provider-signature',
  ].join('.');
}

function adapter(request: typeof fetch) {
  return new SupabaseArtifactStorage({
    url: 'https://project.supabase.co',
    serviceRoleKey: 'service-secret',
    bucket: 'private-artifacts',
    fetch: request,
    now: () => now,
  });
}

async function loopbackServer(handler: RequestListener): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, 'localhost', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://localhost:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

describe('Supabase artifact storage adapter', () => {
  it('creates a signed non-upsert TUS session without leaking storage identity', async () => {
    const capabilityToken = token();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token: capabilityToken }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 201,
          headers: {
            location: '/storage/v1/upload/resumable/opaque-session-id',
          },
        }),
      );
    const storage = adapter(request);
    expect(request).not.toHaveBeenCalled();
    const capability = await storage.issueUploadCapability({
      objectKey: 'artifacts/server-owned/id',
      mediaType: 'application/json',
      byteLength: 42n,
    });
    expect(capability).toEqual({
      protocol: 'tus',
      endpoint:
        'https://project.supabase.co/storage/v1/upload/resumable/opaque-session-id',
      capabilityToken,
      expiresAt,
      requiredChunkSize: 6 * 1024 * 1024,
    });
    const [, signInit] = request.mock.calls[0]!;
    expect(signInit).toMatchObject({
      method: 'POST',
      redirect: 'error',
      body: JSON.stringify({}),
      headers: {
        authorization: 'Bearer service-secret',
        apikey: 'service-secret',
        'content-type': 'application/json',
      },
    });
    expect(String(request.mock.calls[0]![0])).toContain(
      '/private-artifacts/artifacts/server-owned/id',
    );
    const [tusUrl, tusInit] = request.mock.calls[1]!;
    expect(String(tusUrl)).toBe(
      'https://project.supabase.co/storage/v1/upload/resumable/sign',
    );
    expect(tusInit).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: {
        'tus-resumable': '1.0.0',
        'upload-length': '42',
        'x-signature': capabilityToken,
        'x-upsert': 'false',
      },
    });
    const tusHeaders = tusInit?.headers as Record<string, string>;
    expect(tusHeaders['upload-metadata']).toBe(
      [
        `bucketName ${Buffer.from('private-artifacts').toString('base64')}`,
        `objectName ${Buffer.from('artifacts/server-owned/id').toString('base64')}`,
        `contentType ${Buffer.from('application/json').toString('base64')}`,
      ].join(','),
    );
    expect(tusHeaders).not.toHaveProperty('authorization');
    expect(JSON.stringify(capability)).not.toContain('private-artifacts');
    expect(JSON.stringify(capability)).not.toContain(
      'artifacts/server-owned/id',
    );
  });

  it.each([301, 302, 303, 307, 308])(
    'never follows a cross-origin %s with storage secrets',
    async (status) => {
      const targetHeaders: IncomingHttpHeaders[] = [];
      const sourceHeaders: IncomingHttpHeaders[] = [];
      const target = await loopbackServer((request, response) => {
        targetHeaders.push(request.headers);
        response.writeHead(204).end();
      });
      const source = await loopbackServer((request, response) => {
        sourceHeaders.push(request.headers);
        if (
          request.url?.includes('/object/upload/sign/') &&
          !request.url.endsWith('/sign-redirect')
        ) {
          response
            .writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify({ token: token() }));
          return;
        }
        response.writeHead(status, { location: `${target.url}/capture` }).end();
      });
      try {
        const storage = new SupabaseArtifactStorage({
          url: source.url,
          serviceRoleKey: 'service-secret',
          bucket: 'private-artifacts',
          now: () => now,
        });
        await expect(
          storage.issueUploadCapability({
            objectKey: 'sign-redirect',
            mediaType: 'application/json',
            byteLength: 42n,
          }),
        ).rejects.toThrow();
        await expect(
          storage.issueUploadCapability({
            objectKey: 'tus-redirect',
            mediaType: 'application/json',
            byteLength: 42n,
          }),
        ).rejects.toThrow();
        await expect(storage.openReadable('read-redirect')).rejects.toThrow();
        await expect(storage.deleteObject('delete-redirect')).rejects.toThrow();

        expect(sourceHeaders.some((headers) => headers['x-signature'])).toBe(
          true,
        );
        expect(sourceHeaders.some((headers) => headers.apikey)).toBe(true);
        expect(sourceHeaders.some((headers) => headers.authorization)).toBe(
          true,
        );
        expect(targetHeaders).toEqual([]);
      } finally {
        await Promise.all([source.close(), target.close()]);
      }
    },
    15_000,
  );

  it.each([
    ['missing token', {}],
    ['malformed token', { token: 'not-a-jwt' }],
    ['expired token', { token: token(now) }],
  ])('rejects a %s provider capability response', async (_label, body) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(
      adapter(request).issueUploadCapability({
        objectKey: 'artifacts/server-owned/id',
        mediaType: 'application/json',
        byteLength: 42n,
      }),
    ).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['missing Location', new Response(null, { status: 201 })],
    [
      'failed session creation',
      new Response(JSON.stringify({ message: 'nope' }), { status: 400 }),
    ],
    [
      'cross-origin Location',
      new Response(null, {
        status: 201,
        headers: { location: 'https://attacker.example/session' },
      }),
    ],
    [
      'identity-leaking Location',
      new Response(null, {
        status: 201,
        headers: { location: '/session/private-artifacts' },
      }),
    ],
  ])('rejects %s', async (_label, sessionResponse) => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token: token() }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(sessionResponse);
    await expect(
      adapter(request).issueUploadCapability({
        objectKey: 'artifacts/server-owned/id',
        mediaType: 'application/json',
        byteLength: 42n,
      }),
    ).rejects.toThrow();
  });

  it('streams reads and keeps provider details inside the adapter', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('bytes', { status: 200 }));
    const storage = new SupabaseArtifactStorage({
      url: 'https://project.supabase.co',
      serviceRoleKey: 'service-secret',
      bucket: 'private-artifacts',
      fetch: request,
    });
    const stream = await storage.openReadable('opaque/key');
    const chunks: Buffer[] = [];
    for await (const chunk of stream as Readable)
      chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe('bytes');
  });

  it('fails closed for incomplete provider configuration', () => {
    expect(
      () =>
        new SupabaseArtifactStorage({
          url: 'https://project.supabase.co',
          serviceRoleKey: undefined,
          bucket: 'private-artifacts',
        }),
    ).toThrow('Missing service-role key storage configuration.');
  });
});
