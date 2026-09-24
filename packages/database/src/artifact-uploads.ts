import { randomUUID } from 'node:crypto';

import { Prisma, type PrismaClient } from './generated/client/client.js';

export type ArtifactRejectionCode =
  'integrity_mismatch' | 'object_missing' | 'payload_too_large';

export interface ArtifactDeclarationRecord {
  id: string;
  canonicalArtifactId: string;
  byteLength: bigint;
  sha256: string;
  mediaType: string;
  compression: string | null;
}

export interface ArtifactAttemptRecord {
  id: string;
  objectKey: string;
  state: 'issued' | 'verifying' | 'verified' | 'rejected' | 'expired';
  expiresAt: Date;
  observedByteLength: bigint | null;
  observedSha256: string | null;
  verifiedAt: Date | null;
  lastErrorCode: string | null;
}

export interface ArtifactUploadAuthorization {
  outcome: 'created' | 'reused' | 'verified';
  declaration: ArtifactDeclarationRecord;
  attempt: ArtifactAttemptRecord;
}

export interface ArtifactCapabilityTarget {
  uploadId: string;
  objectKey: string;
  byteLength: bigint;
  mediaType: string;
}

export interface IssuedArtifactCapability<T> {
  expiresAt: Date;
  value: T;
}

export type ArtifactUploadAuthorizationWithCapability<T> =
  ArtifactUploadAuthorization & {
    capability?: T;
  };

export interface ArtifactTerminalMutationResult {
  outcome: 'applied' | 'lease_lost';
  attempt: ArtifactAttemptRecord;
}

export type VerificationClaim =
  | {
      outcome: 'claimed';
      declaration: ArtifactDeclarationRecord;
      attempt: ArtifactAttemptRecord;
      leaseId: string;
    }
  | {
      outcome: 'in_progress';
      declaration: ArtifactDeclarationRecord;
      attempt: ArtifactAttemptRecord;
    }
  | {
      outcome: 'verified';
      declaration: ArtifactDeclarationRecord;
      attempt: ArtifactAttemptRecord;
    }
  | {
      outcome: 'rejected';
      declaration: ArtifactDeclarationRecord;
      attempt: ArtifactAttemptRecord;
    }
  | {
      outcome: 'expired';
      declaration: ArtifactDeclarationRecord;
      attempt: ArtifactAttemptRecord;
    };

export class ArtifactNotFoundError extends Error {
  constructor() {
    super('Artifact was not found.');
    this.name = 'ArtifactNotFoundError';
  }
}

export class ArtifactUploadIllegalStateError extends Error {
  constructor() {
    super('Artifact upload is in an illegal state for this operation.');
    this.name = 'ArtifactUploadIllegalStateError';
  }
}

export class ArtifactDeclarationLimitError extends Error {
  constructor() {
    super('Artifact declaration exceeds the configured limit.');
    this.name = 'ArtifactDeclarationLimitError';
  }
}

type ArtifactRow = {
  id: string;
  canonical_artifact_id: string;
  byte_length: bigint;
  sha256: string;
  media_type: string;
  compression: string | null;
};

type AttemptRow = {
  id: string;
  object_key: string;
  state: ArtifactAttemptRecord['state'];
  expires_at: Date;
  observed_byte_length: bigint | null;
  observed_sha256: string | null;
  verified_at: Date | null;
  last_error_code: string | null;
};

function declaration(row: ArtifactRow): ArtifactDeclarationRecord {
  return {
    id: row.id,
    canonicalArtifactId: row.canonical_artifact_id,
    byteLength: row.byte_length,
    sha256: row.sha256,
    mediaType: row.media_type,
    compression: row.compression,
  };
}

function attempt(row: AttemptRow): ArtifactAttemptRecord {
  return {
    id: row.id,
    objectKey: row.object_key,
    state: row.state,
    expiresAt: row.expires_at,
    observedByteLength: row.observed_byte_length,
    observedSha256: row.observed_sha256,
    verifiedAt: row.verified_at,
    lastErrorCode: row.last_error_code,
  };
}

