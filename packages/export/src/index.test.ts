import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { enforceCollectionLimits } from './builder.js';
import {
  buildEvidenceExportV1,
  canonicalUtf8,
  EVIDENCE_EXPORT_MEDIA_TYPE,
  EVIDENCE_EXPORT_V1_FINDING_RULES,
  EVIDENCE_EXPORT_V1_LIMITS,
  EvidenceExportTooLargeError,
  InvalidEvidenceExportError,
  parseEvidenceExportV1,
  type EvidenceExportV1,
  type ExportV1Snapshot,
} from './index.js';

const repositoryId = '11111111-1111-4111-8111-111111111111';
const runId = '22222222-2222-4222-8222-222222222222';
const startedEventId = '33333333-3333-4333-8333-333333333333';
const finishedEventId = '44444444-4444-4444-8444-444444444444';
const artifactId = '55555555-5555-4555-8555-555555555555';
const coreFingerprint = createHash('sha256')
  .update(`0:${startedEventId}\n1:${finishedEventId}\n`)
  .digest('hex');
const filesFingerprint = 'a'.repeat(64);
const findingsFingerprint = 'b'.repeat(64);
const summaryFingerprint = 'c'.repeat(64);

function hash(index: number): string {
  return index.toString(16).padStart(64, '0');
}

function processing(
  projectorName: 'core' | 'files' | 'findings' | 'summary',
  sourceFingerprint: string,
  sourceEventCount: number,
  sourceMaxSequence: number | null,
) {
  return {
    projectorName,
    expectedVersion: 1,
    observedVersion: 1,
    state: 'ready' as const,
    currentness: 'ready' as const,
    sourceEventCount,
    sourceMaxSequence,
    sourceFingerprint,
    errorCode: null,
  };
}

