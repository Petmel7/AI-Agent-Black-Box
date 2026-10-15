import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  generateSummary,
  SUMMARY_TEMPLATE_CATALOG,
  V1_FINDING_RULES,
  type SummaryFinding,
  type SummaryInput,
  validateStructuredSummary,
} from './index.js';

const organizationId = '00000000-0000-4000-8000-000000000001';
const canonicalRunId = '00000000-0000-4000-8000-000000000002';
const sourceFingerprint = 'a'.repeat(64);
const findingsSourceFingerprint = 'b'.repeat(64);

function finding(
  ruleId: string,
  outcome: SummaryFinding['outcome'],
  coverage: SummaryFinding['coverage'] = 'complete',
): SummaryFinding {
  return {
    resultKey: Buffer.from(ruleId).toString('hex').padEnd(64, '0').slice(0, 64),
    ruleId,
    ruleVersion: 1,
    severity: [
      'bbx.repeated-failed-command',
      'bbx.lockfile-without-manifest',
    ].includes(ruleId)
      ? 'medium'
      : 'high',
    outcome,
    coverage,
    reasonCodes: [outcome === 'unknown' ? 'evidence_incomplete' : 'evaluated'],
  };
}

const rules = [...V1_FINDING_RULES];

function input(overrides: Partial<SummaryInput> = {}): SummaryInput {
  return {
    organizationId,
    canonicalRunId,
    sourceFingerprint,
    findingsSourceFingerprint,
    findingsOutcome: 'pass',
    findingsCoverage: 'complete',
    coreComplete: true,
    filesState: 'complete',
    observedOutcome: 'succeeded',
    observedOutcomeEvidence: {
      kind: 'evidence',
      eventId: '00000000-0000-4000-8000-000000000003',
    },
    tests: [
      {
        outcome: 'passed',
        evidence: {
          kind: 'evidence',
          eventId: '00000000-0000-4000-8000-000000000004',
        },
      },
    ],
    gitDiffs: [
      {
        filesChanged: 2,
        evidence: {
          kind: 'evidence',
          eventId: '00000000-0000-4000-8000-000000000005',
        },
      },
    ],
    findings: rules.map((rule) => finding(rule, 'clear')),
    ...overrides,
  };
}

