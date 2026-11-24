import {
  ArtifactReferenceSchema,
  EvidenceEventSchema,
} from '@blackbox/contracts';
import {
  EVIDENCE_EXPORT_V1_LIMITS,
  canonicalUtf8,
  EvidenceExportTooLargeError,
  ExportV1SnapshotSchema,
  type ExportUnavailableReason,
  type ExportV1ProcessingCurrentness,
  type ExportV1ProjectorProcessing,
  type ExportV1Snapshot,
} from '@blackbox/export';

import type { DatabaseClient } from './client.js';
import {
  deriveCoreQueryState,
  deriveFileQueryState,
  deriveFindingsQueryState,
  deriveSummaryQueryStatus,
  inspectCurrentCoreQuerySource,
  inspectCurrentFileQuerySource,
  type QueryConsistencyHooks,
  type QueryProcessingState,
} from './core-queries.js';
import {
  CORE_PROJECTOR_NAME,
  CORE_PROJECTOR_VERSION,
} from './core-projector.js';
import {
  FILES_PROJECTOR_NAME,
  FILES_PROJECTOR_VERSION,
} from './file-processing.js';
import {
  FINDINGS_PROJECTOR_NAME,
  FINDINGS_PROJECTOR_VERSION,
} from './findings-processing.js';
import { Prisma } from './generated/client/client.js';
import {
  SUMMARY_PROJECTOR_NAME,
  SUMMARY_PROJECTOR_VERSION,
} from './summary-processing.js';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type EvidenceExportQueryErrorCode = 'export_unavailable';

/** Safe query failure without tenant, row, storage, or evidence detail. */
export class EvidenceExportQueryError extends Error {
  constructor(
    readonly code: EvidenceExportQueryErrorCode,
    options?: ErrorOptions,
  ) {
    super('The evidence export is unavailable.', options);
    this.name = 'EvidenceExportQueryError';
  }
}

export interface EvidenceExportSnapshotInput {
  organizationId: string;
  repositoryId: string;
  canonicalRunId: string;
  /** Internal/test-only database page size; never a browser cursor. */
  pageSize?: number;
}

function requireUuid(value: string): void {
  if (typeof value !== 'string' || !UUID.test(value))
    throw new TypeError('Export identity must be a UUID.');
}

function pageSize(value: number | undefined): number {
  const result = value ?? 500;
  if (!Number.isSafeInteger(result) || result < 1 || result > 1_000)
    throw new TypeError('Export query page size must be between 1 and 1000.');
  return result;
}

/**
 * A file projection row can contain six maximum-length UTF-8 paths. Sixteen
 * rows remain below the export ceiling even at four bytes per code point. The
 * larger finding JSON row is fetched alone below.
 */
const EXPORT_QUERY_PAGE_ROW_LIMIT = 16;

/**
 * Conservative allowance for the fixed envelope, empty array syntax,
 * processing records, section metadata, outcomes, limitations, and the
 * bounded core-run scalars (including all completeness reasons). Public
 * schemas bound those values well below 256 KiB. Every retained collection
 * entry is charged separately in addition to this allowance.
 */
const EXPORT_QUERY_FIXED_BYTE_ALLOWANCE = 256 * 1_024;

class ExportQueryByteBudget {
  private used = EXPORT_QUERY_FIXED_BYTE_ALLOWANCE;

  charge(value: unknown): void {
    const remaining =
      EVIDENCE_EXPORT_V1_LIMITS.totalCanonicalBytes - this.used - 1;
    if (remaining < 1) throw new EvidenceExportTooLargeError();
    try {
      const bytes = canonicalUtf8(value, remaining);
      // One byte conservatively covers the collection delimiter. The first
      // item overcounts by one; no collection can be undercounted.
      this.used += bytes.byteLength + 1;
    } catch (error) {
      if (
        error instanceof RangeError &&
        error.name === 'CanonicalJsonSizeError'
      )
        throw new EvidenceExportTooLargeError();
      throw error;
    }
  }
}

function safeNumber(value: bigint | number | null): number | null {
  if (value === null) return null;
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0)
    throw new EvidenceExportQueryError('export_unavailable');
  return result;
}

async function boundedPages<T, U>(
  maximum: number,
  size: number,
  budget: ExportQueryByteBudget | null,
  read: (skip: number, take: number) => Promise<T[]>,
  map: (row: T) => U | Promise<U>,
  measure: (row: U) => unknown = (row) => row,
  pageRowLimit = EXPORT_QUERY_PAGE_ROW_LIMIT,
): Promise<U[]> {
  const rows: U[] = [];
  for (;;) {
    const take = Math.min(size, pageRowLimit, maximum + 1 - rows.length);
    const page = await read(rows.length, take);
    if (page.length > take)
      throw new EvidenceExportQueryError('export_unavailable');
    for (const row of page) {
      if (rows.length === maximum) throw new EvidenceExportTooLargeError();
      const mapped = await map(row);
      budget?.charge(measure(mapped));
      rows.push(mapped);
    }
    if (page.length < take) return rows;
  }
}