async function findDeclaration(
  client: Prisma.TransactionClient | PrismaClient,
  organizationId: string,
  repositoryId: string,
  canonicalArtifactId: string,
): Promise<ArtifactRow> {
  const rows = await client.$queryRaw<ArtifactRow[]>(Prisma.sql`
    SELECT a.id, a.canonical_artifact_id, a.byte_length, a.sha256,
           a.media_type, a.compression
      FROM artifact_declarations a
      JOIN runs r ON r.organization_id = a.organization_id AND r.id = a.run_id
     WHERE a.organization_id = CAST(${organizationId} AS uuid)
       AND r.repository_id = CAST(${repositoryId} AS uuid)
       AND a.canonical_artifact_id = CAST(${canonicalArtifactId} AS uuid)
  `);
  if (!rows[0]) throw new ArtifactNotFoundError();
  return rows[0];
}

async function lockDeclaration(
  transaction: Prisma.TransactionClient,
  artifactDeclarationId: string,
) {
  await transaction.$queryRaw<Array<{ locked: boolean }>>(Prisma.sql`
    SELECT TRUE AS locked
      FROM pg_advisory_xact_lock(hashtextextended(${artifactDeclarationId}, 0))
  `);
}

const attemptColumns = Prisma.sql`
  id, object_key, state::text AS state, expires_at, observed_byte_length,
  observed_sha256, verified_at, last_error_code
`;

export async function authorizeArtifactUpload<T>(
  client: PrismaClient,
  input: {
    organizationId: string;
    repositoryId: string;
    artifactId: string;
    now: Date;
    maximumBytes: bigint;
  },
  issueCapability: (
    target: ArtifactCapabilityTarget,
  ) => Promise<IssuedArtifactCapability<T>>,
): Promise<ArtifactUploadAuthorizationWithCapability<T>> {
  return client.$transaction(
    async (transaction) => {
      const artifact = await findDeclaration(
        transaction,
        input.organizationId,
        input.repositoryId,
        input.artifactId,
      );
      await lockDeclaration(transaction, artifact.id);
      const rows = await transaction.$queryRaw<AttemptRow[]>(Prisma.sql`
      SELECT ${attemptColumns}
        FROM artifact_upload_attempts
       WHERE organization_id = CAST(${input.organizationId} AS uuid)
         AND artifact_declaration_id = CAST(${artifact.id} AS uuid)
       ORDER BY issued_at DESC
       FOR UPDATE
      `);
      const verified = rows.find((row) => row.state === 'verified');
      if (verified)
        return {
          outcome: 'verified',
          declaration: declaration(artifact),
          attempt: attempt(verified),
        };
      if (artifact.byte_length > input.maximumBytes)
        throw new ArtifactDeclarationLimitError();

      const active = rows.find(
        (row) => row.state === 'issued' || row.state === 'verifying',
      );
      if (active && active.expires_at <= input.now) {
        await transaction.$executeRaw(Prisma.sql`
        UPDATE artifact_upload_attempts
           SET state = 'expired', verification_lease_id = NULL,
               lease_expires_at = NULL, expired_at = ${input.now}
         WHERE id = CAST(${active.id} AS uuid)
        `);
      } else if (active?.state === 'verifying') {
        throw new ArtifactUploadIllegalStateError();
      } else if (active) {
        const capability = await issueCapability({
          uploadId: active.id,
          objectKey: active.object_key,
          byteLength: artifact.byte_length,
          mediaType: artifact.media_type,
        });
        if (capability.expiresAt <= input.now)
          throw new ArtifactUploadIllegalStateError();
        const refreshed = await transaction.$queryRaw<AttemptRow[]>(Prisma.sql`
          UPDATE artifact_upload_attempts
             SET expires_at = ${capability.expiresAt}, last_error_code = NULL
           WHERE id = CAST(${active.id} AS uuid)
             AND state = 'issued'
          RETURNING ${attemptColumns}
        `);
        if (!refreshed[0]) throw new ArtifactUploadIllegalStateError();
        return {
          outcome: 'reused',
          declaration: declaration(artifact),
          attempt: attempt(refreshed[0]),
          capability: capability.value,
        };
      }

      const uploadId = randomUUID();
      const objectKey = `artifacts/${randomUUID()}`;
      const capability = await issueCapability({
        uploadId,
        objectKey,
        byteLength: artifact.byte_length,
        mediaType: artifact.media_type,
      });
      if (capability.expiresAt <= input.now)
        throw new ArtifactUploadIllegalStateError();
      const inserted = await transaction.$queryRaw<AttemptRow[]>(Prisma.sql`
      INSERT INTO artifact_upload_attempts (
        id, organization_id, run_id, artifact_declaration_id, object_key,
        issued_at, expires_at
      )
      SELECT CAST(${uploadId} AS uuid), a.organization_id, a.run_id, a.id,
             ${objectKey}, ${input.now}, ${capability.expiresAt}
        FROM artifact_declarations a
       WHERE a.id = CAST(${artifact.id} AS uuid)
      RETURNING ${attemptColumns}
      `);
      return {
        outcome: 'created',
        declaration: declaration(artifact),
        attempt: attempt(inserted[0]!),
        capability: capability.value,
      };
    },
    { timeout: 15_000 },
  );
}