describe('V1 deterministic structured summary', () => {
  it('keeps the checked-in incomplete-evidence fixture valid and conservative', () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL('../fixtures/v1-unknown-input.json', import.meta.url),
        'utf8',
      ),
    ) as SummaryInput;
    const summary = generateSummary(fixture);
    expect(summary.outcome).toBe('unknown');
    expect(summary.claims.every((claim) => claim.class === 'limitation')).toBe(
      true,
    );
  });

  it('publishes a stable template catalog across every V1 class and section', () => {
    expect(new Set(SUMMARY_TEMPLATE_CATALOG.map((item) => item.class))).toEqual(
      new Set(['observation', 'deterministic_assessment', 'limitation']),
    );
    expect(
      new Set(SUMMARY_TEMPLATE_CATALOG.map((item) => item.sectionId)),
    ).toEqual(new Set(['run', 'evidence', 'findings', 'limitations']));
    expect(new Set(SUMMARY_TEMPLATE_CATALOG.map((item) => item.id)).size).toBe(
      SUMMARY_TEMPLATE_CATALOG.length,
    );
  });

  it('emits ordered observation and bounded-pass claims with typed support', () => {
    const summary = generateSummary(input());
    expect(summary.outcome).toBe('pass');
    expect(summary.claims.map((claim) => claim.sectionId)).toEqual([
      'run',
      'evidence',
      'evidence',
      'findings',
    ]);
    expect(summary.claims.map((claim) => claim.class)).toEqual([
      'observation',
      'observation',
      'observation',
      'deterministic_assessment',
    ]);
    expect(summary.claims.every((claim) => claim.supports.length > 0)).toBe(
      true,
    );
    expect(summary.claims.at(-1)?.text).toContain(
      'not correctness, merge-safety, task-completion, or policy approval',
    );
  });

  it('is byte-equivalent across input permutations and replay', () => {
    const original = input({
      tests: [
        ...input().tests,
        {
          outcome: 'failed',
          evidence: {
            kind: 'evidence',
            eventId: '00000000-0000-4000-8000-000000000006',
          },
        },
      ],
    });
    const permuted = {
      ...original,
      tests: [...original.tests].reverse(),
      gitDiffs: [...original.gitDiffs].reverse(),
      findings: [...original.findings].reverse(),
    };
    expect(JSON.stringify(generateSummary(permuted))).toBe(
      JSON.stringify(generateSummary(original)),
    );
  });

  it('canonicalizes exact duplicate test observations before counting and support selection', () => {
    const duplicate = input().tests[0]!;
    const claim = generateSummary(
      input({ tests: [duplicate, { ...duplicate }] }),
    ).claims.find((item) => item.stableId === 'evidence.test-observations');
    expect(claim).toMatchObject({ supportCount: 1, supportsTruncated: false });
    expect(claim?.text).toContain('1 passed, 0 failed');
  });

  it('rejects conflicting test outcomes for one evidence identity', () => {
    const observation = input().tests[0]!;
    expect(() =>
      generateSummary(
        input({
          tests: [observation, { ...observation, outcome: 'failed' }],
        }),
      ),
    ).toThrow('Conflicting test observations');
  });

  it('canonicalizes exact duplicate Git observations before wording and support selection', () => {
    const duplicate = input().gitDiffs[0]!;
    const claim = generateSummary(
      input({ gitDiffs: [duplicate, { ...duplicate }] }),
    ).claims.find((item) => item.stableId === 'evidence.git-diff-observations');
    expect(claim).toMatchObject({ supportCount: 1, supportsTruncated: false });
    expect(claim?.text).toContain('2 changed file or files');
  });

  it('rejects conflicting Git counts for one evidence identity', () => {
    const observation = input().gitDiffs[0]!;
    expect(() =>
      generateSummary(
        input({
          gitDiffs: [observation, { ...observation, filesChanged: 3 }],
        }),
      ),
    ).toThrow('Conflicting Git diff observations');
  });

  it('keeps canonical observation identity stable across duplicate permutations', () => {
    const passed = input().tests[0]!;
    const diff = input().gitDiffs[0]!;
    const failed = {
      outcome: 'failed' as const,
      evidence: {
        kind: 'evidence' as const,
        eventId: '00000000-0000-4000-8000-000000000006',
      },
    };
    const left = generateSummary(
      input({
        tests: [passed, failed, { ...passed }, { ...failed }],
        gitDiffs: [diff, { ...diff }],
      }),
    );
    const right = generateSummary(
      input({
        tests: [{ ...failed }, passed, failed, { ...passed }],
        gitDiffs: [{ ...diff }, diff],
      }),
    );
    expect(JSON.stringify(left)).toBe(JSON.stringify(right));
  });

  it.each([
    ['missing rule', () => input({ findings: input().findings.slice(0, -1) })],
    [
      'duplicate rule with a unique result key',
      () => {
        const findings = [...input().findings];
        findings[8] = {
          ...findings[0]!,
          resultKey: 'f'.repeat(64),
        };
        return input({ findings });
      },
    ],
    [
      'unknown rule',
      () => {
        const findings = [...input().findings];
        findings[8] = finding('bbx.unrecognized-rule', 'clear');
        return input({ findings });
      },
    ],
    [
      'version-incompatible rule',
      () => {
        const findings = [...input().findings];
        findings[8] = { ...findings[8]!, ruleVersion: 2 };
        return input({ findings });
      },
    ],
  ])('rejects a %s catalog', (_name, createInput) => {
    expect(() => generateSummary(createInput())).toThrow();
  });

  it('accepts every permutation only when the exact V1 catalog is present', () => {
    const original = generateSummary(input());
    for (const findings of [
      [...input().findings].reverse(),
      [...input().findings.slice(3), ...input().findings.slice(0, 3)],
    ])
      expect(JSON.stringify(generateSummary(input({ findings })))).toBe(
        JSON.stringify(original),
      );
  });

  it('emits review assessments only for exact triggered findings', () => {
    const findings = rules.map((rule, index) =>
      finding(rule, index === 0 ? 'triggered' : 'clear'),
    );
    const summary = generateSummary(
      input({
        findingsOutcome: 'review',
        findingsCoverage: 'complete',
        findings,
      }),
    );
    const assessment = summary.claims.find(
      (claim) => claim.class === 'deterministic_assessment',
    );
    expect(assessment?.stableId).toBe(
      'findings.triggered.bbx.sensitive-area-change',
    );
    expect(assessment?.supports).toEqual([
      {
        kind: 'finding',
        resultKey: findings[0]!.resultKey,
        ruleId: findings[0]!.ruleId,
        ruleVersion: 1,
        findingsSourceFingerprint,
      },
    ]);
  });

  it('turns incomplete inputs into unknown with visible supported limitations', () => {
    const findings = rules.map((rule) => finding(rule, 'unknown', 'partial'));
    const summary = generateSummary(
      input({
        findingsOutcome: 'unknown',
        findingsCoverage: 'partial',
        coreComplete: false,
        filesState: 'missing',
        observedOutcome: null,
        observedOutcomeEvidence: null,
        tests: [],
        gitDiffs: [],
        findings,
      }),
    );
    expect(summary.outcome).toBe('unknown');
    expect(summary.claims.every((claim) => claim.class === 'limitation')).toBe(
      true,
    );
    expect(summary.claims.map((claim) => claim.stableId)).toEqual(
      expect.arrayContaining([
        'limitations.core-incomplete',
        'limitations.files-incomplete',
        'limitations.run-outcome-unavailable',
        'limitations.git-change-unavailable',
        'limitations.tests-unavailable',
      ]),
    );
    expect(
      summary.claims.every((claim) =>
        claim.supports.every((support) => support.kind === 'finding'),
      ),
    ).toBe(true);
  });

  it.each([
    [100, false],
    [101, true],
  ] as const)(
    'keeps observation count and support truncation aligned for %i canonical observations',
    (count, truncated) => {
      const tests = Array.from({ length: count }, (_, index) => ({
        outcome: 'passed' as const,
        evidence: {
          kind: 'evidence' as const,
          eventId: `00000000-0000-4000-8${String(index).padStart(3, '0')}-000000000004`,
        },
      }));
      const summary = generateSummary(input({ tests }));
      const claim = summary.claims.find(
        (item) => item.stableId === 'evidence.test-observations',
      );
      expect(claim).toMatchObject({
        supportCount: Math.min(count, 100),
        supportsTruncated: truncated,
      });
      expect(claim?.supports).toHaveLength(Math.min(count, 100));
      expect(claim?.text).toContain(`${count} passed`);
    },
  );

  it.each([
    [100, false],
    [101, true],
  ] as const)(
    'keeps Git count and support truncation aligned for %i canonical observations',
    (count, truncated) => {
      const gitDiffs = Array.from({ length: count }, (_, index) => ({
        filesChanged: index,
        evidence: {
          kind: 'evidence' as const,
          eventId: `00000000-0000-4000-9${String(index).padStart(3, '0')}-000000000005`,
        },
      }));
      const summary = generateSummary(input({ gitDiffs }));
      const claim = summary.claims.find(
        (item) => item.stableId === 'evidence.git-diff-observations',
      );
      expect(claim).toMatchObject({
        supportCount: Math.min(count, 100),
        supportsTruncated: truncated,
      });
      expect(claim?.supports).toHaveLength(Math.min(count, 100));
      expect(claim?.text).toContain(`${count} diff observation`);
    },
  );

  it('rejects partial locators, inconsistent outcomes, and unsupported claims', () => {
    expect(() =>
      generateSummary(
        input({
          observedOutcomeEvidence: {
            kind: 'evidence',
            eventId: '00000000-0000-4000-8000-000000000003',
            artifactId: '00000000-0000-4000-8000-000000000009',
          },
        }),
      ),
    ).toThrow('artifact support must be complete');
    expect(() =>
      generateSummary(input({ findingsOutcome: 'pass', coreComplete: false })),
    ).toThrow('outcome is inconsistent');
    expect(() =>
      generateSummary(
        input({
          findingsOutcome: 'pass',
          findings: rules.map((rule) => finding(rule, 'unknown', 'partial')),
        }),
      ),
    ).toThrow('outcome is inconsistent');
    const valid = generateSummary(input());
    expect(() =>
      validateStructuredSummary({
        ...valid,
        claims: [
          {
            ...valid.claims[0]!,
            class: 'limitation',
          },
          ...valid.claims.slice(1),
        ],
      }),
    ).toThrow('claim is invalid');
  });

  it('uses conservative wording and never emits causality or optimistic approval', () => {
    const texts = generateSummary(input()).claims.map((claim) => claim.text);
    for (const text of texts) {
      expect(text).not.toMatch(
        /agent (?:caused|completed)|(?:is|was|deemed) merge[- ]safe|safe to merge/i,
      );
      expect(text).not.toMatch(/tests? prove(?:s|d)? correctness/i);
    }
  });
});
