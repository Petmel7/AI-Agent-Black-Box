import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { observeArtifactStream } from './artifact-integrity.js';

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('artifact stream integrity', () => {
  it('hashes exact chunked bytes without combining them into a whole-object buffer', async () => {
    const chunks = [
      Buffer.from('redacted-'),
      Buffer.from('artifact'),
      Buffer.from('-bytes'),
    ];
    const bytes = Buffer.concat(chunks);
    await expect(
      observeArtifactStream(Readable.from(chunks), 100),
    ).resolves.toEqual({
      byteLength: BigInt(bytes.length),
      sha256: sha256(bytes),
      exceededLimit: false,
    });
  });

  it.each([
    ['one byte changed', Buffer.from('abd'), Buffer.from('abc')],
    ['truncated', Buffer.from('ab'), Buffer.from('abc')],
    ['extended', Buffer.from('abcd'), Buffer.from('abc')],
  ])('makes %s observably different', async (_name, actual, declared) => {
    const observation = await observeArtifactStream(
      Readable.from([actual]),
      100,
    );
    expect(
      observation.byteLength === BigInt(declared.length) &&
        observation.sha256 === sha256(declared),
    ).toBe(false);
  });

  it('counts and hashes compressed transport bytes exactly', async () => {
    const compressed = Buffer.from([0x1f, 0x8b, 0x08, 0, 1, 2, 3, 4]);
    await expect(
      observeArtifactStream(Readable.from([compressed]), 100),
    ).resolves.toEqual({
      byteLength: 8n,
      sha256: sha256(compressed),
      exceededLimit: false,
    });
  });

  it('stops once the observed stream crosses the configured limit', async () => {
    const observation = await observeArtifactStream(
      Readable.from([Buffer.alloc(4), Buffer.alloc(4)]),
      7,
    );
    expect(observation).toMatchObject({ byteLength: 8n, exceededLimit: true });
  });
});
