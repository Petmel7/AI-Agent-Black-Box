const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const CURSOR = /^[A-Za-z0-9_-]{1,2048}$/;
const RETURN_DESCRIPTOR = /^[A-Za-z0-9_-]{1,32768}$/;

export type SearchValues = Record<string, string | string[] | undefined>;

export type EvidenceLocatorView =
  | { kind: 'event'; eventId: string }
  | {
      kind: 'artifact';
      eventId: string;
      artifactId: string;
      eventArtifactPointer: string;
      jsonPointer?: string;
    }
  | {
      kind: 'file';
      eventId: string;
      artifactId: string;
      eventArtifactPointer: string;
      jsonPointer: string;
      fileOrdinal: number;
      entryId: string;
    }
  | { kind: 'finding'; resultKey: string; referenceOrdinal: number };

export type EvidenceOriginSection = 'findings' | 'summary';

export interface EvidenceReturnTarget {
  repositoryId: string;
  runId: string;
  section: EvidenceOriginSection;
  itemId: string;
  cursors: Partial<Record<(typeof detailCursorNames)[number], string>>;
  focusFinding: string | null;
}

export class DashboardInputError extends Error {
  constructor() {
    super('The requested dashboard view is invalid.');
    this.name = 'DashboardInputError';
  }
}

export function isCanonicalUuid(value: string): boolean {
  return UUID.test(value);
}

function one(
  values: SearchValues,
  key: string,
  maximum = 2_048,
): string | undefined {
  const value = values[key];
  if (value === undefined) return undefined;
  if (Array.isArray(value) || value.length === 0 || value.length > maximum)
    throw new DashboardInputError();
  return value;
}

function allowOnly(values: SearchValues, allowed: readonly string[]): void {
  if (Object.keys(values).some((key) => !allowed.includes(key)))
    throw new DashboardInputError();
}

function cursor(values: SearchValues, key: string): string | undefined {
  const value = one(values, key);
  if (value !== undefined && !CURSOR.test(value))
    throw new DashboardInputError();
  return value;
}

export function parseRunsSearch(values: SearchValues): {
  repositoryId?: string;
  cursor?: string;
} {
  allowOnly(values, ['repository', 'cursor']);
  const repositoryId = one(values, 'repository');
  if (repositoryId !== undefined && !UUID.test(repositoryId))
    throw new DashboardInputError();
  const continuation = cursor(values, 'cursor');
  return {
    ...(repositoryId === undefined ? {} : { repositoryId }),
    ...(continuation === undefined ? {} : { cursor: continuation }),
  };
}

export const detailCursorNames = [
  'commands',
  'tools',
  'tests',
  'gitSnapshots',
  'gitDiffs',
  'errors',
  'usage',
  'files',
  'findings',
  'summaryClaims',
  'timeline',
  'supportClaim',
  'summarySupports',
] as const;

const FINDING_ORIGIN = /^finding-[0-9a-f]{64}$/;
const FINDING_REFERENCE_ORIGIN =
  /^finding-reference-[0-9a-f]{64}-(?:0|[1-9][0-9]?)$/;
const SUMMARY_SUPPORT_ORIGIN =
  /^summary-support-(?:preview|page)-[0-9a-f]{64}-(?:0|[1-9][0-9]?)$/;

function validOriginItem(section: EvidenceOriginSection, itemId: string) {
  return section === 'findings'
    ? FINDING_ORIGIN.test(itemId) || FINDING_REFERENCE_ORIGIN.test(itemId)
    : SUMMARY_SUPPORT_ORIGIN.test(itemId);
}

export function findingOriginId(resultKey: string): string {
  if (!SHA256.test(resultKey)) throw new DashboardInputError();
  return `finding-${resultKey}`;
}

export function findingReferenceOriginId(
  resultKey: string,
  ordinal: number,
): string {
  if (
    !SHA256.test(resultKey) ||
    !Number.isSafeInteger(ordinal) ||
    ordinal < 0 ||
    ordinal > 99
  )
    throw new DashboardInputError();
  return `finding-reference-${resultKey}-${ordinal}`;
}

