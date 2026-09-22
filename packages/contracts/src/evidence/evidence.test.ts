import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  ArtifactReferenceSchema,
  ContentCaptureSchema,
  EvidenceBatchSchema,
  EvidenceEventSchema,
  EvidenceReferenceSchema,
  MAX_BATCH_EVENTS,
  MAX_CONTENT_EXCERPT_LENGTH,
  MAX_IDENTIFIER_LENGTH,
  MAX_NATIVE_ID_LENGTH,
  type EvidenceEvent,
} from './index.js';

const RUN_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_RUN_ID = '00000000-0000-4000-8000-000000000002';
const EVENT_ID = '00000000-0000-4000-8000-000000000003';
const BATCH_ID = '00000000-0000-4000-8000-000000000004';
const OPERATION_ID = '00000000-0000-4000-8000-000000000005';
const ARTIFACT_ID = '00000000-0000-4000-8000-000000000006';
const SECOND_OPERATION_ID = '00000000-0000-4000-8000-000000000007';
const SHA256 = 'a'.repeat(64);
const TIMESTAMP = '2026-09-22T12:00:00.000Z';

const omitted = { state: 'omitted' as const };
const unavailable = {
  state: 'unavailable' as const,
  reason: 'not-exposed' as const,
};
const artifact = {
  artifactId: ARTIFACT_ID,
  kind: 'command.stdout',
  mediaType: 'text/plain',
  byteLength: 12,
  sha256: SHA256,
  redaction: { applied: true, rulesetVersion: 'rules-v1' },
  characterEncoding: 'utf-8',
};
const captured = {
  state: 'captured' as const,
  excerpt: 'safe excerpt',
  artifact,
  truncated: true,
  redaction: { applied: true, rulesetVersion: 'rules-v1' },
};

const envelope = (
  sequence: number,
  eventId = `00000000-0000-4000-8000-${String(sequence + 3).padStart(12, '0')}`,
) => ({
  schemaVersion: 1 as const,
  eventId,
  runId: RUN_ID,
  sequence,
  observedAt: TIMESTAMP,
  occurredAt: '2026-09-22T11:59:59.000Z',
  source: {
    component: 'agent-adapter' as const,
    provider: 'codex',
    nativeSessionId: 'session-1',
    nativeEventId: 'native-event-1',
  },
  correlation: {
    parentEventId: '00000000-0000-4000-8000-000000000008',
    traceId: '1'.repeat(32),
    spanId: '2'.repeat(16),
  },
});

const validEvents = [
  {
    ...envelope(0),
    kind: 'run.started',
    payload: {
      adapter: 'codex-adapter',
      provider: 'codex',
      taskDescription: captured,
    },
  },
  {
    ...envelope(1),
    kind: 'run.finished',
    payload: { outcome: 'succeeded', durationMs: 250 },
  },
  {
    ...envelope(2),
    kind: 'tool.call.started',
    payload: {
      toolCallId: OPERATION_ID,
      toolName: 'exec_command',
      input: omitted,
    },
  },
  {
    ...envelope(3),
    kind: 'tool.call.finished',
    payload: {
      toolCallId: OPERATION_ID,
      toolName: 'exec_command',
      outcome: 'succeeded',
      durationMs: 25,
      output: captured,
    },
  },
  {
    ...envelope(4),
    kind: 'command.started',
    payload: {
      commandId: OPERATION_ID,
      command: captured,
      workingDirectory: omitted,
    },
  },
  {
    ...envelope(5),
    kind: 'command.finished',
    payload: {
      commandId: OPERATION_ID,
      outcome: 'failed',
      exitCode: 1,
      terminationSignal: 'SIGTERM',
      durationMs: 100,
      stdout: captured,
      stderr: unavailable,
    },
  },
  {
    ...envelope(6),
    kind: 'test.run.finished',
    payload: {
      testRunId: SECOND_OPERATION_ID,
      commandId: OPERATION_ID,
      framework: 'vitest',
      outcome: 'passed',
      counts: { total: 2, passed: 2, failed: 0, skipped: 0 },
      durationMs: 75,
      reportArtifact: artifact,
    },
  },
  {
    ...envelope(7),
    kind: 'git.snapshot.captured',
    payload: {
      snapshotId: OPERATION_ID,
      phase: 'before',
      headCommit: 'b'.repeat(40),
      isDirty: true,
      stagedFileCount: 1,
      unstagedFileCount: 2,
      untrackedFileCount: 3,
      statusArtifact: artifact,
    },
  },
  {
    ...envelope(8),
    kind: 'git.diff.captured',
    payload: {
      diffId: '00000000-0000-4000-8000-000000000009',
      fromSnapshotId: OPERATION_ID,
      toSnapshotId: SECOND_OPERATION_ID,
      filesChanged: 2,
      linesAdded: 10,
      linesDeleted: 3,
      diffArtifact: artifact,
      fileListArtifact: { ...artifact, kind: 'git.file-list' },
    },
  },
  {
    ...envelope(9),
    kind: 'error.observed',
    payload: {
      errorId: OPERATION_ID,
      category: 'process',
      code: 'command-failed',
      retryable: false,
      message: captured,
      relatedOperationId: SECOND_OPERATION_ID,
      relatedEventId: EVENT_ID,
    },
  },
  {
    ...envelope(10),
    kind: 'usage.observed',
    payload: {
      provider: 'openai',
      model: 'gpt-5',
      inputTokens: { state: 'reported', value: 100 },
      outputTokens: { state: 'reported', value: 50 },
      cachedInputTokens: { state: 'reported', value: 25 },
      reasoningTokens: {
        state: 'unavailable',
        reason: 'not-reported',
      },
      totalTokens: { state: 'reported', value: 150 },
    },
  },
] satisfies EvidenceEvent[];

