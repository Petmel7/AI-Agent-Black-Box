import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';

export interface ArtifactStreamObservation {
  byteLength: bigint;
  sha256: string;
  exceededLimit: boolean;
}

/** Hashes and counts the exact stored byte stream without whole-object buffering. */
export async function observeArtifactStream(
  stream: Readable,
  maximumBytes: number,
): Promise<ArtifactStreamObservation> {
  const hash = createHash('sha256');
  let byteLength = 0n;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += BigInt(bytes.byteLength);
    hash.update(bytes);
    if (byteLength > BigInt(maximumBytes)) {
      stream.destroy();
      return { byteLength, sha256: hash.digest('hex'), exceededLimit: true };
    }
  }
  return { byteLength, sha256: hash.digest('hex'), exceededLimit: false };
}
