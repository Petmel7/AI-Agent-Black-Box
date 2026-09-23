import { z } from 'zod';

import { UtcTimestampSchema, UuidSchema } from './evidence/primitives.js';

export const INGESTION_BODY_LIMIT_BYTES = 16 * 1024 * 1024;

export const EvidenceBatchRouteParamsSchema = z
  .object({ repositoryId: UuidSchema })
  .strict();

export const EvidenceBatchIngestionOutcomeSchema = z.enum([
  'accepted',
  'already_accepted',
]);

export const EvidenceBatchIngestionResponseSchema = z
  .object({
    outcome: EvidenceBatchIngestionOutcomeSchema,
    batchId: UuidSchema,
    runId: UuidSchema,
    receivedAt: UtcTimestampSchema,
  })
  .strict();

export const IngestionErrorCodeSchema = z.enum([
  'malformed_json',
  'unauthorized',
  'unsupported_media_type',
  'payload_too_large',
  'unsupported_schema_version',
  'invalid_request',
  'repository_not_found',
  'evidence_conflict',
  'internal_error',
]);

export const IngestionErrorResponseSchema = z
  .object({
    error: z
      .object({
        code: IngestionErrorCodeSchema,
        message: z.string().min(1).max(256),
      })
      .strict(),
  })
  .strict();

export type EvidenceBatchIngestionOutcome = z.infer<
  typeof EvidenceBatchIngestionOutcomeSchema
>;
export type EvidenceBatchIngestionResponse = z.infer<
  typeof EvidenceBatchIngestionResponseSchema
>;
export type IngestionErrorCode = z.infer<typeof IngestionErrorCodeSchema>;
export type IngestionErrorResponse = z.infer<
  typeof IngestionErrorResponseSchema
>;
