import {
  ArtifactCompletionResponseSchema,
  ArtifactErrorResponseSchema,
  ArtifactStorageStatusResponseSchema,
  ArtifactUploadSessionResponseSchema,
  EvidenceBatchIngestionResponseSchema,
  IngestionErrorResponseSchema,
  type ArtifactCompletionResponse,
  type ArtifactReference,
  type ArtifactStorageStatusResponse,
  type ArtifactUploadSessionResponse,
  type EvidenceBatchIngestionResponse,
} from '@blackbox/contracts';

import type { ArtifactWorkClaim, BatchWorkClaim } from './delivery.js';
import { validateRemoteUrl, type DeliveryConfig } from './delivery-config.js';
import {
  hasJsonMediaType,
  SafeHttpClient,
  TransportError,
  type SafeHttpResponse,
} from './http.js';
import { CollectorError } from './errors.js';
import type { WorkErrorCode } from './spool.js';

export type RemoteOutcome<T> =
  | { kind: 'block'; code: WorkErrorCode }
  | { kind: 'retry'; code: WorkErrorCode; retryAfterMs?: number }
  | { kind: 'success'; retryAfterMs?: number; value: T };

export type BatchRemoteOutcome =
  RemoteOutcome<EvidenceBatchIngestionResponse> | { kind: 'oversized' };

function endpoint(config: DeliveryConfig, path: string): URL {
  return new URL(path, `${config.apiBaseUrl}/`);
}

function bearerHeaders(
  config: DeliveryConfig,
): Readonly<Record<string, string>> {
  return {
    accept: 'application/json',
    authorization: `Bearer ${config.apiToken}`,
    'content-type': 'application/json',
  };
}

function parseRetryAfter(
  value: string | undefined,
  now: number,
): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/u.test(value)) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) ? seconds * 1_000 : undefined;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.max(0, timestamp - now);
}

