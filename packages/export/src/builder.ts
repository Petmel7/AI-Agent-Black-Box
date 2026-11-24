import { z } from 'zod';

import {
  canonicalUtf8,
  CanonicalJsonSizeError,
  sha256Hex,
} from './canonical.js';
import {
  deriveExportV1Limitations,
  deriveExportV1Outcomes,
  EVIDENCE_EXPORT_FORMAT,
  EVIDENCE_EXPORT_V1_LIMITS,
  EVIDENCE_EXPORT_VERSION,
  EvidenceExportV1Schema,
  ExportV1SnapshotSchema,
  type EvidenceExportV1,
  type ExportV1Snapshot,
} from './schema.js';

export class EvidenceExportTooLargeError extends Error {
  readonly code = 'export_too_large';

  constructor() {
    super('The evidence export exceeds the Export V1 bounds.');
    this.name = 'EvidenceExportTooLargeError';
  }
}

export class InvalidEvidenceExportError extends Error {
  readonly code = 'invalid_evidence_export';

  constructor(options?: ErrorOptions) {
    super(
      'The evidence export is not a valid canonical Export V1 bundle.',
      options,
    );
    this.name = 'InvalidEvidenceExportError';
  }
}

function compareUtf8(left: string, right: string): number {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1)
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  return a.length - b.length;
}

function compareTuple(
  left: readonly (number | string)[],
  right: readonly (number | string)[],
): number {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const a = left[index]!;
    const b = right[index]!;
    const compared =
      typeof a === 'number' && typeof b === 'number'
        ? a - b
        : compareUtf8(String(a), String(b));
    if (compared !== 0) return compared;
  }
  return left.length - right.length;
}

function sorted<T>(
  values: readonly T[],
  identity: (value: T) => readonly (number | string)[],
): T[] {
  return [...values].sort((left, right) =>
    compareTuple(identity(left), identity(right)),
  );
}

/** Accepts database-order-independent snapshot rows and returns canonical order. */
export function normalizeExportV1Snapshot(input: unknown): ExportV1Snapshot {
  const value = ExportV1SnapshotSchema.parse(input);
  const core =
    value.core.state === 'unavailable'
      ? value.core
      : {
          ...value.core,
          run: {
            ...value.core.run,
            completenessReasons: sorted(
              value.core.run.completenessReasons,
              (item) => [item],
            ),
          },
          commands: sorted(value.core.commands, (item) => [item.operationId]),
          tools: sorted(value.core.tools, (item) => [item.operationId]),
          tests: sorted(value.core.tests, (item) => [
            item.source.sequence,
            item.testRunId,
          ]),
          gitSnapshots: sorted(value.core.gitSnapshots, (item) => [
            item.source.sequence,
            item.snapshotId,
          ]),
          gitDiffs: sorted(value.core.gitDiffs, (item) => [
            item.source.sequence,
            item.diffId,
          ]),
          errors: sorted(value.core.errors, (item) => [
            item.source.sequence,
            item.errorId,
          ]),
          usage: sorted(value.core.usage, (item) => [
            item.source.sequence,
            item.source.eventId,
          ]),
        };
  const files =
    value.files.state === 'unavailable'
      ? value.files
      : {
          ...value.files,
          files: sorted(value.files.files, (item) => [
            item.sourceSequence,
            item.ordinal,
            item.entryId,
          ]),
        };
  const findings =
    value.findings.state === 'unavailable'
      ? value.findings
      : {
          ...value.findings,
          results: sorted(value.findings.results, (item) => [
            item.catalogOrder,
            item.ruleId,
            item.ruleVersion,
          ]).map((item) => ({
            ...item,
            reasonCodes: sorted(item.reasonCodes, (reason) => [reason]),
            matches: sorted(item.matches, (match) => [match]),
            references: sorted(item.references, (reference) => [
              reference.ordinal,
            ]),
          })),
        };
  const summary =
    value.summary.state === 'unavailable'
      ? value.summary
      : {
          ...value.summary,
          claims: sorted(value.summary.claims, (item) => [
            item.sectionOrder,
            item.claimOrder,
            item.claimKey,
          ]).map((item) => ({
            ...item,
            supports: sorted(item.supports, (support) => [support.ordinal]),
          })),
        };
  return ExportV1SnapshotSchema.parse({
    ...value,
    events: sorted(value.events, (item) => [
      item.event.sequence,
      item.event.eventId,
    ]),
    artifacts: sorted(value.artifacts, (item) => [
      item.artifact.artifactId,
    ]).map((item) => ({
      ...item,
      declaredBy: sorted(item.declaredBy, (declaration) => [
        declaration.eventId,
        declaration.pointer,
      ]),
    })),
    core,
    files,
    findings,
    summary,
  });
}

