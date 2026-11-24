import { createHash } from 'node:crypto';

import {
  ArtifactReferenceSchema,
  ContentCaptureSchema,
  EvidenceEventSchema,
  extractArtifactReferences,
  GitFileStateV1Schema,
  JsonPointerSchema,
  LowercaseIdentifierSchema,
  NonNegativeSafeIntegerSchema,
  Sha256Schema,
  TestCountsSchema,
  UsageObservedPayloadSchema,
  UtcTimestampSchema,
  UuidSchema,
} from '@blackbox/contracts';
import { z } from 'zod';

export const EVIDENCE_EXPORT_FORMAT = 'evidence-export' as const;
export const EVIDENCE_EXPORT_VERSION = 1 as const;
export const EVIDENCE_EXPORT_MEDIA_TYPE =
  'application/vnd.ai-agent-black-box.evidence-export.v1+json' as const;
export const EVIDENCE_EXPORT_V1_FINDING_RULES = [
  'bbx.sensitive-area-change',
  'bbx.production-change-without-test-evidence',
  'bbx.tests-not-after-last-code-change',
  'bbx.final-tree-differs-from-tested-state',
  'bbx.repeated-failed-command',
  'bbx.lockfile-without-manifest',
  'bbx.test-removal-or-weakening',
  'bbx.out-of-scope-change',
  'bbx.success-claim-without-test-evidence',
] as const;

/** Public V1 bounds. Raising one is a format-compatibility decision. */
export const EVIDENCE_EXPORT_V1_LIMITS = Object.freeze({
  events: 20_000,
  artifacts: 40_000,
  artifactDeclarations: 40_000,
  completenessReasons: 100,
  commands: 20_000,
  tools: 20_000,
  tests: 20_000,
  gitSnapshots: 20_000,
  gitDiffs: 20_000,
  errors: 20_000,
  usage: 20_000,
  files: 20_000,
  findings: 100,
  findingReasonCodes: 100,
  findingMatches: 100,
  findingReferences: 100,
  summaryClaims: 100,
  summarySupports: 100,
  limitations: 32,
  totalCanonicalBytes: 16 * 1_024 * 1_024,
  safeCodeLength: 128,
  displayStringLength: 32_768,
  explanationLength: 1_000,
});

const SafeCodeSchema = z
  .string()
  .min(1)
  .max(EVIDENCE_EXPORT_V1_LIMITS.safeCodeLength)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);
const BoundedDisplayStringSchema = z
  .string()
  .min(1)
  .max(EVIDENCE_EXPORT_V1_LIMITS.displayStringLength);
const NullableSafeIntegerSchema = NonNegativeSafeIntegerSchema.nullable();
const FingerprintSchema = Sha256Schema;

export const ExportUnavailableReasonSchema = z.enum([
  'missing',
  'processing',
  'stale',
  'incomplete',
  'failed',
]);
export type ExportUnavailableReason = z.infer<
  typeof ExportUnavailableReasonSchema
>;

export const ExportV1ProcessingCurrentnessSchema = z.enum([
  'processing',
  'stale',
  'ready',
  'incomplete',
  'failed',
]);
export const ExportV1ProcessingStateSchema = z.enum([
  'missing',
  'pending',
  'processing',
  'retrying',
  'ready',
  'failed',
]);

export const ExportV1ProjectorProcessingSchema = z
  .object({
    projectorName: LowercaseIdentifierSchema,
    expectedVersion: NonNegativeSafeIntegerSchema.min(1),
    observedVersion: NonNegativeSafeIntegerSchema.min(1).nullable(),
    state: ExportV1ProcessingStateSchema,
    currentness: ExportV1ProcessingCurrentnessSchema,
    sourceEventCount: NullableSafeIntegerSchema,
    sourceMaxSequence: NullableSafeIntegerSchema,
    sourceFingerprint: FingerprintSchema.nullable(),
    errorCode: SafeCodeSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.state === 'missing' && value.observedVersion !== null)
      context.addIssue({
        code: 'custom',
        path: ['observedVersion'],
        message: 'Missing processing state cannot have an observed version.',
      });
    if (value.state === 'failed' && value.errorCode === null)
      context.addIssue({
        code: 'custom',
        path: ['errorCode'],
        message: 'Failed processing state requires a safe error code.',
      });
    if (value.state !== 'failed' && value.errorCode !== null)
      context.addIssue({
        code: 'custom',
        path: ['errorCode'],
        message: 'Only failed processing state carries an error code.',
      });
  });

export const ExportV1ProcessingSchema = z
  .object({
    core: ExportV1ProjectorProcessingSchema,
    files: ExportV1ProjectorProcessingSchema,
    findings: ExportV1ProjectorProcessingSchema,
    summary: ExportV1ProjectorProcessingSchema,
  })
  .strict();

export const ExportV1EventSchema = z
  .object({
    receivedAt: UtcTimestampSchema,
    event: EvidenceEventSchema,
  })
  .strict();

export const ExportV1ArtifactDeclarationSchema = z
  .object({
    eventId: UuidSchema,
    pointer: JsonPointerSchema,
  })
  .strict();

export const ExportV1ArtifactVerificationSchema = z.discriminatedUnion(
  'state',
  [
    z
      .object({
        state: z.literal('verified'),
        observedByteLength: NonNegativeSafeIntegerSchema,
        observedSha256: Sha256Schema,
        verifiedAt: UtcTimestampSchema,
      })
      .strict(),
    z
      .object({
        state: z.literal('unavailable'),
        reason: z.enum(['artifact_not_verified', 'integrity_mismatch']),
      })
      .strict(),
  ],
);

export const ExportV1ArtifactSchema = z
  .object({
    artifact: ArtifactReferenceSchema,
    receivedAt: UtcTimestampSchema,
    declaredBy: z
      .array(ExportV1ArtifactDeclarationSchema)
      .min(1)
      .max(EVIDENCE_EXPORT_V1_LIMITS.artifactDeclarations),
    verification: ExportV1ArtifactVerificationSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.verification.state === 'verified' &&
      (value.verification.observedByteLength !== value.artifact.byteLength ||
        value.verification.observedSha256 !== value.artifact.sha256)
    )
      context.addIssue({
        code: 'custom',
        path: ['verification'],
        message: 'Verified metadata must match the immutable declaration.',
      });
  });

export const ExportV1EventReferenceSchema = z
  .object({
    eventId: UuidSchema,
    sequence: NonNegativeSafeIntegerSchema,
  })
  .strict();

const OperationStateSchema = z.enum(['complete', 'incomplete', 'conflict']);

