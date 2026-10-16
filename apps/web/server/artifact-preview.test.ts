import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import {
  ArtifactReadError,
  type ArtifactObjectReader,
} from '@blackbox/artifact-storage';
import { describe, expect, it, vi } from 'vitest';

import { createDashboardArtifactPreviewReader } from './artifact-preview';

const limits = {
  maximumBytes: 64,
  inactivityTimeoutMs: 20,
  attemptTimeoutMs: 100,
};

function source(bytes: Uint8Array, mediaType = 'text/plain') {
  return {
    objectKey: 'private/storage/key',
    expectedBytes: bytes.byteLength,
    expectedSha256: createHash('sha256').update(bytes).digest('hex'),
    mediaType,
    compression: null,
    characterEncoding: 'utf-8',
    jsonPointer: null,
  };
}

function bytesReader(bytes: Uint8Array): ArtifactObjectReader {
  return { open: async () => Readable.from([bytes]) };
}

describe('dashboard artifact preview reader', () => {
  it.each([
    ['text/plain', 'plain evidence'],
    ['text/plain; charset=utf-8', '<script>untrusted()</script>'],
    ['application/json', '{"ok":true}'],
  ])('returns integrity-verified %s as inert text', async (mediaType, text) => {
    const bytes = Buffer.from(text);
    await expect(
      createDashboardArtifactPreviewReader(
        bytesReader(bytes),
        limits,
      )(source(bytes, mediaType)),
    ).resolves.toEqual({
      state: 'available',
      mediaType: mediaType.startsWith('application/json')
        ? 'application/json'
        : 'text/plain',
      text,
      byteLength: bytes.byteLength,
    });
  });

  it.each([
    ['binary_content', Buffer.from([65, 0, 66]), 'text/plain'],
    ['invalid_utf8', Buffer.from([0xc3, 0x28]), 'text/plain'],
    ['invalid_json', Buffer.from('{nope}'), 'application/json'],
  ])(
    'rejects %s without exposing partial bytes',
    async (reason, bytes, media) => {
      const result = await createDashboardArtifactPreviewReader(
        bytesReader(bytes),
        limits,
      )(source(bytes, media));
      expect(result).toEqual({ state: 'unavailable', reason });
      expect(result).not.toHaveProperty('text');
    },
  );

  it('rejects unsupported media, encoding, compression, and oversize before opening storage', async () => {
    const open = vi.fn(async () => Readable.from([]));
    const preview = createDashboardArtifactPreviewReader({ open }, limits);
    const bytes = Buffer.from('evidence');
    await expect(preview(source(bytes, 'text/html'))).resolves.toEqual({
      state: 'unavailable',
      reason: 'unsupported_media_type',
    });
    await expect(
      preview({ ...source(bytes), compression: 'gzip' }),
    ).resolves.toEqual({
      state: 'unavailable',
      reason: 'unsupported_compression',
    });
    await expect(
      preview({ ...source(bytes), characterEncoding: 'utf-16' }),
    ).resolves.toEqual({
      state: 'unavailable',
      reason: 'unsupported_character_encoding',
    });
    await expect(
      preview({ ...source(bytes), expectedBytes: 65 }),
    ).resolves.toEqual({
      state: 'unavailable',
      reason: 'artifact_too_large',
    });
    expect(open).not.toHaveBeenCalled();
  });

  it('requires an exact JSON pointer when one is part of the evidence locator', async () => {
    const bytes = Buffer.from('{"files":[{"path":"safe.txt"}]}');
    const preview = createDashboardArtifactPreviewReader(
      bytesReader(bytes),
      limits,
    );
    await expect(
      preview({
        ...source(bytes, 'application/json'),
        jsonPointer: '/files/0/path',
      }),
    ).resolves.toMatchObject({ state: 'available' });
    await expect(
      preview({
        ...source(bytes, 'application/json'),
        jsonPointer: '/files/2/path',
      }),
    ).resolves.toEqual({
      state: 'unavailable',
      reason: 'json_pointer_unresolved',
    });
    await expect(
      preview({ ...source(bytes), jsonPointer: '/files/0/path' }),
    ).resolves.toEqual({
      state: 'unavailable',
      reason: 'json_pointer_unresolved',
    });
  });

  it.each([
    ['artifact_stream_underflow', 'integrity_check_failed'],
    ['artifact_stream_overflow', 'integrity_check_failed'],
    ['artifact_hash_mismatch', 'integrity_check_failed'],
    ['artifact_object_missing', 'object_missing'],
    ['artifact_provider_unavailable', 'provider_unavailable'],
    ['artifact_redirect_rejected', 'redirect_rejected'],
    ['artifact_read_timeout', 'read_timeout'],
    ['artifact_read_inactivity_timeout', 'read_inactivity_timeout'],
    ['artifact_read_cancelled', 'read_cancelled'],
  ] as const)('maps %s to %s', async (code, reason) => {
    const preview = createDashboardArtifactPreviewReader(
      {
        open: async () => {
          throw new ArtifactReadError(code, false);
        },
      },
      limits,
    );
    const bytes = Buffer.from('evidence');
    await expect(preview(source(bytes))).resolves.toEqual({
      state: 'unavailable',
      reason,
    });
  });

  it('propagates cancellation bounds and leaves no partial preview', async () => {
    const stream = new Readable({ read() {} });
    const preview = createDashboardArtifactPreviewReader(
      { open: async () => stream },
      limits,
    );
    const bytes = Buffer.from('evidence');
    const controller = new AbortController();
    const pending = preview(source(bytes), controller.signal);
    controller.abort();
    await expect(pending).resolves.toEqual({
      state: 'unavailable',
      reason: 'read_cancelled',
    });
    expect(stream.destroyed).toBe(true);
  });
});