const runStartedEvent = validEvents[0]!;

const batchWith = (events: unknown[]) => ({
  schemaVersion: 1,
  batchId: BATCH_ID,
  runId: RUN_ID,
  sentAt: TIMESTAMP,
  events,
});

describe('EvidenceEventSchema', () => {
  it.each(validEvents)('parses a valid $kind event', (event) => {
    expect(EvidenceEventSchema.parse(event)).toEqual(event);
  });

  it('narrows payload from the kind discriminant', () => {
    const event: EvidenceEvent = EvidenceEventSchema.parse(runStartedEvent);

    if (event.kind !== 'run.started') {
      throw new Error('expected run.started');
    }

    expectTypeOf(event.payload.adapter).toEqualTypeOf<string>();
    expect(event.payload.adapter).toBe('codex-adapter');
  });

  it('accepts an omitted source occurrence time', () => {
    const withoutOccurredAt: Record<string, unknown> = { ...runStartedEvent };
    delete withoutOccurredAt.occurredAt;

    expect(() => EvidenceEventSchema.parse(withoutOccurredAt)).not.toThrow();
  });

  it('rejects unknown envelope and payload properties', () => {
    expect(() =>
      EvidenceEventSchema.parse({ ...runStartedEvent, receivedAt: TIMESTAMP }),
    ).toThrow();
    expect(() =>
      EvidenceEventSchema.parse({
        ...runStartedEvent,
        payload: { ...runStartedEvent.payload, nativePayload: {} },
      }),
    ).toThrow();
  });

  it.each([
    ['unsupported schema version', { ...runStartedEvent, schemaVersion: 2 }],
    ['unknown kind', { ...runStartedEvent, kind: 'run.paused' }],
    ['malformed event UUID', { ...runStartedEvent, eventId: 'not-a-uuid' }],
    ['negative sequence', { ...runStartedEvent, sequence: -1 }],
    [
      'unsafe sequence',
      { ...runStartedEvent, sequence: Number.MAX_SAFE_INTEGER + 1 },
    ],
    [
      'non-UTC timestamp',
      { ...runStartedEvent, observedAt: '2026-09-22T15:00:00+03:00' },
    ],
    [
      'invalid trace ID',
      {
        ...runStartedEvent,
        correlation: { traceId: 'xyz', spanId: '2'.repeat(16) },
      },
    ],
    [
      'all-zero trace ID',
      { ...runStartedEvent, correlation: { traceId: '0'.repeat(32) } },
    ],
    [
      'invalid span ID',
      {
        ...runStartedEvent,
        correlation: { traceId: '1'.repeat(32), spanId: 'xyz' },
      },
    ],
    [
      'span without trace',
      { ...runStartedEvent, correlation: { spanId: '2'.repeat(16) } },
    ],
    [
      'unsupported source component',
      { ...runStartedEvent, source: { component: 'database' } },
    ],
  ])('rejects %s', (_description, event) => {
    expect(() => EvidenceEventSchema.parse(event)).toThrow();
  });

  it.each(['completed', 'timed-out'])(
    'rejects unknown outcome %s',
    (outcome) => {
      expect(() =>
        EvidenceEventSchema.parse({
          ...validEvents[1],
          payload: { outcome },
        }),
      ).toThrow();
    },
  );

  it('enforces bounded canonical and provider-native strings', () => {
    expect(() =>
      EvidenceEventSchema.parse({
        ...runStartedEvent,
        payload: {
          ...runStartedEvent.payload,
          adapter: 'a'.repeat(MAX_IDENTIFIER_LENGTH),
        },
        source: {
          ...runStartedEvent.source,
          nativeEventId: 'n'.repeat(MAX_NATIVE_ID_LENGTH),
        },
      }),
    ).not.toThrow();

    expect(() =>
      EvidenceEventSchema.parse({
        ...runStartedEvent,
        payload: {
          ...runStartedEvent.payload,
          adapter: 'a'.repeat(MAX_IDENTIFIER_LENGTH + 1),
        },
      }),
    ).toThrow();
    expect(() =>
      EvidenceEventSchema.parse({
        ...runStartedEvent,
        source: {
          ...runStartedEvent.source,
          nativeEventId: 'n'.repeat(MAX_NATIVE_ID_LENGTH + 1),
        },
      }),
    ).toThrow();
  });

  it('accepts duration and counters at safe-integer boundaries', () => {
    expect(() =>
      EvidenceEventSchema.parse({
        ...validEvents[1],
        sequence: Number.MAX_SAFE_INTEGER,
        payload: { outcome: 'unknown', durationMs: Number.MAX_SAFE_INTEGER },
      }),
    ).not.toThrow();
    expect(() =>
      EvidenceEventSchema.parse({
        ...validEvents[6]!,
        payload: {
          ...validEvents[6]!.payload,
          counts: { total: Number.MAX_SAFE_INTEGER },
        },
      }),
    ).not.toThrow();
  });

  it.each([
    ['negative duration', { outcome: 'failed', durationMs: -1 }],
    [
      'unsafe duration',
      { outcome: 'failed', durationMs: Number.MAX_SAFE_INTEGER + 1 },
    ],
  ])('rejects %s', (_description, payload) => {
    expect(() =>
      EvidenceEventSchema.parse({ ...validEvents[1], payload }),
    ).toThrow();
  });

  it('rejects negative and unsafe counters', () => {
    for (const total of [-1, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        EvidenceEventSchema.parse({
          ...validEvents[6]!,
          payload: { ...validEvents[6]!.payload, counts: { total } },
        }),
      ).toThrow();
    }
  });

  it('validates exit codes at non-negative safe-integer boundaries', () => {
    expect(() =>
      EvidenceEventSchema.parse({
        ...validEvents[5]!,
        payload: {
          ...validEvents[5]!.payload,
          exitCode: Number.MAX_SAFE_INTEGER,
        },
      }),
    ).not.toThrow();

    for (const exitCode of [-1, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        EvidenceEventSchema.parse({
          ...validEvents[5]!,
          payload: { ...validEvents[5]!.payload, exitCode },
        }),
      ).toThrow();
    }
  });

  it('keeps test outcome independent from command exit status', () => {
    const command = EvidenceEventSchema.parse(validEvents[5]);
    const tests = EvidenceEventSchema.parse(validEvents[6]);

    expect(
      command.kind === 'command.finished' && command.payload.exitCode,
    ).toBe(1);
    expect(tests.kind === 'test.run.finished' && tests.payload.outcome).toBe(
      'passed',
    );
  });

  it('round-trips every event kind through JSON', () => {
    for (const event of validEvents) {
      expect(
        EvidenceEventSchema.parse(JSON.parse(JSON.stringify(event))),
      ).toEqual(event);
    }
  });

  it('rejects cost and verification claims from usage evidence', () => {
    expect(() =>
      EvidenceEventSchema.parse({
        ...validEvents[10],
        payload: { ...validEvents[10]!.payload, costUsd: 0.01 },
      }),
    ).toThrow();
    expect(() =>
      EvidenceEventSchema.parse({ ...validEvents[10], verified: true }),
    ).toThrow();
  });
});