function retry(
  response: SafeHttpResponse,
  now: number,
  code: WorkErrorCode = 'network-failed',
): RemoteOutcome<never> {
  const retryAfterMs = parseRetryAfter(response.headers['retry-after'], now);
  return {
    kind: 'retry',
    code,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
}

function safeJson(response: SafeHttpResponse): unknown | undefined {
  if (!hasJsonMediaType(response.headers['content-type'])) return undefined;
  try {
    return JSON.parse(response.body) as unknown;
  } catch {
    return undefined;
  }
}

function transportFailure(error: unknown): RemoteOutcome<never> {
  return {
    kind: 'retry',
    code:
      error instanceof TransportError &&
      (error.failure === 'response-invalid' ||
        error.failure === 'response-too-large')
        ? 'response-invalid'
        : 'network-failed',
  };
}

function isRedirect(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}

function isRetryableStatus(status: number): boolean {
  return [408, 425, 429].includes(status) || status >= 500;
}

export class BlackBoxClient {
  readonly #http: SafeHttpClient;

  constructor(private readonly config: DeliveryConfig) {
    this.#http = new SafeHttpClient(config);
  }

  async deliverBatch(
    claim: BatchWorkClaim,
    now: number,
    operationBudgetMs: number,
  ): Promise<BatchRemoteOutcome> {
    let response: SafeHttpResponse;
    try {
      response = await this.#http.request(
        {
          body: claim.body,
          contentLength: Buffer.byteLength(claim.body),
          headers: bearerHeaders(this.config),
          method: 'POST',
          url: endpoint(
            this.config,
            `/v1/repositories/${this.config.repositoryId}/evidence-batches`,
          ),
        },
        operationBudgetMs,
      );
    } catch (error) {
      return transportFailure(error);
    }
    if (response.status === 200 || response.status === 202) {
      const parsed = EvidenceBatchIngestionResponseSchema.safeParse(
        safeJson(response),
      );
      return parsed.success
        ? { kind: 'success', value: parsed.data }
        : { kind: 'retry', code: 'response-invalid' };
    }
    if (isRedirect(response.status))
      return { kind: 'block', code: 'validation-rejected' };
    const error = IngestionErrorResponseSchema.safeParse(safeJson(response));
    if (!error.success) return { kind: 'retry', code: 'response-invalid' };
    if (isRetryableStatus(response.status)) return retry(response, now);
    if (response.status === 413) {
      return error.data.error.code === 'payload_too_large'
        ? { kind: 'oversized' }
        : { kind: 'retry', code: 'response-invalid' };
    }
    if (response.status === 401 && error.data.error.code === 'unauthorized')
      return { kind: 'block', code: 'authentication-failed' };
    if (
      response.status === 404 &&
      error.data.error.code === 'repository_not_found'
    )
      return { kind: 'block', code: 'ownership-rejected' };
    if (
      response.status === 409 &&
      error.data.error.code === 'evidence_conflict'
    )
      return { kind: 'block', code: 'integrity-rejected' };
    if ([400, 413, 415, 422].includes(response.status))
      return { kind: 'block', code: 'validation-rejected' };
    return { kind: 'retry', code: 'response-invalid' };
  }

  async artifactStatus(
    artifactId: string,
    now: number,
    operationBudgetMs: number,
  ): Promise<RemoteOutcome<ArtifactStorageStatusResponse>> {
    const outcome = await this.#jsonArtifactRequest(
      'GET',
      `/v1/repositories/${this.config.repositoryId}/artifacts/${artifactId}/storage`,
      ArtifactStorageStatusResponseSchema,
      now,
      operationBudgetMs,
    );
    return outcome.kind === 'success' && outcome.value.artifactId !== artifactId
      ? { kind: 'retry', code: 'response-invalid' }
      : outcome;
  }

  async createArtifactSession(
    artifactId: string,
    now: number,
    operationBudgetMs: number,
  ): Promise<RemoteOutcome<ArtifactUploadSessionResponse>> {
    const outcome = await this.#jsonArtifactRequest(
      'POST',
      `/v1/repositories/${this.config.repositoryId}/artifacts/${artifactId}/uploads`,
      ArtifactUploadSessionResponseSchema,
      now,
      operationBudgetMs,
      '{}',
    );
    return outcome.kind === 'success' && outcome.value.artifactId !== artifactId
      ? { kind: 'retry', code: 'response-invalid' }
      : outcome;
  }

  async completeArtifact(
    artifactId: string,
    uploadId: string,
    now: number,
    operationBudgetMs: number,
  ): Promise<RemoteOutcome<ArtifactCompletionResponse>> {
    const outcome = await this.#jsonArtifactRequest(
      'POST',
      `/v1/repositories/${this.config.repositoryId}/artifacts/${artifactId}/uploads/${uploadId}/complete`,
      ArtifactCompletionResponseSchema,
      now,
      operationBudgetMs,
      '{}',
      [409],
    );
    if (outcome.kind !== 'success') return outcome;
    if (
      outcome.value.artifactId !== artifactId ||
      ('uploadId' in outcome.value && outcome.value.uploadId !== uploadId) ||
      ('verification' in outcome.value &&
        outcome.value.verification.uploadId !== uploadId)
    )
      return { kind: 'retry', code: 'response-invalid' };
    if (outcome.value.outcome === 'verification_in_progress')
      return {
        kind: 'retry',
        code: 'network-failed',
        ...(outcome.retryAfterMs === undefined
          ? {}
          : { retryAfterMs: outcome.retryAfterMs }),
      };
    if (outcome.value.outcome === 'rejected')
      return { kind: 'block', code: 'integrity-rejected' };
    return outcome;
  }

  async #jsonArtifactRequest<T>(
    method: 'GET' | 'POST',
    path: string,
    schema: { safeParse(value: unknown): { success: boolean; data?: T } },
    now: number,
    operationBudgetMs: number,
    body?: string,
    additionalSuccessStatuses: readonly number[] = [],
  ): Promise<RemoteOutcome<T>> {
    let response: SafeHttpResponse;
    try {
      response = await this.#http.request(
        {
          ...(body === undefined
            ? {}
            : { body, contentLength: Buffer.byteLength(body) }),
          headers: bearerHeaders(this.config),
          method,
          url: endpoint(this.config, path),
        },
        operationBudgetMs,
      );
    } catch (error) {
      return transportFailure(error);
    }
    const successStatus =
      (response.status >= 200 && response.status < 300) ||
      additionalSuccessStatuses.includes(response.status);
    if (successStatus) {
      const parsed = schema.safeParse(safeJson(response));
      if (parsed.success && parsed.data !== undefined) {
        const retryAfterMs = parseRetryAfter(
          response.headers['retry-after'],
          now,
        );
        return {
          kind: 'success',
          value: parsed.data,
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        };
      }
      if (response.status >= 200 && response.status < 300)
        return { kind: 'retry', code: 'response-invalid' };
    }
    if (isRedirect(response.status))
      return { kind: 'block', code: 'validation-rejected' };
    const error = ArtifactErrorResponseSchema.safeParse(safeJson(response));
    if (!error.success) return { kind: 'retry', code: 'response-invalid' };
    if (isRetryableStatus(response.status)) return retry(response, now);
    if (response.status === 401 && error.data.error.code === 'unauthorized')
      return { kind: 'block', code: 'authentication-failed' };
    if (
      response.status === 404 &&
      error.data.error.code === 'artifact_not_found'
    )
      return { kind: 'block', code: 'ownership-rejected' };
    if (
      error.data.error.code === 'integrity_mismatch' ||
      error.data.error.code === 'declaration_too_large'
    )
      return { kind: 'block', code: 'integrity-rejected' };
    if (error.data.error.code === 'upload_expired')
      return { kind: 'retry', code: 'network-failed' };
    if ([400, 409, 413, 415, 422].includes(response.status))
      return { kind: 'block', code: 'validation-rejected' };
    return { kind: 'retry', code: 'response-invalid' };
  }
}

