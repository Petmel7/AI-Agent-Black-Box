import { createHash } from 'node:crypto';

export const SUMMARY_GENERATOR_NAME = 'deterministic-structured-summary';
export const SUMMARY_GENERATOR_VERSION = 1;
export const SUMMARY_FORMAT_VERSION = 1;
export const SUMMARY_TEMPLATE_VERSION = 1;
export const MAX_INPUT_TESTS = 20_000;
export const MAX_INPUT_DIFFS = 20_000;
export const MAX_INPUT_FINDINGS = 100;
export const MAX_CLAIMS = 100;
export const MAX_SUPPORTS_PER_CLAIM = 100;
export const MAX_CLAIM_TEXT_LENGTH = 1_000;

export type SummaryOutcome = 'review' | 'pass' | 'unknown';
export type SummaryClaimClass =
  'observation' | 'deterministic_assessment' | 'limitation';
export type SummarySectionId = 'run' | 'evidence' | 'findings' | 'limitations';

export const SUMMARY_TEMPLATE_CATALOG = [
  { id: 'v1.run.observed-outcome', class: 'observation', sectionId: 'run' },
  {
    id: 'v1.evidence.git-diff-observations',
    class: 'observation',
    sectionId: 'evidence',
  },
  {
    id: 'v1.evidence.test-observations',
    class: 'observation',
    sectionId: 'evidence',
  },
  {
    id: 'v1.findings.bounded-pass',
    class: 'deterministic_assessment',
    sectionId: 'findings',
  },
  {
    id: 'v1.findings.triggered-rule',
    class: 'deterministic_assessment',
    sectionId: 'findings',
  },
  {
    id: 'v1.limitations.unknown-rule',
    class: 'limitation',
    sectionId: 'limitations',
  },
  {
    id: 'v1.limitations.core-incomplete',
    class: 'limitation',
    sectionId: 'limitations',
  },
  {
    id: 'v1.limitations.files-incomplete',
    class: 'limitation',
    sectionId: 'limitations',
  },
  {
    id: 'v1.limitations.run-outcome-unavailable',
    class: 'limitation',
    sectionId: 'limitations',
  },
  {
    id: 'v1.limitations.git-change-unavailable',
    class: 'limitation',
    sectionId: 'limitations',
  },
  {
    id: 'v1.limitations.tests-unavailable',
    class: 'limitation',
    sectionId: 'limitations',
  },
] as const satisfies readonly {
  id: string;
  class: SummaryClaimClass;
  sectionId: SummarySectionId;
}[];

export interface EvidenceSupport {
  kind: 'evidence';
  eventId: string;
  artifactId?: string;
  eventArtifactPointer?: string;
  jsonPointer?: string;
  fileOrdinal?: number;
  entryId?: string;
}

export interface FindingSupport {
  kind: 'finding';
  resultKey: string;
  ruleId: string;
  ruleVersion: number;
  findingsSourceFingerprint: string;
}

export type SummarySupport = EvidenceSupport | FindingSupport;

export interface SummaryTestObservation {
  outcome: 'passed' | 'failed' | 'cancelled' | 'unknown';
  evidence: EvidenceSupport;
}

export interface SummaryGitDiffObservation {
  filesChanged: number | null;
  evidence: EvidenceSupport;
}

export interface SummaryFinding {
  resultKey: string;
  ruleId: string;
  ruleVersion: number;
  severity: 'low' | 'medium' | 'high' | 'critical';
  outcome: 'triggered' | 'clear' | 'unknown';
  coverage: 'complete' | 'partial';
  reasonCodes: readonly string[];
}

export interface SummaryInput {
  organizationId: string;
  canonicalRunId: string;
  sourceFingerprint: string;
  findingsSourceFingerprint: string;
  findingsOutcome: SummaryOutcome;
  findingsCoverage: 'complete' | 'partial';
  coreComplete: boolean;
  filesState: 'complete' | 'missing' | 'stale' | 'incomplete';
  observedOutcome: 'succeeded' | 'failed' | 'cancelled' | 'unknown' | null;
  observedOutcomeEvidence: EvidenceSupport | null;
  tests: readonly SummaryTestObservation[];
  gitDiffs: readonly SummaryGitDiffObservation[];
  findings: readonly SummaryFinding[];
}

