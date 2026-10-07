import {
  CORE_PROJECTOR_NAME,
  CORE_PROJECTOR_VERSION,
} from './core-projector.js';
import {
  FILES_PROJECTOR_NAME,
  FILES_PROJECTOR_VERSION,
  inspectFileSourceSnapshot,
} from './file-processing.js';
import {
  FINDINGS_PROJECTOR_NAME,
  FINDINGS_PROJECTOR_VERSION,
  inspectFindingsSourceSnapshot,
} from './findings-processing.js';
import { Prisma } from './generated/client/client.js';
import type { DatabaseClient } from './client.js';

export type QueryProcessingState =
  'processing' | 'stale' | 'ready' | 'incomplete' | 'failed';

export interface RunListInput {
  organizationId: string;
  repositoryId: string;
  limit: number;
  cursor?: string;
}

export interface QueryConsistencyHooks {
  afterBaseRead?(): void | Promise<void>;
}

type Cursor = { createdAt: string; id: string };

function encode(value: object): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decode(value: string): Cursor {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    if (
      typeof parsed.createdAt !== 'string' ||
      Number.isNaN(Date.parse(parsed.createdAt)) ||
      typeof parsed.id !== 'string'
    )
      throw new Error();
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    throw new TypeError('Invalid pagination cursor.');
  }
}

function bounded(value: number, maximum: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new TypeError(`Limit must be between 1 and ${maximum}.`);
}

function number(value: bigint | null): number | null {
  return value === null ? null : Number(value);
}

function state(
  projection: {
    projectorName: string;
    projectorVersion: number;
    sourceEventCount: number;
    sourceMaxSequence: bigint | null;
    sourceFingerprint: string;
    evidenceCompleteness: string;
  } | null,
  processing: {
    state: string;
    projectorVersion: number;
    sourceEventCount: number | null;
    sourceMaxSequence: bigint | null;
    sourceFingerprint: string | null;
  } | null,
  current: { count: number; maxSequence: bigint | null },
): QueryProcessingState {
  if (processing?.state === 'FAILED') return 'failed';
  if (!projection) return 'processing';
  if (
    projection.projectorName !== CORE_PROJECTOR_NAME ||
    projection.projectorVersion !== CORE_PROJECTOR_VERSION ||
    processing?.projectorVersion !== CORE_PROJECTOR_VERSION
  )
    return 'stale';
  if (
    projection.sourceEventCount !== current.count ||
    projection.sourceMaxSequence !== current.maxSequence ||
    processing.sourceEventCount !== current.count ||
    processing.sourceMaxSequence !== current.maxSequence ||
    processing.sourceFingerprint !== projection.sourceFingerprint
  )
    return 'stale';
  if (processing.state !== 'READY') return 'processing';
  return projection.evidenceCompleteness === 'complete'
    ? 'ready'
    : 'incomplete';
}

async function currentSource(
  client: DatabaseClient | Prisma.TransactionClient,
  runId: string,
) {
  const value = await client.evidenceEvent.aggregate({
    where: { runId },
    _count: { _all: true },
    _max: { sequence: true },
  });
  return { count: value._count._all, maxSequence: value._max.sequence };
}

async function currentFileSource(
  client: DatabaseClient | Prisma.TransactionClient,
  organizationId: string,
  runId: string,
) {
  return inspectFileSourceSnapshot(client, organizationId, runId);
}

function fileState(
  projection: {
    projectorName: string;
    projectorVersion: number;
    sourceEventCount: number;
    sourceMaxSequence: bigint | null;
    sourceFingerprint: string;
    completeness: string;
  } | null,
  processing: {
    state: string;
    projectorVersion: number;
    sourceEventCount: number | null;
    sourceMaxSequence: bigint | null;
    sourceFingerprint: string | null;
  } | null,
  current: {
    count: number;
    maxSequence: bigint | null;
    fingerprint: string;
    complete: boolean;
  },
): QueryProcessingState {
  if (processing?.state === 'FAILED') return 'failed';
  if (!current.complete) return 'incomplete';
  if (!projection) return 'processing';
  if (
    projection.projectorName !== FILES_PROJECTOR_NAME ||
    projection.projectorVersion !== FILES_PROJECTOR_VERSION ||
    processing?.projectorVersion !== FILES_PROJECTOR_VERSION
  )
    return 'stale';
  if (
    projection.sourceEventCount !== current.count ||
    projection.sourceMaxSequence !== current.maxSequence ||
    projection.sourceFingerprint !== current.fingerprint ||
    processing.sourceEventCount !== current.count ||
    processing.sourceMaxSequence !== current.maxSequence ||
    processing.sourceFingerprint !== projection.sourceFingerprint
  )
    return 'stale';
  if (processing.state !== 'READY') return 'processing';
  return projection.completeness === 'complete' ? 'ready' : 'incomplete';
}