export async function claimArtifactVerification(
  client: PrismaClient,
  input: {
    organizationId: string;
    repositoryId: string;
    artifactId: string;
    uploadId: string;
    leaseDurationMs: number;
  },
): Promise<VerificationClaim> {
  if (
    !Number.isSafeInteger(input.leaseDurationMs) ||
    input.leaseDurationMs <= 0
  )
    throw new ArtifactUploadIllegalStateError();
  return client.$transaction(async (transaction) => {
    const artifact = await findDeclaration(
      transaction,
      input.organizationId,
      input.repositoryId,
      input.artifactId,
    );
    const rows = await transaction.$queryRaw<
      (AttemptRow & {
        lease_expires_at: Date | null;
        database_now: Date;
      })[]
    >(Prisma.sql`
      SELECT ${attemptColumns}, lease_expires_at,
             clock_timestamp() AS database_now
        FROM artifact_upload_attempts
       WHERE id = CAST(${input.uploadId} AS uuid)
         AND organization_id = CAST(${input.organizationId} AS uuid)
         AND artifact_declaration_id = CAST(${artifact.id} AS uuid)
       FOR UPDATE
    `);
    const row = rows[0];
    if (!row) throw new ArtifactNotFoundError();
    if (
      row.state === 'verified' ||
      row.state === 'rejected' ||
      row.state === 'expired'
    ) {
      return {
        outcome: row.state,
        declaration: declaration(artifact),
        attempt: attempt(row),
      };
    }
    if (
      row.state === 'verifying' &&
      row.lease_expires_at &&
      row.lease_expires_at > row.database_now
    ) {
      return {
        outcome: 'in_progress',
        declaration: declaration(artifact),
        attempt: attempt(row),
      };
    }
    if (row.expires_at <= row.database_now) {
      const expired = await transaction.$queryRaw<AttemptRow[]>(Prisma.sql`
        UPDATE artifact_upload_attempts
           SET state = 'expired', verification_lease_id = NULL,
               lease_expires_at = NULL, expired_at = clock_timestamp()
         WHERE id = CAST(${row.id} AS uuid)
        RETURNING ${attemptColumns}
      `);
      return {
        outcome: 'expired',
        declaration: declaration(artifact),
        attempt: attempt(expired[0]!),
      };
    }
    const leaseId = randomUUID();
    const claimed = await transaction.$queryRaw<AttemptRow[]>(Prisma.sql`
      UPDATE artifact_upload_attempts
         SET state = 'verifying', verification_lease_id = CAST(${leaseId} AS uuid),
             lease_expires_at = clock_timestamp()
               + (${input.leaseDurationMs} * INTERVAL '1 millisecond'),
             last_error_code = NULL
       WHERE id = CAST(${row.id} AS uuid)
      RETURNING ${attemptColumns}
    `);
    return {
      outcome: 'claimed',
      declaration: declaration(artifact),
      attempt: attempt(claimed[0]!),
      leaseId,
    };
  });
}

