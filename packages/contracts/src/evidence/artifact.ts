import { z } from 'zod';

import {
  BoundedIdentifierSchema,
  LowercaseIdentifierSchema,
  NonNegativeSafeIntegerSchema,
  Sha256Schema,
  UuidSchema,
} from './primitives.js';

/** Maximum media-type length accepted by the wire contract. */
export const MAX_MEDIA_TYPE_LENGTH = 128;

export const MediaTypeSchema = z
  .string()
  .min(3)
  .max(MAX_MEDIA_TYPE_LENGTH)
  .regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i);

export const CompressionSchema = z.enum(['gzip', 'zstd']);

export const RedactionMetadataSchema = z
  .object({
    applied: z.boolean(),
    rulesetVersion: BoundedIdentifierSchema.optional(),
  })
  .strict()
  .refine((value) => value.applied || value.rulesetVersion === undefined, {
    message: 'rulesetVersion requires applied redaction',
    path: ['rulesetVersion'],
  });

export const ArtifactReferenceSchema = z
  .object({
    artifactId: UuidSchema,
    kind: LowercaseIdentifierSchema,
    mediaType: MediaTypeSchema,
    byteLength: NonNegativeSafeIntegerSchema,
    sha256: Sha256Schema,
    redaction: RedactionMetadataSchema,
    compression: CompressionSchema.optional(),
    characterEncoding: LowercaseIdentifierSchema.optional(),
  })
  .strict();

export type Compression = z.infer<typeof CompressionSchema>;
export type RedactionMetadata = z.infer<typeof RedactionMetadataSchema>;
export type ArtifactReference = z.infer<typeof ArtifactReferenceSchema>;