async function findingsState(
  client: DatabaseClient | Prisma.TransactionClient,
  organizationId: string,
  runId: string,
  projection: {
    projectorName: string;
    projectorVersion: number;
    sourceFingerprint: string;
  } | null,
  processing: {
    state: string;
    projectorVersion: number;
    sourceFingerprint: string | null;
  } | null,
): Promise<QueryProcessingState> {
  if (processing?.state === 'FAILED') return 'failed';
  const current = await inspectFindingsSourceSnapshot(
    client,
    organizationId,
    runId,
  );
  if (!current.coreCurrent) return projection ? 'stale' : 'processing';
  if (!projection) return 'processing';
  if (
    projection.projectorName !== FINDINGS_PROJECTOR_NAME ||
    projection.projectorVersion !== FINDINGS_PROJECTOR_VERSION ||
    processing?.projectorVersion !== FINDINGS_PROJECTOR_VERSION ||
    projection.sourceFingerprint !== current.fingerprint ||
    processing.sourceFingerprint !== current.fingerprint
  )
    return 'stale';
  return processing.state === 'READY' ? 'ready' : 'processing';
}

async function listCoreRunsInSnapshot(
  client: Prisma.TransactionClient,
  input: RunListInput,
  hooks: QueryConsistencyHooks,
) {
  bounded(input.limit, 100);
  const cursor = input.cursor ? decode(input.cursor) : null;
  const runs = await client.run.findMany({
    where: {
      organizationId: input.organizationId,
      repositoryId: input.repositoryId,
      ...(cursor
        ? {
            OR: [
              { createdAt: { lt: new Date(cursor.createdAt) } },
              { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: input.limit + 1,
    select: {
      id: true,
      canonicalRunId: true,
      createdAt: true,
      coreRunProjection: {
        select: {
          projectorName: true,
          projectorVersion: true,
          sourceEventCount: true,
          sourceMaxSequence: true,
          sourceFingerprint: true,
          evidenceCompleteness: true,
          observedOutcome: true,
          durationMs: true,
          commandCount: true,
          toolCallCount: true,
          testObservationState: true,
          filesChanged: true,
        },
      },
      fileRunProjection: {
        select: {
          projectorName: true,
          projectorVersion: true,
          sourceEventCount: true,
          sourceMaxSequence: true,
          sourceFingerprint: true,
          completeness: true,
          completenessReason: true,
          fileCount: true,
        },
      },
      findingsRunProjection: true,
      processingStates: {
        where: {
          projectorName: {
            in: [
              CORE_PROJECTOR_NAME,
              FILES_PROJECTOR_NAME,
              FINDINGS_PROJECTOR_NAME,
            ],
          },
        },
        select: {
          projectorName: true,
          state: true,
          projectorVersion: true,
          sourceEventCount: true,
          sourceMaxSequence: true,
          sourceFingerprint: true,
          lastErrorCode: true,
        },
      },
    },
  });
  const hasMore = runs.length > input.limit;
  await hooks.afterBaseRead?.();
  const page = runs.slice(0, input.limit);
  const items = await Promise.all(
    page.map(async (run) => {
      const processing =
        run.processingStates.find(
          (value) => value.projectorName === CORE_PROJECTOR_NAME,
        ) ?? null;
      const filesProcessing =
        run.processingStates.find(
          (value) => value.projectorName === FILES_PROJECTOR_NAME,
        ) ?? null;
      const current = await currentSource(client, run.id);
      const currentFiles = await currentFileSource(
        client,
        input.organizationId,
        run.id,
      );
      const filesState = fileState(
        run.fileRunProjection,
        filesProcessing,
        currentFiles,
      );
      const findingsProcessing =
        run.processingStates.find(
          (value) => value.projectorName === FINDINGS_PROJECTOR_NAME,
        ) ?? null;
      const currentFindingsState = await findingsState(
        client,
        input.organizationId,
        run.id,
        run.findingsRunProjection,
        findingsProcessing,
      );
      return {
        runId: run.canonicalRunId,
        createdAt: run.createdAt.toISOString(),
        processingState: state(run.coreRunProjection, processing, current),
        processingErrorCode: processing?.lastErrorCode ?? null,
        filesProcessingState: filesState,
        filesProcessingErrorCode: filesProcessing?.lastErrorCode ?? null,
        filesCompleteness: run.fileRunProjection?.completeness ?? null,
        filesCompletenessReason:
          run.fileRunProjection?.completenessReason ??
          (filesState === 'ready' ? null : `files_${filesState}`),
        findingsProcessingState: currentFindingsState,
        findingsProcessingErrorCode: findingsProcessing?.lastErrorCode ?? null,
        deterministicOutcome:
          currentFindingsState === 'ready'
            ? (run.findingsRunProjection?.deterministicOutcome ?? null)
            : null,
        findingsCoverage:
          currentFindingsState === 'ready'
            ? (run.findingsRunProjection?.coverage ?? null)
            : null,
        triggeredFindingCount:
          currentFindingsState === 'ready'
            ? (run.findingsRunProjection?.triggeredCount ?? null)
            : null,
        unknownFindingCount:
          currentFindingsState === 'ready'
            ? (run.findingsRunProjection?.unknownCount ?? null)
            : null,
        highFindingCount:
          currentFindingsState === 'ready'
            ? (run.findingsRunProjection?.highCount ?? null)
            : null,
        mediumFindingCount:
          currentFindingsState === 'ready'
            ? (run.findingsRunProjection?.mediumCount ?? null)
            : null,
        evidenceCompleteness:
          run.coreRunProjection?.evidenceCompleteness ?? null,
        observedOutcome: run.coreRunProjection?.observedOutcome ?? null,
        durationMs: number(run.coreRunProjection?.durationMs ?? null),
        commandCount: run.coreRunProjection?.commandCount ?? null,
        toolCallCount: run.coreRunProjection?.toolCallCount ?? null,
        testObservationState:
          run.coreRunProjection?.testObservationState ?? 'not_observed',
        filesChanged:
          filesState === 'ready'
            ? (run.fileRunProjection?.fileCount ?? 0)
            : null,
      };
    }),
  );
  const last = page.at(-1);
  return {
    items,
    nextCursor:
      hasMore && last
        ? encode({ createdAt: last.createdAt.toISOString(), id: last.id })
        : null,
  };
}

export async function listCoreRuns(
  client: DatabaseClient,
  input: RunListInput,
  hooks: QueryConsistencyHooks = {},
) {
  return client.$transaction(
    (transaction) => listCoreRunsInSnapshot(transaction, input, hooks),
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

export interface FileChangeListInput {
  organizationId: string;
  repositoryId: string;
  canonicalRunId: string;
  limit: number;
  cursor?: string;
}

type FileCursor = { sequence: number; ordinal: number };

function decodeFileCursor(value: string): FileCursor {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    if (
      typeof parsed.sequence !== 'number' ||
      !Number.isSafeInteger(parsed.sequence) ||
      parsed.sequence < 0 ||
      typeof parsed.ordinal !== 'number' ||
      !Number.isSafeInteger(parsed.ordinal) ||
      parsed.ordinal < 0
    )
      throw new Error();
    return { sequence: parsed.sequence, ordinal: parsed.ordinal };
  } catch {
    throw new TypeError('Invalid file pagination cursor.');
  }
}

/** Tenant-safe current file snapshot pagination. Wrong-tenant and missing runs both return null. */
async function listFileChangesInSnapshot(
  client: Prisma.TransactionClient,
  input: FileChangeListInput,
  hooks: QueryConsistencyHooks,
) {
  bounded(input.limit, 500);
  const cursor = input.cursor ? decodeFileCursor(input.cursor) : null;
  const run = await client.run.findFirst({
    where: {
      organizationId: input.organizationId,
      repositoryId: input.repositoryId,
      canonicalRunId: input.canonicalRunId,
    },
    select: {
      id: true,
      fileRunProjection: {
        select: {
          projectorName: true,
          projectorVersion: true,
          sourceEventCount: true,
          sourceMaxSequence: true,
          sourceFingerprint: true,
          completeness: true,
        },
      },
      processingStates: {
        where: { projectorName: FILES_PROJECTOR_NAME },
        take: 1,
        select: {
          state: true,
          projectorVersion: true,
          sourceEventCount: true,
          sourceMaxSequence: true,
          sourceFingerprint: true,
          lastErrorCode: true,
        },
      },
    },
  });
  if (!run) return null;
  await hooks.afterBaseRead?.();
  const current = await currentFileSource(client, input.organizationId, run.id);
  const processing = run.processingStates[0] ?? null;
  const processingState = fileState(run.fileRunProjection, processing, current);
  if (processingState !== 'ready')
    return {
      processingState,
      processingErrorCode: processing?.lastErrorCode ?? null,
      items: [],
      nextCursor: null,
    };
  const rows = await client.$queryRaw<
    Array<{
      source_event_id: string;
      source_sequence: bigint;
      diff_id: string;
      from_snapshot_id: string;
      to_snapshot_id: string;
      artifact_id: string;
      ordinal: number;
      entry_id: string;
      original_entry_id: string | null;
      display_path: string;
      original_display_path: string | null;
      display_ambiguous: boolean;
      display_reason: string | null;
      before_state: Prisma.JsonValue | null;
      after_state: Prisma.JsonValue | null;
      attribution: string;
      reason: string | null;
    }>
  >(Prisma.sql`
    SELECT event.canonical_event_id AS source_event_id, file.source_sequence,
           file.diff_id, file.from_snapshot_id, file.to_snapshot_id,
           artifact.canonical_artifact_id AS artifact_id, file.ordinal,
           file.entry_id, file.original_entry_id, file.display_path,
           file.original_display_path, file.display_ambiguous, file.display_reason,
           file.before_state, file.after_state, file.attribution, file.reason
      FROM file_change_projections AS file
      JOIN evidence_events AS event
        ON event.organization_id = file.organization_id AND event.run_id = file.run_id AND event.id = file.source_event_id
      JOIN artifact_declarations AS artifact
        ON artifact.organization_id = file.organization_id AND artifact.run_id = file.run_id AND artifact.id = file.artifact_declaration_id
     WHERE file.organization_id = ${input.organizationId}::uuid AND file.run_id = ${run.id}::uuid
       AND (${cursor?.sequence ?? null}::bigint IS NULL OR file.source_sequence > ${cursor?.sequence ?? null}::bigint
            OR (file.source_sequence = ${cursor?.sequence ?? null}::bigint AND file.ordinal > ${cursor?.ordinal ?? null}::integer))
     ORDER BY file.source_sequence, file.ordinal
     LIMIT ${input.limit + 1}
  `);
  const visible = rows.slice(0, input.limit);
  return {
    processingState,
    processingErrorCode: null,
    items: visible.map((row) => ({
      sourceEventId: row.source_event_id,
      sourceSequence: Number(row.source_sequence),
      diffId: row.diff_id,
      fromSnapshotId: row.from_snapshot_id,
      toSnapshotId: row.to_snapshot_id,
      artifactId: row.artifact_id,
      ordinal: row.ordinal,
      entryId: row.entry_id,
      originalEntryId: row.original_entry_id,
      displayPath: row.display_path,
      originalDisplayPath: row.original_display_path,
      displayAmbiguous: row.display_ambiguous,
      displayReason: row.display_reason,
      before: row.before_state,
      after: row.after_state,
      attribution: row.attribution,
      reason: row.reason,
    })),
    nextCursor:
      rows.length > input.limit && visible.at(-1)
        ? encode({
            sequence: Number(visible.at(-1)!.source_sequence),
            ordinal: visible.at(-1)!.ordinal,
          })
        : null,
  };
}

export async function listFileChanges(
  client: DatabaseClient,
  input: FileChangeListInput,
  hooks: QueryConsistencyHooks = {},
) {
  return client.$transaction(
    (transaction) => listFileChangesInSnapshot(transaction, input, hooks),
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

export interface RunDetailInput {
  organizationId: string;
  repositoryId: string;
  canonicalRunId: string;
  childLimit: number;
  childCursors?: Partial<
    Record<
      | 'commands'
      | 'tools'
      | 'tests'
      | 'gitSnapshots'
      | 'gitDiffs'
      | 'errors'
      | 'usage',
      string
    >
  >;
}

function childCursor(
  value: string | undefined,
  sequenced: boolean,
): { id: string; sequence: number | null } | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    if (typeof parsed.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(parsed.id))
      throw new Error();
    if (
      sequenced &&
      (typeof parsed.sequence !== 'number' ||
        !Number.isSafeInteger(parsed.sequence) ||
        parsed.sequence < 0)
    )
      throw new Error();
    return {
      id: parsed.id,
      sequence: sequenced ? (parsed.sequence as number) : null,
    };
  } catch {
    throw new TypeError('Invalid child pagination cursor.');
  }
}

async function getCoreRunDetailInSnapshot(
  client: Prisma.TransactionClient,
  input: RunDetailInput,
  hooks: QueryConsistencyHooks,
) {
  bounded(input.childLimit, 200);
  const commandCursor = childCursor(input.childCursors?.commands, false);
  const toolCursor = childCursor(input.childCursors?.tools, false);
  const testCursor = childCursor(input.childCursors?.tests, true);
  const snapshotCursor = childCursor(input.childCursors?.gitSnapshots, true);
  const diffCursor = childCursor(input.childCursors?.gitDiffs, true);
  const errorCursor = childCursor(input.childCursors?.errors, true);
  const usageCursor = childCursor(input.childCursors?.usage, true);
  const afterSequence = (
    cursor: { id: string; sequence: number | null } | null,
    idField:
      'testRunId' | 'snapshotId' | 'diffId' | 'errorId' | 'sourceEventId',
  ) =>
    cursor
      ? {
          OR: [
            { sourceSequence: { gt: BigInt(cursor.sequence!) } },
            {
              sourceSequence: BigInt(cursor.sequence!),
              [idField]: { gt: cursor.id },
            },
          ],
        }
      : {};
  const run = await client.run.findFirst({
    where: {
      organizationId: input.organizationId,
      repositoryId: input.repositoryId,
      canonicalRunId: input.canonicalRunId,
    },
    select: {
      id: true,
      canonicalRunId: true,
      createdAt: true,
      coreRunProjection: {
        include: {
          commands: {
            where: commandCursor
              ? { operationId: { gt: commandCursor.id } }
              : {},
            orderBy: { operationId: 'asc' },
            take: input.childLimit + 1,
          },
          tools: {
            where: toolCursor ? { operationId: { gt: toolCursor.id } } : {},
            orderBy: { operationId: 'asc' },
            take: input.childLimit + 1,
          },
          tests: {
            where: afterSequence(testCursor, 'testRunId'),
            orderBy: [{ sourceSequence: 'asc' }, { testRunId: 'asc' }],
            take: input.childLimit + 1,
          },
          gitSnapshots: {
            where: afterSequence(snapshotCursor, 'snapshotId'),
            orderBy: [{ sourceSequence: 'asc' }, { snapshotId: 'asc' }],
            take: input.childLimit + 1,
          },
          gitDiffs: {
            where: afterSequence(diffCursor, 'diffId'),
            orderBy: [{ sourceSequence: 'asc' }, { diffId: 'asc' }],
            take: input.childLimit + 1,
          },
          errors: {
            where: afterSequence(errorCursor, 'errorId'),
            orderBy: [{ sourceSequence: 'asc' }, { errorId: 'asc' }],
            take: input.childLimit + 1,
          },
          usage: {
            where: afterSequence(usageCursor, 'sourceEventId'),
            orderBy: [{ sourceSequence: 'asc' }, { sourceEventId: 'asc' }],
            take: input.childLimit + 1,
          },
        },
      },
      fileRunProjection: true,
      findingsRunProjection: true,
      processingStates: {
        where: {
          projectorName: {
            in: [
              CORE_PROJECTOR_NAME,
              FILES_PROJECTOR_NAME,
              FINDINGS_PROJECTOR_NAME,
            ],
          },
        },
      },
    },
  });
  if (!run) return null;
  await hooks.afterBaseRead?.();
  const projection = run.coreRunProjection;
  const processing =
    run.processingStates.find(
      (value) => value.projectorName === CORE_PROJECTOR_NAME,
    ) ?? null;
  const filesProcessing =
    run.processingStates.find(
      (value) => value.projectorName === FILES_PROJECTOR_NAME,
    ) ?? null;
  const current = await currentSource(client, run.id);
  const currentFiles = await currentFileSource(
    client,
    input.organizationId,
    run.id,
  );
  const filesState = fileState(
    run.fileRunProjection,
    filesProcessing,
    currentFiles,
  );
  const findingsProcessing =
    run.processingStates.find(
      (value) => value.projectorName === FINDINGS_PROJECTOR_NAME,
    ) ?? null;
  const currentFindingsState = await findingsState(
    client,
    input.organizationId,
    run.id,
    run.findingsRunProjection,
    findingsProcessing,
  );
  const findingsSummary = {
    findingsProcessingState: currentFindingsState,
    findingsProcessingErrorCode: findingsProcessing?.lastErrorCode ?? null,
    deterministicOutcome:
      currentFindingsState === 'ready'
        ? (run.findingsRunProjection?.deterministicOutcome ?? null)
        : null,
    findingsCoverage:
      currentFindingsState === 'ready'
        ? (run.findingsRunProjection?.coverage ?? null)
        : null,
    triggeredFindingCount:
      currentFindingsState === 'ready'
        ? (run.findingsRunProjection?.triggeredCount ?? null)
        : null,
    unknownFindingCount:
      currentFindingsState === 'ready'
        ? (run.findingsRunProjection?.unknownCount ?? null)
        : null,
    highFindingCount:
      currentFindingsState === 'ready'
        ? (run.findingsRunProjection?.highCount ?? null)
        : null,
    mediumFindingCount:
      currentFindingsState === 'ready'
        ? (run.findingsRunProjection?.mediumCount ?? null)
        : null,
  };
  if (!projection)
    return {
      runId: run.canonicalRunId,
      createdAt: run.createdAt.toISOString(),
      processingState: state(null, processing, current),
      processingErrorCode: processing?.lastErrorCode ?? null,
      filesProcessingState: filesState,
      filesProcessingErrorCode: filesProcessing?.lastErrorCode ?? null,
      filesCompleteness: run.fileRunProjection?.completeness ?? null,
      filesCompletenessReason:
        run.fileRunProjection?.completenessReason ??
        (filesState === 'ready' ? null : `files_${filesState}`),
      filesChanged:
        filesState === 'ready' ? (run.fileRunProjection?.fileCount ?? 0) : null,
      ...findingsSummary,
      projection: null,
    };
  const page = <T, R>(
    values: T[],
    map: (value: T) => R,
    cursor: (value: T) => object,
  ) => {
    const visible = values.slice(0, input.childLimit);
    return {
      items: visible.map(map),
      nextCursor:
        values.length > input.childLimit && visible.at(-1)
          ? encode(cursor(visible.at(-1)!))
          : null,
    };
  };
  return {
    runId: run.canonicalRunId,
    createdAt: run.createdAt.toISOString(),
    processingState: state(projection, processing, current),
    processingErrorCode: processing?.lastErrorCode ?? null,
    filesProcessingState: filesState,
    filesProcessingErrorCode: filesProcessing?.lastErrorCode ?? null,
    filesCompleteness: run.fileRunProjection?.completeness ?? null,
    filesCompletenessReason:
      run.fileRunProjection?.completenessReason ??
      (filesState === 'ready' ? null : `files_${filesState}`),
    ...findingsSummary,
    projection: {
      projectorName: projection.projectorName,
      projectorVersion: projection.projectorVersion,
      source: {
        eventCount: projection.sourceEventCount,
        maxSequence: number(projection.sourceMaxSequence),
        fingerprint: projection.sourceFingerprint,
      },
      evidenceCompleteness: projection.evidenceCompleteness,
      completenessReasons: projection.completenessReasons,
      observedOutcome: projection.observedOutcome,
      durationMs: number(projection.durationMs),
      commandCount: projection.commandCount,
      toolCallCount: projection.toolCallCount,
      testObservationState: projection.testObservationState,
      testCounts: projection.testCounts,
      tokenAggregates: projection.tokenAggregates,
      filesChanged:
        filesState === 'ready' ? (run.fileRunProjection?.fileCount ?? 0) : null,
      commands: page(
        projection.commands,
        (item) => ({
          operationId: item.operationId,
          startEventId: item.startEventId,
          startSequence: number(item.startSequence),
          finishEventId: item.finishEventId,
          finishSequence: number(item.finishSequence),
          state: item.state,
          outcome: item.outcome,
          durationMs: number(item.durationMs),
          exitCode: number(item.exitCode),
          terminationSignal: item.terminationSignal,
          commandCapture: item.commandCapture,
          workingDirectory: item.workingDirectory,
          stdoutCapture: item.stdoutCapture,
          stderrCapture: item.stderrCapture,
        }),
        (item) => ({ id: item.operationId }),
      ),
      tools: page(
        projection.tools,
        (item) => ({
          operationId: item.operationId,
          startEventId: item.startEventId,
          startSequence: number(item.startSequence),
          finishEventId: item.finishEventId,
          finishSequence: number(item.finishSequence),
          state: item.state,
          toolName: item.toolName,
          outcome: item.outcome,
          durationMs: number(item.durationMs),
          inputCapture: item.inputCapture,
          outputCapture: item.outputCapture,
        }),
        (item) => ({ id: item.operationId }),
      ),
      tests: page(
        projection.tests,
        (item) => ({
          testRunId: item.testRunId,
          sourceEventId: item.sourceEventId,
          sourceSequence: Number(item.sourceSequence),
          commandId: item.commandId,
          framework: item.framework,
          outcome: item.outcome,
          counts: item.counts,
          durationMs: number(item.durationMs),
          reportArtifactId: item.reportArtifactId,
        }),
        (item) => ({
          id: item.testRunId,
          sequence: Number(item.sourceSequence),
        }),
      ),
      gitSnapshots: page(
        projection.gitSnapshots,
        (item) => ({
          snapshotId: item.snapshotId,
          sourceEventId: item.sourceEventId,
          sourceSequence: Number(item.sourceSequence),
          phase: item.phase,
          headCommit: item.headCommit,
          isDirty: item.isDirty,
          stagedFileCount: number(item.stagedFileCount),
          unstagedFileCount: number(item.unstagedFileCount),
          untrackedFileCount: number(item.untrackedFileCount),
          statusArtifactId: item.statusArtifactId,
        }),
        (item) => ({
          id: item.snapshotId,
          sequence: Number(item.sourceSequence),
        }),
      ),
      gitDiffs: page(
        projection.gitDiffs,
        (item) => ({
          diffId: item.diffId,
          sourceEventId: item.sourceEventId,
          sourceSequence: Number(item.sourceSequence),
          fromSnapshotId: item.fromSnapshotId,
          toSnapshotId: item.toSnapshotId,
          filesChanged: number(item.filesChanged),
          linesAdded: number(item.linesAdded),
          linesDeleted: number(item.linesDeleted),
          diffArtifactId: item.diffArtifactId,
          fileListArtifactId: item.fileListArtifactId,
        }),
        (item) => ({ id: item.diffId, sequence: Number(item.sourceSequence) }),
      ),
      errors: page(
        projection.errors,
        (item) => ({
          errorId: item.errorId,
          sourceEventId: item.sourceEventId,
          sourceSequence: Number(item.sourceSequence),
          category: item.category,
          code: item.code,
          retryable: item.retryable,
          messageCapture: item.messageCapture,
          relatedOperationId: item.relatedOperationId,
          relatedEventId: item.relatedEventId,
        }),
        (item) => ({ id: item.errorId, sequence: Number(item.sourceSequence) }),
      ),
      usage: page(
        projection.usage,
        (item) => ({
          sourceEventId: item.sourceEventId,
          sourceSequence: Number(item.sourceSequence),
          provider: item.provider,
          model: item.model,
          measurements: item.measurements,
        }),
        (item) => ({
          id: item.sourceEventId,
          sequence: Number(item.sourceSequence),
        }),
      ),
    },
  };
}

export async function getCoreRunDetail(
  client: DatabaseClient,
  input: RunDetailInput,
  hooks: QueryConsistencyHooks = {},
) {
  return client.$transaction(
    (transaction) => getCoreRunDetailInSnapshot(transaction, input, hooks),
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

export interface FindingListInput {
  organizationId: string;
  repositoryId: string;
  canonicalRunId: string;
  limit: number;
  cursor?: string;
}

function findingCursor(value: string | undefined): number | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    if (
      typeof parsed.catalogOrder !== 'number' ||
      !Number.isSafeInteger(parsed.catalogOrder) ||
      parsed.catalogOrder < 0
    )
      throw new Error();
    return parsed.catalogOrder;
  } catch {
    throw new TypeError('Invalid finding pagination cursor.');
  }
}

/** Tenant-safe current catalog pagination. Wrong-tenant and missing runs both return null. */
export async function listFindings(
  client: DatabaseClient,
  input: FindingListInput,
  hooks: QueryConsistencyHooks = {},
) {
  bounded(input.limit, 100);
  const cursor = findingCursor(input.cursor);
  return client.$transaction(
    async (transaction) => {
      const run = await transaction.run.findFirst({
        where: {
          organizationId: input.organizationId,
          repositoryId: input.repositoryId,
          canonicalRunId: input.canonicalRunId,
        },
        select: {
          id: true,
          findingsRunProjection: true,
          processingStates: {
            where: { projectorName: FINDINGS_PROJECTOR_NAME },
            take: 1,
          },
        },
      });
      if (!run) return null;
      await hooks.afterBaseRead?.();
      const processing = run.processingStates[0] ?? null;
      const processingState = await findingsState(
        transaction,
        input.organizationId,
        run.id,
        run.findingsRunProjection,
        processing,
      );
      if (processingState !== 'ready' || !run.findingsRunProjection)
        return {
          processingState,
          processingErrorCode: processing?.lastErrorCode ?? null,
          deterministicOutcome: null,
          coverage: null,
          items: [],
          nextCursor: null,
        };
      const rows = await transaction.findingRuleResult.findMany({
        where: {
          organizationId: input.organizationId,
          runId: run.id,
          ...(cursor === null ? {} : { catalogOrder: { gt: cursor } }),
        },
        orderBy: { catalogOrder: 'asc' },
        take: input.limit + 1,
        include: {
          references: {
            orderBy: { ordinal: 'asc' },
            include: {
              event: { select: { canonicalEventId: true } },
              artifactDeclaration: { select: { canonicalArtifactId: true } },
            },
          },
        },
      });
      const visible = rows.slice(0, input.limit);
      return {
        processingState,
        processingErrorCode: null,
        deterministicOutcome: run.findingsRunProjection.deterministicOutcome,
        coverage: run.findingsRunProjection.coverage,
        items: visible.map((row) => ({
          resultKey: row.resultKey,
          catalogOrder: row.catalogOrder,
          ruleId: row.ruleId,
          ruleVersion: row.ruleVersion,
          severity: row.severity,
          outcome: row.outcome,
          coverage: row.coverage,
          reasonCodes: row.reasonCodes,
          explanation: row.explanation,
          matchCount: row.matchCount,
          matches: row.matches,
          matchesTruncated: row.matchesTruncated,
          referencesTruncated: row.referencesTruncated,
          references: row.references.map((reference) => ({
            ordinal: reference.ordinal,
            eventId: reference.event.canonicalEventId,
            artifactId:
              reference.artifactDeclaration?.canonicalArtifactId ?? null,
            eventArtifactPointer: reference.eventArtifactPointer,
            jsonPointer: reference.jsonPointer,
            fileOrdinal: reference.fileOrdinal,
            entryId: reference.entryId,
          })),
        })),
        nextCursor:
          rows.length > input.limit && visible.at(-1)
            ? encode({ catalogOrder: visible.at(-1)!.catalogOrder })
            : null,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}