export interface SummaryClaim {
  claimKey: string;
  stableId: string;
  sectionId: SummarySectionId;
  sectionOrder: number;
  claimOrder: number;
  class: SummaryClaimClass;
  templateId: string;
  text: string;
  supportCount: number;
  supportsTruncated: boolean;
  supports: readonly SummarySupport[];
}

export interface StructuredSummary {
  summaryKey: string;
  generatorName: typeof SUMMARY_GENERATOR_NAME;
  generatorVersion: typeof SUMMARY_GENERATOR_VERSION;
  formatVersion: typeof SUMMARY_FORMAT_VERSION;
  templateVersion: typeof SUMMARY_TEMPLATE_VERSION;
  outcome: SummaryOutcome;
  sectionCount: number;
  claimCount: number;
  claimsTruncated: boolean;
  claims: readonly SummaryClaim[];
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const STABLE_IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,159}$/;

export const V1_FINDING_RULES = [
  'bbx.sensitive-area-change',
  'bbx.production-change-without-test-evidence',
  'bbx.tests-not-after-last-code-change',
  'bbx.final-tree-differs-from-tested-state',
  'bbx.repeated-failed-command',
  'bbx.lockfile-without-manifest',
  'bbx.test-removal-or-weakening',
  'bbx.out-of-scope-change',
  'bbx.success-claim-without-test-evidence',
] as const;

const V1_FINDING_RULE_SET: ReadonlySet<string> = new Set(V1_FINDING_RULES);

const RULE_LABELS: Readonly<Record<string, string>> = {
  'bbx.sensitive-area-change': 'sensitive-area change',
  'bbx.production-change-without-test-evidence':
    'production change without matching test evidence',
  'bbx.tests-not-after-last-code-change': 'tests after the last code change',
  'bbx.final-tree-differs-from-tested-state': 'final tree and tested state',
  'bbx.repeated-failed-command': 'repeated failed command',
  'bbx.lockfile-without-manifest': 'lockfile without manifest',
  'bbx.test-removal-or-weakening': 'test removal or weakening',
  'bbx.out-of-scope-change': 'out-of-scope change',
  'bbx.success-claim-without-test-evidence':
    'success claim without test evidence',
};
const RULE_SEVERITIES: Readonly<Record<string, SummaryFinding['severity']>> = {
  'bbx.sensitive-area-change': 'high',
  'bbx.production-change-without-test-evidence': 'high',
  'bbx.tests-not-after-last-code-change': 'high',
  'bbx.final-tree-differs-from-tested-state': 'high',
  'bbx.repeated-failed-command': 'medium',
  'bbx.lockfile-without-manifest': 'medium',
  'bbx.test-removal-or-weakening': 'high',
  'bbx.out-of-scope-change': 'high',
  'bbx.success-claim-without-test-evidence': 'high',
};

const SECTION_ORDER: Readonly<Record<SummarySectionId, number>> = {
  run: 0,
  evidence: 1,
  findings: 2,
  limitations: 3,
};
const TEMPLATE_BY_ID: ReadonlyMap<
  string,
  { class: SummaryClaimClass; sectionId: SummarySectionId }
> = new Map(
  SUMMARY_TEMPLATE_CATALOG.map((template) => [template.id, template]),
);

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function supportKey(support: SummarySupport): string {
  return support.kind === 'evidence'
    ? [
        support.kind,
        support.eventId,
        support.artifactId ?? '',
        support.eventArtifactPointer ?? '',
        support.jsonPointer ?? '',
        String(support.fileOrdinal ?? ''),
        support.entryId ?? '',
      ].join('\0')
    : [
        support.kind,
        support.resultKey,
        support.ruleId,
        support.ruleVersion,
        support.findingsSourceFingerprint,
      ].join('\0');
}