export const ExportV1CommandSchema = z
  .object({
    operationId: UuidSchema,
    start: ExportV1EventReferenceSchema.nullable(),
    finish: ExportV1EventReferenceSchema.nullable(),
    state: OperationStateSchema,
    outcome: z.enum(['succeeded', 'failed', 'cancelled', 'unknown']).nullable(),
    durationMs: NullableSafeIntegerSchema,
    exitCode: NullableSafeIntegerSchema,
    terminationSignal: z.string().min(1).max(32).nullable(),
    commandCapture: ContentCaptureSchema.nullable(),
    workingDirectory: ContentCaptureSchema.nullable(),
    stdoutCapture: ContentCaptureSchema.nullable(),
    stderrCapture: ContentCaptureSchema.nullable(),
  })
  .strict();

export const ExportV1ToolSchema = z
  .object({
    operationId: UuidSchema,
    start: ExportV1EventReferenceSchema.nullable(),
    finish: ExportV1EventReferenceSchema.nullable(),
    state: OperationStateSchema,
    toolName: z.string().min(1).max(128).nullable(),
    outcome: z.enum(['succeeded', 'failed', 'cancelled', 'unknown']).nullable(),
    durationMs: NullableSafeIntegerSchema,
    inputCapture: ContentCaptureSchema.nullable(),
    outputCapture: ContentCaptureSchema.nullable(),
  })
  .strict();

export const ExportV1TestSchema = z
  .object({
    testRunId: UuidSchema,
    source: ExportV1EventReferenceSchema,
    commandId: UuidSchema.nullable(),
    framework: z.string().min(1).max(128),
    outcome: z.enum(['passed', 'failed', 'cancelled', 'unknown']),
    counts: TestCountsSchema.nullable(),
    durationMs: NullableSafeIntegerSchema,
    reportArtifactId: UuidSchema.nullable(),
  })
  .strict();

export const ExportV1GitSnapshotSchema = z
  .object({
    snapshotId: UuidSchema,
    source: ExportV1EventReferenceSchema,
    phase: z.enum(['before', 'after', 'checkpoint']),
    headCommit: z
      .string()
      .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
      .nullable(),
    isDirty: z.boolean(),
    stagedFileCount: NullableSafeIntegerSchema,
    unstagedFileCount: NullableSafeIntegerSchema,
    untrackedFileCount: NullableSafeIntegerSchema,
    statusArtifactId: UuidSchema.nullable(),
  })
  .strict();

export const ExportV1GitDiffSchema = z
  .object({
    diffId: UuidSchema,
    source: ExportV1EventReferenceSchema,
    fromSnapshotId: UuidSchema,
    toSnapshotId: UuidSchema,
    filesChanged: NullableSafeIntegerSchema,
    linesAdded: NullableSafeIntegerSchema,
    linesDeleted: NullableSafeIntegerSchema,
    diffArtifactId: UuidSchema,
    fileListArtifactId: UuidSchema,
  })
  .strict();

export const ExportV1ErrorSchema = z
  .object({
    errorId: UuidSchema,
    source: ExportV1EventReferenceSchema,
    category: SafeCodeSchema,
    code: SafeCodeSchema,
    retryable: z.boolean().nullable(),
    messageCapture: ContentCaptureSchema,
    relatedOperationId: UuidSchema.nullable(),
    relatedEventId: UuidSchema.nullable(),
  })
  .strict();

export const ExportV1UsageSchema = z
  .object({
    source: ExportV1EventReferenceSchema,
    provider: SafeCodeSchema.nullable(),
    model: z.string().min(1).max(128).nullable(),
    measurements: UsageObservedPayloadSchema,
  })
  .strict();

const AggregateCountsSchema = z
  .object({
    total: NullableSafeIntegerSchema,
    passed: NullableSafeIntegerSchema,
    failed: NullableSafeIntegerSchema,
    skipped: NullableSafeIntegerSchema,
    todo: NullableSafeIntegerSchema,
  })
  .strict();
const TokenAggregateSchema = z
  .object({
    reportedTotal: NullableSafeIntegerSchema,
    unavailableCount: NonNegativeSafeIntegerSchema,
  })
  .strict();
const TokenAggregatesSchema = z
  .object({
    inputTokens: TokenAggregateSchema,
    outputTokens: TokenAggregateSchema,
    cachedInputTokens: TokenAggregateSchema,
    reasoningTokens: TokenAggregateSchema,
    totalTokens: TokenAggregateSchema,
  })
  .strict();

export const ExportV1CoreProjectionSchema = z
  .object({
    state: z.literal('available'),
    projectorName: z.literal('core'),
    projectorVersion: z.literal(1),
    source: z
      .object({
        eventCount: NonNegativeSafeIntegerSchema,
        maxSequence: NullableSafeIntegerSchema,
        fingerprint: FingerprintSchema,
      })
      .strict(),
    run: z
      .object({
        started: ExportV1EventReferenceSchema.nullable(),
        finished: ExportV1EventReferenceSchema.nullable(),
        adapter: z.string().min(1).max(128).nullable(),
        provider: SafeCodeSchema.nullable(),
        observedOutcome: z
          .enum(['succeeded', 'failed', 'cancelled', 'unknown'])
          .nullable(),
        durationMs: NullableSafeIntegerSchema,
        evidenceCompleteness: z.enum(['complete', 'incomplete']),
        completenessReasons: z
          .array(SafeCodeSchema)
          .max(EVIDENCE_EXPORT_V1_LIMITS.completenessReasons),
        commandCount: NullableSafeIntegerSchema,
        toolCallCount: NullableSafeIntegerSchema,
        testObservationState: z.enum(['not_observed', 'observed']),
        testCounts: AggregateCountsSchema,
        tokenAggregates: TokenAggregatesSchema,
        filesChanged: NullableSafeIntegerSchema,
      })
      .strict(),
    commands: z
      .array(ExportV1CommandSchema)
      .max(EVIDENCE_EXPORT_V1_LIMITS.commands),
    tools: z.array(ExportV1ToolSchema).max(EVIDENCE_EXPORT_V1_LIMITS.tools),
    tests: z.array(ExportV1TestSchema).max(EVIDENCE_EXPORT_V1_LIMITS.tests),
    gitSnapshots: z
      .array(ExportV1GitSnapshotSchema)
      .max(EVIDENCE_EXPORT_V1_LIMITS.gitSnapshots),
    gitDiffs: z
      .array(ExportV1GitDiffSchema)
      .max(EVIDENCE_EXPORT_V1_LIMITS.gitDiffs),
    errors: z.array(ExportV1ErrorSchema).max(EVIDENCE_EXPORT_V1_LIMITS.errors),
    usage: z.array(ExportV1UsageSchema).max(EVIDENCE_EXPORT_V1_LIMITS.usage),
  })
  .strict();