function snapshot(): ExportV1Snapshot {
  const artifact = {
    artifactId,
    kind: 'task.description',
    mediaType: 'text/plain',
    byteLength: 4,
    sha256: hash(30),
    redaction: { applied: false },
    characterEncoding: 'utf-8',
  } as const;
  const results = EVIDENCE_EXPORT_V1_FINDING_RULES.map((ruleId, index) => ({
    resultKey: hash(index + 1),
    catalogOrder: index,
    ruleId,
    ruleVersion: 1 as const,
    severity: (index === 4 || index === 5 ? 'medium' : 'high') as
      'medium' | 'high',
    outcome: 'clear' as const,
    coverage: 'complete' as const,
    reasonCodes: [] as string[],
    explanation: 'The bounded evidence is clear.',
    matchCount: 0,
    matches: [] as string[],
    matchesTruncated: false,
    referencesTruncated: false,
    references: [],
  }));
  return {
    repositoryId,
    runId,
    events: [
      {
        receivedAt: '2026-11-23T10:00:00.000Z',
        event: {
          schemaVersion: 1,
          eventId: startedEventId,
          runId,
          sequence: 0,
          kind: 'run.started',
          observedAt: '2026-11-23T09:59:59.000Z',
          source: { component: 'collector' },
          payload: {
            adapter: 'codex-jsonl',
            provider: 'codex',
            taskDescription: {
              state: 'captured',
              excerpt: 'safe',
              artifact,
              truncated: false,
              redaction: { applied: false },
            },
          },
        },
      },
      {
        receivedAt: '2026-11-23T10:00:01.000Z',
        event: {
          schemaVersion: 1,
          eventId: finishedEventId,
          runId,
          sequence: 1,
          kind: 'run.finished',
          observedAt: '2026-11-23T10:00:00.000Z',
          source: { component: 'collector' },
          payload: { outcome: 'succeeded', durationMs: 1_000 },
        },
      },
    ],
    artifacts: [
      {
        artifact,
        receivedAt: '2026-11-23T10:00:00.000Z',
        declaredBy: [
          {
            eventId: startedEventId,
            pointer: '/payload/taskDescription/artifact',
          },
        ],
        verification: {
          state: 'verified',
          observedByteLength: artifact.byteLength,
          observedSha256: artifact.sha256,
          verifiedAt: '2026-11-23T10:00:02.000Z',
        },
      },
    ],
    processing: {
      core: processing('core', coreFingerprint, 2, 1),
      files: processing('files', filesFingerprint, 0, null),
      findings: processing('findings', findingsFingerprint, 2, 1),
      summary: processing('summary', summaryFingerprint, 1, null),
    },
    core: {
      state: 'available',
      projectorName: 'core',
      projectorVersion: 1,
      source: {
        eventCount: 2,
        maxSequence: 1,
        fingerprint: coreFingerprint,
      },
      run: {
        started: { eventId: startedEventId, sequence: 0 },
        finished: { eventId: finishedEventId, sequence: 1 },
        adapter: 'codex-jsonl',
        provider: 'codex',
        observedOutcome: 'succeeded',
        durationMs: 1_000,
        evidenceCompleteness: 'complete',
        completenessReasons: [],
        commandCount: 0,
        toolCallCount: 0,
        testObservationState: 'not_observed',
        testCounts: {
          total: null,
          passed: null,
          failed: null,
          skipped: null,
          todo: null,
        },
        tokenAggregates: {
          inputTokens: { reportedTotal: null, unavailableCount: 0 },
          outputTokens: { reportedTotal: null, unavailableCount: 0 },
          cachedInputTokens: { reportedTotal: null, unavailableCount: 0 },
          reasoningTokens: { reportedTotal: null, unavailableCount: 0 },
          totalTokens: { reportedTotal: null, unavailableCount: 0 },
        },
        filesChanged: 0,
      },
      commands: [],
      tools: [],
      tests: [],
      gitSnapshots: [],
      gitDiffs: [],
      errors: [],
      usage: [],
    },
    files: {
      state: 'available',
      projectorName: 'files',
      projectorVersion: 1,
      source: {
        eventCount: 0,
        maxSequence: null,
        fingerprint: filesFingerprint,
      },
      completeness: 'complete',
      completenessReason: null,
      files: [],
    },
    findings: {
      state: 'available',
      projectorName: 'findings',
      projectorVersion: 1,
      analyzerName: 'deterministic-findings',
      analyzerVersion: 1,
      catalogVersion: 1,
      sourceFingerprint: findingsFingerprint,
      coreVersion: 1,
      coreFingerprint,
      coreCompleteness: 'complete',
      filesVersion: 1,
      filesFingerprint,
      filesCompleteness: 'complete',
      deterministicOutcome: 'pass',
      coverage: 'complete',
      triggeredCount: 0,
      unknownCount: 0,
      highCount: 0,
      mediumCount: 0,
      results,
    },
    summary: {
      state: 'available',
      projectorName: 'summary',
      projectorVersion: 1,
      generatorName: 'deterministic-structured-summary',
      generatorVersion: 1,
      formatVersion: 1,
      templateVersion: 1,
      summaryKey: hash(20),
      sourceFingerprint: summaryFingerprint,
      coreVersion: 1,
      coreFingerprint,
      coreCompleteness: 'complete',
      filesVersion: 1,
      filesFingerprint,
      filesCompleteness: 'complete',
      findingsProjectorVersion: 1,
      findingsFingerprint,
      findingsAnalyzerName: 'deterministic-findings',
      findingsAnalyzerVersion: 1,
      findingsCatalogVersion: 1,
      outcome: 'pass',
      sectionCount: 1,
      claimCount: 1,
      claimsTruncated: false,
      claims: [
        {
          claimKey: hash(21),
          stableId: 'v1.findings.bounded-pass',
          sectionId: 'findings',
          sectionOrder: 2,
          claimOrder: 0,
          class: 'deterministic_assessment',
          templateId: 'v1.findings.bounded-pass',
          text: 'The current deterministic catalog is clear.',
          supportCount: 1,
          supportsTruncated: false,
          supports: [
            {
              kind: 'finding',
              ordinal: 0,
              resultKey: results[0]!.resultKey,
              ruleId: results[0]!.ruleId,
              ruleVersion: 1,
              findingsSourceFingerprint: findingsFingerprint,
            },
          ],
        },
      ],
    },
  };
}

