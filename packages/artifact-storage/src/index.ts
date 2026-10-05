import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

export interface ArtifactObjectReader {
  open(input: { objectKey: string; signal?: AbortSignal }): Promise<Readable>;
}

export type ArtifactReadErrorCode =
  | 'artifact_read_cancelled'
  | 'artifact_read_timeout'
  | 'artifact_read_inactivity_timeout'
  | 'artifact_object_missing'
  | 'artifact_provider_unavailable'
  | 'artifact_redirect_rejected'
  | 'artifact_stream_overflow'
  | 'artifact_stream_underflow'
  | 'artifact_hash_mismatch';

export class ArtifactReadError extends Error {
  constructor(
    readonly code: ArtifactReadErrorCode,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = 'ArtifactReadError';
  }
}

export interface BoundedReadOptions {
  expectedBytes: number;
  expectedSha256: string;
  maximumBytes: number;
  inactivityTimeoutMs: number;
  attemptTimeoutMs: number;
  signal?: AbortSignal;
}

export interface ArtifactStreamObservation {
  byteLength: bigint;
  sha256: string;
  exceededLimit: boolean;
}

export interface ArtifactObservationOptions {
  inactivityTimeoutMs: number;
  signal?: AbortSignal;
}

/** Hashes and counts exact stored bytes without whole-object buffering. */
export async function observeArtifactStream(
  stream: Readable,
  maximumBytes: number,
  options?: ArtifactObservationOptions,
): Promise<ArtifactStreamObservation> {
  positive(maximumBytes, 'maximumBytes');
  if (options) positive(options.inactivityTimeoutMs, 'inactivityTimeoutMs');
  const controller = new AbortController();
  const abort = () => controller.abort(options?.signal?.reason);
  options?.signal?.addEventListener('abort', abort, { once: true });
  if (options?.signal?.aborted) controller.abort(options.signal.reason);
  let inactivity: ReturnType<typeof setTimeout> | undefined;
  const resetInactivity = () => {
    if (!options) return;
    if (inactivity) clearTimeout(inactivity);
    inactivity = setTimeout(
      () =>
        controller.abort(
          new ArtifactReadError('artifact_read_inactivity_timeout', true),
        ),
      options.inactivityTimeoutMs,
    );
  };
  const onAbort = () => stream.destroy(new Error('aborted'));
  controller.signal.addEventListener('abort', onAbort, { once: true });
  const hash = createHash('sha256');
  let byteLength = 0n;
  try {
    if (controller.signal.aborted)
      throw controller.signal.reason instanceof ArtifactReadError
        ? controller.signal.reason
        : new ArtifactReadError('artifact_read_cancelled', true);
    resetInactivity();
    for await (const chunk of stream) {
      resetInactivity();
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteLength += BigInt(bytes.byteLength);
      hash.update(bytes);
      if (byteLength > BigInt(maximumBytes)) {
        stream.destroy();
        return { byteLength, sha256: hash.digest('hex'), exceededLimit: true };
      }
    }
    return { byteLength, sha256: hash.digest('hex'), exceededLimit: false };
  } catch (error) {
    if (controller.signal.aborted)
      throw controller.signal.reason instanceof ArtifactReadError
        ? controller.signal.reason
        : new ArtifactReadError('artifact_read_cancelled', true, {
            cause: error,
          });
    throw error;
  } finally {
    if (inactivity) clearTimeout(inactivity);
    options?.signal?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', onAbort);
    if (controller.signal.aborted) stream.destroy();
  }
}

function positive(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new TypeError(`${name} must be a positive safe integer.`);
}

/** Reads one object once, enforcing exact length/hash and shared cancellation bounds. */
export async function readVerifiedArtifact(
  reader: ArtifactObjectReader,
  objectKey: string,
  options: BoundedReadOptions,
): Promise<Uint8Array> {
  positive(options.maximumBytes, 'maximumBytes');
  positive(options.inactivityTimeoutMs, 'inactivityTimeoutMs');
  positive(options.attemptTimeoutMs, 'attemptTimeoutMs');
  if (
    !Number.isSafeInteger(options.expectedBytes) ||
    options.expectedBytes < 0 ||
    options.expectedBytes > options.maximumBytes
  )
    throw new ArtifactReadError('artifact_stream_overflow', false);
  if (!/^[0-9a-f]{64}$/.test(options.expectedSha256))
    throw new TypeError('expectedSha256 must be lowercase SHA-256.');

  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  let timeoutKind: 'overall' | 'inactivity' | null = null;
  const overall = setTimeout(() => {
    timeoutKind = 'overall';
    controller.abort();
  }, options.attemptTimeoutMs);
  let inactivity: ReturnType<typeof setTimeout> | undefined;
  const resetInactivity = () => {
    if (inactivity) clearTimeout(inactivity);
    inactivity = setTimeout(() => {
      timeoutKind = 'inactivity';
      controller.abort();
    }, options.inactivityTimeoutMs);
  };
  resetInactivity();
  let stream: Readable | undefined;
  try {
    if (options.signal?.aborted)
      throw new ArtifactReadError('artifact_read_cancelled', true);
    stream = await reader.open({ objectKey, signal: controller.signal });
    if (controller.signal.aborted) {
      stream.destroy();
      throw new ArtifactReadError(
        options.signal?.aborted
          ? 'artifact_read_cancelled'
          : timeoutKind === 'inactivity'
            ? 'artifact_read_inactivity_timeout'
            : 'artifact_read_timeout',
        true,
      );
    }
    const onAbort = () => stream?.destroy(new Error('aborted'));
    controller.signal.addEventListener('abort', onAbort, { once: true });
    const chunks: Buffer[] = [];
    const hash = createHash('sha256');
    let bytes = 0;
    try {
      for await (const chunk of stream) {
        resetInactivity();
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += value.byteLength;
        if (bytes > options.expectedBytes || bytes > options.maximumBytes) {
          stream.destroy();
          throw new ArtifactReadError('artifact_stream_overflow', false);
        }
        hash.update(value);
        chunks.push(value);
      }
    } finally {
      controller.signal.removeEventListener('abort', onAbort);
    }
    if (bytes < options.expectedBytes)
      throw new ArtifactReadError('artifact_stream_underflow', false);
    if (hash.digest('hex') !== options.expectedSha256)
      throw new ArtifactReadError('artifact_hash_mismatch', false);
    return Buffer.concat(chunks, bytes);
  } catch (error) {
    if (error instanceof ArtifactReadError) throw error;
    if (timeoutKind === 'overall')
      throw new ArtifactReadError('artifact_read_timeout', true, {
        cause: error,
      });
    if (timeoutKind === 'inactivity')
      throw new ArtifactReadError('artifact_read_inactivity_timeout', true, {
        cause: error,
      });
    if (options.signal?.aborted)
      throw new ArtifactReadError('artifact_read_cancelled', true, {
        cause: error,
      });
    throw error;
  } finally {
    clearTimeout(overall);
    if (inactivity) clearTimeout(inactivity);
    options.signal?.removeEventListener('abort', abort);
    if (controller.signal.aborted) stream?.destroy();
  }
}

