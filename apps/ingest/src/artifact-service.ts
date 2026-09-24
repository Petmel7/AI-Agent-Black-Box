import type { Readable } from 'node:stream';

import {
  DEFAULT_MAX_ARTIFACT_BYTES,
  type ArtifactCompletionResponse,
  type ArtifactStorageStatusResponse,
  type ArtifactUploadSessionResponse,
} from '@blackbox/contracts';
import {
  ArtifactDeclarationLimitError,
  authorizeArtifactUpload,
  claimArtifactVerification,
  finalizeArtifactVerification,
  getArtifactStorageRecord,
  rejectArtifactVerification,
  releaseArtifactVerification,
  type ArtifactAttemptRecord,
  type DatabaseClient,
} from '@blackbox/database';

import { observeArtifactStream } from './artifact-integrity.js';

export interface ArtifactStoragePort {
  issueUploadCapability(input: {
    objectKey: string;
    mediaType: string;
    byteLength: bigint;
  }): Promise<{
    protocol: 'tus';
    endpoint: string;
    capabilityToken: string;
    expiresAt: Date;
    requiredChunkSize?: number;
  }>;
  openReadable(objectKey: string): Promise<Readable>;
  deleteObject(objectKey: string): Promise<void>;
}

export class ArtifactDeclarationTooLargeError extends Error {}
export class ArtifactStorageUnavailableError extends Error {}
export class ArtifactObjectMissingError extends Error {}
export class ArtifactUploadExpiredError extends Error {}

export interface ArtifactTransportServiceOptions {
  database: DatabaseClient;
  storage: ArtifactStoragePort;
  maximumBytes?: number;
  verificationLeaseMs?: number;
  now?: () => Date;
}

export interface ArtifactScope {
  organizationId: string;
  repositoryId: string;
  artifactId: string;
}

function verified(
  artifactId: string,
  value: ArtifactAttemptRecord,
): Extract<ArtifactCompletionResponse, { outcome: 'verified' }> {
  if (
    value.observedByteLength === null ||
    !value.observedSha256 ||
    !value.verifiedAt
  ) {
    throw new Error('Verified artifact metadata is incomplete.');
  }
  return {
    schemaVersion: 1,
    outcome: 'verified',
    artifactId,
    verification: {
      uploadId: value.id,
      byteLength: Number(value.observedByteLength),
      sha256: value.observedSha256,
      verifiedAt: value.verifiedAt.toISOString(),
    },
  };
}

export class ArtifactTransportService {
  private readonly maximumBytes: number;
  private readonly verificationLeaseMs: number;
  private readonly now: () => Date;

  constructor(private readonly options: ArtifactTransportServiceOptions) {
    this.maximumBytes = options.maximumBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
    this.verificationLeaseMs = options.verificationLeaseMs ?? 5 * 60_000;
    this.now = options.now ?? (() => new Date());
    if (
      !Number.isSafeInteger(this.maximumBytes) ||
      this.maximumBytes <= 0 ||
      this.maximumBytes > DEFAULT_MAX_ARTIFACT_BYTES
    ) {
      throw new Error('Artifact maximum must be between 1 and 50000000 bytes.');
    }
  }

  async createSession(
    scope: ArtifactScope,
  ): Promise<ArtifactUploadSessionResponse> {
    const now = this.now();
    let storageFailure: unknown;
    let authorization;
    try {
      authorization = await authorizeArtifactUpload(
        this.options.database,
        {
          ...scope,
          now,
          maximumBytes: BigInt(this.maximumBytes),
        },
        async (target) => {
          try {
            const capability =
              await this.options.storage.issueUploadCapability(target);
            return { expiresAt: capability.expiresAt, value: capability };
          } catch (error) {
            storageFailure = error;
            throw error;
          }
        },
      );
    } catch (error) {
      if (error instanceof ArtifactDeclarationLimitError)
        throw new ArtifactDeclarationTooLargeError();
      if (storageFailure !== undefined)
        throw new ArtifactStorageUnavailableError('Storage is unavailable.', {
          cause: storageFailure,
        });
      throw error;
    }
    if (authorization.outcome === 'verified') {
      const result = verified(scope.artifactId, authorization.attempt);
      return {
        ...result,
        outcome: 'already_verified',
      };
    }
    const capability = authorization.capability;
    if (
      !capability ||
      capability.expiresAt.getTime() !==
        authorization.attempt.expiresAt.getTime()
    )
      throw new Error(
        'Storage capability expiry did not align with persistence.',
      );
    return {
      schemaVersion: 1,
      outcome:
        authorization.outcome === 'created'
          ? 'upload_authorized'
          : 'already_authorized',
      artifactId: scope.artifactId,
      uploadId: authorization.attempt.id,
      protocol: capability.protocol,
      endpoint: capability.endpoint,
      capabilityToken: capability.capabilityToken,
      ...(capability.requiredChunkSize === undefined
        ? {}
        : { requiredChunkSize: capability.requiredChunkSize }),
      expiresAt: capability.expiresAt.toISOString(),
      maximumBytes: this.maximumBytes,
    };
  }