describe('content capture and artifacts', () => {
  it.each([omitted, unavailable, captured])(
    'parses state $state',
    (content) => {
      expect(ContentCaptureSchema.parse(content)).toEqual(content);
    },
  );

  it('enforces the excerpt length boundary', () => {
    expect(() =>
      ContentCaptureSchema.parse({
        ...captured,
        excerpt: 'x'.repeat(MAX_CONTENT_EXCERPT_LENGTH),
      }),
    ).not.toThrow();
    expect(() =>
      ContentCaptureSchema.parse({
        ...captured,
        excerpt: 'x'.repeat(MAX_CONTENT_EXCERPT_LENGTH + 1),
      }),
    ).toThrow();
  });

  it('rejects unsupported unavailable reasons and cross-state fields', () => {
    expect(() =>
      ContentCaptureSchema.parse({
        state: 'unavailable',
        reason: 'secret-detected',
      }),
    ).toThrow();
    expect(() =>
      ContentCaptureSchema.parse({ state: 'omitted', excerpt: 'leak' }),
    ).toThrow();
  });

  it('requires ruleset metadata to describe applied redaction', () => {
    expect(() =>
      ContentCaptureSchema.parse({
        ...captured,
        redaction: { applied: false, rulesetVersion: 'rules-v1' },
      }),
    ).toThrow();
  });

  it('validates artifact byte length and SHA-256 boundaries', () => {
    expect(() =>
      ArtifactReferenceSchema.parse({
        ...artifact,
        byteLength: Number.MAX_SAFE_INTEGER,
      }),
    ).not.toThrow();

    for (const byteLength of [-1, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        ArtifactReferenceSchema.parse({ ...artifact, byteLength }),
      ).toThrow();
    }

    for (const sha256 of ['A'.repeat(64), 'a'.repeat(63), 'not-a-hash']) {
      expect(() =>
        ArtifactReferenceSchema.parse({ ...artifact, sha256 }),
      ).toThrow();
    }

    expect(() =>
      ArtifactReferenceSchema.parse({ ...artifact, artifactId: 'not-a-uuid' }),
    ).toThrow();
  });

  it('rejects storage locations and unknown artifact fields', () => {
    expect(() =>
      ArtifactReferenceSchema.parse({
        ...artifact,
        storageUrl: 'https://storage.invalid/artifact',
      }),
    ).toThrow();
  });
});

