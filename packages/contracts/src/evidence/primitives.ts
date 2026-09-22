import { z } from 'zod';

/** Evidence wire-format version supported by this package. */
export const EVIDENCE_SCHEMA_VERSION = 1 as const;

/** Maximum number of UTF-16 code units accepted for a bounded identifier. */
export const MAX_IDENTIFIER_LENGTH = 128;

/** Maximum number of UTF-16 code units accepted for a provider-native ID. */
export const MAX_NATIVE_ID_LENGTH = 256;

/** Maximum number of UTF-16 code units accepted for a JSON Pointer. */
export const MAX_JSON_POINTER_LENGTH = 1_024;

/** Maximum number of UTF-16 code units accepted in an inline content excerpt. */
export const MAX_CONTENT_EXCERPT_LENGTH = 4_096;

/** Maximum number of events accepted in one evidence batch. */
export const MAX_BATCH_EVENTS = 500;

export const SchemaVersionSchema = z.literal(EVIDENCE_SCHEMA_VERSION);

export const UuidSchema = z.string().uuid();

export const UtcTimestampSchema = z
  .string()
  .datetime({ offset: false })
  .endsWith('Z');

export const NonNegativeSafeIntegerSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);

export const PositiveSafeIntegerSchema = NonNegativeSafeIntegerSchema.min(1);

export const DurationMillisecondsSchema = NonNegativeSafeIntegerSchema;

export const BoundedIdentifierSchema = z
  .string()
  .min(1)
  .max(MAX_IDENTIFIER_LENGTH);

export const LowercaseIdentifierSchema = BoundedIdentifierSchema.regex(
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/,
);

export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export type SchemaVersion = z.infer<typeof SchemaVersionSchema>;
export type Uuid = z.infer<typeof UuidSchema>;
export type UtcTimestamp = z.infer<typeof UtcTimestampSchema>;
export type NonNegativeSafeInteger = z.infer<
  typeof NonNegativeSafeIntegerSchema
>;
export type DurationMilliseconds = z.infer<typeof DurationMillisecondsSchema>;
