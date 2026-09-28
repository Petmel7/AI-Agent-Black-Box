import {
  UuidSchema,
  type ArtifactReference,
  type EvidenceBatch,
} from '@blackbox/contracts';
import type { Readable } from 'node:stream';

import { auditArtifacts, type ArtifactAudit } from './artifacts.js';
import {
  type CollectorConfigInput,
  validateCollectorConfig,
} from './config.js';
import {
  DELIVERY_SQLITE_BUSY_TIMEOUT_MS,
  LocalSpool,
  type StatusSummary,
  type WorkErrorCode,
} from './spool.js';

const DEFAULT_MAXIMUM_BATCHES = 100;
const MAXIMUM_BATCHES_PER_PREPARATION = 1_000;

export interface PrepareBatchesOptions {
  maximumBatches?: number;
  runId?: string;
}

export interface PrepareBatchesResult {
  batchesCreated: number;
  eventsBatched: number;
}

export interface BatchWorkClaim {
  attemptCount: number;
  body: string;
  id: string;
  leaseExpiresAt: string;
  leaseToken: string;
}

export interface ArtifactWorkClaim {
  attemptCount: number;
  declaration: ArtifactReference;
  id: string;
  leaseExpiresAt: string;
  leaseToken: string;
  readRange(
    offset: number,
    length: number,
    signal?: AbortSignal,
  ): Promise<Readable>;
  runId: string;
  uploadId?: string;
}

function parsePrepareBatchesOptions(
  value: unknown,
): Required<Pick<PrepareBatchesOptions, 'maximumBatches'>> &
  Pick<PrepareBatchesOptions, 'runId'> {
  if (value === undefined) return { maximumBatches: DEFAULT_MAXIMUM_BATCHES };
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new TypeError('batch preparation options must be a plain object');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== 'string') ||
    keys.some((key) => key !== 'maximumBatches' && key !== 'runId') ||
    Object.values(descriptors).some(
      (descriptor) =>
        descriptor.get !== undefined || descriptor.set !== undefined,
    )
  )
    throw new TypeError('batch preparation options contain unsafe fields');
  const maximumBatchesValue = descriptors.maximumBatches?.value as unknown;
  const runIdValue = descriptors.runId?.value as unknown;
  const maximumBatches =
    maximumBatchesValue === undefined
      ? DEFAULT_MAXIMUM_BATCHES
      : maximumBatchesValue;
  if (
    !Number.isSafeInteger(maximumBatches) ||
    Number(maximumBatches) < 1 ||
    Number(maximumBatches) > MAXIMUM_BATCHES_PER_PREPARATION
  )
    throw new TypeError(
      'maximumBatches must be an integer from 1 through 1000',
    );
  if (runIdValue !== undefined) UuidSchema.parse(runIdValue);
  return {
    maximumBatches: Number(maximumBatches),
    ...(runIdValue === undefined ? {} : { runId: String(runIdValue) }),
  };
}

export class CollectorWorkSpool implements Disposable {
  readonly #spool: LocalSpool;

  private constructor(spool: LocalSpool) {
    this.#spool = spool;
  }

  static open(config: CollectorConfigInput): CollectorWorkSpool {
    return new CollectorWorkSpool(
      new LocalSpool(validateCollectorConfig(config)).open({
        busyTimeoutMs: DELIVERY_SQLITE_BUSY_TIMEOUT_MS,
      }),
    );
  }

