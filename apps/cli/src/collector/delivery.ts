import { UuidSchema, type EvidenceBatch } from '@blackbox/contracts';

import { auditArtifacts, type ArtifactAudit } from './artifacts.js';
import {
  type CollectorConfigInput,
  validateCollectorConfig,
} from './config.js';
import {
  LocalSpool,
  type StatusSummary,
  type WorkClaim,
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
      new LocalSpool(validateCollectorConfig(config)).open(),
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

  claimBatch(leaseMs?: number): WorkClaim | undefined {
    const claim = this.#spool.claimBatch(leaseMs);
    return claim ? { ...claim } : undefined;
  }

  claimArtifact(leaseMs?: number): WorkClaim | undefined {
    const claim = this.#spool.claimArtifact(leaseMs);
    return claim ? { ...claim } : undefined;
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

  acknowledgeBatchDelivery(id: string, token: string, response: unknown): void {
    this.#spool.acknowledgeBatchDelivery(id, token, response);
  }

  bindArtifactUpload(id: string, token: string, uploadId: string): void {
    this.#spool.bindArtifactUpload(id, token, uploadId);
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