export const ExportV1UnavailableSectionSchema = z
  .object({
    state: z.literal('unavailable'),
    reason: ExportUnavailableReasonSchema,
  })
  .strict();

export const ExportV1CoreSectionSchema = z.discriminatedUnion('state', [
  ExportV1CoreProjectionSchema,
  ExportV1UnavailableSectionSchema,
]);

export const ExportV1FileSchema = z
  .object({
    sourceEventId: UuidSchema,
    sourceSequence: NonNegativeSafeIntegerSchema,
    diffId: UuidSchema,
    fromSnapshotId: UuidSchema,
    toSnapshotId: UuidSchema,
    artifactId: UuidSchema,
    ordinal: NonNegativeSafeIntegerSchema,
    entryId: Sha256Schema,
    originalEntryId: Sha256Schema.nullable(),
    displayPath: BoundedDisplayStringSchema,
    originalDisplayPath: BoundedDisplayStringSchema.nullable(),
    displayAmbiguous: z.boolean(),
    displayReason: SafeCodeSchema.nullable(),
    before: GitFileStateV1Schema.nullable(),
    after: GitFileStateV1Schema.nullable(),
    attribution: z.enum([
      'pre-existing',
      'observed-during-run',
      'mixed-or-uncertain',
      'unavailable',
    ]),
    reason: SafeCodeSchema.nullable(),
  })
  .strict();

export const ExportV1FilesProjectionSchema = z
  .object({
    state: z.literal('available'),
    projectorName: z.literal('files'),
    projectorVersion: z.literal(1),
    source: z
      .object({
        eventCount: NonNegativeSafeIntegerSchema,
        maxSequence: NullableSafeIntegerSchema,
        fingerprint: FingerprintSchema,
      })
      .strict(),
    completeness: z.enum(['complete', 'incomplete']),
    completenessReason: SafeCodeSchema.nullable(),
    files: z.array(ExportV1FileSchema).max(EVIDENCE_EXPORT_V1_LIMITS.files),
  })
  .strict();

export const ExportV1FilesSectionSchema = z.discriminatedUnion('state', [
  ExportV1FilesProjectionSchema,
  ExportV1UnavailableSectionSchema,
]);

export const ExportV1EvidenceReferenceSchema = z
  .object({
    ordinal: NonNegativeSafeIntegerSchema,
    eventId: UuidSchema,
    artifactId: UuidSchema.nullable(),
    eventArtifactPointer: JsonPointerSchema.nullable(),
    jsonPointer: JsonPointerSchema.nullable(),
    fileOrdinal: NonNegativeSafeIntegerSchema.nullable(),
    entryId: Sha256Schema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const artifactFields = [value.artifactId, value.eventArtifactPointer];
    if (
      artifactFields.some((item) => item !== null) !==
      artifactFields.every((item) => item !== null)
    )
      context.addIssue({
        code: 'custom',
        message: 'Artifact evidence identity must be complete.',
      });
    if ((value.fileOrdinal === null) !== (value.entryId === null))
      context.addIssue({
        code: 'custom',
        message: 'File evidence identity must be complete.',
      });
    if (value.fileOrdinal !== null && value.artifactId === null)
      context.addIssue({
        code: 'custom',
        message: 'File evidence requires an artifact identity.',
      });
  });

export const ExportV1FindingResultSchema = z
  .object({
    resultKey: Sha256Schema,
    catalogOrder: NonNegativeSafeIntegerSchema,
    ruleId: z.enum(EVIDENCE_EXPORT_V1_FINDING_RULES),
    ruleVersion: z.literal(1),
    severity: z.enum(['low', 'medium', 'high', 'critical']),
    outcome: z.enum(['triggered', 'clear', 'unknown']),
    coverage: z.enum(['complete', 'partial']),
    reasonCodes: z
      .array(SafeCodeSchema)
      .max(EVIDENCE_EXPORT_V1_LIMITS.findingReasonCodes),
    explanation: z
      .string()
      .min(1)
      .max(EVIDENCE_EXPORT_V1_LIMITS.explanationLength),
    matchCount: NonNegativeSafeIntegerSchema,
    matches: z
      .array(BoundedDisplayStringSchema)
      .max(EVIDENCE_EXPORT_V1_LIMITS.findingMatches),
    matchesTruncated: z.boolean(),
    referencesTruncated: z.boolean(),
    references: z
      .array(ExportV1EvidenceReferenceSchema)
      .max(EVIDENCE_EXPORT_V1_LIMITS.findingReferences),
  })
  .strict();

export const ExportV1FindingsProjectionSchema = z
  .object({
    state: z.literal('available'),
    projectorName: z.literal('findings'),
    projectorVersion: z.literal(1),
    analyzerName: z.literal('deterministic-findings'),
    analyzerVersion: z.literal(1),
    catalogVersion: z.literal(1),
    sourceFingerprint: FingerprintSchema,
    coreVersion: NonNegativeSafeIntegerSchema.min(1),
    coreFingerprint: FingerprintSchema,
    coreCompleteness: z.enum(['complete', 'incomplete']),
    filesVersion: NonNegativeSafeIntegerSchema.min(1).nullable(),
    filesFingerprint: FingerprintSchema.nullable(),
    filesCompleteness: z.enum(['complete', 'missing', 'stale', 'incomplete']),
    deterministicOutcome: z.enum(['pass', 'review', 'unknown']),
    coverage: z.enum(['complete', 'partial']),
    triggeredCount: NonNegativeSafeIntegerSchema,
    unknownCount: NonNegativeSafeIntegerSchema,
    highCount: NonNegativeSafeIntegerSchema,
    mediumCount: NonNegativeSafeIntegerSchema,
    results: z
      .array(ExportV1FindingResultSchema)
      .length(EVIDENCE_EXPORT_V1_FINDING_RULES.length)
      .max(EVIDENCE_EXPORT_V1_LIMITS.findings),
  })
  .strict();

export const ExportV1FindingsSectionSchema = z.discriminatedUnion('state', [
  ExportV1FindingsProjectionSchema,
  ExportV1UnavailableSectionSchema,
]);

