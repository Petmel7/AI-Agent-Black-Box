import { describe, expect, it } from 'vitest';
import {
  InvalidCanonicalEventError,
  ProjectionCancelledError,
  ProjectionLimitError,
  projectCoreEvents,
} from './core-projector.js';

const runId = '00000000-0000-4000-8000-000000000001';
const ids = Array.from(
  { length: 30 },
  (_, index) =>
    `00000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}`,
);
const omitted = { state: 'omitted' };

function event(sequence: number, kind: string, payload: unknown) {
  return {
    schemaVersion: 1,
    eventId: ids[sequence],
    runId,
    sequence,
    kind,
    observedAt: `2026-10-01T00:00:${String(sequence).padStart(2, '0')}.000Z`,
    source: { component: 'collector' },
    payload,
  };
}

function completeEvents() {
  const commandId = ids[20]!;
  const toolCallId = ids[21]!;
  const before = ids[22]!;
  const after = ids[23]!;
  const artifact = (artifactId: string, kind: string) => ({
    artifactId,
    kind,
    mediaType: 'application/json',
    byteLength: 2,
    sha256: 'a'.repeat(64),
    redaction: { applied: false },
  });
  return [
    event(0, 'run.started', { adapter: 'codex-jsonl', provider: 'codex' }),
    event(1, 'command.started', {
      commandId,
      command: omitted,
      workingDirectory: omitted,
    }),
    event(2, 'tool.call.started', {
      toolCallId,
      toolName: 'shell',
      input: omitted,
    }),
    event(3, 'tool.call.finished', {
      toolCallId,
      toolName: 'shell',
      outcome: 'succeeded',
      durationMs: 3,
      output: omitted,
    }),
    event(4, 'command.finished', {
      commandId,
      outcome: 'succeeded',
      exitCode: 0,
      durationMs: 4,
      stdout: omitted,
      stderr: omitted,
    }),
    event(5, 'test.run.finished', {
      testRunId: ids[24],
      commandId,
      framework: 'vitest',
      outcome: 'passed',
      counts: { total: 2, passed: 2, failed: 0, skipped: 0, todo: 0 },
      reportArtifact: artifact(ids[25]!, 'test-report'),
    }),
    event(6, 'git.snapshot.captured', {
      snapshotId: before,
      phase: 'before',
      headCommit: 'a'.repeat(40),
      isDirty: false,
      statusArtifact: artifact(ids[26]!, 'git-status'),
    }),
    event(7, 'git.snapshot.captured', {
      snapshotId: after,
      phase: 'after',
      headCommit: 'b'.repeat(40),
      isDirty: true,
      stagedFileCount: 1,
    }),
    event(8, 'git.diff.captured', {
      diffId: ids[27],
      fromSnapshotId: before,
      toSnapshotId: after,
      filesChanged: 1,
      linesAdded: 3,
      linesDeleted: 1,
      diffArtifact: artifact(ids[28]!, 'git-diff'),
      fileListArtifact: artifact(ids[29]!, 'git-file-list'),
    }),
    event(9, 'error.observed', {
      errorId: ids[19],
      category: 'tool',
      code: 'retry',
      retryable: true,
      message: omitted,
      relatedOperationId: toolCallId,
    }),
    event(10, 'usage.observed', {
      provider: 'openai',
      model: 'gpt',
      inputTokens: { state: 'reported', value: 10 },
      outputTokens: { state: 'reported', value: 5 },
      cachedInputTokens: { state: 'reported', value: 0 },
      reasoningTokens: { state: 'reported', value: 2 },
      totalTokens: { state: 'reported', value: 17 },
    }),
    event(11, 'run.finished', { outcome: 'succeeded', durationMs: 100 }),
  ];
}

