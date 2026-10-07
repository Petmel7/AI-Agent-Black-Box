import { createHash } from 'node:crypto';

export const ANALYZER_NAME = 'deterministic-findings';
export const ANALYZER_VERSION = 1;
export const CATALOG_VERSION = 1;
export const MAX_INPUT_FILES = 20_000;
export const MAX_INPUT_COMMANDS = 20_000;
export const MAX_MATCHES = 100;
export const MAX_REFERENCES = 100;
export const MAX_EXPLANATION_LENGTH = 1_000;

export type FindingOutcome = 'triggered' | 'clear' | 'unknown';
export type FindingCoverage = 'complete' | 'partial';
export type FindingSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface AnalyzerEvidenceReference {
  eventId: string;
  artifactId?: string;
  eventArtifactPointer?: string;
  jsonPointer?: string;
  fileOrdinal?: number;
  entryId?: string;
}

export interface AnalyzerFile {
  displayPath: string;
  originalDisplayPath?: string | null;
  displayAmbiguous: boolean;
  displayReason?: string | null;
  attribution:
    | 'pre-existing'
    | 'observed-during-run'
    | 'mixed-or-uncertain'
    | 'unavailable';
  changeKind: 'added' | 'modified' | 'deleted' | 'renamed' | 'unavailable';
  evidence: AnalyzerEvidenceReference;
}

export interface AnalyzerCommand {
  operationId: string;
  state: 'complete' | 'incomplete' | 'conflict';
  outcome: string | null;
  commandIdentity: string | null;
  identityAvailable: boolean;
  evidence: AnalyzerEvidenceReference;
}

export interface AnalyzerInput {
  organizationId: string;
  canonicalRunId: string;
  coreComplete: boolean;
  filesState: 'complete' | 'missing' | 'stale' | 'incomplete';
  files: readonly AnalyzerFile[];
  commands: readonly AnalyzerCommand[];
  successfulTestCount: number;
}

export interface RuleDefinition {
  id: RuleId;
  version: 1;
  severity: FindingSeverity;
}

export interface RuleEvaluation extends RuleDefinition {
  resultKey: string;
  outcome: FindingOutcome;
  coverage: FindingCoverage;
  reasonCodes: readonly string[];
  explanation: string;
  matchCount: number;
  matches: readonly string[];
  matchesTruncated: boolean;
  references: readonly AnalyzerEvidenceReference[];
  referencesTruncated: boolean;
}

export interface CatalogEvaluation {
  analyzerName: typeof ANALYZER_NAME;
  analyzerVersion: typeof ANALYZER_VERSION;
  catalogVersion: typeof CATALOG_VERSION;
  deterministicOutcome: 'pass' | 'review' | 'unknown';
  coverage: FindingCoverage;
  results: readonly RuleEvaluation[];
}

export const RULE_CATALOG = [
  { id: 'bbx.sensitive-area-change', version: 1, severity: 'high' },
  {
    id: 'bbx.production-change-without-test-evidence',
    version: 1,
    severity: 'high',
  },
  { id: 'bbx.tests-not-after-last-code-change', version: 1, severity: 'high' },
  {
    id: 'bbx.final-tree-differs-from-tested-state',
    version: 1,
    severity: 'high',
  },
  { id: 'bbx.repeated-failed-command', version: 1, severity: 'medium' },
  { id: 'bbx.lockfile-without-manifest', version: 1, severity: 'medium' },
  { id: 'bbx.test-removal-or-weakening', version: 1, severity: 'high' },
  { id: 'bbx.out-of-scope-change', version: 1, severity: 'high' },
  {
    id: 'bbx.success-claim-without-test-evidence',
    version: 1,
    severity: 'high',
  },
] as const satisfies readonly {
  id: string;
  version: 1;
  severity: FindingSeverity;
}[];

export type RuleId = (typeof RULE_CATALOG)[number]['id'];