function validateEvidence(support: EvidenceSupport): void {
  if (support.kind !== 'evidence' || !UUID.test(support.eventId))
    throw new TypeError('Evidence support eventId must be a UUID.');
  const artifactFields = [
    support.artifactId,
    support.eventArtifactPointer,
    support.jsonPointer,
  ];
  const artifactCount = artifactFields.filter(
    (value) => value !== undefined,
  ).length;
  if (artifactCount !== 0 && artifactCount !== artifactFields.length)
    throw new TypeError('Evidence artifact support must be complete.');
  if (support.artifactId !== undefined && !UUID.test(support.artifactId))
    throw new TypeError('Evidence support artifactId must be a UUID.');
  for (const pointer of [support.eventArtifactPointer, support.jsonPointer])
    if (
      pointer !== undefined &&
      (pointer.length > 2_048 || !/^((\/([^~/]|~[01])*)*)$/.test(pointer))
    )
      throw new TypeError('Evidence support pointer must be bounded RFC 6901.');
  if ((support.fileOrdinal === undefined) !== (support.entryId === undefined))
    throw new TypeError('File evidence locator must be complete.');
  if (
    support.fileOrdinal !== undefined &&
    (!Number.isSafeInteger(support.fileOrdinal) ||
      support.fileOrdinal < 0 ||
      support.fileOrdinal >= 20_000 ||
      !support.entryId ||
      support.entryId.length > 256 ||
      support.artifactId === undefined)
  )
    throw new TypeError('File evidence locator is invalid.');
}

export function validateSummaryInput(input: SummaryInput): void {
  if (
    typeof input.coreComplete !== 'boolean' ||
    !Array.isArray(input.tests) ||
    !Array.isArray(input.gitDiffs) ||
    !Array.isArray(input.findings)
  )
    throw new TypeError('Summary input shape is invalid.');
  if (!UUID.test(input.organizationId) || !UUID.test(input.canonicalRunId))
    throw new TypeError(
      'Summary organization and run identities must be UUIDs.',
    );
  if (
    !SHA256.test(input.sourceFingerprint) ||
    !SHA256.test(input.findingsSourceFingerprint)
  )
    throw new TypeError('Summary source fingerprints must be SHA-256 values.');
  if (
    !['review', 'pass', 'unknown'].includes(input.findingsOutcome) ||
    !['complete', 'partial'].includes(input.findingsCoverage) ||
    !['complete', 'missing', 'stale', 'incomplete'].includes(
      input.filesState,
    ) ||
    (input.observedOutcome !== null &&
      !['succeeded', 'failed', 'cancelled', 'unknown'].includes(
        input.observedOutcome,
      ))
  )
    throw new TypeError('Summary input vocabulary is invalid.');
  if (
    input.tests.length > MAX_INPUT_TESTS ||
    input.gitDiffs.length > MAX_INPUT_DIFFS ||
    input.findings.length > MAX_INPUT_FINDINGS
  )
    throw new RangeError('Summary input exceeds deterministic bounds.');
  if (
    (input.observedOutcome === null) !==
    (input.observedOutcomeEvidence === null)
  )
    throw new TypeError('Observed outcome and evidence must be paired.');
  if (input.observedOutcomeEvidence)
    validateEvidence(input.observedOutcomeEvidence);
  for (const test of input.tests) {
    if (!['passed', 'failed', 'cancelled', 'unknown'].includes(test.outcome))
      throw new TypeError('Summary test outcome is invalid.');
    validateEvidence(test.evidence);
  }
  for (const diff of input.gitDiffs) {
    validateEvidence(diff.evidence);
    if (
      diff.filesChanged !== null &&
      (!Number.isSafeInteger(diff.filesChanged) || diff.filesChanged < 0)
    )
      throw new TypeError(
        'Git file counts must be non-negative safe integers.',
      );
  }
  const resultKeys = new Set<string>();
  const ruleIds = new Set<string>();
  for (const finding of input.findings) {
    if (
      !SHA256.test(finding.resultKey) ||
      !IDENTIFIER.test(finding.ruleId) ||
      !V1_FINDING_RULE_SET.has(finding.ruleId) ||
      finding.ruleVersion !== 1 ||
      finding.reasonCodes.length < 1 ||
      finding.reasonCodes.length > 20 ||
      finding.reasonCodes.some((reason: string) => !IDENTIFIER.test(reason)) ||
      !['low', 'medium', 'high', 'critical'].includes(finding.severity) ||
      finding.severity !== RULE_SEVERITIES[finding.ruleId] ||
      !['triggered', 'clear', 'unknown'].includes(finding.outcome) ||
      !['complete', 'partial'].includes(finding.coverage) ||
      (finding.outcome === 'clear' && finding.coverage !== 'complete') ||
      resultKeys.has(finding.resultKey) ||
      ruleIds.has(finding.ruleId)
    )
      throw new TypeError('Summary finding input is invalid.');
    resultKeys.add(finding.resultKey);
    ruleIds.add(finding.ruleId);
  }
  if (
    ruleIds.size !== V1_FINDING_RULES.length ||
    V1_FINDING_RULES.some((ruleId) => !ruleIds.has(ruleId))
  )
    throw new TypeError(
      'Summary findings must contain the exact compatible V1 catalog.',
    );
  const triggered = input.findings.some(
    (finding) => finding.outcome === 'triggered',
  );
  const unknown = input.findings.some(
    (finding) => finding.outcome === 'unknown',
  );
  const allClear = input.findings.every(
    (finding) => finding.outcome === 'clear' && finding.coverage === 'complete',
  );
  const derivedCoverage = input.findings.some(
    (finding) => finding.coverage === 'partial',
  )
    ? 'partial'
    : 'complete';
  if (
    input.findingsCoverage !== derivedCoverage ||
    (input.findingsOutcome === 'review' && !triggered) ||
    (input.findingsOutcome === 'unknown' && (triggered || !unknown)) ||
    (input.findingsOutcome === 'pass' && !allClear) ||
    (input.findingsOutcome === 'pass' &&
      input.findingsCoverage !== 'complete') ||
    (input.findingsOutcome === 'pass' &&
      (!input.coreComplete || input.filesState !== 'complete'))
  )
    throw new TypeError('Summary findings outcome is inconsistent.');
}

