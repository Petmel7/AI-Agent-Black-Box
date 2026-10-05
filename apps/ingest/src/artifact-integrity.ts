import type { Readable } from 'node:stream';

import {
  observeArtifactStream as observeSharedArtifactStream,
  type ArtifactObservationOptions,
  type ArtifactStreamObservation,
} from '@blackbox/artifact-storage';

export type { ArtifactStreamObservation } from '@blackbox/artifact-storage';

/** Hashes and counts the exact stored byte stream without whole-object buffering. */
export async function observeArtifactStream(
  stream: Readable,
  maximumBytes: number,
  options?: ArtifactObservationOptions,
): Promise<ArtifactStreamObservation> {
  return observeSharedArtifactStream(stream, maximumBytes, options);
}