type UnavailableFilesReason = 'missing' | 'stale' | 'incomplete';
type FilesCompleteness = 'complete' | UnavailableFilesReason;

const unavailableFilesReasons = ['missing', 'stale', 'incomplete'] as const;
const filesCompletenessValues = [
  'complete',
  ...unavailableFilesReasons,
] as const;
const mismatchedUnavailableCompleteness = unavailableFilesReasons.flatMap(
  (reason) =>
    filesCompletenessValues
      .filter((completeness) => completeness !== reason)
      .flatMap((completeness) =>
        (['findings', 'summary'] as const).map(
          (section) => [section, completeness, reason] as const,
        ),
      ),
);

function snapshotWithUnavailableFiles(
  reason: UnavailableFilesReason,
): ExportV1Snapshot {
  const value = snapshot();
  value.files = { state: 'unavailable', reason };
  value.processing.files = {
    projectorName: 'files',
    expectedVersion: 1,
    observedVersion: reason === 'missing' ? null : 1,
    state: reason === 'missing' ? 'missing' : 'ready',
    currentness: reason === 'missing' ? 'processing' : reason,
    sourceEventCount: reason === 'missing' ? null : 0,
    sourceMaxSequence: null,
    sourceFingerprint: reason === 'missing' ? null : filesFingerprint,
    errorCode: null,
  };
  if (value.findings.state !== 'available') throw new Error();
  value.findings.filesVersion = null;
  value.findings.filesFingerprint = null;
  value.findings.filesCompleteness = reason;
  if (value.summary.state !== 'available') throw new Error();
  value.summary.filesVersion = null;
  value.summary.filesFingerprint = null;
  value.summary.filesCompleteness = reason;
  return value;
}