export function validateStructuredSummary(summary: StructuredSummary): void {
  if (
    !SHA256.test(summary.summaryKey) ||
    summary.generatorName !== SUMMARY_GENERATOR_NAME ||
    summary.generatorVersion !== SUMMARY_GENERATOR_VERSION ||
    summary.formatVersion !== SUMMARY_FORMAT_VERSION ||
    summary.templateVersion !== SUMMARY_TEMPLATE_VERSION ||
    !['review', 'pass', 'unknown'].includes(summary.outcome) ||
    !Array.isArray(summary.claims) ||
    summary.claimCount !== summary.claims.length ||
    typeof summary.claimsTruncated !== 'boolean' ||
    summary.claimCount < 1 ||
    summary.claimCount > MAX_CLAIMS ||
    summary.sectionCount !==
      new Set(summary.claims.map((claim) => claim.sectionId)).size
  )
    throw new TypeError('Structured summary envelope is invalid.');
  const seenKeys = new Set<string>();
  const seenStableIds = new Set<string>();
  const sectionCounts = new Map<SummarySectionId, number>();
  for (const claim of summary.claims as readonly SummaryClaim[]) {
    const template = TEMPLATE_BY_ID.get(claim.templateId);
    const expectedOrder = sectionCounts.get(claim.sectionId) ?? 0;
    if (
      !SHA256.test(claim.claimKey) ||
      !STABLE_IDENTIFIER.test(claim.stableId) ||
      seenKeys.has(claim.claimKey) ||
      seenStableIds.has(claim.stableId) ||
      !template ||
      template.class !== claim.class ||
      template.sectionId !== claim.sectionId ||
      claim.sectionOrder !== SECTION_ORDER[claim.sectionId] ||
      claim.claimOrder !== expectedOrder ||
      !claim.text ||
      claim.text.length > MAX_CLAIM_TEXT_LENGTH ||
      claim.supportCount !== claim.supports.length ||
      claim.supportCount < 1 ||
      claim.supportCount > MAX_SUPPORTS_PER_CLAIM ||
      typeof claim.supportsTruncated !== 'boolean'
    )
      throw new TypeError('Structured summary claim is invalid.');
    const supportKeys = new Set<string>();
    for (const support of claim.supports) {
      if (
        supportKeys.has(supportKey(support)) ||
        (claim.class === 'observation' && support.kind !== 'evidence') ||
        (claim.class !== 'observation' && support.kind !== 'finding')
      )
        throw new TypeError('Structured summary support is invalid.');
      supportKeys.add(supportKey(support));
      if (support.kind === 'evidence') validateEvidence(support);
      else if (
        !SHA256.test(support.resultKey) ||
        !IDENTIFIER.test(support.ruleId) ||
        !Number.isSafeInteger(support.ruleVersion) ||
        support.ruleVersion < 1 ||
        !SHA256.test(support.findingsSourceFingerprint)
      )
        throw new TypeError('Structured summary finding support is invalid.');
    }
    seenKeys.add(claim.claimKey);
    seenStableIds.add(claim.stableId);
    sectionCounts.set(claim.sectionId, expectedOrder + 1);
  }
}