function processingState(value: string | undefined) {
  switch (value) {
    case undefined:
      return 'missing' as const;
    case 'PENDING':
      return 'pending' as const;
    case 'PROCESSING':
      return 'processing' as const;
    case 'RETRYING':
      return 'retrying' as const;
    case 'READY':
      return 'ready' as const;
    case 'FAILED':
      return 'failed' as const;
    default:
      throw new EvidenceExportQueryError('export_unavailable');
  }
}

type ProcessingRow = {
  projectorName: string;
  projectorVersion: number;
  state: string;
  sourceEventCount: number | null;
  sourceMaxSequence: bigint | null;
  sourceFingerprint: string | null;
  lastErrorCode: string | null;
};

function exportProcessing(
  projectorName: string,
  expectedVersion: number,
  currentness: QueryProcessingState,
  row: ProcessingRow | null,
): ExportV1ProjectorProcessing {
  return {
    projectorName,
    expectedVersion,
    observedVersion: row?.projectorVersion ?? null,
    state: processingState(row?.state),
    currentness,
    sourceEventCount: row?.sourceEventCount ?? null,
    sourceMaxSequence: safeNumber(row?.sourceMaxSequence ?? null),
    sourceFingerprint: row?.sourceFingerprint ?? null,
    errorCode:
      row?.state === 'FAILED'
        ? (row.lastErrorCode ?? 'processing_failed')
        : null,
  };
}

function unavailableReason(
  currentness: ExportV1ProcessingCurrentness,
  row: ProcessingRow | null,
  projectionExists: boolean,
): ExportUnavailableReason {
  if (currentness === 'failed') return 'failed';
  if (currentness === 'stale') return 'stale';
  if (currentness === 'incomplete') return 'incomplete';
  if (!projectionExists && row === null) return 'missing';
  return 'processing';
}

function eventReference(eventId: string | null, sequence: bigint | null) {
  if (eventId === null && sequence === null) return null;
  if (eventId === null || sequence === null)
    throw new EvidenceExportQueryError('export_unavailable');
  return { eventId, sequence: safeNumber(sequence)! };
}

function processingRow(
  rows: readonly ProcessingRow[],
  projectorName: string,
): ProcessingRow | null {
  return rows.find((row) => row.projectorName === projectorName) ?? null;
}

