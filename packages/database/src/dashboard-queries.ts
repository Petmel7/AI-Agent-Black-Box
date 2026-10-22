import {
  EvidenceEventSchema,
  extractArtifactReferences,
  JsonPointerSchema,
} from '@blackbox/contracts';

import type { DatabaseClient } from './client.js';
import {
  assertDashboardCursorSigningKey,
  dashboardCursorScope,
  decodeDashboardCursor,
  encodeDashboardCursor,
} from './dashboard-cursors.js';
import {
  deriveCoreQueryState,
  deriveFileQueryState,
  deriveFindingsQueryState,
  deriveSummaryQueryStatus,
  inspectCurrentCoreQuerySource,
  inspectCurrentFileQuerySource,
  isCurrentSummaryAvailable,
  type QueryConsistencyHooks,
} from './core-queries.js';
import { CORE_PROJECTOR_NAME } from './core-projector.js';
import { FILES_PROJECTOR_NAME } from './file-processing.js';
import { FINDINGS_PROJECTOR_NAME } from './findings-processing.js';
import { Prisma } from './generated/client/client.js';
import { SUMMARY_PROJECTOR_NAME } from './summary-processing.js';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

export type DashboardQueryErrorCode =
  | 'invalid_cursor'
  | 'cursor_scope_mismatch'
  | 'stale_cursor'
  | 'invalid_locator'
  | 'stale_evidence_locator'
  | 'invalid_canonical_evidence';

/** Safe query failure with no tenant, persistence, or evidence detail. */
export class DashboardQueryError extends Error {
  constructor(readonly code: DashboardQueryErrorCode) {
    super('The dashboard read request could not be completed.');
    this.name = 'DashboardQueryError';
  }
}

export interface DashboardRunListInput {
  organizationId: string;
  cursorSigningKey: Uint8Array;
  repositoryId?: string;
  limit: number;
  cursor?: string;
}

export interface DashboardTimelineInput {
  organizationId: string;
  cursorSigningKey: Uint8Array;
  repositoryId: string;
  canonicalRunId: string;
  limit: number;
  cursor?: string;
}

export type DashboardEvidenceLocator =
  | { kind: 'event'; eventId: string }
  | {
      kind: 'artifact';
      eventId: string;
      artifactId: string;
      eventArtifactPointer: string;
      jsonPointer?: string;
    }
  | {
      kind: 'file';
      eventId: string;
      artifactId: string;
      eventArtifactPointer: string;
      jsonPointer: string;
      fileOrdinal: number;
      entryId: string;
    }
  | {
      kind: 'finding';
      resultKey: string;
      referenceOrdinal: number;
    };

export interface DashboardEvidenceInput {
  organizationId: string;
  repositoryId: string;
  canonicalRunId: string;
  locator: DashboardEvidenceLocator;
  signal?: AbortSignal;
}

export type DashboardArtifactPreviewUnavailableReason =
  | 'artifact_not_verified'
  | 'integrity_metadata_mismatch'
  | 'unsupported_media_type'
  | 'unsupported_compression'
  | 'unsupported_character_encoding'
  | 'artifact_too_large'
  | 'binary_content'
  | 'invalid_utf8'
  | 'invalid_json'
  | 'json_pointer_unresolved'
  | 'object_missing'
  | 'provider_unavailable'
  | 'redirect_rejected'
  | 'read_timeout'
  | 'read_inactivity_timeout'
  | 'read_cancelled'
  | 'integrity_check_failed';

export type DashboardArtifactPreview =
  | {
      state: 'available';
      mediaType: 'application/json' | 'text/plain';
      text: string;
      byteLength: number;
    }
  | {
      state: 'unavailable';
      reason: DashboardArtifactPreviewUnavailableReason;
    };

export interface DashboardVerifiedArtifactSource {
  objectKey: string;
  expectedBytes: number;
  expectedSha256: string;
  mediaType: string;
  compression: string | null;
  characterEncoding: string | null;
  jsonPointer: string | null;
}

export type DashboardArtifactPreviewReader = (
  source: DashboardVerifiedArtifactSource,
  signal?: AbortSignal,
) => Promise<DashboardArtifactPreview>;

function bound(value: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new TypeError(`Limit must be between 1 and ${maximum}.`);
}

function safeNumber(value: bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result))
    throw new DashboardQueryError('invalid_canonical_evidence');
  return result;
}

