import { z } from 'zod';

import { ArtifactReferenceSchema } from './artifact.js';
import { ContentCaptureSchema } from './content.js';
import {
  BoundedIdentifierSchema,
  DurationMillisecondsSchema,
  LowercaseIdentifierSchema,
  NonNegativeSafeIntegerSchema,
  SchemaVersionSchema,
  UtcTimestampSchema,
  UuidSchema,
} from './primitives.js';
import { EvidenceCorrelationSchema, EvidenceSourceSchema } from './source.js';

export const EvidenceEventKindSchema = z.enum([
  'run.started',
  'run.finished',
  'tool.call.started',
  'tool.call.finished',
  'command.started',
  'command.finished',
  'test.run.finished',
  'git.snapshot.captured',
  'git.diff.captured',
  'error.observed',
  'usage.observed',
]);

export const OperationOutcomeSchema = z.enum([
  'succeeded',
  'failed',
  'cancelled',
  'unknown',
]);

export const TestOutcomeSchema = z.enum([
  'passed',
  'failed',
  'cancelled',
  'unknown',
]);

export const GitSnapshotPhaseSchema = z.enum(['before', 'after', 'checkpoint']);

export const RunStartedPayloadSchema = z
  .object({
    adapter: BoundedIdentifierSchema,
    provider: LowercaseIdentifierSchema,
    taskDescription: ContentCaptureSchema.optional(),
  })
  .strict();

export const RunFinishedPayloadSchema = z
  .object({
    outcome: OperationOutcomeSchema,
    durationMs: DurationMillisecondsSchema.optional(),
  })
  .strict();

export const ToolCallStartedPayloadSchema = z
  .object({
    toolCallId: UuidSchema,
    toolName: BoundedIdentifierSchema,
    input: ContentCaptureSchema,
  })
  .strict();

export const ToolCallFinishedPayloadSchema = z
  .object({
    toolCallId: UuidSchema,
    toolName: BoundedIdentifierSchema,
    outcome: OperationOutcomeSchema,
    durationMs: DurationMillisecondsSchema.optional(),
    output: ContentCaptureSchema,
  })
  .strict();

export const CommandStartedPayloadSchema = z
  .object({
    commandId: UuidSchema,
    command: ContentCaptureSchema,
    workingDirectory: ContentCaptureSchema,
  })
  .strict();

export const CommandFinishedPayloadSchema = z
  .object({
    commandId: UuidSchema,
    outcome: OperationOutcomeSchema,
    exitCode: NonNegativeSafeIntegerSchema.optional(),
    terminationSignal: z.string().min(1).max(32).optional(),
    durationMs: DurationMillisecondsSchema.optional(),
    stdout: ContentCaptureSchema,
    stderr: ContentCaptureSchema,
  })
  .strict();

export const TestCountsSchema = z
  .object({
    total: NonNegativeSafeIntegerSchema.optional(),
    passed: NonNegativeSafeIntegerSchema.optional(),
    failed: NonNegativeSafeIntegerSchema.optional(),
    skipped: NonNegativeSafeIntegerSchema.optional(),
    todo: NonNegativeSafeIntegerSchema.optional(),
  })
  .strict()
  .refine(
    (counts) => Object.values(counts).some((value) => value !== undefined),
    {
      message: 'At least one test count must be provided',
    },
  );

export const TestRunFinishedPayloadSchema = z
  .object({
    testRunId: UuidSchema,
    commandId: UuidSchema.optional(),
    framework: BoundedIdentifierSchema,
    outcome: TestOutcomeSchema,
    counts: TestCountsSchema.optional(),
    durationMs: DurationMillisecondsSchema.optional(),
    reportArtifact: ArtifactReferenceSchema.optional(),
  })
  .strict();

export const GitSnapshotCapturedPayloadSchema = z
  .object({
    snapshotId: UuidSchema,
    phase: GitSnapshotPhaseSchema,
    headCommit: z
      .string()
      .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
      .optional(),
    isDirty: z.boolean(),
    stagedFileCount: NonNegativeSafeIntegerSchema.optional(),
    unstagedFileCount: NonNegativeSafeIntegerSchema.optional(),
    untrackedFileCount: NonNegativeSafeIntegerSchema.optional(),
    statusArtifact: ArtifactReferenceSchema.optional(),
  })
  .strict();