  async complete(
    scope: ArtifactScope & { uploadId: string },
  ): Promise<ArtifactCompletionResponse> {
    const claim = await claimArtifactVerification(this.options.database, {
      ...scope,
      leaseDurationMs: this.verificationLeaseMs,
    });
    if (claim.outcome === 'verified')
      return verified(scope.artifactId, claim.attempt);
    if (claim.outcome === 'in_progress') {
      return {
        schemaVersion: 1,
        outcome: 'verification_in_progress',
        artifactId: scope.artifactId,
        uploadId: scope.uploadId,
        retryable: true,
      };
    }
    if (claim.outcome === 'expired') throw new ArtifactUploadExpiredError();
    if (claim.outcome === 'rejected') {
      return {
        schemaVersion: 1,
        outcome: 'rejected',
        artifactId: scope.artifactId,
        uploadId: scope.uploadId,
        reason: claim.attempt.lastErrorCode as
          'integrity_mismatch' | 'object_missing' | 'payload_too_large',
        retryable: false,
      };
    }

    let observedLength = 0n;
    let observedSha256: string | null = null;
    let rejection:
      'integrity_mismatch' | 'object_missing' | 'payload_too_large' | undefined;
    try {
      const stream = await this.options.storage.openReadable(
        claim.attempt.objectKey,
      );
      const observation = await observeArtifactStream(
        stream,
        this.maximumBytes,
      );
      observedLength = observation.byteLength;
      observedSha256 = observation.sha256;
      if (observation.exceededLimit) rejection = 'payload_too_large';
    } catch (error) {
      if (error instanceof ArtifactObjectMissingError) {
        rejection = 'object_missing';
      } else {
        await releaseArtifactVerification(this.options.database, {
          uploadId: scope.uploadId,
          leaseId: claim.leaseId,
        });
        throw new ArtifactStorageUnavailableError('Storage is unavailable.', {
          cause: error,
        });
      }
    }

    if (rejection === 'object_missing') observedSha256 = null;
    if (
      !rejection &&
      (observedLength !== claim.declaration.byteLength ||
        observedSha256 !== claim.declaration.sha256)
    ) {
      rejection = 'integrity_mismatch';
    }
    if (rejection) {
      const rejected = await rejectArtifactVerification(this.options.database, {
        uploadId: scope.uploadId,
        leaseId: claim.leaseId,
        reason: rejection,
        byteLength: rejection === 'object_missing' ? null : observedLength,
        sha256: observedSha256,
        rejectedAt: this.now(),
      });
      if (rejected.outcome === 'lease_lost')
        return this.completionForWinningAttempt(scope, rejected.attempt);
      try {
        await this.options.storage.deleteObject(claim.attempt.objectKey);
      } catch {
        // Rejection is durable; cleanup is deliberately best-effort.
      }
      return {
        schemaVersion: 1,
        outcome: 'rejected',
        artifactId: scope.artifactId,
        uploadId: scope.uploadId,
        reason: rejection,
        retryable: false,
      };
    }
    const finalized = await finalizeArtifactVerification(
      this.options.database,
      {
        uploadId: scope.uploadId,
        leaseId: claim.leaseId,
        byteLength: observedLength,
        sha256: observedSha256!,
        verifiedAt: this.now(),
      },
    );
    if (finalized.outcome === 'lease_lost')
      return this.completionForWinningAttempt(scope, finalized.attempt);
    return verified(scope.artifactId, finalized.attempt);
  }

  private completionForWinningAttempt(
    scope: ArtifactScope & { uploadId: string },
    value: ArtifactAttemptRecord,
  ): ArtifactCompletionResponse {
    if (value.state === 'verified') return verified(scope.artifactId, value);
    if (value.state === 'rejected')
      return {
        schemaVersion: 1,
        outcome: 'rejected',
        artifactId: scope.artifactId,
        uploadId: value.id,
        reason: value.lastErrorCode as
          'integrity_mismatch' | 'object_missing' | 'payload_too_large',
        retryable: false,
      };
    if (value.state === 'expired') throw new ArtifactUploadExpiredError();
    return {
      schemaVersion: 1,
      outcome: 'verification_in_progress',
      artifactId: scope.artifactId,
      uploadId: value.id,
      retryable: true,
    };
  }

  async status(scope: ArtifactScope): Promise<ArtifactStorageStatusResponse> {
    const record = await getArtifactStorageRecord(this.options.database, scope);
    const value = record.attempt;
    if (!value)
      return {
        schemaVersion: 1,
        artifactId: scope.artifactId,
        state: 'declared',
      };
    if (value.state === 'verified') {
      const result = verified(scope.artifactId, value);
      return {
        schemaVersion: 1,
        artifactId: scope.artifactId,
        state: 'verified',
        verification: result.verification,
      };
    }
    if (value.state === 'rejected') {
      return {
        schemaVersion: 1,
        artifactId: scope.artifactId,
        uploadId: value.id,
        state: 'rejected',
        reason: value.lastErrorCode as
          'integrity_mismatch' | 'object_missing' | 'payload_too_large',
      };
    }
    return {
      schemaVersion: 1,
      artifactId: scope.artifactId,
      uploadId: value.id,
      state:
        value.state === 'issued' && value.expiresAt <= this.now()
          ? 'expired'
          : value.state,
      expiresAt: value.expiresAt.toISOString(),
    };
  }
}
