import { EvidenceBatchSchema } from '@blackbox/contracts';
import { performance } from 'node:perf_hooks';

import type { DeliveryConfig } from './delivery-config.js';
import {
  CollectorWorkSpool,
  type ArtifactWorkClaim,
  type BatchWorkClaim,
} from './delivery.js';
import { CollectorError } from './errors.js';
import { BlackBoxClient, TusClient, type RemoteOutcome } from './remote.js';
import {
  DELIVERY_SQLITE_BUSY_TIMEOUT_MS,
  DELIVERY_TRANSITION_MARGIN_MS,
  MAX_DELIVERY_OPERATION_BUDGET_MS,
  MAX_WORK_LEASE_MS,
  MIN_DELIVERY_OPERATION_BUDGET_MS,
  type WorkErrorCode,
} from './spool.js';

export interface DeliveryDrainResult {
  artifacts: { blocked: number; retried: number; verified: number };
  attempts: number;
  batches: {
    blocked: number;
    delivered: number;
    retried: number;
    superseded: number;
  };
  claimedItems: number;
  preparedBatches: number;
  remaining: { blocked: number; readyOrDelayed: number };
  safeCodes: Readonly<Record<string, number>>;
  schemaVersion: 1;
  stopped: 'bounds-reached' | 'drained';
}

interface CoordinatorDependencies {
  blackBox?: BlackBoxClient;
  monotonicNow?(): number;
  now?(): number;
  random?(): number;
  sleep?(milliseconds: number): Promise<void>;
  tus?: TusClient;
  wallNow?(): number;
}

function emptyResult(preparedBatches: number): DeliveryDrainResult {
  return {
    artifacts: { blocked: 0, retried: 0, verified: 0 },
    attempts: 0,
    batches: { blocked: 0, delivered: 0, retried: 0, superseded: 0 },
    claimedItems: 0,
    preparedBatches,
    remaining: { blocked: 0, readyOrDelayed: 0 },
    safeCodes: {},
    schemaVersion: 1,
    stopped: 'drained',
  };
}

export class DeliveryCoordinator {
  readonly #blackBox: BlackBoxClient;
  readonly #monotonicNow: () => number;
  readonly #random: () => number;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #tus: TusClient;
  readonly #wallNow: () => number;

  constructor(
    private readonly spool: CollectorWorkSpool,
    private readonly config: DeliveryConfig,
    dependencies: CoordinatorDependencies = {},
  ) {
    this.#blackBox = dependencies.blackBox ?? new BlackBoxClient(config);
    this.#monotonicNow =
      dependencies.monotonicNow ??
      dependencies.now ??
      (() => performance.now());
    this.#wallNow = dependencies.wallNow ?? Date.now;
    this.#random = dependencies.random ?? Math.random;
    this.#sleep =
      dependencies.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#tus = dependencies.tus ?? new TusClient(config);
  }