function asciiLower(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

function validate(input: AnalyzerInput): void {
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuid.test(input.organizationId) || !uuid.test(input.canonicalRunId))
    throw new TypeError('organizationId and canonicalRunId must be UUIDs.');
  if (
    input.files.length > MAX_INPUT_FILES ||
    input.commands.length > MAX_INPUT_COMMANDS
  )
    throw new RangeError('Analyzer input exceeds deterministic bounds.');
  if (
    !Number.isSafeInteger(input.successfulTestCount) ||
    input.successfulTestCount < 0
  )
    throw new TypeError(
      'successfulTestCount must be a non-negative safe integer.',
    );
  for (const file of input.files) {
    if (
      !file.displayPath ||
      file.displayPath.length > 2_048 ||
      !uuid.test(file.evidence.eventId) ||
      !file.evidence.artifactId ||
      !uuid.test(file.evidence.artifactId) ||
      !file.evidence.eventArtifactPointer ||
      !file.evidence.jsonPointer ||
      file.evidence.fileOrdinal === undefined ||
      !file.evidence.entryId
    )
      throw new TypeError('Invalid bounded file input.');
  }
  for (const command of input.commands)
    if (
      !uuid.test(command.operationId) ||
      !uuid.test(command.evidence.eventId) ||
      (command.commandIdentity?.length ?? 0) > 4_096
    )
      throw new TypeError('Invalid bounded command input.');
}

function resultKey(
  organizationId: string,
  runId: string,
  rule: RuleDefinition,
): string {
  return createHash('sha256')
    .update(
      `${organizationId}\n${runId}\n${ANALYZER_NAME}\n${ANALYZER_VERSION}\n${rule.id}\n${rule.version}`,
      'utf8',
    )
    .digest('hex');
}

const manifestNames = new Set([
  'package.json',
  'pyproject.toml',
  'pipfile',
  'cargo.toml',
  'gemfile',
  'go.mod',
  'composer.json',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
]);
const lockToManifest: Readonly<Record<string, readonly string[]>> = {
  'package-lock.json': ['package.json'],
  'npm-shrinkwrap.json': ['package.json'],
  'yarn.lock': ['package.json'],
  'pnpm-lock.yaml': ['package.json'],
  'poetry.lock': ['pyproject.toml'],
  'pipfile.lock': ['pipfile'],
  'cargo.lock': ['cargo.toml'],
  'gemfile.lock': ['gemfile'],
  'go.sum': ['go.mod'],
};

function basename(path: string): string {
  return path.split('/').at(-1) ?? path;
}
function isTest(path: string): boolean {
  return (
    /(^|\/)(__tests__|tests?|specs?)(\/|$)/.test(path) ||
    /\.(test|spec)\.[^/]+$/.test(path)
  );
}
function isProduction(path: string): boolean {
  if (
    isTest(path) ||
    manifestNames.has(basename(path)) ||
    basename(path) in lockToManifest
  )
    return false;
  return (
    /(^|\/)(src|app|apps|lib|libs|packages|server|services|workers?)(\/|$)/.test(
      path,
    ) &&
    /\.(c|cc|cpp|cs|go|java|js|jsx|kt|php|py|rb|rs|swift|ts|tsx)$/.test(path)
  );
}
function sensitive(path: string): boolean {
  const name = basename(path);
  return (
    /(^|\/)(auth|authentication|authorization|permissions?|payments?|billing|checkout|infra|infrastructure|deploy|deployment|terraform|migrations?|secrets?|config)(\/|\.|-|_|$)/.test(
      path,
    ) ||
    /^\.env(\.|$)/.test(name) ||
    manifestNames.has(name) ||
    name in lockToManifest
  );
}
function relationKey(path: string): string {
  const parts = path
    .split('/')
    .filter(
      (part) =>
        ![
          'src',
          'app',
          'apps',
          'lib',
          'libs',
          'test',
          'tests',
          'spec',
          'specs',
          '__tests__',
        ].includes(part),
    );
  return (parts.at(-1) ?? '')
    .replace(/\.(test|spec)(?=\.)/, '')
    .replace(/\.[^.]+$/, '');
}
function relevant(file: AnalyzerFile): boolean {
  return file.attribution !== 'pre-existing';
}
function redacted(path: string): boolean {
  return /\[redacted\]|<redacted>/i.test(path);
}
function uncertainFile(file: AnalyzerFile): boolean {
  return (
    file.displayAmbiguous ||
    (file.displayReason !== null && file.displayReason !== undefined) ||
    redacted(file.displayPath) ||
    (file.originalDisplayPath !== null &&
      file.originalDisplayPath !== undefined &&
      redacted(file.originalDisplayPath)) ||
    (file.changeKind === 'renamed' && !file.originalDisplayPath) ||
    file.attribution === 'unavailable' ||
    file.attribution === 'mixed-or-uncertain' ||
    file.changeKind === 'unavailable'
  );
}
type ClassifiedPath = {
  file: AnalyzerFile;
  path: string;
  displayPath: string;
  origin: 'current' | 'original';
};
function classifiedPaths(file: AnalyzerFile): ClassifiedPath[] {
  if (file.attribution === 'unavailable' || file.changeKind === 'unavailable')
    return [];

  const paths: ClassifiedPath[] = [];
  if (!redacted(file.displayPath))
    paths.push({
      file,
      path: asciiLower(file.displayPath),
      displayPath: file.displayPath,
      origin: 'current',
    });
  if (
    file.originalDisplayPath &&
    !redacted(file.originalDisplayPath) &&
    asciiLower(file.originalDisplayPath) !== asciiLower(file.displayPath)
  )
    paths.push({
      file,
      path: asciiLower(file.originalDisplayPath),
      displayPath: file.originalDisplayPath,
      origin: 'original',
    });
  return paths;
}
function asMatch(item: ClassifiedPath): AnalyzerFile {
  return { ...item.file, displayPath: item.displayPath };
}
function refKey(ref: AnalyzerEvidenceReference): string {
  return [
    ref.eventId,
    ref.artifactId ?? '',
    ref.eventArtifactPointer ?? '',
    ref.jsonPointer ?? '',
    String(ref.fileOrdinal ?? ''),
    ref.entryId ?? '',
  ].join('\0');
}

