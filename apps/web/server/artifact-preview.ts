import 'server-only';

import {
  ArtifactReadError,
  readVerifiedArtifact,
  type ArtifactObjectReader,
} from '@blackbox/artifact-storage';
import type {
  DashboardArtifactPreview,
  DashboardArtifactPreviewReader,
  DashboardArtifactPreviewUnavailableReason,
} from '@blackbox/database';

export interface DashboardPreviewLimits {
  maximumBytes: number;
  inactivityTimeoutMs: number;
  attemptTimeoutMs: number;
}

function mediaType(value: string): 'application/json' | 'text/plain' | null {
  const parts = value
    .toLowerCase()
    .split(';')
    .map((part) => part.trim());
  if (parts.length > 2) return null;
  if (
    parts[1] !== undefined &&
    parts[1] !== 'charset=utf-8' &&
    parts[1] !== 'charset="utf-8"'
  )
    return null;
  return parts[0] === 'application/json' || parts[0] === 'text/plain'
    ? parts[0]
    : null;
}

function reason(
  error: ArtifactReadError,
): DashboardArtifactPreviewUnavailableReason {
  switch (error.code) {
    case 'artifact_object_missing':
      return 'object_missing';
    case 'artifact_redirect_rejected':
      return 'redirect_rejected';
    case 'artifact_read_timeout':
      return 'read_timeout';
    case 'artifact_read_inactivity_timeout':
      return 'read_inactivity_timeout';
    case 'artifact_read_cancelled':
      return 'read_cancelled';
    case 'artifact_provider_unavailable':
      return 'provider_unavailable';
    case 'artifact_stream_overflow':
    case 'artifact_stream_underflow':
    case 'artifact_hash_mismatch':
      return 'integrity_check_failed';
  }
}

function unavailable(
  reason: DashboardArtifactPreviewUnavailableReason,
): DashboardArtifactPreview {
  return { state: 'unavailable', reason };
}

function resolvesJsonPointer(value: unknown, pointer: string): boolean {
  if (pointer === '') return true;
  let current = value;
  for (const encoded of pointer.slice(1).split('/')) {
    const segment = encoded.replace(/~1/g, '/').replace(/~0/g, '~');
    if (
      current === null ||
      typeof current !== 'object' ||
      !Object.prototype.hasOwnProperty.call(current, segment)
    )
      return false;
    current = (current as Record<string, unknown>)[segment];
  }
  return true;
}

/** Reads once and returns text only after every integrity and content check. */
export function createDashboardArtifactPreviewReader(
  reader: ArtifactObjectReader,
  limits: DashboardPreviewLimits,
): DashboardArtifactPreviewReader {
  return async (source, signal) => {
    const allowedMediaType = mediaType(source.mediaType);
    if (!allowedMediaType) return unavailable('unsupported_media_type');
    if (source.compression !== null)
      return unavailable('unsupported_compression');
    if (
      source.characterEncoding !== null &&
      source.characterEncoding.toLowerCase() !== 'utf-8'
    )
      return unavailable('unsupported_character_encoding');
    if (source.expectedBytes > limits.maximumBytes)
      return unavailable('artifact_too_large');
    let bytes: Uint8Array;
    try {
      bytes = await readVerifiedArtifact(reader, source.objectKey, {
        expectedBytes: source.expectedBytes,
        expectedSha256: source.expectedSha256,
        maximumBytes: limits.maximumBytes,
        inactivityTimeoutMs: limits.inactivityTimeoutMs,
        attemptTimeoutMs: limits.attemptTimeoutMs,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      return error instanceof ArtifactReadError
        ? unavailable(reason(error))
        : unavailable(
            signal?.aborted ? 'read_cancelled' : 'provider_unavailable',
          );
    }
    if (bytes.includes(0)) return unavailable('binary_content');
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return unavailable('invalid_utf8');
    }
    if (allowedMediaType === 'application/json') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return unavailable('invalid_json');
      }
      if (
        source.jsonPointer !== null &&
        !resolvesJsonPointer(parsed, source.jsonPointer)
      )
        return unavailable('json_pointer_unresolved');
    } else if (source.jsonPointer !== null) {
      return unavailable('json_pointer_unresolved');
    }
    return {
      state: 'available',
      mediaType: allowedMediaType,
      text,
      byteLength: bytes.byteLength,
    };
  };
}
