import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import {
  ArtifactReadError,
  readVerifiedArtifact,
  SupabaseArtifactReader,
  type ArtifactObjectReader,
} from './index.js';

const bytes = Buffer.from('{"ok":true}\n');
const sha256 = createHash('sha256').update(bytes).digest('hex');

function reader(value: Buffer): ArtifactObjectReader {
  return { open: async () => Readable.from([value]) };
}

const options = {
  expectedBytes: bytes.byteLength,
  expectedSha256: sha256,
  maximumBytes: 100,
  inactivityTimeoutMs: 100,
  attemptTimeoutMs: 500,
};

describe('bounded artifact reads', () => {
  it('returns only exact independently verified bytes', async () => {
    await expect(
      readVerifiedArtifact(reader(bytes), 'server-key', options),
    ).resolves.toEqual(bytes);
  });

  it.each([
    ['artifact_stream_underflow', bytes.subarray(0, bytes.length - 1), options],
    [
      'artifact_stream_overflow',
      Buffer.concat([bytes, Buffer.from('x')]),
      options,
    ],
    [
      'artifact_hash_mismatch',
      Buffer.from('{"no":true}\n'),
      { ...options, expectedBytes: 12 },
    ],
  ])(
    'rejects %s without returning partial bytes',
    async (code, value, configured) => {
      await expect(
        readVerifiedArtifact(reader(value as Buffer), 'server-key', configured),
      ).rejects.toMatchObject({ code });
    },
  );

  it('cancels and destroys an in-flight stream', async () => {
    const controller = new AbortController();
    const stream = new Readable({ read() {} });
    const pending = readVerifiedArtifact(
      { open: async () => stream },
      'server-key',
      { ...options, signal: controller.signal },
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      code: 'artifact_read_cancelled',
    });
    expect(stream.destroyed).toBe(true);
  });
});

describe('SupabaseArtifactReader', () => {
  it('uses private credentials only on a redirect-disabled authenticated request', async () => {
    const request = vi.fn<typeof fetch>(async (input, init) => {
      void input;
      void init;
      return new Response(bytes);
    });
    const value = new SupabaseArtifactReader({
      url: 'https://example.supabase.co',
      serviceRoleKey: 'secret',
      bucket: 'private',
      fetch: request,
    });
    await value.open({ objectKey: 'server/key' });
    const [url, init] = request.mock.calls[0]!;
    expect(url).toContain('/authenticated/private/server/key');
    expect(init).toMatchObject({ redirect: 'manual' });
    expect((init?.headers as Record<string, string>).authorization).toBe(
      'Bearer secret',
    );
    expect((init?.headers as Record<string, string>).apikey).toBe('secret');
  });

  it('classifies missing and provider failures without exposing provider bodies', async () => {
    const missing = new SupabaseArtifactReader({
      url: 'https://example.supabase.co',
      serviceRoleKey: 'secret',
      bucket: 'private',
      fetch: vi.fn(
        async () => new Response('provider body', { status: 404 }),
      ) as typeof fetch,
    });
    await expect(missing.open({ objectKey: 'server-key' })).rejects.toEqual(
      expect.objectContaining<Partial<ArtifactReadError>>({
        code: 'artifact_object_missing',
      }),
    );
  });

  it('cancels rejected provider bodies and classifies caller cancellation', async () => {
    const cancel = vi.fn();
    const unavailable = new SupabaseArtifactReader({
      url: 'https://example.supabase.co',
      serviceRoleKey: 'secret',
      bucket: 'private',
      fetch: vi.fn(
        async () =>
          new Response(new ReadableStream({ cancel }), { status: 503 }),
      ) as typeof fetch,
    });
    await expect(
      unavailable.open({ objectKey: 'server-key' }),
    ).rejects.toMatchObject({
      code: 'artifact_provider_unavailable',
      retryable: true,
    });
    expect(cancel).toHaveBeenCalledOnce();
    const controller = new AbortController();
    controller.abort();
    await expect(
      unavailable.open({ objectKey: 'server-key', signal: controller.signal }),
    ).rejects.toMatchObject({
      code: 'artifact_read_cancelled',
    });
  });

  it.each([301, 302, 303, 307, 308])(
    'deterministically rejects redirect status %s and cancels its body',
    async (status) => {
      const cancel = vi.fn();
      const body = new ReadableStream({ cancel });
      const value = new SupabaseArtifactReader({
        url: 'https://example.supabase.co',
        serviceRoleKey: 'secret',
        bucket: 'private',
        fetch: vi.fn(
          async () => new Response(body, { status }),
        ) as typeof fetch,
      });
      await expect(
        value.open({ objectKey: 'server-key' }),
      ).rejects.toMatchObject({
        code: 'artifact_redirect_rejected',
        retryable: false,
      });
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it('enforces the headers deadline even when the fetch implementation ignores abort', async () => {
    const value = new SupabaseArtifactReader({
      url: 'https://example.supabase.co',
      serviceRoleKey: 'secret',
      bucket: 'private',
      connectTimeoutMs: 5,
      fetch: vi.fn(
        () => new Promise<Response>(() => undefined),
      ) as typeof fetch,
    });
    await expect(value.open({ objectKey: 'server-key' })).rejects.toMatchObject(
      {
        code: 'artifact_read_timeout',
        retryable: true,
      },
    );
  });
});

describe('stream deadlines and cleanup', () => {
  it('classifies a slow body as inactivity and destroys it', async () => {
    const stream = new Readable({ read() {} });
    await expect(
      readVerifiedArtifact({ open: async () => stream }, 'server-key', {
        ...options,
        inactivityTimeoutMs: 5,
      }),
    ).rejects.toMatchObject({ code: 'artifact_read_inactivity_timeout' });
    expect(stream.destroyed).toBe(true);
  });
});