describe('Export V1 canonical builder and parser', () => {
  it('emits stable canonical bytes, digest, media type, and byte-level round trip', () => {
    const first = buildEvidenceExportV1(snapshot());
    const parsed = parseEvidenceExportV1(first.bytes);

    expect(EVIDENCE_EXPORT_MEDIA_TYPE).toBe(
      'application/vnd.ai-agent-black-box.evidence-export.v1+json',
    );
    expect(parsed.bundle).toEqual(first.bundle);
    expect(parsed.bytes).toEqual(first.bytes);
    expect(parsed.sha256).toBe(first.sha256);
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.sha256).toBe(
      '9e509cf1791381a41d1d76ac9eeda3a231c3902a9ad0d5377fef93e2113deafb',
    );
    expect(new TextDecoder().decode(first.bytes)).not.toMatch(/[\r\n\t]/);
    expect(first.bundle.outcomes).toEqual({
      child: { state: 'available', value: 'succeeded' },
      findings: { state: 'available', value: 'pass' },
      summary: { state: 'available', value: 'pass' },
      presentation: 'PASS',
    });
    expect(first.bundle.limitations).toEqual([
      'artifact_bytes_excluded',
      'not_a_compliance_export',
      'not_a_correctness_certificate',
      'not_a_full_artifact_archive',
      'not_a_merge_approval',
      'not_a_signature',
    ]);
  });

  it('normalizes every database-order-dependent collection', () => {
    const original = snapshot();
    const permuted = structuredClone(original);
    permuted.events.reverse();
    if (permuted.findings.state === 'available')
      permuted.findings.results.reverse();
    if (permuted.summary.state === 'available')
      permuted.summary.claims[0]!.supports.reverse();

    const first = buildEvidenceExportV1(original);
    const second = buildEvidenceExportV1(permuted);
    expect(second.bytes).toEqual(first.bytes);
    expect(second.sha256).toBe(first.sha256);
  });

  it.each(unavailableFilesReasons)(
    'round-trips a current summary over %s files',
    (reason) => {
      const first = buildEvidenceExportV1(snapshotWithUnavailableFiles(reason));
      const second = parseEvidenceExportV1(first.bytes);

      expect(second.bundle).toEqual(first.bundle);
      expect(second.bytes).toEqual(first.bytes);
      expect(second.sha256).toBe(first.sha256);
    },
  );

  it('rejects a fully aligned available but incomplete files dependency graph', () => {
    const bundle = structuredClone(buildEvidenceExportV1(snapshot()).bundle);
    if (
      bundle.files.state !== 'available' ||
      bundle.findings.state !== 'available' ||
      bundle.summary.state !== 'available'
    )
      throw new Error();
    bundle.files.completeness = 'incomplete';
    bundle.files.completenessReason = 'file_evidence_incomplete';
    bundle.findings.filesCompleteness = 'incomplete';
    bundle.summary.filesCompleteness = 'incomplete';

    expect(() => parseEvidenceExportV1(canonicalUtf8(bundle))).toThrow(
      InvalidEvidenceExportError,
    );
  });

  it.each([
    ['missing', 'missing', 'processing'],
    ['stale', 'ready', 'stale'],
    ['incomplete', 'ready', 'incomplete'],
    ['processing', 'processing', 'processing'],
    ['failed', 'failed', 'failed'],
  ] as const)(
    'rejects available files with %s processing currentness',
    (_name, state, currentness) => {
      const bundle = structuredClone(buildEvidenceExportV1(snapshot()).bundle);
      bundle.processing.files.state = state;
      bundle.processing.files.currentness = currentness;
      bundle.processing.files.observedVersion = state === 'missing' ? null : 1;
      bundle.processing.files.sourceEventCount = state === 'missing' ? null : 0;
      bundle.processing.files.sourceMaxSequence = null;
      bundle.processing.files.sourceFingerprint =
        state === 'missing' ? null : filesFingerprint;
      bundle.processing.files.errorCode =
        state === 'failed' ? 'files_processing_failed' : null;
      bundle.outcomes.presentation =
        currentness === 'processing' ? 'PROCESSING' : 'INCOMPLETE';

      expect(() => parseEvidenceExportV1(canonicalUtf8(bundle))).toThrow(
        InvalidEvidenceExportError,
      );
    },
  );

  it('keeps processing, missing, unknown, and unavailable states distinct', () => {
    const value = snapshot();
    value.processing = {
      core: {
        projectorName: 'core',
        expectedVersion: 1,
        observedVersion: 1,
        state: 'pending',
        currentness: 'processing',
        sourceEventCount: null,
        sourceMaxSequence: null,
        sourceFingerprint: null,
        errorCode: null,
      },
      files: {
        projectorName: 'files',
        expectedVersion: 1,
        observedVersion: null,
        state: 'missing',
        currentness: 'processing',
        sourceEventCount: null,
        sourceMaxSequence: null,
        sourceFingerprint: null,
        errorCode: null,
      },
      findings: {
        projectorName: 'findings',
        expectedVersion: 1,
        observedVersion: null,
        state: 'missing',
        currentness: 'processing',
        sourceEventCount: null,
        sourceMaxSequence: null,
        sourceFingerprint: null,
        errorCode: null,
      },
      summary: {
        projectorName: 'summary',
        expectedVersion: 1,
        observedVersion: null,
        state: 'missing',
        currentness: 'processing',
        sourceEventCount: null,
        sourceMaxSequence: null,
        sourceFingerprint: null,
        errorCode: null,
      },
    };
    value.core = { state: 'unavailable', reason: 'processing' };
    value.files = { state: 'unavailable', reason: 'missing' };
    value.findings = { state: 'unavailable', reason: 'processing' };
    value.summary = { state: 'unavailable', reason: 'processing' };

    expect(buildEvidenceExportV1(value).bundle.outcomes).toEqual({
      child: { state: 'unavailable', reason: 'processing' },
      findings: { state: 'unavailable', reason: 'processing' },
      summary: { state: 'unavailable', reason: 'processing' },
      presentation: 'PROCESSING',
    });
  });

  it.each([
    [
      'unknown property',
      (value: Record<string, unknown>) => (value.organizationId = repositoryId),
    ],
    [
      'unknown version',
      (value: Record<string, unknown>) => (value.formatVersion = 2),
    ],
    [
      'internal object key',
      (value: Record<string, unknown>) => (value.objectKey = 'private/path'),
    ],
  ])('rejects %s independently while parsing', (_name, mutate) => {
    const bundle = buildEvidenceExportV1(snapshot())
      .bundle as unknown as Record<string, unknown>;
    mutate(bundle);
    expect(() => parseEvidenceExportV1(canonicalUtf8(bundle))).toThrow(
      InvalidEvidenceExportError,
    );
  });

  it.each([
    [
      'a different summary files version',
      (bundle: EvidenceExportV1) => {
        if (bundle.summary.state !== 'available') throw new Error();
        bundle.summary.filesVersion = 2;
      },
    ],
    [
      'a different summary files fingerprint',
      (bundle: EvidenceExportV1) => {
        if (bundle.summary.state !== 'available') throw new Error();
        bundle.summary.filesFingerprint = 'd'.repeat(64);
      },
    ],
    [
      'a different summary files completeness',
      (bundle: EvidenceExportV1) => {
        if (bundle.summary.state !== 'available') throw new Error();
        bundle.summary.filesCompleteness = 'incomplete';
      },
    ],
    [
      'missing files with complete dependency facts',
      (bundle: EvidenceExportV1) => {
        bundle.files = { state: 'unavailable', reason: 'missing' };
      },
    ],
    [
      'stale files with complete dependency facts',
      (bundle: EvidenceExportV1) => {
        bundle.files = { state: 'unavailable', reason: 'stale' };
      },
    ],
    [
      'incomplete files with complete dependency facts',
      (bundle: EvidenceExportV1) => {
        bundle.files = { state: 'unavailable', reason: 'incomplete' };
      },
    ],
    [
      'non-current summary processing',
      (bundle: EvidenceExportV1) => {
        bundle.processing.summary.currentness = 'stale';
      },
    ],
    [
      'a non-ready summary processing state',
      (bundle: EvidenceExportV1) => {
        bundle.processing.summary.state = 'processing';
        bundle.processing.summary.currentness = 'processing';
      },
    ],
    [
      'a different summary processing source',
      (bundle: EvidenceExportV1) => {
        bundle.processing.summary.sourceFingerprint = 'd'.repeat(64);
      },
    ],
    [
      'a different summary processing source count',
      (bundle: EvidenceExportV1) => {
        bundle.processing.summary.sourceEventCount = 2;
      },
    ],
    [
      'a summary processing source sequence',
      (bundle: EvidenceExportV1) => {
        bundle.processing.summary.sourceMaxSequence = 1;
      },
    ],
  ])('rejects %s from canonical parser input', (_name, mutate) => {
    const bundle = structuredClone(buildEvidenceExportV1(snapshot()).bundle);
    mutate(bundle);
    expect(() => parseEvidenceExportV1(canonicalUtf8(bundle))).toThrow(
      InvalidEvidenceExportError,
    );
  });

  it.each(mismatchedUnavailableCompleteness)(
    'rejects %s completeness %s against unavailable %s files',
    (section, completeness, reason) => {
      const bundle = structuredClone(
        buildEvidenceExportV1(snapshotWithUnavailableFiles(reason)).bundle,
      );
      const dependency = bundle[section];
      if (dependency.state !== 'available') throw new Error();
      dependency.filesCompleteness = completeness as FilesCompleteness;

      expect(() => parseEvidenceExportV1(canonicalUtf8(bundle))).toThrow(
        InvalidEvidenceExportError,
      );
    },
  );

  it.each([
    ['findings', 'version'],
    ['findings', 'fingerprint'],
    ['summary', 'version'],
    ['summary', 'fingerprint'],
  ] as const)(
    'rejects a non-null unavailable-files %s %s identity',
    (section, identity) => {
      const bundle = structuredClone(
        buildEvidenceExportV1(snapshotWithUnavailableFiles('missing')).bundle,
      );
      const dependency = bundle[section];
      if (dependency.state !== 'available') throw new Error();
      if (identity === 'version') dependency.filesVersion = 1;
      else dependency.filesFingerprint = filesFingerprint;

      expect(() => parseEvidenceExportV1(canonicalUtf8(bundle))).toThrow(
        InvalidEvidenceExportError,
      );
    },
  );

  it.each([
    ['findings', 'version'],
    ['findings', 'fingerprint'],
    ['summary', 'version'],
    ['summary', 'fingerprint'],
  ] as const)(
    'rejects a null available-files %s %s identity',
    (section, identity) => {
      const bundle = structuredClone(buildEvidenceExportV1(snapshot()).bundle);
      const dependency = bundle[section];
      if (dependency.state !== 'available') throw new Error();
      if (identity === 'version') dependency.filesVersion = null;
      else dependency.filesFingerprint = null;

      expect(() => parseEvidenceExportV1(canonicalUtf8(bundle))).toThrow(
        InvalidEvidenceExportError,
      );
    },
  );

  it('rejects disagreement between summary and findings unavailable-files facts', () => {
    const bundle = structuredClone(
      buildEvidenceExportV1(snapshotWithUnavailableFiles('missing')).bundle,
    );
    if (bundle.findings.state !== 'available') throw new Error();
    bundle.findings.filesCompleteness = 'stale';

    expect(() => parseEvidenceExportV1(canonicalUtf8(bundle))).toThrow(
      InvalidEvidenceExportError,
    );
  });

  it.each(['processing', 'failed'] as const)(
    'rejects an available summary over %s files',
    (reason) => {
      const bundle = structuredClone(
        buildEvidenceExportV1(snapshotWithUnavailableFiles('missing')).bundle,
      );
      bundle.files = { state: 'unavailable', reason };
      bundle.processing.files.observedVersion = 1;
      bundle.processing.files.state = reason;
      bundle.processing.files.currentness = reason;
      bundle.processing.files.errorCode =
        reason === 'failed' ? 'files_processing_failed' : null;

      expect(() => parseEvidenceExportV1(canonicalUtf8(bundle))).toThrow(
        InvalidEvidenceExportError,
      );
    },
  );

  it('rejects noncanonical whitespace, duplicate JSON keys, duplicate identities, and out-of-order bytes', () => {
    const built = buildEvidenceExportV1(snapshot());
    const text = new TextDecoder().decode(built.bytes);
    expect(() =>
      parseEvidenceExportV1(new TextEncoder().encode(`${text}\n`)),
    ).toThrow(InvalidEvidenceExportError);
    expect(() =>
      parseEvidenceExportV1(
        new TextEncoder().encode(
          text.replace(
            '"format":"evidence-export"',
            '"format":"evidence-export","format":"evidence-export"',
          ),
        ),
      ),
    ).toThrow(InvalidEvidenceExportError);

    const duplicate = snapshot();
    duplicate.events[1] = {
      ...duplicate.events[1]!,
      event: {
        ...duplicate.events[1]!.event,
        eventId: startedEventId,
      },
    };
    expect(() => buildEvidenceExportV1(duplicate)).toThrow(
      InvalidEvidenceExportError,
    );

    const outOfOrder = structuredClone(built.bundle);
    outOfOrder.events.reverse();
    expect(() => parseEvidenceExportV1(canonicalUtf8(outOfOrder))).toThrow(
      InvalidEvidenceExportError,
    );
  });

  it('rejects incompatible summary supports and malformed canonical identities', () => {
    const incompatible = snapshot();
    if (incompatible.summary.state !== 'available') throw new Error();
    const support = incompatible.summary.claims[0]!.supports[0]!;
    if (support.kind !== 'finding') throw new Error();
    support.findingsSourceFingerprint = 'd'.repeat(64);
    expect(() => buildEvidenceExportV1(incompatible)).toThrow(
      InvalidEvidenceExportError,
    );

    const malformed = snapshot() as unknown as Record<string, unknown>;
    malformed.runId = 'not-a-uuid';
    expect(() => buildEvidenceExportV1(malformed)).toThrow(
      InvalidEvidenceExportError,
    );
  });

  it('rejects missing availability facts, unsafe integers, and mismatched artifact verification', () => {
    const missingReason = snapshot() as unknown as Record<string, unknown>;
    missingReason.files = { state: 'unavailable' };
    expect(() => buildEvidenceExportV1(missingReason)).toThrow(
      InvalidEvidenceExportError,
    );

    const unsafe = snapshot();
    if (unsafe.core.state !== 'available') throw new Error();
    unsafe.core.run.durationMs = Number.MAX_SAFE_INTEGER + 1;
    expect(() => buildEvidenceExportV1(unsafe)).toThrow(
      InvalidEvidenceExportError,
    );

    const mismatched = snapshot();
    if (mismatched.artifacts[0]?.verification.state !== 'verified')
      throw new Error();
    mismatched.artifacts[0].verification.observedSha256 = hash(31);
    expect(() => buildEvidenceExportV1(mismatched)).toThrow(
      InvalidEvidenceExportError,
    );
  });

  it.each([
    [
      'events',
      EVIDENCE_EXPORT_V1_LIMITS.events,
      (value: Record<string, unknown>, items: null[]) => {
        value.events = items;
      },
    ],
    [
      'artifacts',
      EVIDENCE_EXPORT_V1_LIMITS.artifacts,
      (value: Record<string, unknown>, items: null[]) => {
        value.artifacts = items;
      },
    ],
    [
      'artifact declarations',
      EVIDENCE_EXPORT_V1_LIMITS.artifactDeclarations,
      (value: Record<string, unknown>, items: null[]) => {
        value.artifacts = [{ declaredBy: items }];
      },
    ],
    [
      'completeness reasons',
      EVIDENCE_EXPORT_V1_LIMITS.completenessReasons,
      (value: Record<string, unknown>, items: null[]) => {
        const core = value.core as Record<string, unknown>;
        const run = core.run as Record<string, unknown>;
        run.completenessReasons = items;
      },
    ],
    ...(
      [
        ['commands', EVIDENCE_EXPORT_V1_LIMITS.commands],
        ['tools', EVIDENCE_EXPORT_V1_LIMITS.tools],
        ['tests', EVIDENCE_EXPORT_V1_LIMITS.tests],
        ['gitSnapshots', EVIDENCE_EXPORT_V1_LIMITS.gitSnapshots],
        ['gitDiffs', EVIDENCE_EXPORT_V1_LIMITS.gitDiffs],
        ['errors', EVIDENCE_EXPORT_V1_LIMITS.errors],
        ['usage', EVIDENCE_EXPORT_V1_LIMITS.usage],
      ] as const
    ).map(
      ([name, maximum]) =>
        [
          name,
          maximum,
          (value: Record<string, unknown>, items: null[]) => {
            const core = value.core as Record<string, unknown>;
            core[name] = items;
          },
        ] as const,
    ),
    [
      'files',
      EVIDENCE_EXPORT_V1_LIMITS.files,
      (value: Record<string, unknown>, items: null[]) => {
        const files = value.files as Record<string, unknown>;
        files.files = items;
      },
    ],
    [
      'findings',
      EVIDENCE_EXPORT_V1_LIMITS.findings,
      (value: Record<string, unknown>, items: null[]) => {
        const findings = value.findings as Record<string, unknown>;
        findings.results = items;
      },
    ],
    [
      'finding reason codes',
      EVIDENCE_EXPORT_V1_LIMITS.findingReasonCodes,
      (value: Record<string, unknown>, items: null[]) => {
        const findings = value.findings as Record<string, unknown>;
        findings.results = [{ reasonCodes: items }];
      },
    ],
    [
      'finding matches',
      EVIDENCE_EXPORT_V1_LIMITS.findingMatches,
      (value: Record<string, unknown>, items: null[]) => {
        const findings = value.findings as Record<string, unknown>;
        findings.results = [{ matches: items }];
      },
    ],
    [
      'finding references',
      EVIDENCE_EXPORT_V1_LIMITS.findingReferences,
      (value: Record<string, unknown>, items: null[]) => {
        const findings = value.findings as Record<string, unknown>;
        findings.results = [{ references: items }];
      },
    ],
    [
      'summary claims',
      EVIDENCE_EXPORT_V1_LIMITS.summaryClaims,
      (value: Record<string, unknown>, items: null[]) => {
        const summary = value.summary as Record<string, unknown>;
        summary.claims = items;
      },
    ],
    [
      'summary supports',
      EVIDENCE_EXPORT_V1_LIMITS.summarySupports,
      (value: Record<string, unknown>, items: null[]) => {
        const summary = value.summary as Record<string, unknown>;
        summary.claims = [{ supports: items }];
      },
    ],
    [
      'derived limitations',
      EVIDENCE_EXPORT_V1_LIMITS.limitations,
      (value: Record<string, unknown>, items: null[]) => {
        value.limitations = items;
      },
    ],
  ] as const)(
    'preflights the exact %s maximum and rejects maximum + 1 as export_too_large',
    (_name, maximum, setItems) => {
      const atMaximum = snapshot() as unknown as Record<string, unknown>;
      setItems(atMaximum, new Array(maximum).fill(null));
      expect(() => enforceCollectionLimits(atMaximum)).not.toThrow();

      const value = snapshot() as unknown as Record<string, unknown>;
      setItems(value, new Array(maximum + 1).fill(null));
      expect(() => enforceCollectionLimits(value)).toThrowError(
        expect.objectContaining({ code: 'export_too_large' }),
      );
      expect(() => enforceCollectionLimits(value)).toThrow(
        EvidenceExportTooLargeError,
      );
    },
  );

  it('rejects bytes beyond the named total canonical-byte ceiling', () => {
    expect(() =>
      parseEvidenceExportV1(
        new Uint8Array(EVIDENCE_EXPORT_V1_LIMITS.totalCanonicalBytes + 1),
      ),
    ).toThrow(InvalidEvidenceExportError);
  });

  it('stops canonical generation at the total-byte ceiling with the stable safe code', () => {
    const value = snapshot();
    if (value.core.state !== 'available') throw new Error();
    const excerpt = 'x'.repeat(4_096);
    value.core.errors = Array.from({ length: 4_200 }, (_, index) => ({
      errorId: `66666666-6666-4666-8666-${String(index).padStart(12, '0')}`,
      source: { eventId: startedEventId, sequence: 0 },
      category: 'agent',
      code: 'bounded-message',
      retryable: null,
      messageCapture: {
        state: 'captured' as const,
        excerpt,
        truncated: true,
        redaction: { applied: false },
      },
      relatedOperationId: null,
      relatedEventId: null,
    }));
    expect(() => buildEvidenceExportV1(value)).toThrow(
      EvidenceExportTooLargeError,
    );
  });
});