function requireUuid(value: string): void {
  if (typeof value !== 'string' || !UUID.test(value))
    throw new DashboardQueryError('invalid_locator');
}

function exactKeys(value: object, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function scope(organizationId: string, ...parts: Array<string | undefined>) {
  return dashboardCursorScope(organizationId, ...parts);
}

function decodeEnvelope(
  cursorSigningKey: Uint8Array,
  value: string,
): Record<string, unknown> {
  try {
    return decodeDashboardCursor(cursorSigningKey, value);
  } catch {
    throw new DashboardQueryError('invalid_cursor');
  }
}

interface RunCursor {
  snapshotCount: number;
  afterCreatedAt: string;
  afterRunId: string;
}

function runCursor(
  organizationId: string,
  cursorSigningKey: Uint8Array,
  repositoryId: string | undefined,
  value: string | undefined,
): RunCursor | null {
  if (!value) return null;
  const parsed = decodeEnvelope(cursorSigningKey, value);
  if (
    !exactKeys(parsed, [
      'version',
      'kind',
      'scope',
      'snapshotCount',
      'afterCreatedAt',
      'afterRunId',
    ]) ||
    parsed.version !== 1 ||
    parsed.kind !== 'dashboard-runs' ||
    typeof parsed.scope !== 'string'
  )
    throw new DashboardQueryError('invalid_cursor');
  if (parsed.scope !== scope(organizationId, repositoryId))
    throw new DashboardQueryError('cursor_scope_mismatch');
  if (
    typeof parsed.snapshotCount !== 'number' ||
    !Number.isSafeInteger(parsed.snapshotCount) ||
    parsed.snapshotCount < 0 ||
    typeof parsed.afterCreatedAt !== 'string' ||
    Number.isNaN(Date.parse(parsed.afterCreatedAt)) ||
    typeof parsed.afterRunId !== 'string' ||
    !UUID.test(parsed.afterRunId)
  )
    throw new DashboardQueryError('invalid_cursor');
  return {
    snapshotCount: parsed.snapshotCount,
    afterCreatedAt: parsed.afterCreatedAt,
    afterRunId: parsed.afterRunId,
  };
}

function encodeRunCursor(
  organizationId: string,
  cursorSigningKey: Uint8Array,
  repositoryId: string | undefined,
  cursor: RunCursor,
): string {
  return encodeDashboardCursor(cursorSigningKey, {
    version: 1,
    kind: 'dashboard-runs',
    scope: scope(organizationId, repositoryId),
    ...cursor,
  });
}

interface TimelineCursor {
  snapshotCount: number;
  snapshotMaxSequence: number | null;
  afterSequence: number;
  afterEventId: string;
}

function timelineCursor(input: DashboardTimelineInput): TimelineCursor | null {
  if (!input.cursor) return null;
  const parsed = decodeEnvelope(input.cursorSigningKey, input.cursor);
  if (
    !exactKeys(parsed, [
      'version',
      'kind',
      'scope',
      'snapshotCount',
      'snapshotMaxSequence',
      'afterSequence',
      'afterEventId',
    ]) ||
    parsed.version !== 1 ||
    parsed.kind !== 'dashboard-timeline' ||
    typeof parsed.scope !== 'string'
  )
    throw new DashboardQueryError('invalid_cursor');
  if (
    parsed.scope !==
    scope(input.organizationId, input.repositoryId, input.canonicalRunId)
  )
    throw new DashboardQueryError('cursor_scope_mismatch');
  if (
    typeof parsed.snapshotCount !== 'number' ||
    !Number.isSafeInteger(parsed.snapshotCount) ||
    parsed.snapshotCount < 0 ||
    !(
      parsed.snapshotMaxSequence === null ||
      (typeof parsed.snapshotMaxSequence === 'number' &&
        Number.isSafeInteger(parsed.snapshotMaxSequence) &&
        parsed.snapshotMaxSequence >= 0)
    ) ||
    typeof parsed.afterSequence !== 'number' ||
    !Number.isSafeInteger(parsed.afterSequence) ||
    parsed.afterSequence < 0 ||
    typeof parsed.afterEventId !== 'string' ||
    !UUID.test(parsed.afterEventId)
  )
    throw new DashboardQueryError('invalid_cursor');
  return {
    snapshotCount: parsed.snapshotCount,
    snapshotMaxSequence: parsed.snapshotMaxSequence as number | null,
    afterSequence: parsed.afterSequence,
    afterEventId: parsed.afterEventId,
  };
}

function encodeTimelineCursor(
  input: DashboardTimelineInput,
  cursor: TimelineCursor,
): string {
  return encodeDashboardCursor(input.cursorSigningKey, {
    version: 1,
    kind: 'dashboard-timeline',
    scope: scope(
      input.organizationId,
      input.repositoryId,
      input.canonicalRunId,
    ),
    ...cursor,
  });
}

/** Tenant-wide newest-first run pagination with scope- and snapshot-bound cursors. */
export async function listDashboardRuns(
  client: DatabaseClient,
  input: DashboardRunListInput,
  hooks: QueryConsistencyHooks = {},
) {
  bound(input.limit, 100);
  assertDashboardCursorSigningKey(input.cursorSigningKey);
  requireUuid(input.organizationId);
  if (input.repositoryId !== undefined) requireUuid(input.repositoryId);
  const cursor = runCursor(
    input.organizationId,
    input.cursorSigningKey,
    input.repositoryId,
    input.cursor,
  );
  return client.$transaction(
    async (transaction) => {
      const where = {
        organizationId: input.organizationId,
        ...(input.repositoryId ? { repositoryId: input.repositoryId } : {}),
      };
      const snapshotCount = await transaction.run.count({ where });
      if (cursor && cursor.snapshotCount !== snapshotCount)
        throw new DashboardQueryError('stale_cursor');
      await hooks.afterBaseRead?.();
      const runs = await transaction.run.findMany({
        where: {
          ...where,
          ...(cursor
            ? {
                OR: [
                  { createdAt: { lt: new Date(cursor.afterCreatedAt) } },
                  {
                    createdAt: new Date(cursor.afterCreatedAt),
                    canonicalRunId: { lt: cursor.afterRunId },
                  },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { canonicalRunId: 'desc' }],
        take: input.limit + 1,
        select: {
          id: true,
          repositoryId: true,
          canonicalRunId: true,
          createdAt: true,
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
          },
        },
      });
      const visible = runs.slice(0, input.limit);
      const items = await Promise.all(
        visible.map(async (run) => {
          const coreProcessing =
            run.processingStates.find(
              (value) => value.projectorName === CORE_PROJECTOR_NAME,
            ) ?? null;
          const filesProcessing =
            run.processingStates.find(
              (value) => value.projectorName === FILES_PROJECTOR_NAME,
            ) ?? null;
          const findingsProcessing =
            run.processingStates.find(
              (value) => value.projectorName === FINDINGS_PROJECTOR_NAME,
            ) ?? null;
          const summaryProcessing =
            run.processingStates.find(
              (value) => value.projectorName === SUMMARY_PROJECTOR_NAME,
            ) ?? null;
          const [coreSource, filesSource] = await Promise.all([
            inspectCurrentCoreQuerySource(transaction, run.id),
            inspectCurrentFileQuerySource(
              transaction,
              input.organizationId,
              run.id,
            ),
          ]);
          const coreState = deriveCoreQueryState(
            run.coreRunProjection,
            coreProcessing,
            coreSource,
          );
          const filesState = deriveFileQueryState(
            run.fileRunProjection,
            filesProcessing,
            filesSource,
          );
          const findingsState = await deriveFindingsQueryState(
            transaction,
            input.organizationId,
            run.id,
            run.findingsRunProjection,
            findingsProcessing,
          );
          const summaryStatus = await deriveSummaryQueryStatus(
            transaction,
            input.organizationId,
            run.id,
            run.summaryRunProjection,
            summaryProcessing,
          );
          const summaryAvailable = isCurrentSummaryAvailable(summaryStatus);
          return {
            repositoryId: run.repositoryId,
            runId: run.canonicalRunId,
            createdAt: run.createdAt.toISOString(),
            processingState: coreState,
            processingErrorCode: coreProcessing?.lastErrorCode ?? null,
            filesProcessingState: filesState,
            filesProcessingErrorCode: filesProcessing?.lastErrorCode ?? null,
            filesCompleteness: run.fileRunProjection?.completeness ?? null,
            filesCompletenessReason:
              run.fileRunProjection?.completenessReason ??
              (filesState === 'ready' ? null : `files_${filesState}`),
            findingsProcessingState: findingsState,
            findingsProcessingErrorCode:
              findingsProcessing?.lastErrorCode ?? null,
            deterministicOutcome:
              findingsState === 'ready'
                ? (run.findingsRunProjection?.deterministicOutcome ?? null)
                : null,
            findingsCoverage:
              findingsState === 'ready'
                ? (run.findingsRunProjection?.coverage ?? null)
                : null,
            triggeredFindingCount:
              findingsState === 'ready'
                ? (run.findingsRunProjection?.triggeredCount ?? null)
                : null,
            unknownFindingCount:
              findingsState === 'ready'
                ? (run.findingsRunProjection?.unknownCount ?? null)
                : null,
            highFindingCount:
              findingsState === 'ready'
                ? (run.findingsRunProjection?.highCount ?? null)
                : null,
            mediumFindingCount:
              findingsState === 'ready'
                ? (run.findingsRunProjection?.mediumCount ?? null)
                : null,
            summaryProcessingState: summaryStatus.processingState,
            summaryAvailability: summaryStatus.availability,
            summaryProcessingErrorCode:
              summaryProcessing?.lastErrorCode ?? null,
            summaryOutcome: summaryAvailable
              ? (run.summaryRunProjection?.summaryOutcome ?? null)
              : null,
            summaryGeneratorVersion: summaryAvailable
              ? (run.summaryRunProjection?.generatorVersion ?? null)
              : null,
            summaryFormatVersion: summaryAvailable
              ? (run.summaryRunProjection?.formatVersion ?? null)
              : null,
            summaryTemplateVersion: summaryAvailable
              ? (run.summaryRunProjection?.templateVersion ?? null)
              : null,
            summarySectionCount: summaryAvailable
              ? (run.summaryRunProjection?.sectionCount ?? null)
              : null,
            summaryClaimCount: summaryAvailable
              ? (run.summaryRunProjection?.claimCount ?? null)
              : null,
            summaryClaimsTruncated: summaryAvailable
              ? (run.summaryRunProjection?.claimsTruncated ?? null)
              : null,
            evidenceCompleteness:
              run.coreRunProjection?.evidenceCompleteness ?? null,
            observedOutcome: run.coreRunProjection?.observedOutcome ?? null,
            durationMs:
              run.coreRunProjection?.durationMs === null ||
              run.coreRunProjection?.durationMs === undefined
                ? null
                : safeNumber(run.coreRunProjection.durationMs),
            commandCount: run.coreRunProjection?.commandCount ?? null,
            toolCallCount: run.coreRunProjection?.toolCallCount ?? null,
            testObservationState:
              run.coreRunProjection?.testObservationState ?? 'not_observed',
            testCounts:
              coreState === 'ready' || coreState === 'incomplete'
                ? (run.coreRunProjection?.testCounts ?? null)
                : null,
            tokenAggregates:
              coreState === 'ready' || coreState === 'incomplete'
                ? (run.coreRunProjection?.tokenAggregates ?? null)
                : null,
            filesChanged:
              filesState === 'ready'
                ? (run.fileRunProjection?.fileCount ?? 0)
                : null,
          };
        }),
      );
      const last = visible.at(-1);
      return {
        items,
        nextCursor:
          runs.length > input.limit && last
            ? encodeRunCursor(
                input.organizationId,
                input.cursorSigningKey,
                input.repositoryId,
                {
                  snapshotCount,
                  afterCreatedAt: last.createdAt.toISOString(),
                  afterRunId: last.canonicalRunId,
                },
              )
            : null,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

function canonicalEvent(
  row: {
    canonicalEventId: string;
    schemaVersion: number;
    sequence: bigint;
    kind: string;
    observedAt: Date;
    occurredAt: Date | null;
    receivedAt: Date;
    rawEvent: Prisma.JsonValue;
  },
  canonicalRunId: string,
) {
  const parsed = EvidenceEventSchema.safeParse(row.rawEvent);
  if (
    !parsed.success ||
    parsed.data.eventId !== row.canonicalEventId ||
    parsed.data.runId !== canonicalRunId ||
    parsed.data.schemaVersion !== row.schemaVersion ||
    parsed.data.sequence !== safeNumber(row.sequence) ||
    parsed.data.kind !== row.kind ||
    parsed.data.observedAt !== row.observedAt.toISOString() ||
    (parsed.data.occurredAt ?? null) !== (row.occurredAt?.toISOString() ?? null)
  )
    throw new DashboardQueryError('invalid_canonical_evidence');
  return {
    eventId: row.canonicalEventId,
    sequence: parsed.data.sequence,
    kind: parsed.data.kind,
    observedAt: parsed.data.observedAt,
    occurredAt: parsed.data.occurredAt ?? null,
    receivedAt: row.receivedAt.toISOString(),
    data: parsed.data,
  };
}

/** Canonical sequence/event-id timeline pinned to one immutable raw snapshot. */
export async function listDashboardTimeline(
  client: DatabaseClient,
  input: DashboardTimelineInput,
  hooks: QueryConsistencyHooks = {},
) {
  bound(input.limit, 200);
  assertDashboardCursorSigningKey(input.cursorSigningKey);
  requireUuid(input.organizationId);
  requireUuid(input.repositoryId);
  requireUuid(input.canonicalRunId);
  const cursor = timelineCursor(input);
  return client.$transaction(
    async (transaction) => {
      const run = await transaction.run.findFirst({
        where: {
          organizationId: input.organizationId,
          repositoryId: input.repositoryId,
          canonicalRunId: input.canonicalRunId,
        },
        select: { id: true },
      });
      if (!run) return null;
      const source = await inspectCurrentCoreQuerySource(transaction, run.id);
      const snapshotMaxSequence =
        source.maxSequence === null ? null : safeNumber(source.maxSequence);
      if (
        cursor &&
        (cursor.snapshotCount !== source.count ||
          cursor.snapshotMaxSequence !== snapshotMaxSequence)
      )
        throw new DashboardQueryError('stale_cursor');
      await hooks.afterBaseRead?.();
      const rows = await transaction.evidenceEvent.findMany({
        where: {
          organizationId: input.organizationId,
          runId: run.id,
          ...(cursor
            ? {
                OR: [
                  { sequence: { gt: BigInt(cursor.afterSequence) } },
                  {
                    sequence: BigInt(cursor.afterSequence),
                    canonicalEventId: { gt: cursor.afterEventId },
                  },
                ],
              }
            : {}),
        },
        orderBy: [{ sequence: 'asc' }, { canonicalEventId: 'asc' }],
        take: input.limit + 1,
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
      });
      const visible = rows.slice(0, input.limit);
      const last = visible.at(-1);
      return {
        items: visible.map((row) => canonicalEvent(row, input.canonicalRunId)),
        nextCursor:
          rows.length > input.limit && last
            ? encodeTimelineCursor(input, {
                snapshotCount: source.count,
                snapshotMaxSequence,
                afterSequence: safeNumber(last.sequence),
                afterEventId: last.canonicalEventId,
              })
            : null,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

function validateLocator(locator: DashboardEvidenceLocator): void {
  if (!locator || typeof locator !== 'object')
    throw new DashboardQueryError('invalid_locator');
  switch (locator.kind) {
    case 'event':
      if (!exactKeys(locator, ['kind', 'eventId']))
        throw new DashboardQueryError('invalid_locator');
      requireUuid(locator.eventId);
      return;
    case 'artifact':
      if (
        !exactKeys(
          locator,
          locator.jsonPointer === undefined
            ? ['kind', 'eventId', 'artifactId', 'eventArtifactPointer']
            : [
                'kind',
                'eventId',
                'artifactId',
                'eventArtifactPointer',
                'jsonPointer',
              ],
        )
      )
        throw new DashboardQueryError('invalid_locator');
      requireUuid(locator.eventId);
      requireUuid(locator.artifactId);
      if (!JsonPointerSchema.safeParse(locator.eventArtifactPointer).success)
        throw new DashboardQueryError('invalid_locator');
      if (
        locator.jsonPointer !== undefined &&
        !JsonPointerSchema.safeParse(locator.jsonPointer).success
      )
        throw new DashboardQueryError('invalid_locator');
      return;
    case 'file':
      if (
        !exactKeys(locator, [
          'kind',
          'eventId',
          'artifactId',
          'eventArtifactPointer',
          'jsonPointer',
          'fileOrdinal',
          'entryId',
        ])
      )
        throw new DashboardQueryError('invalid_locator');
      requireUuid(locator.eventId);
      requireUuid(locator.artifactId);
      if (
        !JsonPointerSchema.safeParse(locator.eventArtifactPointer).success ||
        !JsonPointerSchema.safeParse(locator.jsonPointer).success ||
        !Number.isSafeInteger(locator.fileOrdinal) ||
        locator.fileOrdinal < 0 ||
        locator.fileOrdinal > 19_999 ||
        typeof locator.entryId !== 'string' ||
        locator.entryId.length < 1 ||
        locator.entryId.length > 128
      )
        throw new DashboardQueryError('invalid_locator');
      return;
    case 'finding':
      if (
        !exactKeys(locator, ['kind', 'resultKey', 'referenceOrdinal']) ||
        !SHA256.test(locator.resultKey) ||
        !Number.isSafeInteger(locator.referenceOrdinal) ||
        locator.referenceOrdinal < 0 ||
        locator.referenceOrdinal > 99
      )
        throw new DashboardQueryError('invalid_locator');
      return;
    default:
      throw new DashboardQueryError('invalid_locator');
  }
}

interface InternalArtifact {
  id: string;
  canonicalArtifactId: string;
  kind: string;
  mediaType: string;
  byteLength: bigint;
  sha256: string;
  redactionApplied: boolean;
  redactionRuleset: string | null;
  compression: string | null;
  characterEncoding: string | null;
}

interface InternalResolution {
  event: ReturnType<typeof canonicalEvent>;
  locatorKind: DashboardEvidenceLocator['kind'];
  artifact: InternalArtifact | null;
  eventArtifactPointer: string | null;
  jsonPointer: string | null;
  file: {
    ordinal: number;
    entryId: string;
    displayPath: string;
    displayAmbiguous: boolean;
    displayReason: string | null;
    attribution: string;
    before: Prisma.JsonValue | null;
    after: Prisma.JsonValue | null;
  } | null;
  finding: {
    resultKey: string;
    ruleId: string;
    ruleVersion: number;
    referenceOrdinal: number;
  } | null;
  previewSource: DashboardVerifiedArtifactSource | null;
  previewUnavailableReason:
    'artifact_not_verified' | 'integrity_metadata_mismatch' | null;
}

async function artifactResolution(
  transaction: Prisma.TransactionClient,
  input: DashboardEvidenceInput,
  runId: string,
  eventId: string,
  artifactId: string,
  eventArtifactPointer: string,
): Promise<{
  artifact: InternalArtifact;
  previewSource: DashboardVerifiedArtifactSource | null;
  previewUnavailableReason:
    'artifact_not_verified' | 'integrity_metadata_mismatch' | null;
} | null> {
  const event = await transaction.evidenceEvent.findFirst({
    where: {
      organizationId: input.organizationId,
      runId,
      canonicalEventId: eventId,
    },
    select: { id: true },
  });
  if (!event) return null;
  const artifact = await transaction.artifactDeclaration.findFirst({
    where: {
      organizationId: input.organizationId,
      runId,
      canonicalArtifactId: artifactId,
    },
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
    },
  });
  if (!artifact) return null;
  const link = await transaction.evidenceEventArtifact.findFirst({
    where: {
      organizationId: input.organizationId,
      runId,
      eventId: event.id,
      artifactId: artifact.id,
      jsonPointer: eventArtifactPointer,
    },
    select: { id: true },
  });
  if (!link) return null;
  const attempt = await transaction.artifactUploadAttempt.findFirst({
    where: {
      organizationId: input.organizationId,
      runId,
      artifactDeclarationId: artifact.id,
      state: 'VERIFIED',
    },
    select: {
      objectKey: true,
      observedByteLength: true,
      observedSha256: true,
    },
  });
  if (!attempt)
    return {
      artifact,
      previewSource: null,
      previewUnavailableReason: 'artifact_not_verified',
    };
  if (
    attempt.observedByteLength !== artifact.byteLength ||
    attempt.observedSha256 !== artifact.sha256 ||
    !SHA256.test(artifact.sha256)
  )
    return {
      artifact,
      previewSource: null,
      previewUnavailableReason: 'integrity_metadata_mismatch',
    };
  const expectedBytes = safeNumber(artifact.byteLength);
  return {
    artifact,
    previewSource: {
      objectKey: attempt.objectKey,
      expectedBytes,
      expectedSha256: artifact.sha256,
      mediaType: artifact.mediaType,
      compression: artifact.compression,
      characterEncoding: artifact.characterEncoding,
      jsonPointer: null,
    },
    previewUnavailableReason: null,
  };
}

async function resolveInSnapshot(
  transaction: Prisma.TransactionClient,
  input: DashboardEvidenceInput,
): Promise<InternalResolution | null> {
  const run = await transaction.run.findFirst({
    where: {
      organizationId: input.organizationId,
      repositoryId: input.repositoryId,
      canonicalRunId: input.canonicalRunId,
    },
    select: {
      id: true,
      fileRunProjection: true,
      findingsRunProjection: true,
      processingStates: {
        where: {
          projectorName: {
            in: [FILES_PROJECTOR_NAME, FINDINGS_PROJECTOR_NAME],
          },
        },
      },
    },
  });
  if (!run) return null;

  let locator = input.locator;
  let finding: InternalResolution['finding'] = null;
  if (locator.kind === 'finding') {
    const reference = await transaction.findingEvidenceReference.findFirst({
      where: {
        organizationId: input.organizationId,
        runId: run.id,
        ordinal: locator.referenceOrdinal,
        result: { resultKey: locator.resultKey },
      },
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
        result: {
          select: { resultKey: true, ruleId: true, ruleVersion: true },
        },
      },
    });
    if (!reference) return null;
    const processing =
      run.processingStates.find(
        (value) => value.projectorName === FINDINGS_PROJECTOR_NAME,
      ) ?? null;
    const state = await deriveFindingsQueryState(
      transaction,
      input.organizationId,
      run.id,
      run.findingsRunProjection,
      processing,
    );
    if (state !== 'ready')
      throw new DashboardQueryError('stale_evidence_locator');
    finding = {
      ...reference.result,
      referenceOrdinal: reference.ordinal,
    };
    if (!reference.artifactDeclaration) {
      locator = { kind: 'event', eventId: reference.event.canonicalEventId };
    } else if (
      reference.fileOrdinal !== null &&
      reference.entryId !== null &&
      reference.eventArtifactPointer !== null &&
      reference.jsonPointer !== null
    ) {
      locator = {
        kind: 'file',
        eventId: reference.event.canonicalEventId,
        artifactId: reference.artifactDeclaration.canonicalArtifactId,
        eventArtifactPointer: reference.eventArtifactPointer,
        jsonPointer: reference.jsonPointer,
        fileOrdinal: reference.fileOrdinal,
        entryId: reference.entryId,
      };
    } else if (reference.eventArtifactPointer !== null) {
      locator = {
        kind: 'artifact',
        eventId: reference.event.canonicalEventId,
        artifactId: reference.artifactDeclaration.canonicalArtifactId,
        eventArtifactPointer: reference.eventArtifactPointer,
        ...(reference.jsonPointer === null
          ? {}
          : { jsonPointer: reference.jsonPointer }),
      };
    } else {
      throw new DashboardQueryError('invalid_canonical_evidence');
    }
  }

  const eventRow = await transaction.evidenceEvent.findFirst({
    where: {
      organizationId: input.organizationId,
      runId: run.id,
      canonicalEventId: locator.eventId,
    },
    select: {
      canonicalEventId: true,
      schemaVersion: true,
      sequence: true,
      kind: true,
      observedAt: true,
      occurredAt: true,
      receivedAt: true,
      rawEvent: true,
      id: true,
    },
  });
  if (!eventRow) return null;
  const event = canonicalEvent(eventRow, input.canonicalRunId);
  if (locator.kind === 'event')
    return {
      event,
      locatorKind: input.locator.kind,
      artifact: null,
      eventArtifactPointer: null,
      jsonPointer: null,
      file: null,
      finding,
      previewSource: null,
      previewUnavailableReason: null,
    };

  const resolvedArtifact = await artifactResolution(
    transaction,
    input,
    run.id,
    locator.eventId,
    locator.artifactId,
    locator.eventArtifactPointer,
  );
  if (!resolvedArtifact) return null;
  const canonicalReference = extractArtifactReferences(event.data).find(
    (candidate) =>
      candidate.jsonPointer === locator.eventArtifactPointer &&
      candidate.reference.artifactId === locator.artifactId,
  )?.reference;
  if (
    !canonicalReference ||
    canonicalReference.kind !== resolvedArtifact.artifact.kind ||
    canonicalReference.mediaType !== resolvedArtifact.artifact.mediaType ||
    BigInt(canonicalReference.byteLength) !==
      resolvedArtifact.artifact.byteLength ||
    canonicalReference.sha256 !== resolvedArtifact.artifact.sha256 ||
    canonicalReference.redaction.applied !==
      resolvedArtifact.artifact.redactionApplied ||
    (canonicalReference.redaction.rulesetVersion ?? null) !==
      resolvedArtifact.artifact.redactionRuleset ||
    (canonicalReference.compression ?? null) !==
      resolvedArtifact.artifact.compression ||
    (canonicalReference.characterEncoding ?? null) !==
      resolvedArtifact.artifact.characterEncoding
  )
    throw new DashboardQueryError('invalid_canonical_evidence');

  let file: InternalResolution['file'] = null;
  if (locator.kind === 'file') {
    if (locator.jsonPointer !== `/files/${locator.fileOrdinal}`) return null;
    const row = await transaction.fileChangeProjection.findFirst({
      where: {
        organizationId: input.organizationId,
        repositoryId: input.repositoryId,
        runId: run.id,
        sourceEventId: eventRow.id,
        artifactDeclarationId: resolvedArtifact.artifact.id,
        ordinal: locator.fileOrdinal,
        entryId: locator.entryId,
      },
      select: {
        ordinal: true,
        entryId: true,
        displayPath: true,
        displayAmbiguous: true,
        displayReason: true,
        attribution: true,
        beforeState: true,
        afterState: true,
      },
    });
    if (!row) return null;
    const processing =
      run.processingStates.find(
        (value) => value.projectorName === FILES_PROJECTOR_NAME,
      ) ?? null;
    const current = await inspectCurrentFileQuerySource(
      transaction,
      input.organizationId,
      run.id,
    );
    if (
      deriveFileQueryState(run.fileRunProjection, processing, current) !==
      'ready'
    )
      throw new DashboardQueryError('stale_evidence_locator');
    file = {
      ordinal: row.ordinal,
      entryId: row.entryId,
      displayPath: row.displayPath,
      displayAmbiguous: row.displayAmbiguous,
      displayReason: row.displayReason,
      attribution: row.attribution,
      before: row.beforeState,
      after: row.afterState,
    };
  }
  return {
    event,
    locatorKind: input.locator.kind,
    artifact: resolvedArtifact.artifact,
    eventArtifactPointer: locator.eventArtifactPointer,
    jsonPointer: locator.jsonPointer ?? null,
    file,
    finding,
    previewSource: resolvedArtifact.previewSource,
    previewUnavailableReason: resolvedArtifact.previewUnavailableReason,
  };
}

/**
 * Resolves an exact same-tenant evidence identity. The storage object key is
 * supplied only to the injected server-side reader and is never returned.
 */
export async function resolveDashboardEvidence(
  client: DatabaseClient,
  input: DashboardEvidenceInput,
  previewReader?: DashboardArtifactPreviewReader,
) {
  requireUuid(input.organizationId);
  requireUuid(input.repositoryId);
  requireUuid(input.canonicalRunId);
  validateLocator(input.locator);
  const resolution = await client.$transaction(
    (transaction) => resolveInSnapshot(transaction, input),
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
  if (!resolution) return null;

  let preview: DashboardArtifactPreview | null = null;
  if (resolution.artifact) {
    if (resolution.previewUnavailableReason) {
      preview = {
        state: 'unavailable',
        reason: resolution.previewUnavailableReason,
      };
    } else if (!previewReader || !resolution.previewSource) {
      preview = {
        state: 'unavailable',
        reason: 'provider_unavailable',
      };
    } else {
      try {
        preview = await previewReader(
          {
            ...resolution.previewSource,
            jsonPointer: resolution.jsonPointer,
          },
          input.signal,
        );
      } catch {
        preview = {
          state: 'unavailable',
          reason: input.signal?.aborted
            ? 'read_cancelled'
            : 'provider_unavailable',
        };
      }
    }
  }

  return {
    locatorKind: resolution.locatorKind,
    event: resolution.event,
    artifact: resolution.artifact
      ? {
          artifactId: resolution.artifact.canonicalArtifactId,
          kind: resolution.artifact.kind,
          mediaType: resolution.artifact.mediaType,
          byteLength: safeNumber(resolution.artifact.byteLength),
          sha256: resolution.artifact.sha256,
          redactionApplied: resolution.artifact.redactionApplied,
          redactionRuleset: resolution.artifact.redactionRuleset,
          compression: resolution.artifact.compression,
          characterEncoding: resolution.artifact.characterEncoding,
          eventArtifactPointer: resolution.eventArtifactPointer,
          jsonPointer: resolution.jsonPointer,
          verificationState: resolution.previewSource
            ? ('verified' as const)
            : ('unavailable' as const),
          preview,
        }
      : null,
    file: resolution.file,
    finding: resolution.finding,
  };
}