export function summarySupportOriginId(
  claimKey: string,
  ordinal: number,
  scope: 'preview' | 'page',
): string {
  if (
    !SHA256.test(claimKey) ||
    !Number.isSafeInteger(ordinal) ||
    ordinal < 0 ||
    ordinal > 99
  )
    throw new DashboardInputError();
  return `summary-support-${scope}-${claimKey}-${ordinal}`;
}

export function parseDetailSearch(values: SearchValues): {
  cursors: Partial<Record<(typeof detailCursorNames)[number], string>>;
  focusFinding: string | null;
} {
  allowOnly(values, [...detailCursorNames, 'focusFinding']);
  const cursors: Partial<Record<(typeof detailCursorNames)[number], string>> =
    {};
  for (const key of detailCursorNames) {
    const value =
      key === 'supportClaim' ? one(values, key, 64) : cursor(values, key);
    if (value !== undefined) cursors[key] = value;
  }
  if (cursors.supportClaim !== undefined && !SHA256.test(cursors.supportClaim))
    throw new DashboardInputError();
  if (
    cursors.summarySupports !== undefined &&
    cursors.supportClaim === undefined
  )
    throw new DashboardInputError();
  const focusFinding = one(values, 'focusFinding', 64) ?? null;
  if (focusFinding !== null && !SHA256.test(focusFinding))
    throw new DashboardInputError();
  if (focusFinding !== null && cursors.findings !== undefined)
    throw new DashboardInputError();
  return { cursors, focusFinding };
}

export function parseEvidenceSearch(values: SearchValues): EvidenceLocatorView {
  const kind = one(values, 'kind', 16);
  if (kind === 'event') {
    allowOnly(values, ['kind', 'eventId']);
    const eventId = one(values, 'eventId', 36);
    if (!eventId || !UUID.test(eventId)) throw new DashboardInputError();
    return { kind, eventId };
  }
  if (kind === 'finding') {
    allowOnly(values, ['kind', 'resultKey', 'referenceOrdinal']);
    const resultKey = one(values, 'resultKey', 64);
    const ordinal = one(values, 'referenceOrdinal', 2);
    if (
      !resultKey ||
      !SHA256.test(resultKey) ||
      !ordinal ||
      !/^\d{1,2}$/.test(ordinal)
    )
      throw new DashboardInputError();
    return { kind, resultKey, referenceOrdinal: Number(ordinal) };
  }
  if (kind === 'artifact' || kind === 'file') {
    const allowed = [
      'kind',
      'eventId',
      'artifactId',
      'eventArtifactPointer',
      'jsonPointer',
      ...(kind === 'file' ? ['fileOrdinal', 'entryId'] : []),
    ];
    allowOnly(values, allowed);
    const eventId = one(values, 'eventId', 36);
    const artifactId = one(values, 'artifactId', 36);
    const eventArtifactPointer = one(values, 'eventArtifactPointer', 512);
    const jsonPointer = one(values, 'jsonPointer', 512);
    if (
      !eventId ||
      !UUID.test(eventId) ||
      !artifactId ||
      !UUID.test(artifactId) ||
      !eventArtifactPointer
    )
      throw new DashboardInputError();
    if (kind === 'artifact')
      return {
        kind,
        eventId,
        artifactId,
        eventArtifactPointer,
        ...(jsonPointer === undefined ? {} : { jsonPointer }),
      };
    const ordinal = one(values, 'fileOrdinal', 5);
    const entryId = one(values, 'entryId', 128);
    if (!jsonPointer || !ordinal || !/^\d{1,5}$/.test(ordinal) || !entryId)
      throw new DashboardInputError();
    return {
      kind,
      eventId,
      artifactId,
      eventArtifactPointer,
      jsonPointer,
      fileOrdinal: Number(ordinal),
      entryId,
    };
  }
  throw new DashboardInputError();
}