export async function finalizeArtifactVerification(
  client: PrismaClient,
  input: {
    uploadId: string;
    leaseId: string;
    byteLength: bigint;
    sha256: string;
    verifiedAt: Date;
  },
): Promise<ArtifactTerminalMutationResult> {
  return client.$transaction(async (transaction) => {
    const rows = await transaction.$queryRaw<AttemptRow[]>(Prisma.sql`
      UPDATE artifact_upload_attempts
         SET state = 'verified', verification_lease_id = NULL,
             lease_expires_at = NULL, observed_byte_length = ${input.byteLength},
             observed_sha256 = ${input.sha256}, verified_at = ${input.verifiedAt},
             last_error_code = NULL
       WHERE id = CAST(${input.uploadId} AS uuid)
         AND state = 'verifying'
         AND verification_lease_id = CAST(${input.leaseId} AS uuid)
         AND lease_expires_at > clock_timestamp()
      RETURNING ${attemptColumns}
    `);
    if (rows[0]) return { outcome: 'applied', attempt: attempt(rows[0]) };
    const winning = await transaction.$queryRaw<AttemptRow[]>(Prisma.sql`
      SELECT ${attemptColumns}
        FROM artifact_upload_attempts
       WHERE id = CAST(${input.uploadId} AS uuid)
    `);
    if (!winning[0]) throw new ArtifactUploadIllegalStateError();
    return { outcome: 'lease_lost', attempt: attempt(winning[0]) };
  });
}

export async function rejectArtifactVerification(
  client: PrismaClient,
  input: {
    uploadId: string;
    leaseId: string;
    reason: ArtifactRejectionCode;
    byteLength: bigint | null;
    sha256: string | null;
    rejectedAt: Date;
  },
): Promise<ArtifactTerminalMutationResult> {
  return client.$transaction(async (transaction) => {
    const rows = await transaction.$queryRaw<AttemptRow[]>(Prisma.sql`
      UPDATE artifact_upload_attempts
         SET state = 'rejected', verification_lease_id = NULL,
             lease_expires_at = NULL, observed_byte_length = ${input.byteLength},
             observed_sha256 = ${input.sha256}, rejected_at = ${input.rejectedAt},
             last_error_code = ${input.reason}
       WHERE id = CAST(${input.uploadId} AS uuid)
         AND state = 'verifying'
         AND verification_lease_id = CAST(${input.leaseId} AS uuid)
         AND lease_expires_at > clock_timestamp()
      RETURNING ${attemptColumns}
    `);
    if (rows[0]) return { outcome: 'applied', attempt: attempt(rows[0]) };
    const winning = await transaction.$queryRaw<AttemptRow[]>(Prisma.sql`
      SELECT ${attemptColumns}
        FROM artifact_upload_attempts
       WHERE id = CAST(${input.uploadId} AS uuid)
    `);
    if (!winning[0]) throw new ArtifactUploadIllegalStateError();
    return { outcome: 'lease_lost', attempt: attempt(winning[0]) };
  });
}

export async function releaseArtifactVerification(
  client: PrismaClient,
  input: { uploadId: string; leaseId: string },
): Promise<void> {
  await client.$executeRaw(Prisma.sql`
    UPDATE artifact_upload_attempts
       SET state = CASE WHEN expires_at <= clock_timestamp()
                              AND lease_expires_at <= clock_timestamp()
                        THEN 'expired'::"ArtifactUploadState"
                        ELSE 'issued'::"ArtifactUploadState" END,
           verification_lease_id = NULL, lease_expires_at = NULL,
           expired_at = CASE WHEN expires_at <= clock_timestamp()
                                  AND lease_expires_at <= clock_timestamp()
                             THEN clock_timestamp()
                             ELSE NULL::timestamptz END,
           last_error_code = 'storage_unavailable'
     WHERE id = CAST(${input.uploadId} AS uuid)
       AND state = 'verifying'
       AND verification_lease_id = CAST(${input.leaseId} AS uuid)
  `);
}

export async function getArtifactStorageRecord(
  client: PrismaClient,
  input: { organizationId: string; repositoryId: string; artifactId: string },
): Promise<{
  declaration: ArtifactDeclarationRecord;
  attempt?: ArtifactAttemptRecord;
}> {
  const artifact = await findDeclaration(
    client,
    input.organizationId,
    input.repositoryId,
    input.artifactId,
  );
  const rows = await client.$queryRaw<AttemptRow[]>(Prisma.sql`
    SELECT ${attemptColumns}
      FROM artifact_upload_attempts
     WHERE organization_id = CAST(${input.organizationId} AS uuid)
       AND artifact_declaration_id = CAST(${artifact.id} AS uuid)
     ORDER BY (state = 'verified') DESC, issued_at DESC
     LIMIT 1
  `);
  return rows[0]
    ? { declaration: declaration(artifact), attempt: attempt(rows[0]) }
    : { declaration: declaration(artifact) };
}