describe('core projector v1', () => {
  it('projects every canonical kind conservatively and retains source references', () => {
    const result = projectCoreEvents(completeEvents().reverse(), {
      maxEvents: 100,
      maxProjectedChildren: 100,
    });
    expect(result.run).toMatchObject({
      observedOutcome: 'succeeded',
      durationMs: 100,
      evidenceCompleteness: 'complete',
      commandCount: 1,
      toolCallCount: 1,
      testObservationState: 'observed',
      filesChanged: 1,
    });
    expect(result.commands[0]).toMatchObject({
      state: 'complete',
      exitCode: 0,
      start: { sequence: 1 },
      finish: { sequence: 4 },
    });
    expect(result.tools[0]).toMatchObject({
      state: 'complete',
      toolName: 'shell',
    });
    expect(result.tests[0]?.reportArtifactId).toBe(ids[25]);
    expect(result.gitDiffs[0]).toMatchObject({
      diffArtifactId: ids[28],
      fileListArtifactId: ids[29],
    });
    expect(result.errors[0]?.source.sequence).toBe(9);
    expect(result.run.tokenAggregates).toMatchObject({
      inputTokens: { reportedTotal: 10, unavailableCount: 0 },
      totalTokens: { reportedTotal: 17, unavailableCount: 0 },
    });
  });

  it('is deterministic across input iteration order and replay', () => {
    const left = projectCoreEvents(completeEvents(), {
      maxEvents: 100,
      maxProjectedChildren: 100,
    });
    const right = projectCoreEvents(
      [...completeEvents()].sort(() => -1),
      { maxEvents: 100, maxProjectedChildren: 100 },
    );
    expect(right).toEqual(left);
  });

  it('marks missing halves and conflicting operations and terminals incomplete', () => {
    const base = completeEvents();
    const commandStart = base[1]!;
    const duplicate = {
      ...commandStart,
      eventId: '00000000-0000-4000-8000-000000000099',
      sequence: 12,
      observedAt: '2026-10-01T00:00:12.000Z',
    };
    const result = projectCoreEvents(
      [
        ...base.filter((value) => value.kind !== 'command.finished'),
        duplicate,
        {
          ...base.at(-1)!,
          eventId: '00000000-0000-4000-8000-000000000098',
          sequence: 13,
          observedAt: '2026-10-01T00:00:13.000Z',
        },
      ],
      { maxEvents: 100, maxProjectedChildren: 100 },
    );
    expect(result.commands[0]?.state).toBe('conflict');
    expect(result.run.observedOutcome).toBeNull();
    expect(result.run.completenessReasons).toEqual(
      expect.arrayContaining(['command_conflict', 'run_finish_conflict']),
    );
  });

  it('reports tests as not observed and never invents token totals', () => {
    const result = projectCoreEvents(
      completeEvents().filter(
        (value) =>
          value.kind !== 'test.run.finished' && value.kind !== 'usage.observed',
      ),
      { maxEvents: 100, maxProjectedChildren: 100 },
    );
    expect(result.run.testObservationState).toBe('not_observed');
    expect(result.run.testCounts.total).toBeNull();
    expect(result.run.tokenAggregates.totalTokens).toEqual({
      reportedTotal: null,
      unavailableCount: 0,
    });
  });

  it('fails safely for unsupported stored schema and configured ceilings', () => {
    expect(() =>
      projectCoreEvents([{ ...completeEvents()[0], schemaVersion: 2 }], {
        maxEvents: 100,
        maxProjectedChildren: 100,
      }),
    ).toThrow(InvalidCanonicalEventError);
    expect(() =>
      projectCoreEvents(completeEvents(), {
        maxEvents: 2,
        maxProjectedChildren: 100,
      }),
    ).toThrow(new ProjectionLimitError('event_limit_exceeded'));
    expect(() =>
      projectCoreEvents(completeEvents(), {
        maxEvents: 100,
        maxProjectedChildren: 2,
      }),
    ).toThrow(new ProjectionLimitError('projected_child_limit_exceeded'));
  });

  it('accepts sequence gaps and incorporates a later-arriving lower sequence', () => {
    const initial = [
      event(0, 'run.started', { adapter: 'codex-jsonl', provider: 'codex' }),
      event(10, 'run.finished', { outcome: 'succeeded', durationMs: 10 }),
    ];
    const before = projectCoreEvents(initial, {
      maxEvents: 10,
      maxProjectedChildren: 10,
    });
    const after = projectCoreEvents(
      [
        ...initial,
        event(5, 'error.observed', {
          errorId: ids[19],
          category: 'agent',
          code: 'late',
          message: omitted,
        }),
      ],
      { maxEvents: 10, maxProjectedChildren: 10 },
    );
    expect(before.source.maxSequence).toBe(10);
    expect(after.source).toMatchObject({ eventCount: 3, maxSequence: 10 });
    expect(after.source.fingerprint).not.toBe(before.source.fingerprint);
    expect(after.errors[0]?.source.sequence).toBe(5);
  });

  it('cooperatively cancels projection work at the absolute attempt deadline', () => {
    let checks = 0;
    expect(() =>
      projectCoreEvents(
        completeEvents(),
        { maxEvents: 100, maxProjectedChildren: 100 },
        () => ++checks > 3,
      ),
    ).toThrow(ProjectionCancelledError);
  });
});