export const GitDiffCapturedPayloadSchema = z
  .object({
    diffId: UuidSchema,
    fromSnapshotId: UuidSchema,
    toSnapshotId: UuidSchema,
    filesChanged: NonNegativeSafeIntegerSchema.optional(),
    linesAdded: NonNegativeSafeIntegerSchema.optional(),
    linesDeleted: NonNegativeSafeIntegerSchema.optional(),
    diffArtifact: ArtifactReferenceSchema,
    fileListArtifact: ArtifactReferenceSchema,
  })
  .strict();

export const ErrorObservedPayloadSchema = z
  .object({
    errorId: UuidSchema,
    category: LowercaseIdentifierSchema,
    code: LowercaseIdentifierSchema,
    retryable: z.boolean().optional(),
    message: ContentCaptureSchema,
    relatedOperationId: UuidSchema.optional(),
    relatedEventId: UuidSchema.optional(),
  })
  .strict();

export const UsageUnavailableReasonSchema = z.enum([
  'not-reported',
  'not-supported',
  'collection-failed',
]);

export const ReportedTokenMeasurementSchema = z
  .object({
    state: z.literal('reported'),
    value: NonNegativeSafeIntegerSchema,
  })
  .strict();

export const UnavailableTokenMeasurementSchema = z
  .object({
    state: z.literal('unavailable'),
    reason: UsageUnavailableReasonSchema,
  })
  .strict();

export const TokenMeasurementSchema = z.discriminatedUnion('state', [
  ReportedTokenMeasurementSchema,
  UnavailableTokenMeasurementSchema,
]);

export const UsageObservedPayloadSchema = z
  .object({
    provider: LowercaseIdentifierSchema.optional(),
    model: BoundedIdentifierSchema.optional(),
    inputTokens: TokenMeasurementSchema,
    outputTokens: TokenMeasurementSchema,
    cachedInputTokens: TokenMeasurementSchema,
    reasoningTokens: TokenMeasurementSchema,
    totalTokens: TokenMeasurementSchema,
  })
  .strict();

const evidenceEnvelopeShape = {
  schemaVersion: SchemaVersionSchema,
  eventId: UuidSchema,
  runId: UuidSchema,
  sequence: NonNegativeSafeIntegerSchema,
  observedAt: UtcTimestampSchema,
  occurredAt: UtcTimestampSchema.optional(),
  source: EvidenceSourceSchema,
  correlation: EvidenceCorrelationSchema.optional(),
};

export const RunStartedEventSchema = z
  .object({
    ...evidenceEnvelopeShape,
    kind: z.literal('run.started'),
    payload: RunStartedPayloadSchema,
  })
  .strict();

export const RunFinishedEventSchema = z
  .object({
    ...evidenceEnvelopeShape,
    kind: z.literal('run.finished'),
    payload: RunFinishedPayloadSchema,
  })
  .strict();

export const ToolCallStartedEventSchema = z
  .object({
    ...evidenceEnvelopeShape,
    kind: z.literal('tool.call.started'),
    payload: ToolCallStartedPayloadSchema,
  })
  .strict();

export const ToolCallFinishedEventSchema = z
  .object({
    ...evidenceEnvelopeShape,
    kind: z.literal('tool.call.finished'),
    payload: ToolCallFinishedPayloadSchema,
  })
  .strict();

export const CommandStartedEventSchema = z
  .object({
    ...evidenceEnvelopeShape,
    kind: z.literal('command.started'),
    payload: CommandStartedPayloadSchema,
  })
  .strict();

export const CommandFinishedEventSchema = z
  .object({
    ...evidenceEnvelopeShape,
    kind: z.literal('command.finished'),
    payload: CommandFinishedPayloadSchema,
  })
  .strict();

export const TestRunFinishedEventSchema = z
  .object({
    ...evidenceEnvelopeShape,
    kind: z.literal('test.run.finished'),
    payload: TestRunFinishedPayloadSchema,
  })
  .strict();