type ClaimDraft = Omit<
  SummaryClaim,
  | 'claimKey'
  | 'sectionOrder'
  | 'claimOrder'
  | 'supportCount'
  | 'supportsTruncated'
  | 'supports'
> & { supports: readonly SummarySupport[] };

function findingSupport(
  finding: SummaryFinding,
  sourceFingerprint: string,
): FindingSupport {
  return {
    kind: 'finding',
    resultKey: finding.resultKey,
    ruleId: finding.ruleId,
    ruleVersion: finding.ruleVersion,
    findingsSourceFingerprint: sourceFingerprint,
  };
}

function uniqueSupports(values: readonly SummarySupport[]): SummarySupport[] {
  return [...values]
    .sort((left, right) => supportKey(left).localeCompare(supportKey(right)))
    .filter(
      (value, index, array) =>
        index === 0 || supportKey(array[index - 1]!) !== supportKey(value),
    );
}

function canonicalObservations(input: SummaryInput): {
  tests: SummaryTestObservation[];
  gitDiffs: SummaryGitDiffObservation[];
} {
  const tests = new Map<string, SummaryTestObservation>();
  for (const test of input.tests) {
    const key = supportKey(test.evidence);
    const existing = tests.get(key);
    if (existing && existing.outcome !== test.outcome)
      throw new TypeError(
        'Conflicting test observations share one evidence identity.',
      );
    tests.set(key, existing ?? test);
  }
  const gitDiffs = new Map<string, SummaryGitDiffObservation>();
  for (const diff of input.gitDiffs) {
    const key = supportKey(diff.evidence);
    const existing = gitDiffs.get(key);
    if (existing && existing.filesChanged !== diff.filesChanged)
      throw new TypeError(
        'Conflicting Git diff observations share one evidence identity.',
      );
    gitDiffs.set(key, existing ?? diff);
  }
  return {
    tests: [...tests.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, value]) => value),
    gitDiffs: [...gitDiffs.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, value]) => value),
  };
}

function limitationSupport(
  input: SummaryInput,
  preferredReasons: readonly string[] = [],
): FindingSupport[] {
  const preferred = input.findings.filter((finding) =>
    finding.reasonCodes.some((reason) => preferredReasons.includes(reason)),
  );
  const fallback = input.findings.filter(
    (finding) =>
      finding.outcome === 'unknown' || finding.coverage === 'partial',
  );
  return (
    preferred.length ? preferred : fallback.length ? fallback : input.findings
  )
    .slice(0, MAX_SUPPORTS_PER_CLAIM)
    .map((finding) => findingSupport(finding, input.findingsSourceFingerprint));
}

