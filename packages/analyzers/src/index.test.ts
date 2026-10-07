import { describe, expect, it } from 'vitest';

import {
  MAX_MATCHES,
  RULE_CATALOG,
  evaluateCatalog,
  type AnalyzerFile,
  type AnalyzerInput,
} from './index.js';

const runId = '00000000-0000-4000-8000-000000000001';
const organizationId = '00000000-0000-4000-8000-000000000002';

function file(
  path: string,
  overrides: Partial<AnalyzerFile> = {},
): AnalyzerFile {
  const ordinal = overrides.evidence?.fileOrdinal ?? 0;
  const { evidence, ...rest } = overrides;
  return {
    displayPath: path,
    displayAmbiguous: false,
    attribution: 'observed-during-run',
    changeKind: 'modified',
    evidence: {
      eventId: '00000000-0000-4000-8000-000000000010',
      artifactId: '00000000-0000-4000-8000-000000000011',
      eventArtifactPointer: '/payload/fileListArtifact',
      jsonPointer: `/files/${ordinal}`,
      fileOrdinal: ordinal,
      entryId: `entry-${ordinal}`,
      ...evidence,
    },
    ...rest,
  };
}

function input(overrides: Partial<AnalyzerInput> = {}): AnalyzerInput {
  return {
    organizationId,
    canonicalRunId: runId,
    coreComplete: true,
    filesState: 'complete',
    files: [],
    commands: [],
    successfulTestCount: 0,
    ...overrides,
  };
}

function rule(value: AnalyzerInput, id: (typeof RULE_CATALOG)[number]['id']) {
  return evaluateCatalog(value).results.find((result) => result.id === id)!;
}

