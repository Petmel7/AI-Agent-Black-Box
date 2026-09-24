import { z } from 'zod';

import {
  NonNegativeSafeIntegerSchema,
  Sha256Schema,
  UtcTimestampSchema,
  UuidSchema,
} from './evidence/primitives.js';

export const DEFAULT_MAX_ARTIFACT_BYTES = 50_000_000;

export const ArtifactOperationBodySchema = z.object({}).strict();

export const ArtifactRouteParamsSchema = z
  .object({ repositoryId: UuidSchema, artifactId: UuidSchema })
  .strict();

export const ArtifactUploadRouteParamsSchema = ArtifactRouteParamsSchema.extend(
  {
    uploadId: UuidSchema,
  },
).strict();

const VerifiedMetadataSchema = z
  .object({
    uploadId: UuidSchema,
    byteLength: NonNegativeSafeIntegerSchema,
    sha256: Sha256Schema,
    verifiedAt: UtcTimestampSchema,
  })
  .strict();

const UploadCapabilitySchema = z
  .object({
    schemaVersion: z.literal(1),
    outcome: z.enum(['upload_authorized', 'already_authorized']),
    artifactId: UuidSchema,
    uploadId: UuidSchema,
    protocol: z.literal('tus'),
    endpoint: z.string().url().max(2048),
    capabilityToken: z.string().min(1).max(4096),
    expiresAt: UtcTimestampSchema,
    requiredChunkSize: NonNegativeSafeIntegerSchema.optional(),
    maximumBytes: NonNegativeSafeIntegerSchema,
  })
  .strict();

export const ArtifactUploadSessionResponseSchema = z.discriminatedUnion(
  'outcome',
  [
    UploadCapabilitySchema.extend({ outcome: z.literal('upload_authorized') }),
    UploadCapabilitySchema.extend({ outcome: z.literal('already_authorized') }),
    z
      .object({
        schemaVersion: z.literal(1),
        outcome: z.literal('already_verified'),
        artifactId: UuidSchema,
        verification: VerifiedMetadataSchema,
      })
      .strict(),
  ],
);

export const ArtifactCompletionResponseSchema = z.discriminatedUnion(
  'outcome',
  [
    z
      .object({
        schemaVersion: z.literal(1),
        outcome: z.literal('verified'),
        artifactId: UuidSchema,
        verification: VerifiedMetadataSchema,
      })
      .strict(),
    z
      .object({
        schemaVersion: z.literal(1),
        outcome: z.literal('verification_in_progress'),
        artifactId: UuidSchema,
        uploadId: UuidSchema,
        retryable: z.literal(true),
      })
      .strict(),
    z
      .object({
        schemaVersion: z.literal(1),
        outcome: z.literal('rejected'),
        artifactId: UuidSchema,
        uploadId: UuidSchema,
        reason: z.enum([
          'integrity_mismatch',
          'object_missing',
          'payload_too_large',
        ]),
        retryable: z.literal(false),
      })
      .strict(),
  ],
);

export const ArtifactStorageStatusResponseSchema = z.discriminatedUnion(
  'state',
  [
    z
      .object({
        schemaVersion: z.literal(1),
        artifactId: UuidSchema,
        state: z.literal('declared'),
      })
      .strict(),
    z
      .object({
        schemaVersion: z.literal(1),
        artifactId: UuidSchema,
        uploadId: UuidSchema,
        state: z.enum(['issued', 'verifying', 'expired']),
        expiresAt: UtcTimestampSchema,
      })
      .strict(),
    z
      .object({
        schemaVersion: z.literal(1),
        artifactId: UuidSchema,
        uploadId: UuidSchema,
        state: z.literal('rejected'),
        reason: z.enum([
          'integrity_mismatch',
          'object_missing',
          'payload_too_large',
        ]),
      })
      .strict(),
    z
      .object({
        schemaVersion: z.literal(1),
        artifactId: UuidSchema,
        state: z.literal('verified'),
        verification: VerifiedMetadataSchema,
      })
      .strict(),
  ],
);

export const ArtifactErrorCodeSchema = z.enum([
  'unauthorized',
  'unsupported_media_type',
  'invalid_request',
  'artifact_not_found',
  'declaration_too_large',
  'upload_expired',
  'storage_unavailable',
  'integrity_mismatch',
  'illegal_state',
  'internal_error',
]);

export const ArtifactErrorResponseSchema = z
  .object({
    error: z
      .object({
        code: ArtifactErrorCodeSchema,
        message: z.string().min(1).max(256),
      })
      .strict(),
  })
  .strict();

export type ArtifactUploadSessionResponse = z.infer<
  typeof ArtifactUploadSessionResponseSchema
>;
export type ArtifactCompletionResponse = z.infer<
  typeof ArtifactCompletionResponseSchema
>;
export type ArtifactStorageStatusResponse = z.infer<
  typeof ArtifactStorageStatusResponseSchema
>;
export type ArtifactErrorCode = z.infer<typeof ArtifactErrorCodeSchema>;