export const GitSnapshotCapturedEventSchema = z
  .object({
    ...evidenceEnvelopeShape,
    kind: z.literal('git.snapshot.captured'),
    payload: GitSnapshotCapturedPayloadSchema,
  })
  .strict();

export const GitDiffCapturedEventSchema = z
  .object({
    ...evidenceEnvelopeShape,
    kind: z.literal('git.diff.captured'),
    payload: GitDiffCapturedPayloadSchema,
  })
  .strict();

export const ErrorObservedEventSchema = z
  .object({
    ...evidenceEnvelopeShape,
    kind: z.literal('error.observed'),
    payload: ErrorObservedPayloadSchema,
  })
  .strict();

export const UsageObservedEventSchema = z
  .object({
    ...evidenceEnvelopeShape,
    kind: z.literal('usage.observed'),
    payload: UsageObservedPayloadSchema,
  })
  .strict();

export const EvidenceEventSchema = z.discriminatedUnion('kind', [
  RunStartedEventSchema,
  RunFinishedEventSchema,
  ToolCallStartedEventSchema,
  ToolCallFinishedEventSchema,
  CommandStartedEventSchema,
  CommandFinishedEventSchema,
  TestRunFinishedEventSchema,
  GitSnapshotCapturedEventSchema,
  GitDiffCapturedEventSchema,
  ErrorObservedEventSchema,
  UsageObservedEventSchema,
]);

export type EvidenceEventKind = z.infer<typeof EvidenceEventKindSchema>;
export type OperationOutcome = z.infer<typeof OperationOutcomeSchema>;
export type TestOutcome = z.infer<typeof TestOutcomeSchema>;
export type GitSnapshotPhase = z.infer<typeof GitSnapshotPhaseSchema>;
export type RunStartedPayload = z.infer<typeof RunStartedPayloadSchema>;
export type RunFinishedPayload = z.infer<typeof RunFinishedPayloadSchema>;
export type ToolCallStartedPayload = z.infer<
  typeof ToolCallStartedPayloadSchema
>;
export type ToolCallFinishedPayload = z.infer<
  typeof ToolCallFinishedPayloadSchema
>;
export type CommandStartedPayload = z.infer<typeof CommandStartedPayloadSchema>;
export type CommandFinishedPayload = z.infer<
  typeof CommandFinishedPayloadSchema
>;
export type TestCounts = z.infer<typeof TestCountsSchema>;
export type TestRunFinishedPayload = z.infer<
  typeof TestRunFinishedPayloadSchema
>;
export type GitSnapshotCapturedPayload = z.infer<
  typeof GitSnapshotCapturedPayloadSchema
>;
export type GitDiffCapturedPayload = z.infer<
  typeof GitDiffCapturedPayloadSchema
>;
export type ErrorObservedPayload = z.infer<typeof ErrorObservedPayloadSchema>;
export type UsageUnavailableReason = z.infer<
  typeof UsageUnavailableReasonSchema
>;
export type TokenMeasurement = z.infer<typeof TokenMeasurementSchema>;
export type UsageObservedPayload = z.infer<typeof UsageObservedPayloadSchema>;
export type RunStartedEvent = z.infer<typeof RunStartedEventSchema>;
export type RunFinishedEvent = z.infer<typeof RunFinishedEventSchema>;
export type ToolCallStartedEvent = z.infer<typeof ToolCallStartedEventSchema>;
export type ToolCallFinishedEvent = z.infer<typeof ToolCallFinishedEventSchema>;
export type CommandStartedEvent = z.infer<typeof CommandStartedEventSchema>;
export type CommandFinishedEvent = z.infer<typeof CommandFinishedEventSchema>;
export type TestRunFinishedEvent = z.infer<typeof TestRunFinishedEventSchema>;
export type GitSnapshotCapturedEvent = z.infer<
  typeof GitSnapshotCapturedEventSchema
>;
export type GitDiffCapturedEvent = z.infer<typeof GitDiffCapturedEventSchema>;
export type ErrorObservedEvent = z.infer<typeof ErrorObservedEventSchema>;
export type UsageObservedEvent = z.infer<typeof UsageObservedEventSchema>;
export type EvidenceEvent = z.infer<typeof EvidenceEventSchema>;