describe('EvidenceReferenceSchema', () => {
  it.each([
    { type: 'event', eventId: EVENT_ID, pointer: '' },
    { type: 'event', eventId: EVENT_ID, pointer: '/payload/a~1b/~0value' },
    {
      type: 'artifact',
      artifactId: ARTIFACT_ID,
      sha256: SHA256,
      range: { type: 'bytes', start: 0, endExclusive: 1 },
    },
    {
      type: 'artifact',
      artifactId: ARTIFACT_ID,
      sha256: SHA256,
      range: { type: 'lines', start: 1, end: 1 },
    },
  ])('parses a valid $type reference', (reference) => {
    expect(() => EvidenceReferenceSchema.parse(reference)).not.toThrow();
  });

  it.each(['/bad~escape', 'not/a/pointer', '/bad~2escape'])(
    'rejects malformed JSON Pointer %s',
    (pointer) => {
      expect(() =>
        EvidenceReferenceSchema.parse({
          type: 'event',
          eventId: EVENT_ID,
          pointer,
        }),
      ).toThrow();
    },
  );

  it('rejects malformed ranges, identities, and hashes', () => {
    expect(() =>
      EvidenceReferenceSchema.parse({
        type: 'artifact',
        artifactId: 'bad-id',
        sha256: SHA256,
      }),
    ).toThrow();
    expect(() =>
      EvidenceReferenceSchema.parse({
        type: 'artifact',
        artifactId: ARTIFACT_ID,
        sha256: 'badhash',
      }),
    ).toThrow();
    expect(() =>
      EvidenceReferenceSchema.parse({
        type: 'artifact',
        artifactId: ARTIFACT_ID,
        sha256: SHA256,
        range: { type: 'bytes', start: 2, endExclusive: 2 },
      }),
    ).toThrow();
  });
});

describe('EvidenceBatchSchema', () => {
  it('parses and JSON round-trips a valid batch', () => {
    const batch = batchWith(validEvents);
    const parsed = EvidenceBatchSchema.parse(batch);

    expect(parsed).toEqual(batch);
    expect(
      EvidenceBatchSchema.parse(JSON.parse(JSON.stringify(parsed))),
    ).toEqual(batch);
  });

  it('rejects an empty batch', () => {
    expect(() => EvidenceBatchSchema.parse(batchWith([]))).toThrow();
  });

  it('accepts exactly 500 events and rejects 501', () => {
    const events = Array.from({ length: MAX_BATCH_EVENTS }, (_, index) => ({
      ...runStartedEvent,
      eventId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      sequence: index,
    }));

    expect(() => EvidenceBatchSchema.parse(batchWith(events))).not.toThrow();
    expect(() =>
      EvidenceBatchSchema.parse(
        batchWith([
          ...events,
          {
            ...runStartedEvent,
            eventId: '00000000-0000-4000-8000-000000000501',
            sequence: MAX_BATCH_EVENTS,
          },
        ]),
      ),
    ).toThrow();
  });

  it('rejects duplicate event IDs', () => {
    expect(() =>
      EvidenceBatchSchema.parse(
        batchWith([
          runStartedEvent,
          { ...validEvents[1]!, eventId: runStartedEvent.eventId },
        ]),
      ),
    ).toThrow();
  });

  it('rejects duplicate sequences', () => {
    expect(() =>
      EvidenceBatchSchema.parse(
        batchWith([runStartedEvent, { ...validEvents[1], sequence: 0 }]),
      ),
    ).toThrow();
  });

  it('rejects mismatched run IDs', () => {
    expect(() =>
      EvidenceBatchSchema.parse(
        batchWith([{ ...runStartedEvent, runId: OTHER_RUN_ID }]),
      ),
    ).toThrow();
  });

  it('rejects unknown batch properties', () => {
    expect(() =>
      EvidenceBatchSchema.parse({
        ...batchWith([runStartedEvent]),
        organizationId: OTHER_RUN_ID,
      }),
    ).toThrow();
  });
});