function encodeReturnTarget(target: EvidenceReturnTarget): string {
  const focusedItem =
    target.focusFinding === null ||
    target.itemId === `finding-${target.focusFinding}` ||
    target.itemId.startsWith(`finding-reference-${target.focusFinding}-`);
  if (
    !UUID.test(target.repositoryId) ||
    !UUID.test(target.runId) ||
    !validOriginItem(target.section, target.itemId) ||
    !(target.focusFinding === null || SHA256.test(target.focusFinding)) ||
    (target.section === 'summary' && target.focusFinding !== null) ||
    !focusedItem
  )
    throw new DashboardInputError();
  const parsed = parseDetailSearch(target.cursors as SearchValues);
  const encoded = Buffer.from(
    JSON.stringify({
      repositoryId: target.repositoryId,
      runId: target.runId,
      section: target.section,
      itemId: target.itemId,
      cursors: parsed.cursors,
      focusFinding: target.focusFinding,
    }),
    'utf8',
  ).toString('base64url');
  if (!RETURN_DESCRIPTOR.test(encoded)) throw new DashboardInputError();
  return encoded;
}

function decodeReturnTarget(
  encoded: string,
  repositoryId: string,
  runId: string,
): EvidenceReturnTarget {
  if (!RETURN_DESCRIPTOR.test(encoded)) throw new DashboardInputError();
  try {
    const parsed = JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    if (
      Object.keys(parsed).length !== 6 ||
      parsed.repositoryId !== repositoryId ||
      parsed.runId !== runId ||
      (parsed.section !== 'findings' && parsed.section !== 'summary') ||
      typeof parsed.itemId !== 'string' ||
      !validOriginItem(parsed.section, parsed.itemId) ||
      !(
        parsed.focusFinding === null ||
        (typeof parsed.focusFinding === 'string' &&
          SHA256.test(parsed.focusFinding))
      ) ||
      !parsed.cursors ||
      typeof parsed.cursors !== 'object' ||
      Array.isArray(parsed.cursors)
    )
      throw new Error();
    const { cursors } = parseDetailSearch(parsed.cursors as SearchValues);
    const section: EvidenceOriginSection = parsed.section;
    const target: EvidenceReturnTarget = {
      repositoryId,
      runId,
      section,
      itemId: parsed.itemId,
      cursors,
      focusFinding: parsed.focusFinding,
    };
    if (encodeReturnTarget(target) !== encoded) throw new Error();
    return target;
  } catch (error) {
    if (error instanceof DashboardInputError) throw error;
    throw new DashboardInputError();
  }
}

export function parseEvidencePageSearch(
  values: SearchValues,
  repositoryId: string,
  runId: string,
): { locator: EvidenceLocatorView; returnTarget: EvidenceReturnTarget | null } {
  const returnTo = one(values, 'returnTo', 32_768);
  const locatorValues = Object.fromEntries(
    Object.entries(values).filter(([key]) => key !== 'returnTo'),
  );
  const locator = parseEvidenceSearch(locatorValues);
  return {
    locator,
    returnTarget:
      returnTo === undefined
        ? null
        : decodeReturnTarget(returnTo, repositoryId, runId),
  };
}

export function presentationDescription(state: string): string {
  const values: Record<string, string> = {
    PASS: 'Current deterministic evidence is fully clear. This is not a correctness, completion, test-sufficiency, merge-safety, or policy claim.',
    REVIEW:
      'Current deterministic evidence contains at least one review finding.',
    FAILED:
      'The wrapped process was observed as failed or cancelled; this is separate from deterministic findings.',
    INCOMPLETE:
      'Required evidence or processing is incomplete, stale, failed, or unavailable.',
    PROCESSING: 'Required projections are still processing.',
  };
  return values[state] ?? 'Presentation state unavailable.';
}

