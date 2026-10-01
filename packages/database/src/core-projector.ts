import { createHash } from 'node:crypto';

import {
  EvidenceEventSchema,
  type EvidenceEvent,
  type TokenMeasurement,
} from '@blackbox/contracts';

export const CORE_PROJECTOR_NAME = 'core';
export const CORE_PROJECTOR_VERSION = 1;

export class ProjectionLimitError extends Error {
  readonly code: 'event_limit_exceeded' | 'projected_child_limit_exceeded';

  constructor(code: ProjectionLimitError['code']) {
    super(code);
    this.name = 'ProjectionLimitError';
    this.code = code;
  }
}

export class InvalidCanonicalEventError extends Error {
  readonly code = 'invalid_canonical_event';

  constructor() {
    super('Stored canonical evidence could not be validated.');
    this.name = 'InvalidCanonicalEventError';
  }
}

export class ProjectionCancelledError extends Error {
  readonly code = 'projection_attempt_deadline_exceeded';

  constructor() {
    super('Core projection was cancelled before publication.');
    this.name = 'ProjectionCancelledError';
  }
}

export interface CoreProjectorLimits {
  maxEvents: number;
  maxProjectedChildren: number;
}

type EventRef = { eventId: string; sequence: number };
type OperationState = 'complete' | 'incomplete' | 'conflict';

export interface CommandProjection {
  operationId: string;
  start: EventRef | null;
  finish: EventRef | null;
  state: OperationState;
  outcome: string | null;
  durationMs: number | null;
  exitCode: number | null;
  terminationSignal: string | null;
  commandCapture: unknown | null;
  workingDirectory: unknown | null;
  stdoutCapture: unknown | null;
  stderrCapture: unknown | null;
}

export interface ToolProjection {
  operationId: string;
  start: EventRef | null;
  finish: EventRef | null;
  state: OperationState;
  toolName: string | null;
  outcome: string | null;
  durationMs: number | null;
  inputCapture: unknown | null;
  outputCapture: unknown | null;
}

export interface CoreProjectionSnapshot {
  projectorName: typeof CORE_PROJECTOR_NAME;
  projectorVersion: typeof CORE_PROJECTOR_VERSION;
  source: {
    eventCount: number;
    maxSequence: number | null;
    fingerprint: string;
  };
  run: {
    started: EventRef | null;
    finished: EventRef | null;
    adapter: string | null;
    provider: string | null;
    observedOutcome: string | null;
    durationMs: number | null;
    evidenceCompleteness: 'complete' | 'incomplete';
    completenessReasons: string[];
    commandCount: number | null;
    toolCallCount: number | null;
    testObservationState: 'not_observed' | 'observed';
    testCounts: Record<string, number | null>;
    tokenAggregates: Record<
      string,
      { reportedTotal: number | null; unavailableCount: number }
    >;
    filesChanged: number | null;
  };
  commands: CommandProjection[];
  tools: ToolProjection[];
  tests: Array<{
    testRunId: string;
    source: EventRef;
    commandId: string | null;
    framework: string;
    outcome: string;
    counts: unknown | null;
    durationMs: number | null;
    reportArtifactId: string | null;
  }>;
  gitSnapshots: Array<{
    snapshotId: string;
    source: EventRef;
    phase: string;
    headCommit: string | null;
    isDirty: boolean;
    stagedFileCount: number | null;
    unstagedFileCount: number | null;
    untrackedFileCount: number | null;
    statusArtifactId: string | null;
  }>;
  gitDiffs: Array<{
    diffId: string;
    source: EventRef;
    fromSnapshotId: string;
    toSnapshotId: string;
    filesChanged: number | null;
    linesAdded: number | null;
    linesDeleted: number | null;
    diffArtifactId: string;
    fileListArtifactId: string;
  }>;
  errors: Array<{
    errorId: string;
    source: EventRef;
    category: string;
    code: string;
    retryable: boolean | null;
    messageCapture: unknown;
    relatedOperationId: string | null;
    relatedEventId: string | null;
  }>;
  usage: Array<{
    source: EventRef;
    provider: string | null;
    model: string | null;
    measurements: unknown;
  }>;
}

function eventRef(event: EvidenceEvent): EventRef {
  return { eventId: event.eventId, sequence: event.sequence };
}

function fingerprint(events: EvidenceEvent[]): string {
  const hash = createHash('sha256');
  for (const event of events)
    hash.update(`${event.sequence}:${event.eventId}\n`);
  return hash.digest('hex');
}