function drafts(input: SummaryInput): ClaimDraft[] {
  const claims: ClaimDraft[] = [];
  if (input.observedOutcome && input.observedOutcomeEvidence)
    claims.push({
      stableId: 'run.observed-outcome',
      sectionId: 'run',
      class: 'observation',
      templateId: 'v1.run.observed-outcome',
      text: `The recorded run reported an observed process outcome of ${input.observedOutcome}.`,
      supports: [input.observedOutcomeEvidence],
    });

  if (input.gitDiffs.length) {
    const knownCounts = input.gitDiffs
      .map((diff) => diff.filesChanged)
      .filter((value): value is number => value !== null);
    const text =
      input.gitDiffs.length === 1 && knownCounts.length === 1
        ? `Git diff evidence recorded ${knownCounts[0]} changed file or files.`
        : `Git diff evidence recorded ${input.gitDiffs.length} diff observation or observations; a single authoritative changed-file count is unavailable.`;
    claims.push({
      stableId: 'evidence.git-diff-observations',
      sectionId: 'evidence',
      class: 'observation',
      templateId: 'v1.evidence.git-diff-observations',
      text,
      supports: input.gitDiffs.map((diff) => diff.evidence),
    });
  }

  if (input.tests.length) {
    const counts = { passed: 0, failed: 0, cancelled: 0, unknown: 0 };
    for (const test of input.tests) counts[test.outcome] += 1;
    claims.push({
      stableId: 'evidence.test-observations',
      sectionId: 'evidence',
      class: 'observation',
      templateId: 'v1.evidence.test-observations',
      text: `Explicit test observations recorded ${counts.passed} passed, ${counts.failed} failed, ${counts.cancelled} cancelled, and ${counts.unknown} unknown outcome or outcomes. These observations do not prove complete correctness.`,
      supports: input.tests.map((test) => test.evidence),
    });
  }

  const orderedFindings = [...input.findings].sort((left, right) =>
    left.ruleId.localeCompare(right.ruleId),
  );
  if (input.findingsOutcome === 'pass')
    claims.push({
      stableId: 'findings.bounded-pass',
      sectionId: 'findings',
      class: 'deterministic_assessment',
      templateId: 'v1.findings.bounded-pass',
      text: `The current deterministic findings catalog is fully clear across ${orderedFindings.length} rule or rules with complete coverage. This bounded result is not correctness, merge-safety, task-completion, or policy approval.`,
      supports: orderedFindings.map((finding) =>
        findingSupport(finding, input.findingsSourceFingerprint),
      ),
    });
  else
    for (const finding of orderedFindings.filter(
      (item) => item.outcome === 'triggered',
    ))
      claims.push({
        stableId: `findings.triggered.${finding.ruleId}`,
        sectionId: 'findings',
        class: 'deterministic_assessment',
        templateId: 'v1.findings.triggered-rule',
        text: `The current deterministic catalog triggered the ${RULE_LABELS[finding.ruleId] ?? 'versioned rule'} assessment at ${finding.severity} severity.`,
        supports: [findingSupport(finding, input.findingsSourceFingerprint)],
      });

  for (const finding of orderedFindings.filter(
    (item) => item.outcome === 'unknown',
  ))
    claims.push({
      stableId: `limitations.unknown.${finding.ruleId}`,
      sectionId: 'limitations',
      class: 'limitation',
      templateId: 'v1.limitations.unknown-rule',
      text: `The ${RULE_LABELS[finding.ruleId] ?? 'versioned rule'} conclusion is unknown because the current deterministic evidence or coverage is insufficient.`,
      supports: [findingSupport(finding, input.findingsSourceFingerprint)],
    });

  if (!input.coreComplete)
    claims.push({
      stableId: 'limitations.core-incomplete',
      sectionId: 'limitations',
      class: 'limitation',
      templateId: 'v1.limitations.core-incomplete',
      text: 'Core evidence is incomplete, so unsupported completion or correctness conclusions are unavailable.',
      supports: limitationSupport(input, ['core_evidence_incomplete']),
    });
  if (input.filesState !== 'complete')
    claims.push({
      stableId: 'limitations.files-incomplete',
      sectionId: 'limitations',
      class: 'limitation',
      templateId: 'v1.limitations.files-incomplete',
      text: `File evidence is ${input.filesState}, so file-dependent conclusions remain bounded or unknown.`,
      supports: limitationSupport(input, ['file_evidence_incomplete']),
    });
  if (!input.observedOutcome)
    claims.push({
      stableId: 'limitations.run-outcome-unavailable',
      sectionId: 'limitations',
      class: 'limitation',
      templateId: 'v1.limitations.run-outcome-unavailable',
      text: 'A unique observed process outcome is unavailable; no task-completion conclusion is made.',
      supports: limitationSupport(input, ['core_evidence_incomplete']),
    });
  if (!input.gitDiffs.length)
    claims.push({
      stableId: 'limitations.git-change-unavailable',
      sectionId: 'limitations',
      class: 'limitation',
      templateId: 'v1.limitations.git-change-unavailable',
      text: 'Current deterministic findings do not support a positive Git-change availability or count claim.',
      supports: limitationSupport(input, ['file_evidence_incomplete']),
    });
  if (!input.tests.length)
    claims.push({
      stableId: 'limitations.tests-unavailable',
      sectionId: 'limitations',
      class: 'limitation',
      templateId: 'v1.limitations.tests-unavailable',
      text: 'Current deterministic findings do not support a positive testing or correctness conclusion.',
      supports: limitationSupport(input, [
        'success_claim_contract_unavailable',
        'test_relevance_unproven',
        'core_evidence_incomplete',
      ]),
    });
  return claims;
}