export function displayValue(value: unknown): string {
  if (value === null || value === undefined) return 'Unavailable';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

export function formatDuration(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'Unavailable';
  if (value < 1_000) return `${value} ms`;
  return `${(value / 1_000).toFixed(1)} s`;
}

export function boundedJson(
  value: unknown,
  maximum = 12_000,
): { text: string; truncated: boolean } {
  const text = JSON.stringify(value, null, 2) ?? 'Unavailable';
  return text.length <= maximum
    ? { text, truncated: false }
    : { text: `${text.slice(0, maximum)}\n…`, truncated: true };
}

export function evidenceHref(
  repositoryId: string,
  runId: string,
  locator: EvidenceLocatorView,
  returnTarget?: EvidenceReturnTarget,
): string {
  const values = new URLSearchParams();
  for (const [key, value] of Object.entries(locator))
    values.set(key, String(value));
  if (returnTarget) values.set('returnTo', encodeReturnTarget(returnTarget));
  return `/repositories/${repositoryId}/runs/${runId}/evidence?${values.toString()}`;
}

export function evidenceReturnHref(target: EvidenceReturnTarget): string {
  const query = new URLSearchParams();
  for (const key of detailCursorNames) {
    const value = target.cursors[key];
    if (value !== undefined) query.set(key, value);
  }
  if (target.focusFinding !== null)
    query.set('focusFinding', target.focusFinding);
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return `/repositories/${target.repositoryId}/runs/${target.runId}${suffix}#${target.itemId}`;
}

export function evidenceReturnTarget(
  repositoryId: string,
  runId: string,
  current: SearchValues,
  section: EvidenceOriginSection,
  itemId: string,
): EvidenceReturnTarget {
  const { cursors, focusFinding } = parseDetailSearch(current);
  return { repositoryId, runId, section, itemId, cursors, focusFinding };
}

export function detailTargetHref(
  repositoryId: string,
  runId: string,
  current: SearchValues,
  itemId: string,
  omit: readonly (typeof detailCursorNames)[number][] = [],
  focusFinding?: string,
): string {
  const { cursors, focusFinding: currentFocusFinding } =
    parseDetailSearch(current);
  const query = new URLSearchParams();
  for (const key of detailCursorNames) {
    const value = cursors[key];
    if (value !== undefined && !omit.includes(key)) query.set(key, value);
  }
  const selectedFinding = focusFinding ?? currentFocusFinding;
  if (selectedFinding !== null && selectedFinding !== undefined) {
    if (!SHA256.test(selectedFinding)) throw new DashboardInputError();
    query.set('focusFinding', selectedFinding);
  }
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return `/repositories/${repositoryId}/runs/${runId}${suffix}#${itemId}`;
}

export function findingSupportTargetHref(
  repositoryId: string,
  runId: string,
  current: SearchValues,
  resultKey: string,
): string {
  if (!UUID.test(repositoryId) || !UUID.test(runId) || !SHA256.test(resultKey))
    throw new DashboardInputError();
  return detailTargetHref(
    repositoryId,
    runId,
    current,
    findingOriginId(resultKey),
    ['findings'],
    resultKey,
  );
}

export function continuationHref(
  pathname: string,
  current: SearchValues,
  name: string,
  value: string,
  extras: Record<string, string> = {},
): string {
  const query = new URLSearchParams();
  for (const [key, raw] of Object.entries(current))
    if (typeof raw === 'string' && key !== name) query.set(key, raw);
  query.set(name, value);
  for (const [key, raw] of Object.entries(extras)) query.set(key, raw);
  return `${pathname}?${query.toString()}`;
}

export function scopedHref(
  pathname: string,
  current: SearchValues,
  values: Record<string, string>,
  omit: readonly string[] = [],
): string {
  const query = new URLSearchParams();
  for (const [key, raw] of Object.entries(current))
    if (typeof raw === 'string' && !(key in values) && !omit.includes(key))
      query.set(key, raw);
  for (const [key, raw] of Object.entries(values)) query.set(key, raw);
  return `${pathname}?${query.toString()}`;
}