export interface BuiltEvidenceExportV1 {
  bundle: EvidenceExportV1;
  bytes: Uint8Array;
  sha256: string;
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Internal structural preflight used before full schema validation. */
export function enforceCollectionLimits(input: unknown): void {
  const value = record(input);
  if (!value) return;
  const checks: Array<[unknown, number]> = [
    [value.events, EVIDENCE_EXPORT_V1_LIMITS.events],
    [value.artifacts, EVIDENCE_EXPORT_V1_LIMITS.artifacts],
    [value.limitations, EVIDENCE_EXPORT_V1_LIMITS.limitations],
  ];
  const core = record(value.core);
  if (core?.state === 'available') {
    const run = record(core.run);
    checks.push(
      [run?.completenessReasons, EVIDENCE_EXPORT_V1_LIMITS.completenessReasons],
      [core.commands, EVIDENCE_EXPORT_V1_LIMITS.commands],
      [core.tools, EVIDENCE_EXPORT_V1_LIMITS.tools],
      [core.tests, EVIDENCE_EXPORT_V1_LIMITS.tests],
      [core.gitSnapshots, EVIDENCE_EXPORT_V1_LIMITS.gitSnapshots],
      [core.gitDiffs, EVIDENCE_EXPORT_V1_LIMITS.gitDiffs],
      [core.errors, EVIDENCE_EXPORT_V1_LIMITS.errors],
      [core.usage, EVIDENCE_EXPORT_V1_LIMITS.usage],
    );
  }
  const files = record(value.files);
  if (files?.state === 'available')
    checks.push([files.files, EVIDENCE_EXPORT_V1_LIMITS.files]);
  const findings = record(value.findings);
  if (findings?.state === 'available') {
    checks.push([findings.results, EVIDENCE_EXPORT_V1_LIMITS.findings]);
    if (Array.isArray(findings.results))
      for (const item of findings.results) {
        const result = record(item);
        if (!result) continue;
        checks.push(
          [result.reasonCodes, EVIDENCE_EXPORT_V1_LIMITS.findingReasonCodes],
          [result.matches, EVIDENCE_EXPORT_V1_LIMITS.findingMatches],
          [result.references, EVIDENCE_EXPORT_V1_LIMITS.findingReferences],
        );
      }
  }
  const summary = record(value.summary);
  if (summary?.state === 'available') {
    checks.push([summary.claims, EVIDENCE_EXPORT_V1_LIMITS.summaryClaims]);
    if (Array.isArray(summary.claims))
      for (const item of summary.claims) {
        const claim = record(item);
        if (claim)
          checks.push([
            claim.supports,
            EVIDENCE_EXPORT_V1_LIMITS.summarySupports,
          ]);
      }
  }
  let artifactDeclarationCount = 0;
  if (Array.isArray(value.artifacts))
    for (const item of value.artifacts) {
      const artifact = record(item);
      if (artifact) {
        checks.push([
          artifact.declaredBy,
          EVIDENCE_EXPORT_V1_LIMITS.artifactDeclarations,
        ]);
        artifactDeclarationCount += arrayLength(artifact.declaredBy);
      }
    }
  if (
    artifactDeclarationCount > EVIDENCE_EXPORT_V1_LIMITS.artifactDeclarations ||
    checks.some(([items, maximum]) => arrayLength(items) > maximum)
  )
    throw new EvidenceExportTooLargeError();
}

export function buildEvidenceExportV1(input: unknown): BuiltEvidenceExportV1 {
  enforceCollectionLimits(input);
  let snapshot: ExportV1Snapshot;
  try {
    snapshot = normalizeExportV1Snapshot(input);
  } catch (error) {
    if (error instanceof z.ZodError)
      throw new InvalidEvidenceExportError({ cause: error });
    throw error;
  }
  let bundle: EvidenceExportV1;
  try {
    bundle = EvidenceExportV1Schema.parse({
      format: EVIDENCE_EXPORT_FORMAT,
      formatVersion: EVIDENCE_EXPORT_VERSION,
      ...snapshot,
      outcomes: deriveExportV1Outcomes(snapshot),
      limitations: deriveExportV1Limitations(snapshot),
    });
  } catch (error) {
    if (error instanceof z.ZodError)
      throw new InvalidEvidenceExportError({ cause: error });
    throw error;
  }
  let bytes: Uint8Array;
  try {
    bytes = canonicalUtf8(
      bundle,
      EVIDENCE_EXPORT_V1_LIMITS.totalCanonicalBytes,
    );
  } catch (error) {
    if (error instanceof CanonicalJsonSizeError)
      throw new EvidenceExportTooLargeError();
    throw error;
  }
  return { bundle, bytes, sha256: sha256Hex(bytes) };
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1)
    if (left[index] !== right[index]) return false;
  return true;
}

/** Independently parses only exact canonical Export V1 bytes. */
export function parseEvidenceExportV1(
  bytes: Uint8Array,
): BuiltEvidenceExportV1 {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength === 0 ||
    bytes.byteLength > EVIDENCE_EXPORT_V1_LIMITS.totalCanonicalBytes ||
    (bytes.byteLength >= 3 &&
      bytes[0] === 0xef &&
      bytes[1] === 0xbb &&
      bytes[2] === 0xbf)
  )
    throw new InvalidEvidenceExportError();
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const parsed = EvidenceExportV1Schema.parse(JSON.parse(text) as unknown);
    const canonical = canonicalUtf8(
      parsed,
      EVIDENCE_EXPORT_V1_LIMITS.totalCanonicalBytes,
    );
    if (!equalBytes(bytes, canonical)) throw new InvalidEvidenceExportError();
    return {
      bundle: parsed,
      bytes: Uint8Array.from(bytes),
      sha256: sha256Hex(bytes),
    };
  } catch (error) {
    if (error instanceof InvalidEvidenceExportError) throw error;
    throw new InvalidEvidenceExportError({ cause: error });
  }
}