  status(runId?: string): StatusSummary {
    return structuredClone(this.#spool.status(runId));
  }

  auditArtifacts(): ArtifactAudit {
    return { ...auditArtifacts(this.#spool) };
  }

  recoverExpired(): { artifacts: number; batches: number; runs: number } {
    return { ...this.#spool.recoverExpired() };
  }

  prepareBatches(options?: PrepareBatchesOptions): PrepareBatchesResult {
    const parsed = parsePrepareBatchesOptions(options);
    let batchesCreated = 0;
    let eventsBatched = 0;
    while (batchesCreated < parsed.maximumBatches) {
      const runId = this.#spool.eligibleBatchRunIds(parsed.runId)[0];
      if (!runId) break;
      const batch = this.#spool.createBatch(runId);
      if (!batch) continue;
      batchesCreated += 1;
      eventsBatched += batch.events.length;
    }
    return Object.freeze({ batchesCreated, eventsBatched });
  }

  claimBatch(
    leaseMs?: number,
    runId?: string,
    maximumWaitMs?: number,
  ): BatchWorkClaim | undefined {
    const claim = this.#spool.claimBatch(
      leaseMs,
      undefined,
      runId,
      maximumWaitMs,
    );
    if (!claim?.body) return undefined;
    return Object.freeze({
      attemptCount: claim.attemptCount,
      body: claim.body,
      id: claim.id,
      leaseExpiresAt: claim.leaseExpiresAt,
      leaseToken: claim.leaseToken,
    });
  }

  claimArtifact(
    leaseMs?: number,
    runId?: string,
    maximumWaitMs?: number,
  ): ArtifactWorkClaim | undefined {
    const claim = this.#spool.claimArtifact(
      leaseMs,
      undefined,
      runId,
      maximumWaitMs,
    );
    if (!claim) return undefined;
    const declaration = structuredClone(claim.declaration);
    Object.freeze(declaration.redaction);
    Object.freeze(declaration);
    const result: ArtifactWorkClaim = {
      attemptCount: claim.attemptCount,
      declaration,
      id: claim.id,
      leaseExpiresAt: claim.leaseExpiresAt,
      leaseToken: claim.leaseToken,
      readRange: (offset, length, signal) =>
        this.#spool.openArtifactRange(
          claim.id,
          claim.leaseToken,
          offset,
          length,
          undefined,
          signal,
        ),
      runId: claim.runId,
      ...(claim.uploadId ? { uploadId: claim.uploadId } : {}),
    };
    return Object.freeze(result);
  }

  releaseBatch(id: string, token: string, nextAttemptAt?: number): void {
    this.#spool.releaseBatch(id, token, nextAttemptAt);
  }

  releaseArtifact(id: string, token: string, nextAttemptAt?: number): void {
    this.#spool.releaseArtifact(id, token, nextAttemptAt);
  }

  blockBatch(id: string, token: string, code: WorkErrorCode): void {
    this.#spool.blockBatch(id, token, code);
  }

  blockArtifact(id: string, token: string, code: WorkErrorCode): void {
    this.#spool.blockArtifact(id, token, code);
  }

  scheduleBatchRetry(
    id: string,
    token: string,
    nextAttemptAt: number,
    code: WorkErrorCode,
  ): void {
    this.#spool.scheduleBatchRetry(id, token, nextAttemptAt, code);
  }

  scheduleArtifactRetry(
    id: string,
    token: string,
    nextAttemptAt: number,
    code: WorkErrorCode,
  ): void {
    this.#spool.scheduleArtifactRetry(id, token, nextAttemptAt, code);
  }

  acknowledgeBatchDelivery(id: string, token: string, response: unknown): void {
    this.#spool.acknowledgeBatchDelivery(id, token, response);
  }

  bindArtifactUpload(id: string, token: string, uploadId: string): void {
    this.#spool.bindArtifactUpload(id, token, uploadId);
  }

  replaceArtifactUpload(
    id: string,
    token: string,
    previousUploadId: string,
    replacementUploadId: string,
  ): void {
    this.#spool.replaceArtifactUpload(
      id,
      token,
      previousUploadId,
      replacementUploadId,
    );
  }

  acknowledgeArtifactVerification(
    id: string,
    token: string,
    response: unknown,
  ): void {
    this.#spool.acknowledgeArtifactVerification(id, token, response);
  }

  supersedeOversizedBatch(
    id: string,
    token: string,
    rejection: unknown,
    maximumEvents: number,
  ): readonly EvidenceBatch[] {
    return structuredClone(
      this.#spool.supersedeOversizedBatch(id, token, rejection, maximumEvents),
    );
  }

  close(): void {
    this.#spool.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }
}
