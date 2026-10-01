import {
  CORE_PROJECTOR_NAME,
  CORE_PROJECTOR_VERSION,
} from './core-projector.js';
import type { DatabaseClient } from './client.js';

export type QueryProcessingState =
  'processing' | 'stale' | 'ready' | 'incomplete' | 'failed';

export interface RunListInput {
  organizationId: string;
  repositoryId: string;
  limit: number;
  cursor?: string;
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

async function currentSource(client: DatabaseClient, runId: string) {
  const value = await client.evidenceEvent.aggregate({
    where: { runId },
    _count: { _all: true },
    _max: { sequence: true },
  });
  return { count: value._count._all, maxSequence: value._max.sequence };
}

export async function listCoreRuns(
  client: DatabaseClient,
  input: RunListInput,
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
      processingStates: {
        where: { projectorName: CORE_PROJECTOR_NAME },
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
  const hasMore = runs.length > input.limit;
  const page = runs.slice(0, input.limit);
  const items = await Promise.all(
    page.map(async (run) => {
      const processing = run.processingStates[0] ?? null;
      const current = await currentSource(client, run.id);
      return {
        runId: run.canonicalRunId,
        createdAt: run.createdAt.toISOString(),
        processingState: state(run.coreRunProjection, processing, current),
        processingErrorCode: processing?.lastErrorCode ?? null,
        evidenceCompleteness:
          run.coreRunProjection?.evidenceCompleteness ?? null,
        observedOutcome: run.coreRunProjection?.observedOutcome ?? null,
        durationMs: number(run.coreRunProjection?.durationMs ?? null),
        commandCount: run.coreRunProjection?.commandCount ?? null,
        toolCallCount: run.coreRunProjection?.toolCallCount ?? null,
        testObservationState:
          run.coreRunProjection?.testObservationState ?? 'not_observed',
        filesChanged: number(run.coreRunProjection?.filesChanged ?? null),
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

export async function getCoreRunDetail(
  client: DatabaseClient,
  input: RunDetailInput,
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
      processingStates: {
        where: { projectorName: CORE_PROJECTOR_NAME },
        take: 1,
      },
    },
  });
  if (!run) return null;
  const projection = run.coreRunProjection;
  const processing = run.processingStates[0] ?? null;
  const current = await currentSource(client, run.id);
  if (!projection)
    return {
      runId: run.canonicalRunId,
      createdAt: run.createdAt.toISOString(),
      processingState: state(null, processing, current),
      processingErrorCode: processing?.lastErrorCode ?? null,
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
      filesChanged: number(projection.filesChanged),
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