function parseOffset(response: SafeHttpResponse): number | undefined {
  const value = response.headers['upload-offset'];
  if (!value || !/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function validOffset(
  offset: number,
  previous: number,
  declaration: ArtifactReference,
  chunkSize: number,
): boolean {
  return (
    offset >= previous &&
    offset <= declaration.byteLength &&
    (offset === declaration.byteLength || offset % chunkSize === 0)
  );
}

export class TusClient {
  readonly #http: SafeHttpClient;

  constructor(private readonly config: DeliveryConfig) {
    this.#http = new SafeHttpClient(config);
  }

  async upload(
    claim: ArtifactWorkClaim,
    session: Extract<
      ArtifactUploadSessionResponse,
      { outcome: 'already_authorized' | 'upload_authorized' }
    >,
    wallNow: () => number,
    monotonicNowOrDeadline: (() => number) | number,
    operationDeadlineOrSignal?: number | AbortSignal,
    signal?: AbortSignal,
  ): Promise<RemoteOutcome<undefined>> {
    const monotonicNow =
      typeof monotonicNowOrDeadline === 'function'
        ? monotonicNowOrDeadline
        : wallNow;
    const operationDeadline =
      typeof monotonicNowOrDeadline === 'number'
        ? monotonicNowOrDeadline
        : (operationDeadlineOrSignal as number);
    const operationSignal =
      typeof monotonicNowOrDeadline === 'number'
        ? operationDeadlineOrSignal instanceof AbortSignal
          ? operationDeadlineOrSignal
          : undefined
        : signal;
    const endpointUrl = validateRemoteUrl(session.endpoint, 'TUS endpoint');
    const expiry = Date.parse(session.expiresAt);
    const chunkSize = session.requiredChunkSize ?? 1024 * 1024;
    if (
      session.artifactId !== claim.id ||
      session.maximumBytes < claim.declaration.byteLength ||
      !Number.isSafeInteger(chunkSize) ||
      chunkSize < 1 ||
      expiry <= wallNow()
    )
      return { kind: 'block', code: 'validation-rejected' };
    if (claim.declaration.byteLength === 0)
      return { kind: 'success', value: undefined };
    let offset = 0;
    let reconciled = false;
    if (session.outcome === 'already_authorized') {
      const headNow = monotonicNow();
      const head = await this.#head(
        endpointUrl,
        session.capabilityToken,
        wallNow(),
        operationDeadline - headNow,
      );
      if (head.kind !== 'success') return head;
      if (!validOffset(head.value, 0, claim.declaration, chunkSize))
        return { kind: 'retry', code: 'response-invalid' };
      offset = head.value;
      reconciled = true;
    }
    while (offset < claim.declaration.byteLength) {
      if (
        operationSignal?.aborted ||
        expiry <= wallNow() ||
        operationDeadline <= monotonicNow()
      )
        return { kind: 'retry', code: 'network-failed' };
      const length = Math.min(chunkSize, claim.declaration.byteLength - offset);
      try {
        const body = await claim.readRange(offset, length, operationSignal);
        const budget = operationDeadline - monotonicNow();
        if (operationSignal?.aborted || budget <= 0) {
          body.destroy();
          return { kind: 'retry', code: 'network-failed' };
        }
        const response = await this.#http.request(
          {
            body,
            contentLength: length,
            headers: {
              'content-type': 'application/offset+octet-stream',
              'tus-resumable': '1.0.0',
              'upload-offset': String(offset),
              'x-signature': session.capabilityToken,
            },
            method: 'PATCH',
            url: endpointUrl,
          },
          budget,
        );
        if (isRedirect(response.status))
          return { kind: 'block', code: 'validation-rejected' };
        if (response.status !== 204)
          return isRetryableStatus(response.status)
            ? retry(response, wallNow())
            : { kind: 'retry', code: 'response-invalid' };
        if (response.headers['tus-resumable'] !== '1.0.0')
          return { kind: 'retry', code: 'response-invalid' };
        const next = parseOffset(response);
        if (
          next === undefined ||
          next !== offset + length ||
          !validOffset(next, offset, claim.declaration, chunkSize)
        )
          return { kind: 'retry', code: 'response-invalid' };
        offset = next;
      } catch (error) {
        if (error instanceof CollectorError) {
          if (error.code === 'artifact-missing')
            return { kind: 'block', code: 'validation-rejected' };
          if (error.code === 'artifact-corrupt')
            return { kind: 'block', code: 'integrity-rejected' };
          if (error.code === 'lease-lost')
            return { kind: 'retry', code: 'network-failed' };
        }
        if (reconciled) return transportFailure(error);
        reconciled = true;
        const headNow = monotonicNow();
        const head = await this.#head(
          endpointUrl,
          session.capabilityToken,
          wallNow(),
          operationDeadline - headNow,
        );
        if (head.kind !== 'success') return head;
        if (!validOffset(head.value, offset, claim.declaration, chunkSize))
          return { kind: 'retry', code: 'response-invalid' };
        offset = head.value;
      }
    }
    return { kind: 'success', value: undefined };
  }

  async #head(
    url: URL,
    capability: string,
    now: number,
    operationBudgetMs: number,
  ): Promise<RemoteOutcome<number>> {
    let response: SafeHttpResponse;
    try {
      response = await this.#http.request(
        {
          headers: {
            'tus-resumable': '1.0.0',
            'x-signature': capability,
          },
          method: 'HEAD',
          url,
        },
        operationBudgetMs,
      );
    } catch (error) {
      return transportFailure(error);
    }
    if (isRedirect(response.status))
      return { kind: 'block', code: 'validation-rejected' };
    if (response.status !== 200 && response.status !== 204)
      return isRetryableStatus(response.status)
        ? retry(response, now)
        : { kind: 'retry', code: 'response-invalid' };
    if (response.headers['tus-resumable'] !== '1.0.0')
      return { kind: 'retry', code: 'response-invalid' };
    const offset = parseOffset(response);
    return offset === undefined
      ? { kind: 'retry', code: 'response-invalid' }
      : { kind: 'success', value: offset };
  }
}