export const ExportV1SummarySupportSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('evidence'),
      ordinal: NonNegativeSafeIntegerSchema,
      eventId: UuidSchema,
      artifactId: UuidSchema.nullable(),
      eventArtifactPointer: JsonPointerSchema.nullable(),
      jsonPointer: JsonPointerSchema.nullable(),
      fileOrdinal: NonNegativeSafeIntegerSchema.nullable(),
      entryId: Sha256Schema.nullable(),
    })
    .strict()
    .superRefine((value, context) => {
      if ((value.artifactId === null) !== (value.eventArtifactPointer === null))
        context.addIssue({
          code: 'custom',
          message: 'Evidence artifact support must be complete.',
        });
      if ((value.fileOrdinal === null) !== (value.entryId === null))
        context.addIssue({
          code: 'custom',
          message: 'Evidence file support must be complete.',
        });
      if (value.fileOrdinal !== null && value.artifactId === null)
        context.addIssue({
          code: 'custom',
          message: 'File support requires artifact evidence.',
        });
    }),
  z
    .object({
      kind: z.literal('finding'),
      ordinal: NonNegativeSafeIntegerSchema,
      resultKey: Sha256Schema,
      ruleId: SafeCodeSchema,
      ruleVersion: NonNegativeSafeIntegerSchema.min(1),
      findingsSourceFingerprint: FingerprintSchema,
    })
    .strict(),
]);

export const ExportV1SummaryClaimSchema = z
  .object({
    claimKey: Sha256Schema,
    stableId: z.string().min(1).max(160),
    sectionId: z.enum(['run', 'evidence', 'findings', 'limitations']),
    sectionOrder: NonNegativeSafeIntegerSchema.max(3),
    claimOrder: NonNegativeSafeIntegerSchema.max(99),
    class: z.enum(['observation', 'deterministic_assessment', 'limitation']),
    templateId: z.string().min(1).max(160),
    text: z.string().min(1).max(EVIDENCE_EXPORT_V1_LIMITS.explanationLength),
    supportCount: NonNegativeSafeIntegerSchema,
    supportsTruncated: z.boolean(),
    supports: z
      .array(ExportV1SummarySupportSchema)
      .min(1)
      .max(EVIDENCE_EXPORT_V1_LIMITS.summarySupports),
  })
  .strict();

export const ExportV1SummaryProjectionSchema = z
  .object({
    state: z.literal('available'),
    projectorName: z.literal('summary'),
    projectorVersion: z.literal(1),
    generatorName: z.literal('deterministic-structured-summary'),
    generatorVersion: z.literal(1),
    formatVersion: z.literal(1),
    templateVersion: z.literal(1),
    summaryKey: Sha256Schema,
    sourceFingerprint: FingerprintSchema,
    coreVersion: NonNegativeSafeIntegerSchema.min(1),
    coreFingerprint: FingerprintSchema,
    coreCompleteness: z.enum(['complete', 'incomplete']),
    filesVersion: NonNegativeSafeIntegerSchema.min(1).nullable(),
    filesFingerprint: FingerprintSchema.nullable(),
    filesCompleteness: z.enum(['complete', 'missing', 'stale', 'incomplete']),
    findingsProjectorVersion: NonNegativeSafeIntegerSchema.min(1),
    findingsFingerprint: FingerprintSchema,
    findingsAnalyzerName: LowercaseIdentifierSchema,
    findingsAnalyzerVersion: NonNegativeSafeIntegerSchema.min(1),
    findingsCatalogVersion: NonNegativeSafeIntegerSchema.min(1),
    outcome: z.enum(['pass', 'review', 'unknown']),
    sectionCount: NonNegativeSafeIntegerSchema,
    claimCount: NonNegativeSafeIntegerSchema,
    claimsTruncated: z.boolean(),
    claims: z
      .array(ExportV1SummaryClaimSchema)
      .max(EVIDENCE_EXPORT_V1_LIMITS.summaryClaims),
  })
  .strict();

export const ExportV1SummarySectionSchema = z.discriminatedUnion('state', [
  ExportV1SummaryProjectionSchema,
  ExportV1UnavailableSectionSchema,
]);

export const ExportV1SnapshotSchema = z
  .object({
    repositoryId: UuidSchema,
    runId: UuidSchema,
    events: z.array(ExportV1EventSchema).max(EVIDENCE_EXPORT_V1_LIMITS.events),
    artifacts: z
      .array(ExportV1ArtifactSchema)
      .max(EVIDENCE_EXPORT_V1_LIMITS.artifacts),
    processing: ExportV1ProcessingSchema,
    core: ExportV1CoreSectionSchema,
    files: ExportV1FilesSectionSchema,
    findings: ExportV1FindingsSectionSchema,
    summary: ExportV1SummarySectionSchema,
  })
  .strict();

export const ExportV1OutcomeSchema = z.discriminatedUnion('state', [
  z
    .object({
      state: z.literal('available'),
      value: z.string().min(1).max(32),
    })
    .strict(),
  ExportV1UnavailableSectionSchema,
]);

export const ExportV1OutcomesSchema = z
  .object({
    child: ExportV1OutcomeSchema,
    findings: ExportV1OutcomeSchema,
    summary: ExportV1OutcomeSchema,
    presentation: z.enum([
      'PASS',
      'REVIEW',
      'FAILED',
      'INCOMPLETE',
      'PROCESSING',
    ]),
  })
  .strict();

export const ExportV1LimitationSchema = z.enum([
  'artifact_bytes_excluded',
  'not_a_compliance_export',
  'not_a_correctness_certificate',
  'not_a_full_artifact_archive',
  'not_a_merge_approval',
  'not_a_signature',
  'source_content_omitted',
  'source_content_truncated',
  'source_content_unavailable',
]);

const EvidenceExportV1BaseSchema = z
  .object({
    format: z.literal(EVIDENCE_EXPORT_FORMAT),
    formatVersion: z.literal(EVIDENCE_EXPORT_VERSION),
    repositoryId: UuidSchema,
    runId: UuidSchema,
    events: z.array(ExportV1EventSchema).max(EVIDENCE_EXPORT_V1_LIMITS.events),
    artifacts: z
      .array(ExportV1ArtifactSchema)
      .max(EVIDENCE_EXPORT_V1_LIMITS.artifacts),
    processing: ExportV1ProcessingSchema,
    core: ExportV1CoreSectionSchema,
    files: ExportV1FilesSectionSchema,
    findings: ExportV1FindingsSectionSchema,
    summary: ExportV1SummarySectionSchema,
    outcomes: ExportV1OutcomesSchema,
    limitations: z
      .array(ExportV1LimitationSchema)
      .max(EVIDENCE_EXPORT_V1_LIMITS.limitations),
  })
  .strict();

function compareUtf8(left: string, right: string): number {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1)
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  return a.length - b.length;
}

function compareNumber(left: number, right: number): number {
  return left - right;
}