function make(
  rule: RuleDefinition,
  input: AnalyzerInput,
  outcome: FindingOutcome,
  partial: boolean,
  reasons: string[],
  explanation: string,
  matched: AnalyzerFile[] = [],
  extraRefs: AnalyzerEvidenceReference[] = [],
): RuleEvaluation {
  const sortedMatches = [
    ...new Set(matched.map((item) => item.displayPath)),
  ].sort();
  const refs = [...matched.map((item) => item.evidence), ...extraRefs]
    .sort((a, b) => refKey(a).localeCompare(refKey(b)))
    .filter(
      (value, index, array) =>
        index === 0 || refKey(array[index - 1]!) !== refKey(value),
    );
  if (outcome === 'triggered' && refs.length === 0)
    throw new TypeError(
      'Triggered rules require immutable evidence references.',
    );
  const text = explanation.slice(0, MAX_EXPLANATION_LENGTH);
  return {
    ...rule,
    resultKey: resultKey(input.organizationId, input.canonicalRunId, rule),
    outcome,
    coverage:
      outcome === 'clear' ? 'complete' : partial ? 'partial' : 'complete',
    reasonCodes: [...new Set(reasons)].sort(),
    explanation: text,
    matchCount: sortedMatches.length,
    matches: sortedMatches.slice(0, MAX_MATCHES),
    matchesTruncated: sortedMatches.length > MAX_MATCHES,
    references: refs.slice(0, MAX_REFERENCES),
    referencesTruncated: refs.length > MAX_REFERENCES,
  };
}