export function generateSummary(input: SummaryInput): StructuredSummary {
  validateSummaryInput(input);
  const observations = canonicalObservations(input);
  const canonicalInput: SummaryInput = { ...input, ...observations };
  const summaryKey = hash(
    [
      input.organizationId,
      input.canonicalRunId,
      SUMMARY_GENERATOR_NAME,
      SUMMARY_GENERATOR_VERSION,
      SUMMARY_FORMAT_VERSION,
      SUMMARY_TEMPLATE_VERSION,
      input.sourceFingerprint,
    ].join('\n'),
  );
  const allDrafts = drafts(canonicalInput);
  const prepared = allDrafts
    .sort(
      (left, right) =>
        SECTION_ORDER[left.sectionId] - SECTION_ORDER[right.sectionId] ||
        left.stableId.localeCompare(right.stableId),
    )
    .slice(0, MAX_CLAIMS);
  const sectionClaims = new Map<SummarySectionId, number>();
  const claims = prepared.map((draft) => {
    const template = TEMPLATE_BY_ID.get(draft.templateId);
    if (
      !template ||
      template.class !== draft.class ||
      template.sectionId !== draft.sectionId
    )
      throw new TypeError(
        'Summary claim does not match the V1 template catalog.',
      );
    const supports = uniqueSupports(draft.supports);
    if (supports.length === 0)
      throw new TypeError('Every summary claim requires typed support.');
    if (
      (draft.class === 'observation' &&
        supports.some((support) => support.kind !== 'evidence')) ||
      (draft.class !== 'observation' &&
        supports.some((support) => support.kind !== 'finding'))
    )
      throw new TypeError(
        'Summary claim class and support kind are incompatible.',
      );
    if (!draft.text || draft.text.length > MAX_CLAIM_TEXT_LENGTH)
      throw new RangeError('Summary claim text exceeds deterministic bounds.');
    const claimOrder = sectionClaims.get(draft.sectionId) ?? 0;
    sectionClaims.set(draft.sectionId, claimOrder + 1);
    return {
      ...draft,
      claimKey: hash(`${summaryKey}\n${draft.stableId}`),
      sectionOrder: SECTION_ORDER[draft.sectionId],
      claimOrder,
      supportCount: Math.min(supports.length, MAX_SUPPORTS_PER_CLAIM),
      supportsTruncated: supports.length > MAX_SUPPORTS_PER_CLAIM,
      supports: supports.slice(0, MAX_SUPPORTS_PER_CLAIM),
    };
  });
  const summary: StructuredSummary = {
    summaryKey,
    generatorName: SUMMARY_GENERATOR_NAME,
    generatorVersion: SUMMARY_GENERATOR_VERSION,
    formatVersion: SUMMARY_FORMAT_VERSION,
    templateVersion: SUMMARY_TEMPLATE_VERSION,
    outcome: input.findingsOutcome,
    sectionCount: new Set(claims.map((claim) => claim.sectionId)).size,
    claimCount: claims.length,
    claimsTruncated: allDrafts.length > MAX_CLAIMS,
    claims,
  };
  validateStructuredSummary(summary);
  return summary;
}