function compareTuple(
  left: readonly (number | string)[],
  right: readonly (number | string)[],
): number {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const a = left[index]!;
    const b = right[index]!;
    const compared =
      typeof a === 'number' && typeof b === 'number'
        ? compareNumber(a, b)
        : compareUtf8(String(a), String(b));
    if (compared !== 0) return compared;
  }
  return left.length - right.length;
}

function orderedUnique<T>(
  values: readonly T[],
  identity: (value: T) => string,
  order: (value: T) => readonly (number | string)[],
  context: z.RefinementCtx,
  path: (string | number)[],
): void {
  const identities = new Set<string>();
  let previous: T | undefined;
  for (const [index, value] of values.entries()) {
    const key = identity(value);
    if (identities.has(key))
      context.addIssue({
        code: 'custom',
        path: [...path, index],
        message: 'Duplicate canonical identity.',
      });
    identities.add(key);
    if (
      previous !== undefined &&
      compareTuple(order(previous), order(value)) >= 0
    )
      context.addIssue({
        code: 'custom',
        path: [...path, index],
        message: 'Collection is not in strict canonical order.',
      });
    previous = value;
  }
}

function unavailableReason(
  section:
    | { state: 'available' }
    | { state: 'unavailable'; reason: ExportUnavailableReason },
): ExportUnavailableReason | null {
  return section.state === 'unavailable' ? section.reason : null;
}

type ExportV1FilesDependency = {
  filesVersion: number | null;
  filesFingerprint: string | null;
  filesCompleteness: 'complete' | 'missing' | 'stale' | 'incomplete';
};

function filesDependencyMatchesSection(
  dependency: ExportV1FilesDependency,
  files: z.infer<typeof ExportV1FilesSectionSchema>,
): boolean {
  if (files.state === 'available')
    return (
      files.completeness === 'complete' &&
      dependency.filesVersion === files.projectorVersion &&
      dependency.filesFingerprint === files.source.fingerprint &&
      dependency.filesCompleteness === 'complete'
    );

  return (
    (files.reason === 'missing' ||
      files.reason === 'stale' ||
      files.reason === 'incomplete') &&
    dependency.filesVersion === null &&
    dependency.filesFingerprint === null &&
    dependency.filesCompleteness === files.reason
  );
}

function filesDependenciesMatch(
  left: ExportV1FilesDependency,
  right: ExportV1FilesDependency,
): boolean {
  return (
    left.filesVersion === right.filesVersion &&
    left.filesFingerprint === right.filesFingerprint &&
    left.filesCompleteness === right.filesCompleteness
  );
}

export function deriveExportV1Outcomes(
  snapshot: ExportV1Snapshot,
): z.infer<typeof ExportV1OutcomesSchema> {
  const child =
    snapshot.core.state === 'available' &&
    snapshot.core.run.observedOutcome !== null
      ? ({
          state: 'available',
          value: snapshot.core.run.observedOutcome,
        } as const)
      : ({
          state: 'unavailable',
          reason:
            unavailableReason(snapshot.core) ??
            (snapshot.core.state === 'available' &&
            snapshot.core.run.evidenceCompleteness === 'incomplete'
              ? 'incomplete'
              : 'missing'),
        } as const);
  const findings =
    snapshot.findings.state === 'available'
      ? ({
          state: 'available',
          value: snapshot.findings.deterministicOutcome,
        } as const)
      : ({ state: 'unavailable', reason: snapshot.findings.reason } as const);
  const summary =
    snapshot.summary.state === 'available'
      ? ({ state: 'available', value: snapshot.summary.outcome } as const)
      : ({ state: 'unavailable', reason: snapshot.summary.reason } as const);

  let presentation: z.infer<typeof ExportV1OutcomesSchema>['presentation'];
  if (
    child.state === 'available' &&
    (child.value === 'failed' || child.value === 'cancelled')
  )
    presentation = 'FAILED';
  else {
    const states = Object.values(snapshot.processing).map(
      (item) => item.currentness,
    );
    if (states.includes('processing')) presentation = 'PROCESSING';
    else if (states.some((state) => state !== 'ready'))
      presentation = 'INCOMPLETE';
    else if (
      findings.state !== 'available' ||
      summary.state !== 'available' ||
      (findings.value !== 'pass' && findings.value !== 'review') ||
      (summary.value !== 'pass' && summary.value !== 'review') ||
      findings.value !== summary.value
    )
      presentation = 'INCOMPLETE';
    else presentation = summary.value === 'review' ? 'REVIEW' : 'PASS';
  }
  return { child, findings, summary, presentation };
}

function contentLimitations(value: unknown, result: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) contentLimitations(item, result);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  if (record.state === 'omitted') result.add('source_content_omitted');
  if (record.state === 'unavailable') result.add('source_content_unavailable');
  if (record.truncated === true) result.add('source_content_truncated');
  for (const item of Object.values(record)) contentLimitations(item, result);
}

export function deriveExportV1Limitations(
  snapshot: Pick<ExportV1Snapshot, 'events'>,
): z.infer<typeof ExportV1LimitationSchema>[] {
  const values = new Set<string>([
    'artifact_bytes_excluded',
    'not_a_compliance_export',
    'not_a_correctness_certificate',
    'not_a_full_artifact_archive',
    'not_a_merge_approval',
    'not_a_signature',
  ]);
  for (const item of snapshot.events) contentLimitations(item.event, values);
  return [...values]
    .sort(compareUtf8)
    .map((value) => ExportV1LimitationSchema.parse(value));
}

function validateEventReference(
  reference: z.infer<typeof ExportV1EventReferenceSchema> | null,
  events: ReadonlyMap<string, z.infer<typeof ExportV1EventSchema>>,
  context: z.RefinementCtx,
  path: (string | number)[],
): void {
  if (!reference) return;
  const event = events.get(reference.eventId);
  if (!event || event.event.sequence !== reference.sequence)
    context.addIssue({
      code: 'custom',
      path,
      message: 'Projection reference does not resolve to immutable evidence.',
    });
}

function validateEvidenceReference(
  reference: {
    eventId: string;
    artifactId: string | null;
    eventArtifactPointer: string | null;
  },
  events: ReadonlyMap<string, z.infer<typeof ExportV1EventSchema>>,
  artifacts: ReadonlyMap<string, z.infer<typeof ExportV1ArtifactSchema>>,
  context: z.RefinementCtx,
  path: (string | number)[],
): void {
  if (!events.has(reference.eventId))
    context.addIssue({
      code: 'custom',
      path: [...path, 'eventId'],
      message: 'Evidence support event is not in this bundle.',
    });
  if (reference.artifactId !== null) {
    const artifact = artifacts.get(reference.artifactId);
    if (
      !artifact ||
      reference.eventArtifactPointer === null ||
      !artifact.declaredBy.some(
        (declaration) =>
          declaration.eventId === reference.eventId &&
          declaration.pointer === reference.eventArtifactPointer,
      )
    )
      context.addIssue({
        code: 'custom',
        path: [...path, 'artifactId'],
        message: 'Evidence support artifact is not declared by this event.',
      });
  }
}