describe('V1 deterministic catalog', () => {
  it('always emits all nine stable ordered rules and conservative run outcome', () => {
    const result = evaluateCatalog(input());
    expect(result.results.map((item) => item.id)).toEqual(
      RULE_CATALOG.map((item) => item.id),
    );
    expect(result.results).toHaveLength(9);
    expect(result.deterministicOutcome).toBe('unknown');
    expect(
      result.results
        .filter((item) => item.outcome === 'unknown')
        .map((item) => item.id),
    ).toEqual([
      'bbx.tests-not-after-last-code-change',
      'bbx.final-tree-differs-from-tested-state',
      'bbx.out-of-scope-change',
      'bbx.success-claim-without-test-evidence',
    ]);
  });

  it.each([
    ['src/auth/session.ts', 'bbx.sensitive-area-change'],
    ['infra/deploy.ts', 'bbx.sensitive-area-change'],
    ['db/migrations/001.sql', 'bbx.sensitive-area-change'],
    ['packages/app/package.json', 'bbx.sensitive-area-change'],
  ] as const)('triggers fixed sensitive classification for %s', (path, id) => {
    const result = rule(input({ files: [file(path)] }), id);
    expect(result).toMatchObject({
      outcome: 'triggered',
      coverage: 'complete',
    });
    expect(result.references).toHaveLength(1);
  });

  it('normalizes only separators and ASCII case for path classification', () => {
    expect(
      rule(
        input({ files: [file('SRC\\AUTH\\Token.TS')] }),
        'bbx.sensitive-area-change',
      ),
    ).toMatchObject({
      outcome: 'triggered',
      matches: ['SRC\\AUTH\\Token.TS'],
    });
  });

  it('ignores pre-existing changes and preserves mixed attribution as partial non-causal evidence', () => {
    expect(
      rule(
        input({
          files: [file('src/auth.ts', { attribution: 'pre-existing' })],
        }),
        'bbx.sensitive-area-change',
      ).outcome,
    ).toBe('clear');
    expect(
      rule(
        input({
          files: [file('src/auth.ts', { attribution: 'mixed-or-uncertain' })],
        }),
        'bbx.sensitive-area-change',
      ),
    ).toMatchObject({ outcome: 'triggered', coverage: 'partial' });
  });

  it('makes ambiguous or unavailable file evidence unknown rather than clear', () => {
    expect(
      rule(
        input({ files: [file('[REDACTED].ts', { displayAmbiguous: true })] }),
        'bbx.sensitive-area-change',
      ).outcome,
    ).toBe('unknown');
    expect(
      rule(
        input({ files: [file('[REDACTED]/auth.ts')] }),
        'bbx.sensitive-area-change',
      ).outcome,
    ).toBe('unknown');
    expect(
      rule(input({ filesState: 'incomplete' }), 'bbx.lockfile-without-manifest')
        .outcome,
    ).toBe('unknown');
  });

  it.each([
    {
      side: 'current',
      renamed: file('SRC\\AUTH\\Token.TS', {
        originalDisplayPath: '[REDACTED]/legacy.ts',
        changeKind: 'renamed',
      }),
      expectedMatch: 'SRC\\AUTH\\Token.TS',
    },
    {
      side: 'current with ambiguous counterpart',
      renamed: file('SRC\\AUTH\\Ambiguous.TS', {
        originalDisplayPath: '[REDACTED]/legacy.ts',
        displayAmbiguous: true,
        displayReason: 'redaction-collision',
        changeKind: 'renamed',
      }),
      expectedMatch: 'SRC\\AUTH\\Ambiguous.TS',
    },
    {
      side: 'original',
      renamed: file('[REDACTED]/current.ts', {
        originalDisplayPath: 'Legacy\\AUTH\\Session.TS',
        displayAmbiguous: true,
        displayReason: 'redaction-collision',
        changeKind: 'renamed',
      }),
      expectedMatch: 'Legacy\\AUTH\\Session.TS',
    },
    {
      side: 'current with unavailable origin',
      renamed: file('Infra\\Deploy.TS', {
        originalDisplayPath: null,
        changeKind: 'renamed',
      }),
      expectedMatch: 'Infra\\Deploy.TS',
    },
  ])(
    'classifies the safe $side rename path and retains its display spelling',
    ({ renamed, expectedMatch }) => {
      expect(
        rule(input({ files: [renamed] }), 'bbx.sensitive-area-change'),
      ).toMatchObject({
        outcome: 'triggered',
        coverage: 'partial',
        matches: [expectedMatch],
      });
    },
  );

  it('requires a deterministic related test relation to clear production changes', () => {
    const production = file('src/cart.ts', {
      evidence: {
        eventId: '00000000-0000-4000-8000-000000000010',
        fileOrdinal: 0,
        entryId: 'prod',
      },
    });
    const related = file('tests/cart.test.ts', {
      evidence: {
        eventId: '00000000-0000-4000-8000-000000000010',
        fileOrdinal: 1,
        entryId: 'test',
      },
    });
    expect(
      rule(
        input({ files: [production] }),
        'bbx.production-change-without-test-evidence',
      ).outcome,
    ).toBe('triggered');
    expect(
      rule(
        input({ files: [production], successfulTestCount: 1 }),
        'bbx.production-change-without-test-evidence',
      ).outcome,
    ).toBe('unknown');
    expect(
      rule(
        input({ files: [production, related] }),
        'bbx.production-change-without-test-evidence',
      ).outcome,
    ).toBe('clear');
    expect(
      rule(
        input({ files: [production, related], coreComplete: false }),
        'bbx.production-change-without-test-evidence',
      ),
    ).toMatchObject({
      outcome: 'unknown',
      coverage: 'partial',
      reasonCodes: ['core_evidence_incomplete'],
    });
    expect(
      rule(
        input({
          files: [production, { ...related, changeKind: 'deleted' }],
        }),
        'bbx.production-change-without-test-evidence',
      ).outcome,
    ).toBe('triggered');
  });

  it('classifies safe rename origins without treating a renamed-away test as positive test evidence', () => {
    const renamed = file('src/cart.ts', {
      originalDisplayPath: 'tests/cart.test.ts',
      changeKind: 'renamed',
    });
    expect(
      rule(
        input({ files: [renamed] }),
        'bbx.production-change-without-test-evidence',
      ).outcome,
    ).toBe('triggered');
    expect(
      rule(
        input({
          files: [
            file('src/session.ts', {
              originalDisplayPath: 'src/auth/session.ts',
              changeKind: 'renamed',
            }),
          ],
        }),
        'bbx.sensitive-area-change',
      ).outcome,
    ).toBe('triggered');
    expect(
      rule(
        input({
          files: [
            file('web/dependencies.lock', {
              originalDisplayPath: 'web/pnpm-lock.yaml',
              changeKind: 'renamed',
            }),
          ],
        }),
        'bbx.lockfile-without-manifest',
      ).outcome,
    ).toBe('triggered');
  });

  it('classifies production and test rename paths independently', () => {
    const currentProduction = file('SRC\\Cart.TS', {
      originalDisplayPath: '[REDACTED]/old.ts',
      changeKind: 'renamed',
    });
    expect(
      rule(
        input({ files: [currentProduction] }),
        'bbx.production-change-without-test-evidence',
      ),
    ).toMatchObject({
      outcome: 'triggered',
      coverage: 'partial',
      matches: ['SRC\\Cart.TS'],
    });

    const originalProduction = file('[REDACTED]/current.ts', {
      originalDisplayPath: 'Legacy\\SRC\\Cart.TS',
      changeKind: 'renamed',
    });
    expect(
      rule(
        input({ files: [originalProduction] }),
        'bbx.production-change-without-test-evidence',
      ),
    ).toMatchObject({
      outcome: 'triggered',
      coverage: 'partial',
      matches: ['Legacy\\SRC\\Cart.TS'],
    });

    const production = file('src/cart.ts');
    const currentTest = file('TESTS\\Cart.TEST.TS', {
      originalDisplayPath: '[REDACTED]/old.test.ts',
      changeKind: 'renamed',
      evidence: {
        eventId: '00000000-0000-4000-8000-000000000010',
        fileOrdinal: 1,
        entryId: 'current-test',
      },
    });
    expect(
      rule(
        input({ files: [production, currentTest] }),
        'bbx.production-change-without-test-evidence',
      ),
    ).toMatchObject({ outcome: 'unknown', coverage: 'partial' });

    const renamedAwayTest = file('[REDACTED]/current.test.ts', {
      originalDisplayPath: 'TESTS\\Cart.TEST.TS',
      changeKind: 'renamed',
      evidence: {
        eventId: '00000000-0000-4000-8000-000000000010',
        fileOrdinal: 1,
        entryId: 'original-test',
      },
    });
    expect(
      rule(
        input({ files: [production, renamedAwayTest] }),
        'bbx.production-change-without-test-evidence',
      ),
    ).toMatchObject({ outcome: 'triggered', coverage: 'partial' });
  });

  it('requires two distinct failures with the same complete redacted identity', () => {
    const command = (operationId: string, available = true) => ({
      operationId,
      state: 'complete' as const,
      outcome: 'failed',
      commandIdentity: available ? 'pnpm test' : null,
      identityAvailable: available,
      evidence: {
        eventId:
          operationId === '00000000-0000-4000-8000-000000000020'
            ? '00000000-0000-4000-8000-000000000030'
            : '00000000-0000-4000-8000-000000000031',
      },
    });
    expect(
      rule(
        input({
          commands: [
            command('00000000-0000-4000-8000-000000000020'),
            command('00000000-0000-4000-8000-000000000021'),
          ],
        }),
        'bbx.repeated-failed-command',
      ),
    ).toMatchObject({ outcome: 'triggered', coverage: 'complete' });
    expect(
      rule(
        input({
          commands: [command('00000000-0000-4000-8000-000000000020', false)],
        }),
        'bbx.repeated-failed-command',
      ).outcome,
    ).toBe('unknown');
  });

  it('uses only the corresponding same-directory ecosystem manifest', () => {
    expect(
      rule(
        input({
          files: [
            file('web/pnpm-lock.yaml'),
            file('api/package.json', {
              evidence: {
                eventId: '00000000-0000-4000-8000-000000000010',
                fileOrdinal: 1,
                entryId: 'manifest',
              },
            }),
          ],
        }),
        'bbx.lockfile-without-manifest',
      ).outcome,
    ).toBe('triggered');
    expect(
      rule(
        input({
          files: [
            file('web/pnpm-lock.yaml'),
            file('web/package.json', {
              evidence: {
                eventId: '00000000-0000-4000-8000-000000000010',
                fileOrdinal: 1,
                entryId: 'manifest',
              },
            }),
          ],
        }),
        'bbx.lockfile-without-manifest',
      ).outcome,
    ).toBe('clear');
  });

  it.each([
    {
      side: 'current',
      lockfile: file('WEB\\PNPM-LOCK.YAML', {
        originalDisplayPath: '[REDACTED]/old.lock',
        changeKind: 'renamed',
      }),
      expectedMatch: 'WEB\\PNPM-LOCK.YAML',
    },
    {
      side: 'original',
      lockfile: file('[REDACTED]/current.lock', {
        originalDisplayPath: 'Legacy\\PNPM-LOCK.YAML',
        changeKind: 'renamed',
      }),
      expectedMatch: 'Legacy\\PNPM-LOCK.YAML',
    },
  ])(
    'classifies a safe $side lockfile path while its rename counterpart is unknown',
    ({ lockfile, expectedMatch }) => {
      expect(
        rule(input({ files: [lockfile] }), 'bbx.lockfile-without-manifest'),
      ).toMatchObject({
        outcome: 'triggered',
        coverage: 'partial',
        matches: [expectedMatch],
      });
    },
  );

  it.each([
    file('WEB\\PACKAGE.JSON', {
      originalDisplayPath: '[REDACTED]/old.json',
      changeKind: 'renamed',
    }),
    file('[REDACTED]/current.json', {
      originalDisplayPath: 'WEB\\PACKAGE.JSON',
      changeKind: 'renamed',
    }),
  ])('recognizes a safe manifest rename path from either side', (manifest) => {
    expect(
      rule(
        input({
          files: [file('web/pnpm-lock.yaml'), manifest],
        }),
        'bbx.lockfile-without-manifest',
      ),
    ).toMatchObject({ outcome: 'unknown', coverage: 'partial' });
  });

  it('triggers only deletion for test removal and treats modify/rename conservatively', () => {
    expect(
      rule(
        input({ files: [file('tests/a.test.ts', { changeKind: 'deleted' })] }),
        'bbx.test-removal-or-weakening',
      ).outcome,
    ).toBe('triggered');
    expect(
      rule(
        input({ files: [file('tests/a.test.ts', { changeKind: 'modified' })] }),
        'bbx.test-removal-or-weakening',
      ).outcome,
    ).toBe('unknown');
    expect(
      rule(
        input({
          files: [
            file('tests/a.test.ts', {
              originalDisplayPath: 'tests/old-a.test.ts',
              changeKind: 'renamed',
            }),
          ],
        }),
        'bbx.test-removal-or-weakening',
      ).outcome,
    ).toBe('clear');
    expect(
      rule(
        input({
          files: [
            file('src/a.ts', {
              originalDisplayPath: 'tests/a.test.ts',
              changeKind: 'renamed',
            }),
          ],
        }),
        'bbx.test-removal-or-weakening',
      ).outcome,
    ).toBe('clear');
  });

  it('is invariant to input permutations and has stable result identities', () => {
    const files = [
      file('src/auth.ts', {
        evidence: {
          eventId: '00000000-0000-4000-8000-000000000010',
          fileOrdinal: 0,
          entryId: 'a',
        },
      }),
      file('infra/main.tf', {
        evidence: {
          eventId: '00000000-0000-4000-8000-000000000010',
          fileOrdinal: 1,
          entryId: 'b',
        },
      }),
    ];
    expect(evaluateCatalog(input({ files }))).toEqual(
      evaluateCatalog(input({ files: [...files].reverse() })),
    );
    expect(
      evaluateCatalog(input()).results.map((result) => result.resultKey),
    ).not.toEqual(
      evaluateCatalog(
        input({
          organizationId: '00000000-0000-4000-8000-000000000003',
        }),
      ).results.map((result) => result.resultKey),
    );
  });

  it('caps matches and references with explicit deterministic truncation', () => {
    const files = Array.from({ length: MAX_MATCHES + 2 }, (_, ordinal) =>
      file(`src/auth/${String(ordinal).padStart(3, '0')}.ts`, {
        evidence: {
          eventId: '00000000-0000-4000-8000-000000000010',
          fileOrdinal: ordinal,
          entryId: `e-${ordinal}`,
        },
      }),
    );
    const result = rule(input({ files }), 'bbx.sensitive-area-change');
    expect(result).toMatchObject({
      matchCount: MAX_MATCHES + 2,
      matchesTruncated: true,
      referencesTruncated: true,
    });
    expect(result.matches).toHaveLength(MAX_MATCHES);
    expect(result.references).toHaveLength(MAX_MATCHES);
  });
});
