import { describe, expect, it } from 'vitest';

import {
  findingsGraphFingerprint,
  summarySourceFingerprint,
  type FindingsGraphResultIdentity,
  type SummarySourceIdentity,
} from './summary-processing.js';

const identity: SummarySourceIdentity = {
  generatorName: 'deterministic-structured-summary',
  generatorVersion: 1,
  formatVersion: 1,
  templateVersion: 1,
  core: {
    version: 1,
    fingerprint: 'a'.repeat(64),
    completeness: 'complete',
  },
  files: {
    version: 1,
    fingerprint: 'b'.repeat(64),
    completeness: 'complete',
  },
  findings: {
    projectorVersion: 1,
    fingerprint: 'c'.repeat(64),
    graphFingerprint: 'd'.repeat(64),
    analyzerName: 'deterministic-findings',
    analyzerVersion: 1,
    catalogVersion: 1,
    outcome: 'pass',
    coverage: 'complete',
  },
};

const graph: FindingsGraphResultIdentity[] = [
  {
    catalogOrder: 0,
    resultKey: 'a'.repeat(64),
    ruleId: 'bbx.example-one',
    ruleVersion: 1,
    severity: 'high',
    outcome: 'triggered',
    coverage: 'complete',
    reasonCodes: ['evaluated'],
    explanation: 'A bounded explanation.',
    matchCount: 1,
    matches: [{ z: 2, a: 1 }],
    matchesTruncated: false,
    referencesTruncated: false,
    references: [
      {
        ordinal: 0,
        eventId: '00000000-0000-4000-8000-000000000001',
        artifactId: null,
        eventArtifactPointer: null,
        jsonPointer: null,
        fileOrdinal: null,
        entryId: null,
      },
    ],
  },
  {
    catalogOrder: 1,
    resultKey: 'b'.repeat(64),
    ruleId: 'bbx.example-two',
    ruleVersion: 1,
    severity: 'medium',
    outcome: 'clear',
    coverage: 'complete',
    reasonCodes: ['evaluated'],
    explanation: 'Another bounded explanation.',
    matchCount: 0,
    matches: [],
    matchesTruncated: false,
    referencesTruncated: false,
    references: [],
  },
];

describe('summary source identity', () => {
  it.each(['generatorVersion', 'formatVersion', 'templateVersion'] as const)(
    'changes when %s changes',
    (field) => {
      expect(summarySourceFingerprint({ ...identity, [field]: 2 })).not.toBe(
        summarySourceFingerprint(identity),
      );
    },
  );

  it('canonicalizes result, reference, and JSON-object row permutations', () => {
    const permuted: FindingsGraphResultIdentity[] = [
      graph[1]!,
      {
        ...graph[0]!,
        matches: [{ a: 1, z: 2 }],
        references: [...graph[0]!.references].reverse(),
      },
    ];
    expect(findingsGraphFingerprint(permuted)).toBe(
      findingsGraphFingerprint(graph),
    );
  });

  it.each([
    [
      'material result content',
      () => [{ ...graph[0]!, explanation: 'Changed.' }, graph[1]!],
    ],
    ['result outcome', () => [{ ...graph[0]!, outcome: 'clear' }, graph[1]!]],
    [
      'reference locator',
      () => [
        {
          ...graph[0]!,
          references: [
            { ...graph[0]!.references[0]!, jsonPointer: '/changed' },
          ],
        },
        graph[1]!,
      ],
    ],
  ] as const)('changes for %s changes', (_name, change) => {
    expect(findingsGraphFingerprint(change())).not.toBe(
      findingsGraphFingerprint(graph),
    );
  });

  it('folds the graph fingerprint into the summary source identity', () => {
    expect(
      summarySourceFingerprint({
        ...identity,
        findings: {
          ...identity.findings,
          graphFingerprint: findingsGraphFingerprint(graph),
        },
      }),
    ).not.toBe(summarySourceFingerprint(identity));
  });
});