export interface SupabaseArtifactReaderConfig {
  url: string | undefined;
  serviceRoleKey: string | undefined;
  bucket: string | undefined;
  connectTimeoutMs?: number;
  fetch?: typeof fetch;
}

function required(value: string | undefined, label: string): string {
  const result = value?.trim();
  if (!result) throw new Error(`Missing ${label} storage configuration.`);
  return result;
}

function encodePath(value: string): string {
  return value.split('/').map(encodeURIComponent).join('/');
}

/** Private authenticated Supabase reader. Construction validates and performs no I/O. */
export class SupabaseArtifactReader implements ArtifactObjectReader {
  private readonly baseUrl: string;
  private readonly serviceRoleKey: string;
  private readonly bucket: string;
  private readonly connectTimeoutMs: number;
  private readonly request: typeof fetch;

  constructor(config: SupabaseArtifactReaderConfig) {
    const rawUrl = required(config.url, 'URL');
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new Error('Storage URL configuration is invalid.');
    }
    if (url.protocol !== 'https:' && url.hostname !== 'localhost')
      throw new Error('Storage URL must use HTTPS.');
    this.baseUrl = url.toString().replace(/\/$/, '');
    this.serviceRoleKey = required(config.serviceRoleKey, 'service-role key');
    this.bucket = required(config.bucket, 'bucket');
    this.connectTimeoutMs = config.connectTimeoutMs ?? 10_000;
    positive(this.connectTimeoutMs, 'connectTimeoutMs');
    this.request = config.fetch ?? fetch;
  }

  async open(input: {
    objectKey: string;
    signal?: AbortSignal;
  }): Promise<Readable> {
    const controller = new AbortController();
    const abort = () => controller.abort(input.signal?.reason);
    input.signal?.addEventListener('abort', abort, { once: true });
    if (input.signal?.aborted) controller.abort(input.signal.reason);
    if (controller.signal.aborted) {
      input.signal?.removeEventListener('abort', abort);
      throw new ArtifactReadError('artifact_read_cancelled', true);
    }
    let timedOut = false;
    let rejectDeadline: ((error: Error) => void) | undefined;
    const deadline = new Promise<never>((_, reject) => {
      rejectDeadline = reject;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      rejectDeadline?.(new Error('artifact_headers_timeout'));
    }, this.connectTimeoutMs);
    let response: Response;
    try {
      response = await Promise.race([
        this.request(
          `${this.baseUrl}/storage/v1/object/authenticated/${encodePath(this.bucket)}/${encodePath(input.objectKey)}`,
          {
            redirect: 'manual',
            signal: controller.signal,
            headers: {
              authorization: `Bearer ${this.serviceRoleKey}`,
              apikey: this.serviceRoleKey,
            },
          },
        ),
        deadline,
      ]);
    } catch (error) {
      if (
        input.signal?.aborted &&
        input.signal.reason instanceof ArtifactReadError
      )
        throw input.signal.reason;
      if (input.signal?.aborted)
        throw new ArtifactReadError('artifact_read_cancelled', true, {
          cause: error,
        });
      if (timedOut)
        throw new ArtifactReadError('artifact_read_timeout', true, {
          cause: error,
        });
      throw new ArtifactReadError('artifact_provider_unavailable', true, {
        cause: error,
      });
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', abort);
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel().catch(() => undefined);
      throw new ArtifactReadError('artifact_redirect_rejected', false);
    }
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      throw new ArtifactReadError('artifact_object_missing', true);
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      throw new ArtifactReadError(
        'artifact_provider_unavailable',
        response.status >= 500,
      );
    }
    return Readable.fromWeb(response.body);
  }
}
