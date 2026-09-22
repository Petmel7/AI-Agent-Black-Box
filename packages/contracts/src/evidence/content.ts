import { z } from 'zod';

import {
  ArtifactReferenceSchema,
  RedactionMetadataSchema,
} from './artifact.js';
import { MAX_CONTENT_EXCERPT_LENGTH } from './primitives.js';

export const UnavailableReasonSchema = z.enum([
  'not-exposed',
  'not-supported',
  'collection-failed',
]);

export const OmittedContentSchema = z
  .object({
    state: z.literal('omitted'),
  })
  .strict();

export const UnavailableContentSchema = z
  .object({
    state: z.literal('unavailable'),
    reason: UnavailableReasonSchema,
  })
  .strict();

export const CapturedContentSchema = z
  .object({
    state: z.literal('captured'),
    excerpt: z.string().max(MAX_CONTENT_EXCERPT_LENGTH),
    artifact: ArtifactReferenceSchema.optional(),
    truncated: z.boolean(),
    redaction: RedactionMetadataSchema,
  })
  .strict();

export const ContentCaptureSchema = z.discriminatedUnion('state', [
  OmittedContentSchema,
  UnavailableContentSchema,
  CapturedContentSchema,
]);

export type UnavailableReason = z.infer<typeof UnavailableReasonSchema>;
export type OmittedContent = z.infer<typeof OmittedContentSchema>;
export type UnavailableContent = z.infer<typeof UnavailableContentSchema>;
export type CapturedContent = z.infer<typeof CapturedContentSchema>;
export type ContentCapture = z.infer<typeof ContentCaptureSchema>;