function aggregateMeasurement(values: TokenMeasurement[]) {
  let total = 0n;
  let reported = 0;
  let unavailableCount = 0;
  for (const value of values) {
    if (value.state === 'reported') {
      total += BigInt(value.value);
      reported += 1;
    } else unavailableCount += 1;
  }
  const overflow = total > BigInt(Number.MAX_SAFE_INTEGER);
  return {
    value: {
      reportedTotal: reported === 0 || overflow ? null : Number(total),
      unavailableCount,
    },
    overflow,
  };
}

function uniqueById<T>(
  items: T[],
  id: (item: T) => string,
  reason: string,
  reasons: Set<string>,
): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const value = id(item);
    if (seen.has(value)) {
      reasons.add(reason);
      return false;
    }
    seen.add(value);
    return true;
  });
}

/** Deterministically rebuilds core v1 projections from validated canonical order. */
export function projectCoreEvents(
  rawEvents: readonly unknown[],
  limits: CoreProjectorLimits,
  shouldCancel: () => boolean = () => false,
): CoreProjectionSnapshot {
  if (
    !Number.isSafeInteger(limits.maxEvents) ||
    limits.maxEvents < 1 ||
    !Number.isSafeInteger(limits.maxProjectedChildren) ||
    limits.maxProjectedChildren < 1
  ) {
    throw new TypeError('Projection limits must be positive safe integers.');
  }
  if (rawEvents.length > limits.maxEvents)
    throw new ProjectionLimitError('event_limit_exceeded');

  if (shouldCancel()) throw new ProjectionCancelledError();
  let events: EvidenceEvent[];
  try {
    events = [];
    for (const value of rawEvents) {
      if (shouldCancel()) throw new ProjectionCancelledError();
      events.push(EvidenceEventSchema.parse(value));
    }
  } catch {
    if (shouldCancel()) throw new ProjectionCancelledError();
    throw new InvalidCanonicalEventError();
  }
  events.sort(
    (left, right) =>
      left.sequence - right.sequence ||
      left.eventId.localeCompare(right.eventId),
  );
  for (let index = 1; index < events.length; index += 1) {
    if (events[index - 1]!.sequence === events[index]!.sequence)
      throw new InvalidCanonicalEventError();
  }

  const reasons = new Set<string>();
  const runStarts = events.filter((event) => event.kind === 'run.started');
  const runFinishes = events.filter((event) => event.kind === 'run.finished');
  if (runStarts.length !== 1)
    reasons.add(
      runStarts.length === 0 ? 'run_start_missing' : 'run_start_conflict',
    );
  if (runFinishes.length !== 1)
    reasons.add(
      runFinishes.length === 0 ? 'run_finish_missing' : 'run_finish_conflict',
    );

  const commandGroups = new Map<
    string,
    { starts: EvidenceEvent[]; finishes: EvidenceEvent[] }
  >();
  const toolGroups = new Map<
    string,
    { starts: EvidenceEvent[]; finishes: EvidenceEvent[] }
  >();
  for (const event of events) {
    if (shouldCancel()) throw new ProjectionCancelledError();
    if (event.kind === 'command.started' || event.kind === 'command.finished') {
      const group = commandGroups.get(event.payload.commandId) ?? {
        starts: [],
        finishes: [],
      };
      (event.kind === 'command.started' ? group.starts : group.finishes).push(
        event,
      );
      commandGroups.set(event.payload.commandId, group);
    }
    if (
      event.kind === 'tool.call.started' ||
      event.kind === 'tool.call.finished'
    ) {
      const group = toolGroups.get(event.payload.toolCallId) ?? {
        starts: [],
        finishes: [],
      };
      (event.kind === 'tool.call.started' ? group.starts : group.finishes).push(
        event,
      );
      toolGroups.set(event.payload.toolCallId, group);
    }
  }

  const commands = [...commandGroups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([operationId, group]) => {
      const start = group.starts[0];
      const finish = group.finishes[0];
      const conflict = group.starts.length > 1 || group.finishes.length > 1;
      if (conflict) reasons.add('command_conflict');
      else if (!start || !finish) reasons.add('command_incomplete');
      return {
        operationId,
        start: start ? eventRef(start) : null,
        finish: finish ? eventRef(finish) : null,
        state: conflict
          ? 'conflict'
          : start && finish
            ? 'complete'
            : 'incomplete',
        outcome:
          finish?.kind === 'command.finished' ? finish.payload.outcome : null,
        durationMs:
          finish?.kind === 'command.finished'
            ? (finish.payload.durationMs ?? null)
            : null,
        exitCode:
          finish?.kind === 'command.finished'
            ? (finish.payload.exitCode ?? null)
            : null,
        terminationSignal:
          finish?.kind === 'command.finished'
            ? (finish.payload.terminationSignal ?? null)
            : null,
        commandCapture:
          start?.kind === 'command.started' ? start.payload.command : null,
        workingDirectory:
          start?.kind === 'command.started'
            ? start.payload.workingDirectory
            : null,
        stdoutCapture:
          finish?.kind === 'command.finished' ? finish.payload.stdout : null,
        stderrCapture:
          finish?.kind === 'command.finished' ? finish.payload.stderr : null,
      } satisfies CommandProjection;
    });

  const tools = [...toolGroups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([operationId, group]) => {
      const start = group.starts[0];
      const finish = group.finishes[0];
      const conflict =
        group.starts.length > 1 ||
        group.finishes.length > 1 ||
        (start?.kind === 'tool.call.started' &&
          finish?.kind === 'tool.call.finished' &&
          start.payload.toolName !== finish.payload.toolName);
      if (conflict) reasons.add('tool_conflict');
      else if (!start || !finish) reasons.add('tool_incomplete');
      return {
        operationId,
        start: start ? eventRef(start) : null,
        finish: finish ? eventRef(finish) : null,
        state: conflict
          ? 'conflict'
          : start && finish
            ? 'complete'
            : 'incomplete',
        toolName:
          start?.kind === 'tool.call.started'
            ? start.payload.toolName
            : finish?.kind === 'tool.call.finished'
              ? finish.payload.toolName
              : null,
        outcome:
          finish?.kind === 'tool.call.finished' ? finish.payload.outcome : null,
        durationMs:
          finish?.kind === 'tool.call.finished'
            ? (finish.payload.durationMs ?? null)
            : null,
        inputCapture:
          start?.kind === 'tool.call.started' ? start.payload.input : null,
        outputCapture:
          finish?.kind === 'tool.call.finished' ? finish.payload.output : null,
      } satisfies ToolProjection;
    });

  const crossKindOperationIds = new Set(
    [...commandGroups.keys()].filter((operationId) =>
      toolGroups.has(operationId),
    ),
  );
  if (crossKindOperationIds.size > 0) {
    reasons.add('operation_identity_conflict');
    for (const command of commands) {
      if (crossKindOperationIds.has(command.operationId))
        command.state = 'conflict';
    }
    for (const tool of tools) {
      if (crossKindOperationIds.has(tool.operationId)) tool.state = 'conflict';
    }
  }

  const tests = uniqueById(
    events
      .filter((event) => event.kind === 'test.run.finished')
      .map((event) => ({
        testRunId: event.payload.testRunId,
        source: eventRef(event),
        commandId: event.payload.commandId ?? null,
        framework: event.payload.framework,
        outcome: event.payload.outcome,
        counts: event.payload.counts ?? null,
        durationMs: event.payload.durationMs ?? null,
        reportArtifactId: event.payload.reportArtifact?.artifactId ?? null,
      })),
    (item) => item.testRunId,
    'test_identity_conflict',
    reasons,
  );
  const gitSnapshots = uniqueById(
    events
      .filter((event) => event.kind === 'git.snapshot.captured')
      .map((event) => ({
        snapshotId: event.payload.snapshotId,
        source: eventRef(event),
        phase: event.payload.phase,
        headCommit: event.payload.headCommit ?? null,
        isDirty: event.payload.isDirty,
        stagedFileCount: event.payload.stagedFileCount ?? null,
        unstagedFileCount: event.payload.unstagedFileCount ?? null,
        untrackedFileCount: event.payload.untrackedFileCount ?? null,
        statusArtifactId: event.payload.statusArtifact?.artifactId ?? null,
      })),
    (item) => item.snapshotId,
    'git_snapshot_identity_conflict',
    reasons,
  );
  const gitDiffs = uniqueById(
    events
      .filter((event) => event.kind === 'git.diff.captured')
      .map((event) => ({
        diffId: event.payload.diffId,
        source: eventRef(event),
        fromSnapshotId: event.payload.fromSnapshotId,
        toSnapshotId: event.payload.toSnapshotId,
        filesChanged: event.payload.filesChanged ?? null,
        linesAdded: event.payload.linesAdded ?? null,
        linesDeleted: event.payload.linesDeleted ?? null,
        diffArtifactId: event.payload.diffArtifact.artifactId,
        fileListArtifactId: event.payload.fileListArtifact.artifactId,
      })),
    (item) => item.diffId,
    'git_diff_identity_conflict',
    reasons,
  );
  const errors = uniqueById(
    events
      .filter((event) => event.kind === 'error.observed')
      .map((event) => ({
        errorId: event.payload.errorId,
        source: eventRef(event),
        category: event.payload.category,
        code: event.payload.code,
        retryable: event.payload.retryable ?? null,
        messageCapture: event.payload.message,
        relatedOperationId: event.payload.relatedOperationId ?? null,
        relatedEventId: event.payload.relatedEventId ?? null,
      })),
    (item) => item.errorId,
    'error_identity_conflict',
    reasons,
  );
  const usageEvents = events.filter((event) => event.kind === 'usage.observed');
  const usage = usageEvents.map((event) => ({
    source: eventRef(event),
    provider: event.payload.provider ?? null,
    model: event.payload.model ?? null,
    measurements: event.payload,
  }));
  const tokenKeys = [
    'inputTokens',
    'outputTokens',
    'cachedInputTokens',
    'reasoningTokens',
    'totalTokens',
  ] as const;
  const tokenResults = tokenKeys.map(
    (key) =>
      [
        key,
        aggregateMeasurement(usageEvents.map((event) => event.payload[key])),
      ] as const,
  );
  const tokenAggregates = Object.fromEntries(
    tokenResults.map(([key, result]) => [key, result.value]),
  );
  if (tokenResults.some(([, result]) => result.overflow))
    reasons.add('token_aggregate_overflow');
  if (usageEvents.length === 0) reasons.add('usage_not_observed');
  else if (
    usageEvents.some((event) =>
      tokenKeys.some((key) => event.payload[key].state === 'unavailable'),
    )
  )
    reasons.add('usage_measurement_unavailable');

  const eventIds = new Set(events.map((event) => event.eventId));
  const snapshotIds = new Set(
    gitSnapshots.map((snapshot) => snapshot.snapshotId),
  );
  if (
    tests.some(
      (test) => test.commandId !== null && !commandGroups.has(test.commandId),
    )
  )
    reasons.add('test_command_missing');
  if (
    gitDiffs.some(
      (diff) =>
        !snapshotIds.has(diff.fromSnapshotId) ||
        !snapshotIds.has(diff.toSnapshotId),
    )
  )
    reasons.add('git_snapshot_reference_missing');
  if (
    errors.some(
      (error) =>
        error.relatedEventId !== null && !eventIds.has(error.relatedEventId),
    )
  )
    reasons.add('error_event_reference_missing');

  const childCount =
    commands.length +
    tools.length +
    tests.length +
    gitSnapshots.length +
    gitDiffs.length +
    errors.length +
    usage.length;
  if (childCount > limits.maxProjectedChildren)
    throw new ProjectionLimitError('projected_child_limit_exceeded');
  if (shouldCancel()) throw new ProjectionCancelledError();
  const testCounts: Record<string, number | null> = {};
  for (const key of ['total', 'passed', 'failed', 'skipped', 'todo'] as const) {
    const values = tests
      .map((test) => (test.counts as Record<string, number> | null)?.[key])
      .filter((value): value is number => value !== undefined);
    const sum = values.reduce((total, value) => total + BigInt(value), 0n);
    testCounts[key] =
      values.length === tests.length &&
      tests.length > 0 &&
      sum <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(sum)
        : null;
    if (sum > BigInt(Number.MAX_SAFE_INTEGER))
      reasons.add('test_count_overflow');
    if (tests.length > 0 && values.length !== tests.length)
      reasons.add('test_counts_incomplete');
  }
  const fileCounts = gitDiffs.map((diff) => diff.filesChanged);
  const filesChanged = fileCounts.length === 1 ? (fileCounts[0] ?? null) : null;
  if (gitDiffs.length === 0) reasons.add('files_changed_not_observed');
  else if (filesChanged === null) reasons.add('files_changed_unknown');
  const start =
    runStarts.length === 1 && runStarts[0]?.kind === 'run.started'
      ? runStarts[0]
      : null;
  const finish =
    runFinishes.length === 1 && runFinishes[0]?.kind === 'run.finished'
      ? runFinishes[0]
      : null;
  if (finish && finish.payload.durationMs === undefined)
    reasons.add('run_duration_unknown');
  const completenessReasons = [...reasons].sort();

  return {
    projectorName: CORE_PROJECTOR_NAME,
    projectorVersion: CORE_PROJECTOR_VERSION,
    source: {
      eventCount: events.length,
      maxSequence: events.at(-1)?.sequence ?? null,
      fingerprint: fingerprint(events),
    },
    run: {
      started: start ? eventRef(start) : null,
      finished: finish ? eventRef(finish) : null,
      adapter: start?.payload.adapter ?? null,
      provider: start?.payload.provider ?? null,
      observedOutcome: finish?.payload.outcome ?? null,
      durationMs: finish?.payload.durationMs ?? null,
      evidenceCompleteness:
        completenessReasons.length === 0 ? 'complete' : 'incomplete',
      completenessReasons,
      commandCount: commands.every((item) => item.state !== 'conflict')
        ? commands.length
        : null,
      toolCallCount: tools.every((item) => item.state !== 'conflict')
        ? tools.length
        : null,
      testObservationState: tests.length === 0 ? 'not_observed' : 'observed',
      testCounts,
      tokenAggregates,
      filesChanged,
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