function evaluateRule(
  rule: RuleDefinition,
  input: AnalyzerInput,
): RuleEvaluation {
  const files = input.files.filter(relevant);
  const paths = files.flatMap(classifiedPaths);
  const uncertain =
    input.filesState !== 'complete' || files.some(uncertainFile);
  switch (rule.id) {
    case 'bbx.sensitive-area-change': {
      const matches = paths.filter((item) => sensitive(item.path)).map(asMatch);
      if (matches.length)
        return make(
          rule,
          input,
          'triggered',
          uncertain,
          ['sensitive_path_matched'],
          `Sensitive-area changes were observed in ${matches.length} classified file entry or entries.`,
          matches,
        );
      return uncertain
        ? make(
            rule,
            input,
            'unknown',
            true,
            ['file_evidence_incomplete'],
            'Sensitive-area changes cannot be ruled out because file evidence is incomplete or ambiguous.',
          )
        : make(
            rule,
            input,
            'clear',
            false,
            ['no_sensitive_path_match'],
            'No run-attributed file matched the fixed sensitive-area catalog.',
          );
    }
    case 'bbx.production-change-without-test-evidence': {
      const production = paths
        .filter((item) => isProduction(item.path))
        .map(asMatch);
      const productionUncertain = uncertain || !input.coreComplete;
      if (!production.length)
        return productionUncertain
          ? make(
              rule,
              input,
              'unknown',
              true,
              [
                !input.coreComplete
                  ? 'core_evidence_incomplete'
                  : 'file_evidence_incomplete',
              ],
              'Production and test evidence coverage is incomplete.',
            )
          : make(
              rule,
              input,
              'clear',
              false,
              ['no_production_change'],
              'No run-attributed production file change was observed.',
            );
      const tests = paths
        .filter(
          (item) =>
            isTest(item.path) &&
            item.file.changeKind !== 'deleted' &&
            (item.origin === 'current' ||
              paths.some(
                (candidate) =>
                  candidate.file === item.file &&
                  candidate.origin === 'current' &&
                  isTest(candidate.path),
              )),
        )
        .map(asMatch);
      const allRelated = production.every((prod) =>
        tests.some(
          (test) =>
            relationKey(asciiLower(test.displayPath)) ===
            relationKey(asciiLower(prod.displayPath)),
        ),
      );
      if (allRelated && !productionUncertain)
        return make(
          rule,
          input,
          'clear',
          false,
          ['related_test_change_observed'],
          'Every production change has a deterministic related test-file change.',
        );
      if (allRelated)
        return make(
          rule,
          input,
          'unknown',
          true,
          [
            !input.coreComplete
              ? 'core_evidence_incomplete'
              : 'file_evidence_incomplete',
          ],
          'Production and related test changes were observed, but file or core evidence coverage is incomplete.',
        );
      if (input.successfulTestCount > 0 || !input.coreComplete)
        return make(
          rule,
          input,
          'unknown',
          true,
          [
            !input.coreComplete
              ? 'core_evidence_incomplete'
              : input.successfulTestCount > 0
                ? 'test_relevance_unproven'
                : 'file_evidence_incomplete',
          ],
          'Production changes exist, but available test evidence does not prove relevance for every changed production file.',
        );
      return make(
        rule,
        input,
        'triggered',
        uncertain,
        ['production_change_without_test_evidence'],
        `${production.length} production file change or changes have no related test change and no successful test observation.`,
        production,
      );
    }
    case 'bbx.repeated-failed-command': {
      const failed = input.commands.filter(
        (command) =>
          command.state === 'complete' && command.outcome === 'failed',
      );
      const groups = new Map<string, AnalyzerCommand[]>();
      for (const command of failed)
        if (command.identityAvailable && command.commandIdentity)
          groups.set(command.commandIdentity, [
            ...(groups.get(command.commandIdentity) ?? []),
            command,
          ]);
      const repeated = [...groups.values()]
        .filter(
          (group) => new Set(group.map((item) => item.operationId)).size >= 2,
        )
        .flat()
        .sort((a, b) => a.operationId.localeCompare(b.operationId));
      const identityUnknown = input.commands.some(
        (command) =>
          (command.outcome === 'failed' &&
            (!command.identityAvailable || !command.commandIdentity)) ||
          command.state !== 'complete',
      );
      if (repeated.length)
        return make(
          rule,
          input,
          'triggered',
          identityUnknown,
          ['repeated_failed_command'],
          `At least two distinct failed command operations share the same available redacted command identity.`,
          [],
          repeated.map((item) => item.evidence),
        );
      return !input.coreComplete || identityUnknown
        ? make(
            rule,
            input,
            'unknown',
            true,
            ['command_identity_incomplete'],
            'Repeated failure cannot be ruled out because command identity or command pairing is incomplete.',
          )
        : make(
            rule,
            input,
            'clear',
            false,
            ['no_repeated_failed_command'],
            'No repeated failed command identity was observed.',
          );
    }
    case 'bbx.lockfile-without-manifest': {
      const changedPaths = new Set(paths.map((item) => item.path));
      const unmatched = paths.flatMap((item) => {
        const path = item.path;
        const manifests = lockToManifest[basename(path)];
        if (!manifests) return [];
        const directory = path.includes('/')
          ? path.slice(0, path.lastIndexOf('/') + 1)
          : '';
        return manifests.some((manifest) =>
          changedPaths.has(directory + manifest),
        )
          ? []
          : [asMatch(item)];
      });
      if (unmatched.length)
        return make(
          rule,
          input,
          'triggered',
          uncertain,
          ['lockfile_without_ecosystem_manifest'],
          `${unmatched.length} lockfile change or changes lack a corresponding same-ecosystem manifest change.`,
          unmatched,
        );
      return uncertain
        ? make(
            rule,
            input,
            'unknown',
            true,
            ['file_evidence_incomplete'],
            'Lockfile correspondence cannot be ruled out because file evidence is incomplete or ambiguous.',
          )
        : make(
            rule,
            input,
            'clear',
            false,
            ['lockfiles_have_manifests'],
            'Every supported lockfile change has its corresponding ecosystem manifest change.',
          );
    }
    case 'bbx.test-removal-or-weakening': {
      const removed = files.filter(
        (file) =>
          !file.displayAmbiguous &&
          !file.displayReason &&
          !redacted(file.displayPath) &&
          isTest(asciiLower(file.displayPath)) &&
          file.changeKind === 'deleted',
      );
      const modified = files.some(
        (file) =>
          !file.displayAmbiguous &&
          !file.displayReason &&
          !redacted(file.displayPath) &&
          isTest(asciiLower(file.displayPath)) &&
          file.changeKind === 'modified',
      );
      if (removed.length)
        return make(
          rule,
          input,
          'triggered',
          uncertain || modified,
          ['test_file_deleted'],
          `${removed.length} recognized test file or files were deleted.`,
          removed,
        );
      return uncertain || modified
        ? make(
            rule,
            input,
            'unknown',
            true,
            [
              modified
                ? 'test_modification_semantics_unavailable'
                : 'file_evidence_incomplete',
            ],
            'Test weakening cannot be determined without patch semantics or complete unambiguous file evidence.',
          )
        : make(
            rule,
            input,
            'clear',
            false,
            ['no_test_removal'],
            'No recognized test-file deletion was observed.',
          );
    }
    case 'bbx.tests-not-after-last-code-change':
      return make(
        rule,
        input,
        'unknown',
        true,
        ['tested_state_timing_unavailable'],
        'Canonical evidence does not link test execution to a code-change state.',
      );
    case 'bbx.final-tree-differs-from-tested-state':
      return make(
        rule,
        input,
        'unknown',
        true,
        ['tested_tree_identity_unavailable'],
        'Canonical evidence does not identify the Git tree tested by a test observation.',
      );
    case 'bbx.out-of-scope-change':
      return make(
        rule,
        input,
        'unknown',
        true,
        ['declared_scope_unavailable'],
        'Canonical declared-scope evidence is unavailable.',
      );
    case 'bbx.success-claim-without-test-evidence':
      return make(
        rule,
        input,
        'unknown',
        true,
        ['success_claim_contract_unavailable'],
        'Canonical explicit success-claim evidence is unavailable; process exit is not treated as a claim.',
      );
  }
}

export function evaluateCatalog(input: AnalyzerInput): CatalogEvaluation {
  validate(input);
  const results = RULE_CATALOG.map((rule) => evaluateRule(rule, input));
  const deterministicOutcome = results.some(
    (result) => result.outcome === 'triggered',
  )
    ? 'review'
    : results.every(
          (result) =>
            result.outcome === 'clear' && result.coverage === 'complete',
        )
      ? 'pass'
      : 'unknown';
  return {
    analyzerName: ANALYZER_NAME,
    analyzerVersion: ANALYZER_VERSION,
    catalogVersion: CATALOG_VERSION,
    deterministicOutcome,
    coverage: results.every((result) => result.coverage === 'complete')
      ? 'complete'
      : 'partial',
    results,
  };
}