  async drain(runId?: string): Promise<DeliveryDrainResult> {
    if (
      DELIVERY_TRANSITION_MARGIN_MS !==
        DELIVERY_SQLITE_BUSY_TIMEOUT_MS + 1_000 ||
      MAX_DELIVERY_OPERATION_BUDGET_MS + DELIVERY_TRANSITION_MARGIN_MS >
        MAX_WORK_LEASE_MS
    )
      throw new CollectorError(
        'invalid-config',
        'delivery timing limits violate the work lease bound',
      );
    const startedAt = this.#monotonicNow();
    const deadline = startedAt + this.config.drainMaxElapsedMs;
    this.spool.recoverExpired();
    const prepared = this.spool.prepareBatches({
      maximumBatches: this.config.drainMaxItems,
      ...(runId ? { runId } : {}),
    });
    const result = emptyResult(prepared.batchesCreated);
    const claimed = new Set<string>();
    let bounded = false;
    let readyClaimRecheckUsed = false;
    while (true) {
      const claimStartedAt = this.#monotonicNow();
      if (
        result.attempts >= this.config.drainMaxAttempts ||
        claimed.size >= this.config.drainMaxItems ||
        deadline - claimStartedAt < MIN_DELIVERY_OPERATION_BUDGET_MS
      ) {
        bounded = true;
        break;
      }
      const operationBudgetMs = Math.floor(
        Math.min(deadline - claimStartedAt, MAX_DELIVERY_OPERATION_BUDGET_MS),
      );
      const operationDeadline = claimStartedAt + operationBudgetMs;
      const leaseMs = operationBudgetMs + DELIVERY_TRANSITION_MARGIN_MS;
      const maximumWaitMs = Math.max(
        1,
        Math.floor(
          Math.min(operationBudgetMs, DELIVERY_SQLITE_BUSY_TIMEOUT_MS),
        ),
      );
      const batch = this.spool.claimBatch(leaseMs, runId, maximumWaitMs);
      if (batch) {
        readyClaimRecheckUsed = false;
        claimed.add(`batch:${batch.id}`);
        result.attempts += 1;
        await this.#deliverBatch(batch, result, operationDeadline);
        continue;
      }
      const artifactClaimStartedAt = this.#monotonicNow();
      const artifactBudgetMs = Math.floor(
        Math.min(
          deadline - artifactClaimStartedAt,
          MAX_DELIVERY_OPERATION_BUDGET_MS,
        ),
      );
      if (artifactBudgetMs < MIN_DELIVERY_OPERATION_BUDGET_MS) {
        bounded = true;
        break;
      }
      const artifact = this.spool.claimArtifact(
        artifactBudgetMs + DELIVERY_TRANSITION_MARGIN_MS,
        runId,
        Math.max(
          1,
          Math.floor(
            Math.min(artifactBudgetMs, DELIVERY_SQLITE_BUSY_TIMEOUT_MS),
          ),
        ),
      );
      if (artifact) {
        readyClaimRecheckUsed = false;
        claimed.add(`artifact:${artifact.id}`);
        result.attempts += 1;
        await this.#deliverArtifact(
          artifact,
          result,
          artifactClaimStartedAt + artifactBudgetMs,
        );
        continue;
      }
      const status = this.spool.status(runId);
      const next = status.nextRetryAt ? Date.parse(status.nextRetryAt) : NaN;
      const retryDelay = next - this.#wallNow();
      const readyPending =
        status.batches.pending > status.retryDelayed.batches ||
        status.artifacts.pending > status.retryDelayed.artifacts;
      if (readyPending && !readyClaimRecheckUsed) {
        readyClaimRecheckUsed = true;
        continue;
      }
      if (
        Number.isFinite(next) &&
        retryDelay > 0 &&
        retryDelay < deadline - this.#monotonicNow() &&
        result.attempts < this.config.drainMaxAttempts
      ) {
        readyClaimRecheckUsed = false;
        await this.#sleep(retryDelay);
        continue;
      }
      break;
    }
    const status = this.spool.status(runId);
    result.claimedItems = claimed.size;
    result.remaining = {
      blocked: status.batches.blocked + status.artifacts.blocked,
      readyOrDelayed:
        status.batches.pending +
        status.batches.leased +
        status.artifacts.pending +
        status.artifacts.leased +
        status.unbatchedEvents,
    };
    result.safeCodes = Object.freeze({ ...status.workErrorCodes });
    result.stopped = bounded ? 'bounds-reached' : 'drained';
    return Object.freeze(result);
  }

  async #deliverBatch(
    claim: BatchWorkClaim,
    result: DeliveryDrainResult,
    operationDeadline: number,
  ): Promise<void> {
    try {
      const request = this.#requestBudget(operationDeadline);
      if (!request) {
        this.#retryBatch(
          claim,
          { kind: 'retry', code: 'network-failed' },
          result,
        );
        return;
      }
      const outcome = await this.#blackBox.deliverBatch(
        claim,
        request.now,
        request.budgetMs,
      );
      if (this.#deadlineReached(operationDeadline)) {
        this.#retryBatch(
          claim,
          { kind: 'retry', code: 'network-failed' },
          result,
        );
        return;
      }
      if (outcome.kind === 'success') {
        this.spool.acknowledgeBatchDelivery(
          claim.id,
          claim.leaseToken,
          outcome.value,
        );
        result.batches.delivered += 1;
      } else if (outcome.kind === 'oversized') {
        const batch = EvidenceBatchSchema.parse(JSON.parse(claim.body));
        if (batch.events.length < 2) {
          this.spool.blockBatch(
            claim.id,
            claim.leaseToken,
            'validation-rejected',
          );
          result.batches.blocked += 1;
          return;
        }
        const replacements = this.spool.supersedeOversizedBatch(
          claim.id,
          claim.leaseToken,
          {
            batchId: batch.batchId,
            code: 'payload_too_large',
            runId: batch.runId,
          },
          Math.max(1, Math.floor(batch.events.length / 2)),
        );
        result.batches.superseded += 1;
        result.preparedBatches += replacements.length;
      } else if (outcome.kind === 'block') {
        this.spool.blockBatch(claim.id, claim.leaseToken, outcome.code);
        result.batches.blocked += 1;
      } else {
        this.#retryBatch(claim, outcome, result);
      }
    } catch (error) {
      if (error instanceof CollectorError && error.code === 'lease-lost')
        return;
      try {
        this.spool.scheduleBatchRetry(
          claim.id,
          claim.leaseToken,
          this.#wallNow() + this.#retryDelay(claim.attemptCount),
          'response-invalid',
        );
        result.batches.retried += 1;
      } catch {
        /* A lost lease remains recoverable and must not be falsely acknowledged. */
      }
    }
  }

  #retryBatch(
    claim: BatchWorkClaim,
    outcome: Extract<RemoteOutcome<never>, { kind: 'retry' }>,
    result: DeliveryDrainResult,
  ): void {
    this.spool.scheduleBatchRetry(
      claim.id,
      claim.leaseToken,
      this.#wallNow() +
        this.#retryDelay(claim.attemptCount, outcome.retryAfterMs),
      outcome.code,
    );
    result.batches.retried += 1;
  }

  async #deliverArtifact(
    claim: ArtifactWorkClaim,
    result: DeliveryDrainResult,
    operationDeadline: number,
  ): Promise<void> {
    const controller = new AbortController();
    const remainingAtStart = Math.max(
      0,
      operationDeadline - this.#monotonicNow(),
    );
    const cancellation = setTimeout(
      () => controller.abort(),
      Math.ceil(remainingAtStart),
    );
    cancellation.unref();
    try {
      let replacementAllowed = false;
      if (claim.uploadId) {
        const request = this.#requestBudget(operationDeadline);
        if (!request) {
          this.#retryArtifact(claim, 'network-failed', result);
          return;
        }
        const status = await this.#blackBox.artifactStatus(
          claim.id,
          request.now,
          request.budgetMs,
        );
        if (this.#deadlineReached(operationDeadline)) {
          this.#retryArtifact(claim, 'network-failed', result);
          return;
        }
        if (status.kind !== 'success') {
          this.#finishArtifactFailure(claim, status, result);
          return;
        }
        if (status.value.state === 'verified') {
          if (status.value.verification.uploadId !== claim.uploadId) {
            this.#retryArtifact(claim, 'response-invalid', result);
            return;
          }
          this.spool.acknowledgeArtifactVerification(
            claim.id,
            claim.leaseToken,
            status.value,
          );
          result.artifacts.verified += 1;
          return;
        }
        if (
          'uploadId' in status.value &&
          status.value.uploadId !== claim.uploadId
        ) {
          this.#retryArtifact(claim, 'response-invalid', result);
          return;
        }
        replacementAllowed =
          status.value.state === 'expired' || status.value.state === 'rejected';
        if (status.value.state === 'verifying') {
          const completionRequest = this.#requestBudget(operationDeadline);
          if (!completionRequest) {
            this.#retryArtifact(claim, 'network-failed', result);
            return;
          }
          const completed = await this.#blackBox.completeArtifact(
            claim.id,
            claim.uploadId,
            completionRequest.now,
            completionRequest.budgetMs,
          );
          if (this.#deadlineReached(operationDeadline)) {
            this.#retryArtifact(claim, 'network-failed', result);
            return;
          }
          if (completed.kind !== 'success') {
            this.#finishArtifactFailure(claim, completed, result);
            return;
          }
          this.spool.acknowledgeArtifactVerification(
            claim.id,
            claim.leaseToken,
            completed.value,
          );
          result.artifacts.verified += 1;
          return;
        }
      }
      const sessionRequest = this.#requestBudget(operationDeadline);
      if (!sessionRequest) {
        this.#retryArtifact(claim, 'network-failed', result);
        return;
      }
      const session = await this.#blackBox.createArtifactSession(
        claim.id,
        sessionRequest.now,
        sessionRequest.budgetMs,
      );
      if (this.#deadlineReached(operationDeadline)) {
        this.#retryArtifact(claim, 'network-failed', result);
        return;
      }
      if (session.kind !== 'success') {
        this.#finishArtifactFailure(claim, session, result);
        return;
      }
      if (session.value.outcome === 'already_verified') {
        const terminalUploadId = session.value.verification.uploadId;
        if (
          claim.uploadId &&
          claim.uploadId !== terminalUploadId &&
          !replacementAllowed
        ) {
          this.#retryArtifact(claim, 'response-invalid', result);
          return;
        }
        this.#bindUpload(claim, terminalUploadId, replacementAllowed);
        if (this.#deadlineReached(operationDeadline)) {
          this.#retryArtifact(claim, 'network-failed', result);
          return;
        }
        this.spool.acknowledgeArtifactVerification(
          claim.id,
          claim.leaseToken,
          session.value,
        );
        result.artifacts.verified += 1;
        return;
      }
      if (
        claim.uploadId &&
        claim.uploadId !== session.value.uploadId &&
        !replacementAllowed
      ) {
        this.#retryArtifact(claim, 'response-invalid', result);
        return;
      }
      this.#bindUpload(claim, session.value.uploadId, replacementAllowed);
      if (this.#deadlineReached(operationDeadline)) {
        this.#retryArtifact(claim, 'network-failed', result);
        return;
      }
      const uploaded = await this.#tus.upload(
        claim,
        session.value,
        this.#wallNow,
        this.#monotonicNow,
        operationDeadline,
        controller.signal,
      );
      if (this.#deadlineReached(operationDeadline)) {
        this.#retryArtifact(claim, 'network-failed', result);
        return;
      }
      if (uploaded.kind !== 'success') {
        this.#finishArtifactFailure(claim, uploaded, result);
        return;
      }
      const completionRequest = this.#requestBudget(operationDeadline);
      if (!completionRequest) {
        this.#retryArtifact(claim, 'network-failed', result);
        return;
      }
      const completed = await this.#blackBox.completeArtifact(
        claim.id,
        session.value.uploadId,
        completionRequest.now,
        completionRequest.budgetMs,
      );
      if (this.#deadlineReached(operationDeadline)) {
        this.#retryArtifact(claim, 'network-failed', result);
        return;
      }
      if (completed.kind !== 'success') {
        this.#finishArtifactFailure(claim, completed, result);
        return;
      }
      this.spool.acknowledgeArtifactVerification(
        claim.id,
        claim.leaseToken,
        completed.value,
      );
      result.artifacts.verified += 1;
    } catch (error) {
      if (error instanceof CollectorError && error.code === 'lease-lost')
        return;
      const code =
        error instanceof CollectorError && error.code === 'artifact-missing'
          ? 'validation-rejected'
          : error instanceof CollectorError && error.code === 'artifact-corrupt'
            ? 'integrity-rejected'
            : 'response-invalid';
      try {
        if (code === 'response-invalid')
          this.#retryArtifact(claim, code, result);
        else {
          this.spool.blockArtifact(claim.id, claim.leaseToken, code);
          result.artifacts.blocked += 1;
        }
      } catch {
        /* Preserve the original failure; lease recovery retains the bytes. */
      }
    } finally {
      clearTimeout(cancellation);
    }
  }

  #bindUpload(
    claim: ArtifactWorkClaim,
    uploadId: string,
    replacementAllowed: boolean,
  ): void {
    if (!claim.uploadId || claim.uploadId === uploadId)
      this.spool.bindArtifactUpload(claim.id, claim.leaseToken, uploadId);
    else if (replacementAllowed)
      this.spool.replaceArtifactUpload(
        claim.id,
        claim.leaseToken,
        claim.uploadId,
        uploadId,
      );
    else
      throw new CollectorError(
        'collection-failed',
        'upload replacement lacks remote evidence',
      );
  }

  #finishArtifactFailure(
    claim: ArtifactWorkClaim,
    outcome: Exclude<RemoteOutcome<unknown>, { kind: 'success' }>,
    result: DeliveryDrainResult,
  ): void {
    if (outcome.kind === 'block') {
      this.spool.blockArtifact(claim.id, claim.leaseToken, outcome.code);
      result.artifacts.blocked += 1;
    } else
      this.#retryArtifact(claim, outcome.code, result, outcome.retryAfterMs);
  }

  #retryArtifact(
    claim: ArtifactWorkClaim,
    code: WorkErrorCode,
    result: DeliveryDrainResult,
    retryAfterMs?: number,
  ): void {
    this.spool.scheduleArtifactRetry(
      claim.id,
      claim.leaseToken,
      this.#wallNow() + this.#retryDelay(claim.attemptCount, retryAfterMs),
      code,
    );
    result.artifacts.retried += 1;
  }

  #retryDelay(attempt: number, retryAfterMs?: number): number {
    if (retryAfterMs !== undefined)
      return Math.max(1, Math.min(this.config.retryMaxMs, retryAfterMs));
    const exponent = Math.min(30, Math.max(0, attempt - 1));
    const ceiling = Math.min(
      this.config.retryMaxMs,
      this.config.retryBaseMs * 2 ** exponent,
    );
    const random = Math.min(1, Math.max(0, this.#random()));
    return Math.max(1, Math.floor(ceiling * (0.5 + random * 0.5)));
  }

  #requestBudget(
    operationDeadline: number,
  ): { budgetMs: number; now: number } | undefined {
    const budgetMs = operationDeadline - this.#monotonicNow();
    return budgetMs > 0 ? { budgetMs, now: this.#wallNow() } : undefined;
  }

  #deadlineReached(operationDeadline: number): boolean {
    return this.#monotonicNow() >= operationDeadline;
  }
}