function validateBundle(
  value: z.infer<typeof EvidenceExportV1BaseSchema>,
  context: z.RefinementCtx,
): void {
  orderedUnique(
    value.events,
    (item) => item.event.eventId,
    (item) => [item.event.sequence, item.event.eventId],
    context,
    ['events'],
  );
  const sequences = new Set<number>();
  const events = new Map(
    value.events.map((item) => [item.event.eventId, item]),
  );
  for (const [index, item] of value.events.entries()) {
    if (item.event.runId !== value.runId)
      context.addIssue({
        code: 'custom',
        path: ['events', index, 'event', 'runId'],
        message: 'Immutable event belongs to another run.',
      });
    if (sequences.has(item.event.sequence))
      context.addIssue({
        code: 'custom',
        path: ['events', index, 'event', 'sequence'],
        message: 'Duplicate immutable event sequence.',
      });
    sequences.add(item.event.sequence);
  }

  orderedUnique(
    value.artifacts,
    (item) => item.artifact.artifactId,
    (item) => [item.artifact.artifactId],
    context,
    ['artifacts'],
  );
  const artifacts = new Map(
    value.artifacts.map((item) => [item.artifact.artifactId, item]),
  );
  const artifactDeclarationCount = value.artifacts.reduce(
    (count, item) => count + item.declaredBy.length,
    0,
  );
  if (artifactDeclarationCount > EVIDENCE_EXPORT_V1_LIMITS.artifactDeclarations)
    context.addIssue({
      code: 'custom',
      path: ['artifacts'],
      message: 'Artifact declaration links exceed the Export V1 bound.',
    });
  for (const [artifactIndex, item] of value.artifacts.entries()) {
    orderedUnique(
      item.declaredBy,
      (declaration) => `${declaration.eventId}\0${declaration.pointer}`,
      (declaration) => [declaration.eventId, declaration.pointer],
      context,
      ['artifacts', artifactIndex, 'declaredBy'],
    );
    for (const [declarationIndex, declaration] of item.declaredBy.entries()) {
      const event = events.get(declaration.eventId);
      const candidate = event
        ? extractArtifactReferences(event.event).find(
            (reference) => reference.jsonPointer === declaration.pointer,
          )?.reference
        : undefined;
      if (
        !candidate ||
        candidate.artifactId !== item.artifact.artifactId ||
        candidate.kind !== item.artifact.kind ||
        candidate.mediaType !== item.artifact.mediaType ||
        candidate.byteLength !== item.artifact.byteLength ||
        candidate.sha256 !== item.artifact.sha256 ||
        candidate.redaction.applied !== item.artifact.redaction.applied ||
        (candidate.redaction.rulesetVersion ?? null) !==
          (item.artifact.redaction.rulesetVersion ?? null) ||
        (candidate.compression ?? null) !==
          (item.artifact.compression ?? null) ||
        (candidate.characterEncoding ?? null) !==
          (item.artifact.characterEncoding ?? null)
      )
        context.addIssue({
          code: 'custom',
          path: ['artifacts', artifactIndex, 'declaredBy', declarationIndex],
          message: 'Artifact declaration does not match immutable evidence.',
        });
    }
  }
  for (const [eventIndex, item] of value.events.entries())
    for (const reference of extractArtifactReferences(item.event)) {
      const artifact = artifacts.get(reference.reference.artifactId);
      if (
        !artifact ||
        !artifact.declaredBy.some(
          (declaration) =>
            declaration.eventId === item.event.eventId &&
            declaration.pointer === reference.jsonPointer,
        )
      )
        context.addIssue({
          code: 'custom',
          path: ['events', eventIndex, 'event'],
          message: 'Immutable artifact reference is absent from declarations.',
        });
    }

  const processingNames = {
    core: 'core',
    files: 'files',
    findings: 'findings',
    summary: 'summary',
  } as const;
  for (const key of Object.keys(processingNames) as Array<
    keyof typeof processingNames
  >) {
    const processing = value.processing[key];
    if (
      processing.projectorName !== processingNames[key] ||
      processing.expectedVersion !== 1
    )
      context.addIssue({
        code: 'custom',
        path: ['processing', key],
        message: 'Processing identity is incompatible with Export V1.',
      });
  }

  if (value.core.state === 'available') {
    const expectedMax = value.events.at(-1)?.event.sequence ?? null;
    const expectedFingerprint = createHash('sha256')
      .update(
        value.events
          .map((item) => `${item.event.sequence}:${item.event.eventId}\n`)
          .join(''),
      )
      .digest('hex');
    if (
      value.core.source.eventCount !== value.events.length ||
      value.core.source.maxSequence !== expectedMax ||
      value.core.source.fingerprint !== expectedFingerprint ||
      value.core.projectorVersion !== 1 ||
      !['ready', 'incomplete'].includes(value.processing.core.currentness) ||
      value.processing.core.sourceEventCount !== value.core.source.eventCount ||
      value.processing.core.sourceMaxSequence !==
        value.core.source.maxSequence ||
      value.processing.core.sourceFingerprint !== value.core.source.fingerprint
    )
      context.addIssue({
        code: 'custom',
        path: ['core'],
        message: 'Core projection is not compatible with immutable evidence.',
      });
    orderedUnique(
      value.core.run.completenessReasons,
      (item) => item,
      (item) => [item],
      context,
      ['core', 'run', 'completenessReasons'],
    );
    orderedUnique(
      value.core.commands,
      (item) => item.operationId,
      (item) => [item.operationId],
      context,
      ['core', 'commands'],
    );
    orderedUnique(
      value.core.tools,
      (item) => item.operationId,
      (item) => [item.operationId],
      context,
      ['core', 'tools'],
    );
    orderedUnique(
      value.core.tests,
      (item) => item.testRunId,
      (item) => [item.source.sequence, item.testRunId],
      context,
      ['core', 'tests'],
    );
    orderedUnique(
      value.core.gitSnapshots,
      (item) => item.snapshotId,
      (item) => [item.source.sequence, item.snapshotId],
      context,
      ['core', 'gitSnapshots'],
    );
    orderedUnique(
      value.core.gitDiffs,
      (item) => item.diffId,
      (item) => [item.source.sequence, item.diffId],
      context,
      ['core', 'gitDiffs'],
    );
    orderedUnique(
      value.core.errors,
      (item) => item.errorId,
      (item) => [item.source.sequence, item.errorId],
      context,
      ['core', 'errors'],
    );
    orderedUnique(
      value.core.usage,
      (item) => item.source.eventId,
      (item) => [item.source.sequence, item.source.eventId],
      context,
      ['core', 'usage'],
    );
    validateEventReference(value.core.run.started, events, context, [
      'core',
      'run',
      'started',
    ]);
    validateEventReference(value.core.run.finished, events, context, [
      'core',
      'run',
      'finished',
    ]);
    for (const [index, item] of value.core.commands.entries()) {
      validateEventReference(item.start, events, context, [
        'core',
        'commands',
        index,
        'start',
      ]);
      validateEventReference(item.finish, events, context, [
        'core',
        'commands',
        index,
        'finish',
      ]);
    }
    for (const [index, item] of value.core.tools.entries()) {
      validateEventReference(item.start, events, context, [
        'core',
        'tools',
        index,
        'start',
      ]);
      validateEventReference(item.finish, events, context, [
        'core',
        'tools',
        index,
        'finish',
      ]);
    }
    for (const [name, items] of [
      ['tests', value.core.tests],
      ['gitSnapshots', value.core.gitSnapshots],
      ['gitDiffs', value.core.gitDiffs],
      ['errors', value.core.errors],
      ['usage', value.core.usage],
    ] as const)
      for (const [index, item] of items.entries())
        validateEventReference(item.source, events, context, [
          'core',
          name,
          index,
          'source',
        ]);
    for (const [index, item] of value.core.tests.entries())
      if (
        item.reportArtifactId !== null &&
        !artifacts.has(item.reportArtifactId)
      )
        context.addIssue({
          code: 'custom',
          path: ['core', 'tests', index, 'reportArtifactId'],
          message: 'Test artifact is absent.',
        });
    for (const [index, item] of value.core.gitSnapshots.entries())
      if (
        item.statusArtifactId !== null &&
        !artifacts.has(item.statusArtifactId)
      )
        context.addIssue({
          code: 'custom',
          path: ['core', 'gitSnapshots', index, 'statusArtifactId'],
          message: 'Git status artifact is absent.',
        });
    for (const [index, item] of value.core.gitDiffs.entries())
      for (const key of ['diffArtifactId', 'fileListArtifactId'] as const)
        if (!artifacts.has(item[key]))
          context.addIssue({
            code: 'custom',
            path: ['core', 'gitDiffs', index, key],
            message: 'Git diff artifact is absent.',
          });
  }

  if (value.files.state === 'available') {
    orderedUnique(
      value.files.files,
      (item) => `${item.sourceEventId}\0${item.entryId}`,
      (item) => [item.sourceSequence, item.ordinal, item.entryId],
      context,
      ['files', 'files'],
    );
    if (
      value.files.projectorVersion !== 1 ||
      value.files.completeness !== 'complete' ||
      value.processing.files.currentness !== 'ready' ||
      value.processing.files.sourceEventCount !==
        value.files.source.eventCount ||
      value.processing.files.sourceMaxSequence !==
        value.files.source.maxSequence ||
      value.processing.files.sourceFingerprint !==
        value.files.source.fingerprint
    )
      context.addIssue({
        code: 'custom',
        path: ['files'],
        message: 'Files projection is not current.',
      });
    for (const [index, item] of value.files.files.entries())
      validateEvidenceReference(
        {
          eventId: item.sourceEventId,
          artifactId: item.artifactId,
          eventArtifactPointer: '/payload/fileListArtifact',
        },
        events,
        artifacts,
        context,
        ['files', 'files', index],
      );
  }

  const findingResults = new Map<
    string,
    z.infer<typeof ExportV1FindingResultSchema>
  >();
  if (value.findings.state === 'available') {
    orderedUnique(
      value.findings.results,
      (item) => item.resultKey,
      (item) => [item.catalogOrder, item.ruleId, item.ruleVersion],
      context,
      ['findings', 'results'],
    );
    if (
      value.findings.projectorVersion !== 1 ||
      value.processing.findings.currentness !== 'ready' ||
      value.processing.findings.sourceFingerprint !==
        value.findings.sourceFingerprint ||
      value.core.state !== 'available' ||
      value.findings.coreVersion !== value.core.projectorVersion ||
      value.findings.coreFingerprint !== value.core.source.fingerprint ||
      value.findings.coreCompleteness !== value.core.run.evidenceCompleteness
    )
      context.addIssue({
        code: 'custom',
        path: ['findings'],
        message: 'Findings projection has incompatible source state.',
      });
    if (!filesDependencyMatchesSection(value.findings, value.files))
      context.addIssue({
        code: 'custom',
        path: ['findings'],
        message: 'Findings files dependency is incompatible.',
      });
    let triggeredCount = 0;
    let unknownCount = 0;
    let highCount = 0;
    let mediumCount = 0;
    for (const [resultIndex, result] of value.findings.results.entries()) {
      findingResults.set(result.resultKey, result);
      if (
        result.catalogOrder !== resultIndex ||
        result.ruleId !== EVIDENCE_EXPORT_V1_FINDING_RULES[resultIndex]
      )
        context.addIssue({
          code: 'custom',
          path: ['findings', 'results', resultIndex],
          message: 'Finding does not match the complete V1 catalog order.',
        });
      if (result.outcome === 'triggered') {
        triggeredCount += 1;
        if (result.severity === 'high') highCount += 1;
        if (result.severity === 'medium') mediumCount += 1;
        if (result.references.length === 0)
          context.addIssue({
            code: 'custom',
            path: ['findings', 'results', resultIndex, 'references'],
            message: 'Triggered finding requires immutable evidence.',
          });
      }
      if (result.outcome === 'unknown') unknownCount += 1;
      if (result.outcome === 'clear' && result.coverage !== 'complete')
        context.addIssue({
          code: 'custom',
          path: ['findings', 'results', resultIndex, 'coverage'],
          message: 'A clear finding requires complete coverage.',
        });
      orderedUnique(
        result.reasonCodes,
        (item) => item,
        (item) => [item],
        context,
        ['findings', 'results', resultIndex, 'reasonCodes'],
      );
      orderedUnique(
        result.matches,
        (item) => item,
        (item) => [item],
        context,
        ['findings', 'results', resultIndex, 'matches'],
      );
      orderedUnique(
        result.references,
        (item) => String(item.ordinal),
        (item) => [item.ordinal],
        context,
        ['findings', 'results', resultIndex, 'references'],
      );
      for (const [referenceIndex, reference] of result.references.entries())
        validateEvidenceReference(reference, events, artifacts, context, [
          'findings',
          'results',
          resultIndex,
          'references',
          referenceIndex,
        ]);
      if (
        (!result.matchesTruncated &&
          result.matchCount !== result.matches.length) ||
        result.matchCount < result.matches.length
      )
        context.addIssue({
          code: 'custom',
          path: ['findings', 'results', resultIndex, 'matchCount'],
          message: 'Finding match count is inconsistent.',
        });
    }
    const derivedOutcome =
      triggeredCount > 0
        ? 'review'
        : unknownCount === 0 &&
            value.findings.results.every(
              (result) =>
                result.outcome === 'clear' && result.coverage === 'complete',
            )
          ? 'pass'
          : 'unknown';
    const derivedCoverage = value.findings.results.every(
      (result) => result.coverage === 'complete',
    )
      ? 'complete'
      : 'partial';
    if (
      value.findings.triggeredCount !== triggeredCount ||
      value.findings.unknownCount !== unknownCount ||
      value.findings.highCount !== highCount ||
      value.findings.mediumCount !== mediumCount ||
      value.findings.deterministicOutcome !== derivedOutcome ||
      value.findings.coverage !== derivedCoverage
    )
      context.addIssue({
        code: 'custom',
        path: ['findings'],
        message: 'Findings aggregate outcome or counts are inconsistent.',
      });
  }

  if (value.summary.state === 'available') {
    const compatibleFindings =
      value.findings.state === 'available' ? value.findings : null;
    orderedUnique(
      value.summary.claims,
      (item) => item.claimKey,
      (item) => [item.sectionOrder, item.claimOrder, item.claimKey],
      context,
      ['summary', 'claims'],
    );
    if (
      value.summary.projectorVersion !== 1 ||
      value.processing.summary.observedVersion !==
        value.summary.projectorVersion ||
      value.processing.summary.state !== 'ready' ||
      value.processing.summary.currentness !== 'ready' ||
      value.processing.summary.sourceFingerprint !==
        value.summary.sourceFingerprint ||
      value.processing.summary.sourceEventCount !== value.summary.claimCount ||
      value.processing.summary.sourceMaxSequence !== null ||
      compatibleFindings === null ||
      value.summary.findingsProjectorVersion !==
        compatibleFindings?.projectorVersion ||
      value.summary.findingsFingerprint !==
        compatibleFindings?.sourceFingerprint ||
      value.summary.findingsAnalyzerName !== compatibleFindings?.analyzerName ||
      value.summary.findingsAnalyzerVersion !==
        compatibleFindings?.analyzerVersion ||
      value.summary.findingsCatalogVersion !==
        compatibleFindings?.catalogVersion ||
      value.core.state !== 'available' ||
      value.summary.coreVersion !== value.core.projectorVersion ||
      value.summary.coreFingerprint !== value.core.source.fingerprint ||
      value.summary.coreCompleteness !== value.core.run.evidenceCompleteness ||
      !filesDependencyMatchesSection(value.summary, value.files) ||
      (compatibleFindings !== null &&
        !filesDependenciesMatch(value.summary, compatibleFindings))
    )
      context.addIssue({
        code: 'custom',
        path: ['summary'],
        message: 'Summary projection has incompatible source state.',
      });
    if (value.summary.claimCount !== value.summary.claims.length)
      context.addIssue({
        code: 'custom',
        path: ['summary', 'claimCount'],
        message: 'Summary claim count is inconsistent.',
      });
    const sectionCount = new Set(
      value.summary.claims.map((claim) => claim.sectionId),
    ).size;
    if (
      value.summary.sectionCount !== sectionCount ||
      compatibleFindings === null ||
      value.summary.outcome !== compatibleFindings.deterministicOutcome
    )
      context.addIssue({
        code: 'custom',
        path: ['summary'],
        message: 'Summary outcome or section count is inconsistent.',
      });
    for (const [claimIndex, claim] of value.summary.claims.entries()) {
      orderedUnique(
        claim.supports,
        (item) => String(item.ordinal),
        (item) => [item.ordinal],
        context,
        ['summary', 'claims', claimIndex, 'supports'],
      );
      if (claim.supportCount !== claim.supports.length)
        context.addIssue({
          code: 'custom',
          path: ['summary', 'claims', claimIndex, 'supportCount'],
          message: 'Summary support count is inconsistent.',
        });
      for (const [supportIndex, support] of claim.supports.entries()) {
        if (support.kind === 'evidence')
          validateEvidenceReference(support, events, artifacts, context, [
            'summary',
            'claims',
            claimIndex,
            'supports',
            supportIndex,
          ]);
        else {
          const result = findingResults.get(support.resultKey);
          if (
            compatibleFindings === null ||
            !result ||
            result.ruleId !== support.ruleId ||
            result.ruleVersion !== support.ruleVersion ||
            support.findingsSourceFingerprint !==
              compatibleFindings?.sourceFingerprint
          )
            context.addIssue({
              code: 'custom',
              path: ['summary', 'claims', claimIndex, 'supports', supportIndex],
              message: 'Summary finding support is incompatible.',
            });
        }
      }
    }
  }

  const expectedOutcomes = deriveExportV1Outcomes(value);
  if (JSON.stringify(value.outcomes) !== JSON.stringify(expectedOutcomes))
    context.addIssue({
      code: 'custom',
      path: ['outcomes'],
      message: 'Export outcomes do not match the included state.',
    });
  const expectedLimitations = deriveExportV1Limitations(value);
  if (JSON.stringify(value.limitations) !== JSON.stringify(expectedLimitations))
    context.addIssue({
      code: 'custom',
      path: ['limitations'],
      message: 'Export limitations are incomplete or not canonical.',
    });
}

export const EvidenceExportV1Schema =
  EvidenceExportV1BaseSchema.superRefine(validateBundle);

export type ExportV1ProcessingCurrentness = z.infer<
  typeof ExportV1ProcessingCurrentnessSchema
>;
export type ExportV1ProjectorProcessing = z.infer<
  typeof ExportV1ProjectorProcessingSchema
>;
export type ExportV1Snapshot = z.infer<typeof ExportV1SnapshotSchema>;
export type EvidenceExportV1 = z.infer<typeof EvidenceExportV1Schema>;
export type ExportV1CoreSection = z.infer<typeof ExportV1CoreSectionSchema>;
export type ExportV1FilesSection = z.infer<typeof ExportV1FilesSectionSchema>;
export type ExportV1FindingsSection = z.infer<
  typeof ExportV1FindingsSectionSchema
>;
export type ExportV1SummarySection = z.infer<
  typeof ExportV1SummarySectionSchema
>;
