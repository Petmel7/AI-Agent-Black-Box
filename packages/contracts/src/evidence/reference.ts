import { z } from 'zod';

import {
  MAX_JSON_POINTER_LENGTH,
  NonNegativeSafeIntegerSchema,
  PositiveSafeIntegerSchema,
  Sha256Schema,
  UuidSchema,
} from './primitives.js';

export const JsonPointerSchema = z
  .string()
  .max(MAX_JSON_POINTER_LENGTH)
  .regex(/^(?:\/(?:[^~/]|~[01])*)*$/);

export const ByteRangeSchema = z
  .object({
    type: z.literal('bytes'),
    start: NonNegativeSafeIntegerSchema,
    endExclusive: PositiveSafeIntegerSchema,
  })
  .strict()
  .refine((value) => value.endExclusive > value.start, {
    message: 'endExclusive must be greater than start',
    path: ['endExclusive'],
  });

export const LineRangeSchema = z
  .object({
    type: z.literal('lines'),
    start: PositiveSafeIntegerSchema,
    end: PositiveSafeIntegerSchema,
  })
  .strict()
  .refine((value) => value.end >= value.start, {
    message: 'end must be greater than or equal to start',
    path: ['end'],
  });

export const ArtifactRangeSchema = z.discriminatedUnion('type', [
  ByteRangeSchema,
  LineRangeSchema,
]);

export const EventEvidenceReferenceSchema = z
  .object({
    type: z.literal('event'),
    eventId: UuidSchema,
    pointer: JsonPointerSchema.optional(),
  })
  .strict();

export const ArtifactEvidenceReferenceSchema = z
  .object({
    type: z.literal('artifact'),
    artifactId: UuidSchema,
    sha256: Sha256Schema,
    range: ArtifactRangeSchema.optional(),
  })
  .strict();

export const EvidenceReferenceSchema = z.discriminatedUnion('type', [
  EventEvidenceReferenceSchema,
  ArtifactEvidenceReferenceSchema,
]);

export type ByteRange = z.infer<typeof ByteRangeSchema>;
export type LineRange = z.infer<typeof LineRangeSchema>;
export type ArtifactRange = z.infer<typeof ArtifactRangeSchema>;
export type EventEvidenceReference = z.infer<
  typeof EventEvidenceReferenceSchema
>;
export type ArtifactEvidenceReference = z.infer<
  typeof ArtifactEvidenceReferenceSchema
>;
export type EvidenceReference = z.infer<typeof EvidenceReferenceSchema>;