async function exportInSnapshot(
  transaction: Prisma.TransactionClient,
  input: EvidenceExportSnapshotInput,
  size: number,
  hooks: QueryConsistencyHooks,
): Promise<ExportV1Snapshot | null> {
  const run = await transaction.run.findFirst({
    where: {
      organizationId: input.organizationId,
      repositoryId: input.repositoryId,
      canonicalRunId: input.canonicalRunId,
    },
    select: {
      id: true,
      coreRunProjection: true,
      fileRunProjection: true,
      findingsRunProjection: true,
      summaryRunProjection: true,
      processingStates: {
        where: {
          projectorName: {
            in: [
              CORE_PROJECTOR_NAME,
              FILES_PROJECTOR_NAME,
              FINDINGS_PROJECTOR_NAME,
              SUMMARY_PROJECTOR_NAME,
            ],
          },
        },
        select: {
          projectorName: true,
          projectorVersion: true,
          state: true,
          sourceEventCount: true,
          sourceMaxSequence: true,
          sourceFingerprint: true,
          lastErrorCode: true,
        },
      },
    },
  });
  if (!run) return null;
  if (
    run.coreRunProjection &&
    Array.isArray(run.coreRunProjection.completenessReasons) &&
    run.coreRunProjection.completenessReasons.length >
      EVIDENCE_EXPORT_V1_LIMITS.completenessReasons
  )
    throw new EvidenceExportTooLargeError();
  const byteBudget = new ExportQueryByteBudget();
  await hooks.afterBaseRead?.();

  const events = await boundedPages(
    EVIDENCE_EXPORT_V1_LIMITS.events,
    size,
    byteBudget,
    (skip, take) =>
      transaction.evidenceEvent.findMany({
        where: { organizationId: input.organizationId, runId: run.id },
        orderBy: [{ sequence: 'asc' }, { canonicalEventId: 'asc' }],
        skip,
        take,
        select: {
          canonicalEventId: true,
          schemaVersion: true,
          sequence: true,
          kind: true,
          observedAt: true,
          occurredAt: true,
          receivedAt: true,
          rawEvent: true,
        },
      }),
    (row) => {
      const parsed = EvidenceEventSchema.safeParse(row.rawEvent);
      if (
        !parsed.success ||
        parsed.data.eventId !== row.canonicalEventId ||
        parsed.data.runId !== input.canonicalRunId ||
        parsed.data.schemaVersion !== row.schemaVersion ||
        parsed.data.sequence !== safeNumber(row.sequence) ||
        parsed.data.kind !== row.kind ||
        parsed.data.observedAt !== row.observedAt.toISOString() ||
        (parsed.data.occurredAt ?? null) !==
          (row.occurredAt?.toISOString() ?? null)
      )
        throw new EvidenceExportQueryError('export_unavailable');
      return { receivedAt: row.receivedAt.toISOString(), event: parsed.data };
    },
  );

  const artifactLinks = await boundedPages(
    EVIDENCE_EXPORT_V1_LIMITS.artifactDeclarations,
    size,
    byteBudget,
    (skip, take) =>
      transaction.evidenceEventArtifact.findMany({
        where: { organizationId: input.organizationId, runId: run.id },
        orderBy: [
          { artifact: { canonicalArtifactId: 'asc' } },
          { event: { canonicalEventId: 'asc' } },
          { jsonPointer: 'asc' },
        ],
        skip,
        take,
        select: {
          artifactId: true,
          jsonPointer: true,
          event: { select: { canonicalEventId: true } },
        },
      }),
    (row) => ({
      artifactId: row.artifactId,
      declaration: {
        eventId: row.event.canonicalEventId,
        pointer: row.jsonPointer,
      },
    }),
    (row) => row.declaration,
  );
  const verifiedAttempts = await boundedPages(
    EVIDENCE_EXPORT_V1_LIMITS.artifacts,
    size,
    byteBudget,
    (skip, take) =>
      transaction.artifactUploadAttempt.findMany({
        where: {
          organizationId: input.organizationId,
          runId: run.id,
          state: 'VERIFIED',
        },
        orderBy: [
          { artifactDeclaration: { canonicalArtifactId: 'asc' } },
          { verifiedAt: 'asc' },
          { id: 'asc' },
        ],
        skip,
        take,
        select: {
          artifactDeclarationId: true,
          observedByteLength: true,
          observedSha256: true,
          verifiedAt: true,
        },
      }),
    (row) => row,
    (row) => ({
      state: 'verified',
      observedByteLength: safeNumber(row.observedByteLength),
      observedSha256: row.observedSha256,
      verifiedAt: row.verifiedAt?.toISOString() ?? null,
    }),
  );
  const attempts = new Map<string, (typeof verifiedAttempts)[number]>();
  for (const attempt of verifiedAttempts) {
    if (attempts.has(attempt.artifactDeclarationId))
      throw new EvidenceExportQueryError('export_unavailable');
    attempts.set(attempt.artifactDeclarationId, attempt);
  }
  const links = new Map<string, Array<{ eventId: string; pointer: string }>>();
  for (const link of artifactLinks) {
    const values = links.get(link.artifactId) ?? [];
    values.push(link.declaration);
    links.set(link.artifactId, values);
  }
  const artifacts = await boundedPages(
    EVIDENCE_EXPORT_V1_LIMITS.artifacts,
    size,
    byteBudget,
    (skip, take) =>
      transaction.artifactDeclaration.findMany({
        where: { organizationId: input.organizationId, runId: run.id },
        orderBy: { canonicalArtifactId: 'asc' },
        skip,
        take,
        select: {
          id: true,
          canonicalArtifactId: true,
          kind: true,
          mediaType: true,
          byteLength: true,
          sha256: true,
          redactionApplied: true,
          redactionRuleset: true,
          compression: true,
          characterEncoding: true,
          receivedAt: true,
          rawReference: true,
        },
      }),
    (row) => {
      const reference = ArtifactReferenceSchema.safeParse(row.rawReference);
      if (
        !reference.success ||
        reference.data.artifactId !== row.canonicalArtifactId ||
        reference.data.kind !== row.kind ||
        reference.data.mediaType !== row.mediaType ||
        reference.data.byteLength !== safeNumber(row.byteLength) ||
        reference.data.sha256 !== row.sha256 ||
        reference.data.redaction.applied !== row.redactionApplied ||
        (reference.data.redaction.rulesetVersion ?? null) !==
          row.redactionRuleset ||
        (reference.data.compression ?? null) !== row.compression ||
        (reference.data.characterEncoding ?? null) !== row.characterEncoding
      )
        throw new EvidenceExportQueryError('export_unavailable');
      const attempt = attempts.get(row.id);
      const verification = !attempt
        ? ({ state: 'unavailable', reason: 'artifact_not_verified' } as const)
        : attempt.observedByteLength === row.byteLength &&
            attempt.observedSha256 === row.sha256 &&
            attempt.verifiedAt !== null
          ? ({
              state: 'verified',
              observedByteLength: safeNumber(attempt.observedByteLength)!,
              observedSha256: attempt.observedSha256,
              verifiedAt: attempt.verifiedAt.toISOString(),
            } as const)
          : ({ state: 'unavailable', reason: 'integrity_mismatch' } as const);
      return {
        artifact: reference.data,
        receivedAt: row.receivedAt.toISOString(),
        declaredBy: links.get(row.id) ?? [],
        verification,
      };
    },
    (row) => ({ ...row, declaredBy: [] }),
  );

  const coreProcessingRow = processingRow(
    run.processingStates,
    CORE_PROJECTOR_NAME,
  );
  const filesProcessingRow = processingRow(
    run.processingStates,
    FILES_PROJECTOR_NAME,
  );
  const findingsProcessingRow = processingRow(
    run.processingStates,
    FINDINGS_PROJECTOR_NAME,
  );
  const summaryProcessingRow = processingRow(
    run.processingStates,
    SUMMARY_PROJECTOR_NAME,
  );
  const [currentCore, currentFiles] = await Promise.all([
    inspectCurrentCoreQuerySource(transaction, run.id),
    inspectCurrentFileQuerySource(transaction, input.organizationId, run.id),
  ]);
  const coreCurrentness = deriveCoreQueryState(
    run.coreRunProjection,
    coreProcessingRow,
    currentCore,
  );
  const filesCurrentness = deriveFileQueryState(
    run.fileRunProjection,
    filesProcessingRow,
    currentFiles,
  );
  const findingsCurrentness = await deriveFindingsQueryState(
    transaction,
    input.organizationId,
    run.id,
    run.findingsRunProjection,
    findingsProcessingRow,
  );
  const summaryStatus = await deriveSummaryQueryStatus(
    transaction,
    input.organizationId,
    run.id,
    run.summaryRunProjection,
    summaryProcessingRow,
  );
  const processing = {
    core: exportProcessing(
      CORE_PROJECTOR_NAME,
      CORE_PROJECTOR_VERSION,
      coreCurrentness,
      coreProcessingRow,
    ),
    files: exportProcessing(
      FILES_PROJECTOR_NAME,
      FILES_PROJECTOR_VERSION,
      filesCurrentness,
      filesProcessingRow,
    ),
    findings: exportProcessing(
      FINDINGS_PROJECTOR_NAME,
      FINDINGS_PROJECTOR_VERSION,
      findingsCurrentness,
      findingsProcessingRow,
    ),
    summary: exportProcessing(
      SUMMARY_PROJECTOR_NAME,
      SUMMARY_PROJECTOR_VERSION,
      summaryStatus.processingState,
      summaryProcessingRow,
    ),
  };

  const coreAvailable =
    run.coreRunProjection !== null &&
    (coreCurrentness === 'ready' || coreCurrentness === 'incomplete');
  let core: unknown;
  if (!coreAvailable || !run.coreRunProjection) {
    core = {
      state: 'unavailable',
      reason: unavailableReason(
        coreCurrentness,
        coreProcessingRow,
        run.coreRunProjection !== null,
      ),
    };
  } else {
    const commands = await boundedPages(
      EVIDENCE_EXPORT_V1_LIMITS.commands,
      size,
      byteBudget,
      (skip, take) =>
        transaction.coreCommandProjection.findMany({
          where: { organizationId: input.organizationId, runId: run.id },
          orderBy: { operationId: 'asc' },
          skip,
          take,
        }),
      (row) => ({
        operationId: row.operationId,
        start: eventReference(row.startEventId, row.startSequence),
        finish: eventReference(row.finishEventId, row.finishSequence),
        state: row.state as 'complete' | 'incomplete' | 'conflict',
        outcome: row.outcome as
          'succeeded' | 'failed' | 'cancelled' | 'unknown' | null,
        durationMs: safeNumber(row.durationMs),
        exitCode: safeNumber(row.exitCode),
        terminationSignal: row.terminationSignal,
        commandCapture: row.commandCapture,
        workingDirectory: row.workingDirectory,
        stdoutCapture: row.stdoutCapture,
        stderrCapture: row.stderrCapture,
      }),
    );
    const tools = await boundedPages(
      EVIDENCE_EXPORT_V1_LIMITS.tools,
      size,
      byteBudget,
      (skip, take) =>
        transaction.coreToolProjection.findMany({
          where: { organizationId: input.organizationId, runId: run.id },
          orderBy: { operationId: 'asc' },
          skip,
          take,
        }),
      (row) => ({
        operationId: row.operationId,
        start: eventReference(row.startEventId, row.startSequence),
        finish: eventReference(row.finishEventId, row.finishSequence),
        state: row.state as 'complete' | 'incomplete' | 'conflict',
        toolName: row.toolName,
        outcome: row.outcome as
          'succeeded' | 'failed' | 'cancelled' | 'unknown' | null,
        durationMs: safeNumber(row.durationMs),
        inputCapture: row.inputCapture,
        outputCapture: row.outputCapture,
      }),
    );
    const tests = await boundedPages(
      EVIDENCE_EXPORT_V1_LIMITS.tests,
      size,
      byteBudget,
      (skip, take) =>
        transaction.coreTestProjection.findMany({
          where: { organizationId: input.organizationId, runId: run.id },
          orderBy: [{ sourceSequence: 'asc' }, { testRunId: 'asc' }],
          skip,
          take,
        }),
      (row) => ({
        testRunId: row.testRunId,
        source: {
          eventId: row.sourceEventId,
          sequence: safeNumber(row.sourceSequence)!,
        },
        commandId: row.commandId,
        framework: row.framework,
        outcome: row.outcome as 'passed' | 'failed' | 'cancelled' | 'unknown',
        counts: row.counts,
        durationMs: safeNumber(row.durationMs),
        reportArtifactId: row.reportArtifactId,
      }),
    );
    const gitSnapshots = await boundedPages(
      EVIDENCE_EXPORT_V1_LIMITS.gitSnapshots,
      size,
      byteBudget,
      (skip, take) =>
        transaction.coreGitSnapshotProjection.findMany({
          where: { organizationId: input.organizationId, runId: run.id },
          orderBy: [{ sourceSequence: 'asc' }, { snapshotId: 'asc' }],
          skip,
          take,
        }),
      (row) => ({
        snapshotId: row.snapshotId,
        source: {
          eventId: row.sourceEventId,
          sequence: safeNumber(row.sourceSequence)!,
        },
        phase: row.phase as 'before' | 'after' | 'checkpoint',
        headCommit: row.headCommit,
        isDirty: row.isDirty,
        stagedFileCount: safeNumber(row.stagedFileCount),
        unstagedFileCount: safeNumber(row.unstagedFileCount),
        untrackedFileCount: safeNumber(row.untrackedFileCount),
        statusArtifactId: row.statusArtifactId,
      }),
    );
    const gitDiffs = await boundedPages(
      EVIDENCE_EXPORT_V1_LIMITS.gitDiffs,
      size,
      byteBudget,
      (skip, take) =>
        transaction.coreGitDiffProjection.findMany({
          where: { organizationId: input.organizationId, runId: run.id },
          orderBy: [{ sourceSequence: 'asc' }, { diffId: 'asc' }],
          skip,
          take,
        }),
      (row) => ({
        diffId: row.diffId,
        source: {
          eventId: row.sourceEventId,
          sequence: safeNumber(row.sourceSequence)!,
        },
        fromSnapshotId: row.fromSnapshotId,
        toSnapshotId: row.toSnapshotId,
        filesChanged: safeNumber(row.filesChanged),
        linesAdded: safeNumber(row.linesAdded),
        linesDeleted: safeNumber(row.linesDeleted),
        diffArtifactId: row.diffArtifactId,
        fileListArtifactId: row.fileListArtifactId,
      }),
    );
    const errors = await boundedPages(
      EVIDENCE_EXPORT_V1_LIMITS.errors,
      size,
      byteBudget,
      (skip, take) =>
        transaction.coreErrorProjection.findMany({
          where: { organizationId: input.organizationId, runId: run.id },
          orderBy: [{ sourceSequence: 'asc' }, { errorId: 'asc' }],
          skip,
          take,
        }),
      (row) => ({
        errorId: row.errorId,
        source: {
          eventId: row.sourceEventId,
          sequence: safeNumber(row.sourceSequence)!,
        },
        category: row.category,
        code: row.code,
        retryable: row.retryable,
        messageCapture: row.messageCapture,
        relatedOperationId: row.relatedOperationId,
        relatedEventId: row.relatedEventId,
      }),
    );
    const usage = await boundedPages(
      EVIDENCE_EXPORT_V1_LIMITS.usage,
      size,
      byteBudget,
      (skip, take) =>
        transaction.coreUsageProjection.findMany({
          where: { organizationId: input.organizationId, runId: run.id },
          orderBy: [{ sourceSequence: 'asc' }, { sourceEventId: 'asc' }],
          skip,
          take,
        }),
      (row) => ({
        source: {
          eventId: row.sourceEventId,
          sequence: safeNumber(row.sourceSequence)!,
        },
        provider: row.provider,
        model: row.model,
        measurements: row.measurements,
      }),
    );
    const projection = run.coreRunProjection;
    core = {
      state: 'available',
      projectorName: 'core',
      projectorVersion: projection.projectorVersion,
      source: {
        eventCount: projection.sourceEventCount,
        maxSequence: safeNumber(projection.sourceMaxSequence),
        fingerprint: projection.sourceFingerprint,
      },
      run: {
        started: eventReference(
          projection.startedEventId,
          projection.startedSequence,
        ),
        finished: eventReference(
          projection.finishedEventId,
          projection.finishedSequence,
        ),
        adapter: projection.adapter,
        provider: projection.provider,
        observedOutcome: projection.observedOutcome as
          'succeeded' | 'failed' | 'cancelled' | 'unknown' | null,
        durationMs: safeNumber(projection.durationMs),
        evidenceCompleteness: projection.evidenceCompleteness as
          'complete' | 'incomplete',
        completenessReasons: projection.completenessReasons,
        commandCount: projection.commandCount,
        toolCallCount: projection.toolCallCount,
        testObservationState: projection.testObservationState as
          'not_observed' | 'observed',
        testCounts: projection.testCounts,
        tokenAggregates: projection.tokenAggregates,
        filesChanged: safeNumber(projection.filesChanged),
      },
      commands,
      tools,
      tests,
      gitSnapshots,
      gitDiffs,
      errors,
      usage,
    };
  }

  const fileProjectionCompatible = Boolean(
    run.fileRunProjection &&
    filesProcessingRow &&
    filesCurrentness === 'ready' &&
    filesProcessingRow.state === 'READY' &&
    run.fileRunProjection.completeness === 'complete' &&
    run.fileRunProjection.projectorName === FILES_PROJECTOR_NAME &&
    run.fileRunProjection.projectorVersion === FILES_PROJECTOR_VERSION &&
    filesProcessingRow.projectorVersion === FILES_PROJECTOR_VERSION &&
    run.fileRunProjection.sourceEventCount === currentFiles.count &&
    run.fileRunProjection.sourceMaxSequence === currentFiles.maxSequence &&
    run.fileRunProjection.sourceFingerprint === currentFiles.fingerprint &&
    filesProcessingRow.sourceEventCount === currentFiles.count &&
    filesProcessingRow.sourceMaxSequence === currentFiles.maxSequence &&
    filesProcessingRow.sourceFingerprint === currentFiles.fingerprint,
  );
  let unavailableFilesDependencyReason:
    'missing' | 'stale' | 'incomplete' | null = null;
  let files: unknown;
  if (!fileProjectionCompatible || !run.fileRunProjection) {
    const reason = unavailableReason(
      filesCurrentness,
      filesProcessingRow,
      run.fileRunProjection !== null,
    );
    files = {
      state: 'unavailable',
      reason,
    };
    if (reason === 'missing' || reason === 'stale' || reason === 'incomplete')
      unavailableFilesDependencyReason = reason;
  } else {
    const rows = await boundedPages(
      EVIDENCE_EXPORT_V1_LIMITS.files,
      size,
      byteBudget,
      (skip, take) =>
        transaction.fileChangeProjection.findMany({
          where: { organizationId: input.organizationId, runId: run.id },
          orderBy: [
            { sourceSequence: 'asc' },
            { ordinal: 'asc' },
            { entryId: 'asc' },
          ],
          skip,
          take,
          select: {
            sourceEventId: true,
            sourceSequence: true,
            diffId: true,
            fromSnapshotId: true,
            toSnapshotId: true,
            ordinal: true,
            entryId: true,
            originalEntryId: true,
            displayPath: true,
            originalDisplayPath: true,
            displayAmbiguous: true,
            displayReason: true,
            beforeState: true,
            afterState: true,
            attribution: true,
            reason: true,
            artifactDeclaration: {
              select: { canonicalArtifactId: true },
            },
          },
        }),
      (row) => ({
        sourceEventId: row.sourceEventId,
        sourceSequence: safeNumber(row.sourceSequence)!,
        diffId: row.diffId,
        fromSnapshotId: row.fromSnapshotId,
        toSnapshotId: row.toSnapshotId,
        artifactId: row.artifactDeclaration.canonicalArtifactId,
        ordinal: row.ordinal,
        entryId: row.entryId,
        originalEntryId: row.originalEntryId,
        displayPath: row.displayPath,
        originalDisplayPath: row.originalDisplayPath,
        displayAmbiguous: row.displayAmbiguous,
        displayReason: row.displayReason,
        before: row.beforeState,
        after: row.afterState,
        attribution: row.attribution as
          | 'pre-existing'
          | 'observed-during-run'
          | 'mixed-or-uncertain'
          | 'unavailable',
        reason: row.reason,
      }),
    );
    const projection = run.fileRunProjection;
    files = {
      state: 'available',
      projectorName: 'files',
      projectorVersion: projection.projectorVersion,
      source: {
        eventCount: projection.sourceEventCount,
        maxSequence: safeNumber(projection.sourceMaxSequence),
        fingerprint: projection.sourceFingerprint,
      },
      completeness: projection.completeness as 'complete' | 'incomplete',
      completenessReason: projection.completenessReason,
      files: rows,
    };
  }

  let findings: unknown;
  if (findingsCurrentness !== 'ready' || !run.findingsRunProjection) {
    findings = {
      state: 'unavailable',
      reason: unavailableReason(
        findingsCurrentness,
        findingsProcessingRow,
        run.findingsRunProjection !== null,
      ),
    };
  } else {
    const mappedResults = await boundedPages(
      EVIDENCE_EXPORT_V1_LIMITS.findings,
      size,
      byteBudget,
      (skip, take) =>
        transaction.findingRuleResult.findMany({
          where: { organizationId: input.organizationId, runId: run.id },
          orderBy: [{ catalogOrder: 'asc' }, { ruleId: 'asc' }],
          skip,
          take,
        }),
      async (result) => {
        if (
          (Array.isArray(result.reasonCodes) &&
            result.reasonCodes.length >
              EVIDENCE_EXPORT_V1_LIMITS.findingReasonCodes) ||
          (Array.isArray(result.matches) &&
            result.matches.length > EVIDENCE_EXPORT_V1_LIMITS.findingMatches)
        )
          throw new EvidenceExportTooLargeError();
        const references = await boundedPages(
          EVIDENCE_EXPORT_V1_LIMITS.findingReferences,
          size,
          null,
          (skip, take) =>
            transaction.findingEvidenceReference.findMany({
              where: {
                organizationId: input.organizationId,
                runId: run.id,
                resultId: result.id,
              },
              orderBy: { ordinal: 'asc' },
              skip,
              take,
              select: {
                ordinal: true,
                eventArtifactPointer: true,
                jsonPointer: true,
                fileOrdinal: true,
                entryId: true,
                event: { select: { canonicalEventId: true } },
                artifactDeclaration: {
                  select: { canonicalArtifactId: true },
                },
              },
            }),
          (reference) => ({
            ordinal: reference.ordinal,
            eventId: reference.event.canonicalEventId,
            artifactId:
              reference.artifactDeclaration?.canonicalArtifactId ?? null,
            eventArtifactPointer: reference.eventArtifactPointer,
            jsonPointer: reference.jsonPointer,
            fileOrdinal: reference.fileOrdinal,
            entryId: reference.entryId,
          }),
        );
        return {
          resultKey: result.resultKey,
          catalogOrder: result.catalogOrder,
          ruleId: result.ruleId,
          ruleVersion: result.ruleVersion,
          severity: result.severity as 'low' | 'medium' | 'high' | 'critical',
          outcome: result.outcome as 'triggered' | 'clear' | 'unknown',
          coverage: result.coverage as 'complete' | 'partial',
          reasonCodes: result.reasonCodes,
          explanation: result.explanation,
          matchCount: result.matchCount,
          matches: result.matches,
          matchesTruncated: result.matchesTruncated,
          referencesTruncated: result.referencesTruncated,
          references,
        };
      },
      (row) => row,
      1,
    );
    const projection = run.findingsRunProjection;
    findings = {
      state: 'available',
      projectorName: 'findings',
      projectorVersion: projection.projectorVersion,
      analyzerName: projection.analyzerName,
      analyzerVersion: projection.analyzerVersion,
      catalogVersion: projection.catalogVersion,
      sourceFingerprint: projection.sourceFingerprint,
      coreVersion: projection.coreVersion,
      coreFingerprint: projection.coreFingerprint,
      coreCompleteness: projection.coreCompleteness as
        'complete' | 'incomplete',
      filesVersion:
        unavailableFilesDependencyReason === null
          ? projection.filesVersion
          : null,
      filesFingerprint:
        unavailableFilesDependencyReason === null
          ? projection.filesFingerprint
          : null,
      filesCompleteness:
        unavailableFilesDependencyReason ??
        (projection.filesCompleteness as
          'complete' | 'missing' | 'stale' | 'incomplete'),
      deterministicOutcome: projection.deterministicOutcome as
        'pass' | 'review' | 'unknown',
      coverage: projection.coverage as 'complete' | 'partial',
      triggeredCount: projection.triggeredCount,
      unknownCount: projection.unknownCount,
      highCount: projection.highCount,
      mediumCount: projection.mediumCount,
      results: mappedResults,
    };
  }

  let summary: unknown;
  if (summaryStatus.availability !== 'current' || !run.summaryRunProjection) {
    summary = {
      state: 'unavailable',
      reason:
        summaryStatus.availability === 'stale'
          ? 'stale'
          : unavailableReason(
              summaryStatus.processingState,
              summaryProcessingRow,
              run.summaryRunProjection !== null,
            ),
    };
  } else {
    const mappedClaims = await boundedPages(
      EVIDENCE_EXPORT_V1_LIMITS.summaryClaims,
      size,
      byteBudget,
      (skip, take) =>
        transaction.summaryClaim.findMany({
          where: { organizationId: input.organizationId, runId: run.id },
          orderBy: [
            { sectionOrder: 'asc' },
            { claimOrder: 'asc' },
            { claimKey: 'asc' },
          ],
          skip,
          take,
        }),
      async (claim) => {
        const supports = await boundedPages(
          EVIDENCE_EXPORT_V1_LIMITS.summarySupports,
          size,
          null,
          (skip, take) =>
            transaction.summaryClaimSupport.findMany({
              where: {
                organizationId: input.organizationId,
                runId: run.id,
                claimId: claim.id,
              },
              orderBy: { ordinal: 'asc' },
              skip,
              take,
              select: {
                ordinal: true,
                supportKind: true,
                eventArtifactPointer: true,
                jsonPointer: true,
                fileOrdinal: true,
                entryId: true,
                findingResultKey: true,
                findingRuleId: true,
                findingRuleVersion: true,
                findingsSourceFingerprint: true,
                event: { select: { canonicalEventId: true } },
                artifactDeclaration: {
                  select: { canonicalArtifactId: true },
                },
              },
            }),
          (support) => {
            if (support.supportKind === 'evidence') {
              if (!support.event)
                throw new EvidenceExportQueryError('export_unavailable');
              return {
                kind: 'evidence' as const,
                ordinal: support.ordinal,
                eventId: support.event.canonicalEventId,
                artifactId:
                  support.artifactDeclaration?.canonicalArtifactId ?? null,
                eventArtifactPointer: support.eventArtifactPointer,
                jsonPointer: support.jsonPointer,
                fileOrdinal: support.fileOrdinal,
                entryId: support.entryId,
              };
            }
            if (
              support.supportKind !== 'finding' ||
              support.findingResultKey === null ||
              support.findingRuleId === null ||
              support.findingRuleVersion === null ||
              support.findingsSourceFingerprint === null
            )
              throw new EvidenceExportQueryError('export_unavailable');
            return {
              kind: 'finding' as const,
              ordinal: support.ordinal,
              resultKey: support.findingResultKey,
              ruleId: support.findingRuleId,
              ruleVersion: support.findingRuleVersion,
              findingsSourceFingerprint: support.findingsSourceFingerprint,
            };
          },
        );
        return {
          claimKey: claim.claimKey,
          stableId: claim.stableId,
          sectionId: claim.sectionId as
            'run' | 'evidence' | 'findings' | 'limitations',
          sectionOrder: claim.sectionOrder,
          claimOrder: claim.claimOrder,
          class: claim.claimClass as
            'observation' | 'deterministic_assessment' | 'limitation',
          templateId: claim.templateId,
          text: claim.text,
          supportCount: claim.supportCount,
          supportsTruncated: claim.supportsTruncated,
          supports,
        };
      },
    );
    const projection = run.summaryRunProjection;
    summary = {
      state: 'available',
      projectorName: 'summary',
      projectorVersion: projection.projectorVersion,
      generatorName: projection.generatorName,
      generatorVersion: projection.generatorVersion,
      formatVersion: projection.formatVersion,
      templateVersion: projection.templateVersion,
      summaryKey: projection.summaryKey,
      sourceFingerprint: projection.sourceFingerprint,
      coreVersion: projection.coreVersion,
      coreFingerprint: projection.coreFingerprint,
      coreCompleteness: projection.coreCompleteness as
        'complete' | 'incomplete',
      filesVersion:
        unavailableFilesDependencyReason === null
          ? projection.filesVersion
          : null,
      filesFingerprint:
        unavailableFilesDependencyReason === null
          ? projection.filesFingerprint
          : null,
      filesCompleteness:
        unavailableFilesDependencyReason ??
        (projection.filesCompleteness as
          'complete' | 'missing' | 'stale' | 'incomplete'),
      findingsProjectorVersion: projection.findingsProjectorVersion,
      findingsFingerprint: projection.findingsFingerprint,
      findingsAnalyzerName: projection.findingsAnalyzerName,
      findingsAnalyzerVersion: projection.findingsAnalyzerVersion,
      findingsCatalogVersion: projection.findingsCatalogVersion,
      outcome: projection.summaryOutcome as 'pass' | 'review' | 'unknown',
      sectionCount: projection.sectionCount,
      claimCount: projection.claimCount,
      claimsTruncated: projection.claimsTruncated,
      claims: mappedClaims,
    };
  }

  try {
    return ExportV1SnapshotSchema.parse({
      repositoryId: input.repositoryId,
      runId: input.canonicalRunId,
      events,
      artifacts,
      processing,
      core,
      files,
      findings,
      summary,
    });
  } catch (error) {
    throw new EvidenceExportQueryError('export_unavailable', { cause: error });
  }
}

/**
 * Builds one complete tenant-scoped export snapshot inside repeatable read.
 * No Prisma type, internal identity, object location, or cursor is returned.
 */
export async function getEvidenceExportSnapshot(
  client: DatabaseClient,
  input: EvidenceExportSnapshotInput,
  hooks: QueryConsistencyHooks = {},
): Promise<ExportV1Snapshot | null> {
  requireUuid(input.organizationId);
  requireUuid(input.repositoryId);
  requireUuid(input.canonicalRunId);
  const size = pageSize(input.pageSize);
  const normalized = {
    ...input,
    organizationId: input.organizationId.toLowerCase(),
    repositoryId: input.repositoryId.toLowerCase(),
    canonicalRunId: input.canonicalRunId.toLowerCase(),
  };
  return client.$transaction(
    (transaction) => exportInSnapshot(transaction, normalized, size, hooks),
    {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      maxWait: 5_000,
      timeout: 30_000,
    },
  );
}
