import { z } from 'zod';

import {
  BoundedIdentifierSchema,
  LowercaseIdentifierSchema,
  MAX_NATIVE_ID_LENGTH,
  UuidSchema,
} from './primitives.js';

export const SourceComponentSchema = z.enum([
  'collector',
  'agent-adapter',
  'git',
  'process',
  'test-parser',
]);

export const EvidenceSourceSchema = z
  .object({
    component: SourceComponentSchema,
    provider: LowercaseIdentifierSchema.optional(),
    nativeSessionId: z.string().min(1).max(MAX_NATIVE_ID_LENGTH).optional(),
    nativeEventId: z.string().min(1).max(MAX_NATIVE_ID_LENGTH).optional(),
  })
  .strict();

const nonZeroHex = (length: number) =>
  z
    .string()
    .regex(new RegExp(`^[a-f0-9]{${length}}$`))
    .refine((value) => !/^0+$/.test(value), {
      message: 'Trace identifiers must not be all zeroes',
    });

export const TraceIdSchema = nonZeroHex(32);
export const SpanIdSchema = nonZeroHex(16);

export const EvidenceCorrelationSchema = z
  .object({
    parentEventId: UuidSchema.optional(),
    traceId: TraceIdSchema.optional(),
    spanId: SpanIdSchema.optional(),
  })
  .strict()
  .refine(
    (value) => value.traceId !== undefined || value.spanId === undefined,
    {
      message: 'spanId requires traceId',
      path: ['spanId'],
    },
  );

export const OperationNameSchema = BoundedIdentifierSchema;

export type SourceComponent = z.infer<typeof SourceComponentSchema>;
export type EvidenceSource = z.infer<typeof EvidenceSourceSchema>;
export type EvidenceCorrelation = z.infer<typeof EvidenceCorrelationSchema>;
