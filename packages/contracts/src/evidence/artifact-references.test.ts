import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { ArtifactReference } from './artifact.js';
import { extractArtifactReferences } from './artifact-references.js';
import type { EvidenceEvent } from './events.js';

const artifact: ArtifactReference = {
  artifactId: randomUUID(),
  kind: 'log',
  mediaType: 'text/plain',
  byteLength: 1,
  sha256: 'a'.repeat(64),
  redaction: { applied: false },
};
const captured = {
  state: 'captured',
  excerpt: '',
  artifact,
  truncated: false,
  redaction: { applied: false },
} as const;
const envelope = {
  schemaVersion: 1,
  eventId: randomUUID(),
  runId: randomUUID(),
  sequence: 0,
  observedAt: '2026-09-23T12:00:00.000Z',
  source: { component: 'collector' },
} as const;

function event(kind: EvidenceEvent['kind'], payload: unknown): EvidenceEvent {
  return { ...envelope, kind, payload } as EvidenceEvent;
}

describe('extractArtifactReferences', () => {
  it('extracts every v1 artifact-bearing location with stable JSON pointers', () => {
    const cases = [
      event('run.started', {
        adapter: 'codex',
        provider: 'codex',
        taskDescription: captured,
      }),
      event('tool.call.started', {
        toolCallId: randomUUID(),
        toolName: 'shell',
        input: captured,
      }),
      event('tool.call.finished', {
        toolCallId: randomUUID(),
        toolName: 'shell',
        outcome: 'succeeded',
        output: captured,
      }),
      event('command.started', {
        commandId: randomUUID(),
        command: captured,
        workingDirectory: captured,
      }),
      event('command.finished', {
        commandId: randomUUID(),
        outcome: 'succeeded',
        stdout: captured,
        stderr: captured,
      }),
      event('test.run.finished', {
        testRunId: randomUUID(),
        framework: 'vitest',
        outcome: 'passed',
        reportArtifact: artifact,
      }),
      event('git.snapshot.captured', {
        snapshotId: randomUUID(),
        phase: 'before',
        isDirty: false,
        statusArtifact: artifact,
      }),
      event('git.diff.captured', {
        diffId: randomUUID(),
        fromSnapshotId: randomUUID(),
        toSnapshotId: randomUUID(),
        diffArtifact: artifact,
        fileListArtifact: artifact,
      }),
      event('error.observed', {
        errorId: randomUUID(),
        category: 'runtime',
        code: 'failed',
        message: captured,
      }),
    ];
    expect(
      cases
        .flatMap(extractArtifactReferences)
        .map((located) => located.jsonPointer),
    ).toEqual([
      '/payload/taskDescription/artifact',
      '/payload/input/artifact',
      '/payload/output/artifact',
      '/payload/command/artifact',
      '/payload/workingDirectory/artifact',
      '/payload/stdout/artifact',
      '/payload/stderr/artifact',
      '/payload/reportArtifact',
      '/payload/statusArtifact',
      '/payload/diffArtifact',
      '/payload/fileListArtifact',
      '/payload/message/artifact',
    ]);
  });

  it.each([
    event('run.finished', { outcome: 'succeeded' }),
    event('usage.observed', {
      inputTokens: { state: 'unavailable', reason: 'not-reported' },
      outputTokens: { state: 'unavailable', reason: 'not-reported' },
      cachedInputTokens: { state: 'unavailable', reason: 'not-reported' },
      reasoningTokens: { state: 'unavailable', reason: 'not-reported' },
      totalTokens: { state: 'unavailable', reason: 'not-reported' },
    }),
  ])('returns no references for $kind', (value) => {
    expect(extractArtifactReferences(value)).toEqual([]);
  });
});
