import { createHash, randomUUID } from 'node:crypto';

import {
  ANALYZER_NAME,
  ANALYZER_VERSION,
  CATALOG_VERSION,
} from '@blackbox/analyzers';
import {
  generateSummary,
  SUMMARY_FORMAT_VERSION,
  SUMMARY_GENERATOR_NAME,
  SUMMARY_GENERATOR_VERSION,
  SUMMARY_TEMPLATE_VERSION,
  type SummaryFinding,
  type SummaryGitDiffObservation,
  type SummaryOutcome,
  type SummarySupport,
  type SummaryTestObservation,
} from '@blackbox/summaries';

import type { DatabaseClient } from './client.js';
import {
  CORE_PROJECTOR_NAME,
  CORE_PROJECTOR_VERSION,
} from './core-projector.js';
import {
  FILES_PROJECTOR_NAME,
  FILES_PROJECTOR_VERSION,
  inspectFileSourceSnapshot,
} from './file-processing.js';
import {
  FINDINGS_PROJECTOR_NAME,
  FINDINGS_PROJECTOR_VERSION,
  inspectFindingsSourceSnapshot,
} from './findings-processing.js';
import { Prisma } from './generated/client/client.js';
import { lockRunSourceSet } from './run-source-lock.js';

export const SUMMARY_PROJECTOR_NAME = 'summary';
export const SUMMARY_PROJECTOR_VERSION = 1;

export interface SummaryProcessingOptions {
  leaseSeconds: number;
  attemptTimeoutMs: number;
  transitionMarginMs: number;
  maxAttempts: number;
  retryBaseSeconds: number;
  retryMaxSeconds: number;
}

export interface SummaryProcessingContext {
  signal?: AbortSignal;
  hooks?: {
    afterDependenciesRead?: () => void | Promise<void>;
    afterClaimsReplaced?: () => void | Promise<void>;
  };
}

export type SummaryProcessingResult =
  'applied' | 'already_applied' | 'busy' | 'failed';

export class SummaryProcessingError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = 'SummaryProcessingError';
  }
}

type Attempt = {
  leaseId: string;
  deadlineAt: Date;
  attemptedFingerprint: string | null;
};

function validate(options: SummaryProcessingOptions): void {
  for (const value of Object.values(options))
    if (!Number.isSafeInteger(value) || value < 1)
      throw new TypeError(
        'Summary processing bounds must be positive safe integers.',
      );
  if (
    options.leaseSeconds * 1_000 <=
    options.attemptTimeoutMs + options.transitionMarginMs
  )
    throw new TypeError(
      'Summary lease must exceed attempt timeout plus transition margin.',
    );
}

function active(context: SummaryProcessingContext, deadlineAt: Date): void {
  if (context.signal?.aborted)
    throw new SummaryProcessingError('processing_cancelled', true);
  if (Date.now() >= deadlineAt.getTime())
    throw new SummaryProcessingError(
      'projection_attempt_deadline_exceeded',
      true,
    );
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(canonical(value), 'utf8').digest('hex');
}

export interface SummarySourceIdentity {
  generatorName: string;
  generatorVersion: number;
  formatVersion: number;
  templateVersion: number;
  core: {
    version: number;
    fingerprint: string;
    completeness: string;
  };
  files: {
    version: number | null;
    fingerprint: string | null;
    completeness: string;
  };
  findings: {
    projectorVersion: number;
    fingerprint: string;
    graphFingerprint: string;
    analyzerName: string;
    analyzerVersion: number;
    catalogVersion: number;
    outcome: string;
    coverage: string;
  };
}

export interface FindingsGraphReferenceIdentity {
  ordinal: number;
  eventId: string;
  artifactId: string | null;
  eventArtifactPointer: string | null;
  jsonPointer: string | null;
  fileOrdinal: number | null;
  entryId: string | null;
}

export interface FindingsGraphResultIdentity {
  catalogOrder: number;
  resultKey: string;
  ruleId: string;
  ruleVersion: number;
  severity: string;
  outcome: string;
  coverage: string;
  reasonCodes: unknown;
  explanation: string;
  matchCount: number;
  matches: unknown;
  matchesTruncated: boolean;
  referencesTruncated: boolean;
  references: readonly FindingsGraphReferenceIdentity[];
}

/** Stable material identity for the complete ordered findings result graph. */
export function findingsGraphFingerprint(
  results: readonly FindingsGraphResultIdentity[],
): string {
  return fingerprint({
    results: [...results]
      .sort(
        (left, right) =>
          left.catalogOrder - right.catalogOrder ||
          left.ruleId.localeCompare(right.ruleId) ||
          left.resultKey.localeCompare(right.resultKey),
      )
      .map((result) => ({
        catalogOrder: result.catalogOrder,
        resultKey: result.resultKey,
        ruleId: result.ruleId,
        ruleVersion: result.ruleVersion,
        severity: result.severity,
        outcome: result.outcome,
        coverage: result.coverage,
        reasonCodes: result.reasonCodes,
        explanation: result.explanation,
        matchCount: result.matchCount,
        matches: result.matches,
        matchesTruncated: result.matchesTruncated,
        referencesTruncated: result.referencesTruncated,
        references: [...result.references]
          .sort(
            (left, right) =>
              left.ordinal - right.ordinal ||
              left.eventId.localeCompare(right.eventId) ||
              (left.artifactId ?? '').localeCompare(right.artifactId ?? '') ||
              (left.eventArtifactPointer ?? '').localeCompare(
                right.eventArtifactPointer ?? '',
              ) ||
              (left.jsonPointer ?? '').localeCompare(right.jsonPointer ?? '') ||
              (left.fileOrdinal ?? -1) - (right.fileOrdinal ?? -1) ||
              (left.entryId ?? '').localeCompare(right.entryId ?? ''),
          )
          .map((reference) => ({ ...reference })),
      })),
  });
}

/** Exact versioned dependency identity used by inspection and publication. */
export function summarySourceFingerprint(
  identity: SummarySourceIdentity,
): string {
  return fingerprint(identity);
}

export interface SummarySourceSnapshot {
  fingerprint: string | null;
  coreCurrent: boolean;
  findingsCurrent: boolean;
}

/** Recomputes compatible dependency identity without generating claims. */
export async function inspectSummarySourceSnapshot(
  client: DatabaseClient | Prisma.TransactionClient,
  organizationId: string,
  runId: string,
): Promise<SummarySourceSnapshot> {
  const [core, files, findings, findingsState, currentFindings] =
    await Promise.all([
      client.coreRunProjection.findUnique({ where: { runId } }),
      client.fileRunProjection.findUnique({ where: { runId } }),
      client.findingsRunProjection.findUnique({
        where: { runId },
        include: {
          results: {
            orderBy: { catalogOrder: 'asc' },
            include: {
              references: {
                orderBy: { ordinal: 'asc' },
                include: {
                  event: { select: { canonicalEventId: true } },
                  artifactDeclaration: {
                    select: { canonicalArtifactId: true },
                  },
                },
              },
            },
          },
        },
      }),
      client.runProcessingState.findUnique({
        where: {
          organizationId_runId_projectorName: {
            organizationId,
            runId,
            projectorName: FINDINGS_PROJECTOR_NAME,
          },
        },
      }),
      inspectFindingsSourceSnapshot(client, organizationId, runId),
    ]);
  const coreCurrent = currentFindings.coreCurrent;
  const findingsCurrent = Boolean(
    coreCurrent &&
    findings &&
    currentFindings.fingerprint !== null &&
    findingsState?.state === 'READY' &&
    findingsState.projectorVersion === FINDINGS_PROJECTOR_VERSION &&
    findings.projectorVersion === FINDINGS_PROJECTOR_VERSION &&
    findings.sourceFingerprint === currentFindings.fingerprint &&
    findingsState.sourceFingerprint === currentFindings.fingerprint &&
    findings.analyzerName === ANALYZER_NAME &&
    findings.analyzerVersion === ANALYZER_VERSION &&
    findings.catalogVersion === CATALOG_VERSION,
  );
  return {
    coreCurrent,
    findingsCurrent,
    fingerprint:
      !coreCurrent || !findingsCurrent || !core || !findings
        ? null
        : summarySourceFingerprint({
            generatorName: SUMMARY_GENERATOR_NAME,
            generatorVersion: SUMMARY_GENERATOR_VERSION,
            formatVersion: SUMMARY_FORMAT_VERSION,
            templateVersion: SUMMARY_TEMPLATE_VERSION,
            core: {
              version: core.projectorVersion,
              fingerprint: core.sourceFingerprint,
              completeness: core.evidenceCompleteness,
            },
            files:
              findings.filesVersion !== null && files
                ? {
                    version: files.projectorVersion,
                    fingerprint: files.sourceFingerprint,
                    completeness: files.completeness,
                  }
                : {
                    version: null,
                    fingerprint: null,
                    completeness: findings.filesCompleteness,
                  },
            findings: {
              projectorVersion: findings.projectorVersion,
              fingerprint: findings.sourceFingerprint,
              graphFingerprint: findingsGraphFingerprint(
                findings.results.map((result) => ({
                  ...result,
                  references: result.references.map((reference) => ({
                    ordinal: reference.ordinal,
                    eventId: reference.event.canonicalEventId,
                    artifactId:
                      reference.artifactDeclaration?.canonicalArtifactId ??
                      null,
                    eventArtifactPointer: reference.eventArtifactPointer,
                    jsonPointer: reference.jsonPointer,
                    fileOrdinal: reference.fileOrdinal,
                    entryId: reference.entryId,
                  })),
                })),
              ),
              analyzerName: findings.analyzerName,
              analyzerVersion: findings.analyzerVersion,
              catalogVersion: findings.catalogVersion,
              outcome: findings.deterministicOutcome,
              coverage: findings.coverage,
            },
          }),
  };
}

async function acquire(
  client: DatabaseClient,
  organizationId: string,
  runId: string,
  intentId: string,
  options: SummaryProcessingOptions,
  allowFailedRecovery: boolean,
): Promise<Attempt | null> {
  const leaseId = randomUUID();
  const rows = await client.$queryRaw<
    Array<{ leaseId: string; deadlineAt: Date }>
  >(Prisma.sql`
    INSERT INTO run_processing_states (organization_id, run_id, projector_name, projector_version, state, lease_id, lease_expires_at, attempt_deadline_at, active_intent_id, attempt_count)
    VALUES (${organizationId}::uuid, ${runId}::uuid, ${SUMMARY_PROJECTOR_NAME}, ${SUMMARY_PROJECTOR_VERSION}, 'processing', ${leaseId}::uuid,
            clock_timestamp() + make_interval(secs => ${options.leaseSeconds}), clock_timestamp() + ${options.attemptTimeoutMs} * interval '1 millisecond', ${intentId}::uuid, 1)
    ON CONFLICT (organization_id, run_id, projector_name) DO UPDATE SET
      projector_version = EXCLUDED.projector_version, state = 'processing', lease_id = EXCLUDED.lease_id,
      lease_expires_at = EXCLUDED.lease_expires_at, attempt_deadline_at = EXCLUDED.attempt_deadline_at,
      active_intent_id = EXCLUDED.active_intent_id, attempt_count = CASE WHEN run_processing_states.active_intent_id = EXCLUDED.active_intent_id THEN run_processing_states.attempt_count + 1 ELSE 1 END,
      attempt_source_fingerprint = CASE WHEN run_processing_states.active_intent_id = EXCLUDED.active_intent_id THEN run_processing_states.attempt_source_fingerprint ELSE NULL END,
      completed_at = NULL, last_error_code = NULL
    WHERE (run_processing_states.state <> 'processing' AND (${allowFailedRecovery} OR run_processing_states.state <> 'failed') AND run_processing_states.available_at <= clock_timestamp())
       OR (run_processing_states.state = 'processing' AND run_processing_states.lease_expires_at <= clock_timestamp())
    RETURNING lease_id AS "leaseId", attempt_deadline_at AS "deadlineAt"
  `);
  return rows[0] ? { ...rows[0], attemptedFingerprint: null } : null;
}

async function fail(
  client: DatabaseClient,
  input: {
    organizationId: string;
    runId: string;
    intentId: string;
    attempt: Attempt;
  },
  error: SummaryProcessingError,
  options: SummaryProcessingOptions,
): Promise<'failed' | 'retrying' | 'lost'> {
  return client.$transaction(async (transaction) => {
    const rows = await transaction.$queryRaw<
      Array<{ state: 'failed' | 'retrying'; attemptCount: number }>
    >(Prisma.sql`
      WITH owned AS (
        SELECT id, CASE WHEN ${input.attempt.attemptedFingerprint}::text IS NOT NULL AND attempt_source_fingerprint IS DISTINCT FROM ${input.attempt.attemptedFingerprint}::text THEN 1 ELSE attempt_count END AS scoped_attempt_count
        FROM run_processing_states
        WHERE organization_id = ${input.organizationId}::uuid AND run_id = ${input.runId}::uuid AND projector_name = ${SUMMARY_PROJECTOR_NAME}
          AND state = 'processing' AND lease_id = ${input.attempt.leaseId}::uuid AND active_intent_id = ${input.intentId}::uuid
        FOR UPDATE
      )
      UPDATE run_processing_states AS processing SET
        state = CASE WHEN NOT ${error.retryable} OR owned.scoped_attempt_count >= ${options.maxAttempts} THEN 'failed'::"RunProcessingStatus" ELSE 'retrying'::"RunProcessingStatus" END,
        lease_id = NULL, lease_expires_at = NULL, attempt_deadline_at = NULL,
        attempt_count = owned.scoped_attempt_count,
        attempt_source_fingerprint = COALESCE(${input.attempt.attemptedFingerprint}::text, processing.attempt_source_fingerprint),
        available_at = CASE WHEN NOT ${error.retryable} OR owned.scoped_attempt_count >= ${options.maxAttempts} THEN clock_timestamp() ELSE clock_timestamp() + LEAST(${options.retryMaxSeconds}, ${options.retryBaseSeconds} * power(2, LEAST(30, GREATEST(0, owned.scoped_attempt_count - 1)))) * interval '1 second' END,
        completed_at = CASE WHEN NOT ${error.retryable} OR owned.scoped_attempt_count >= ${options.maxAttempts} THEN clock_timestamp() ELSE NULL END,
        last_error_code = ${error.code}
      FROM owned WHERE processing.id = owned.id
      RETURNING processing.state::text AS state, processing.attempt_count AS "attemptCount"
    `);
    const row = rows[0];
    if (!row) return 'lost';
    if (row.state === 'failed')
      await transaction.processingAttemptFailure.upsert({
        where: {
          intentId_projectorName_projectorVersion: {
            intentId: input.intentId,
            projectorName: SUMMARY_PROJECTOR_NAME,
            projectorVersion: SUMMARY_PROJECTOR_VERSION,
          },
        },
        create: {
          organizationId: input.organizationId,
          runId: input.runId,
          intentId: input.intentId,
          projectorName: SUMMARY_PROJECTOR_NAME,
          projectorVersion: SUMMARY_PROJECTOR_VERSION,
          sourceFingerprint: input.attempt.attemptedFingerprint,
          attemptCount: row.attemptCount,
          errorCode: error.code,
        },
        update: {
          sourceFingerprint: input.attempt.attemptedFingerprint,
          attemptCount: row.attemptCount,
          errorCode: error.code,
          failedAt: new Date(),
        },
      });
    return row.state;
  });
}

function stringArray(value: Prisma.JsonValue): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
    throw new SummaryProcessingError('summary_findings_shape_invalid', false);
  return value as string[];
}

async function publish(
  client: DatabaseClient,
  intent: {
    id: string;
    organizationId: string;
    runId: string;
    run: { repositoryId: string; canonicalRunId: string };
  },
  attempt: Attempt,
  context: SummaryProcessingContext,
): Promise<SummaryProcessingResult> {
  const timeout = Math.max(1, attempt.deadlineAt.getTime() - Date.now());
  return client.$transaction(
    async (transaction) => {
      active(context, attempt.deadlineAt);
      await lockRunSourceSet(transaction, intent.runId);
      const [
        raw,
        core,
        coreState,
        files,
        filesState,
        currentFiles,
        findings,
        findingsState,
        currentFindings,
      ] = await Promise.all([
        transaction.evidenceEvent.aggregate({
          where: { runId: intent.runId },
          _count: { _all: true },
          _max: { sequence: true },
        }),
        transaction.coreRunProjection.findUnique({
          where: { runId: intent.runId },
          include: {
            tests: { orderBy: { sourceSequence: 'asc' } },
            gitDiffs: { orderBy: { sourceSequence: 'asc' } },
          },
        }),
        transaction.runProcessingState.findUnique({
          where: {
            organizationId_runId_projectorName: {
              organizationId: intent.organizationId,
              runId: intent.runId,
              projectorName: CORE_PROJECTOR_NAME,
            },
          },
        }),
        transaction.fileRunProjection.findUnique({
          where: { runId: intent.runId },
        }),
        transaction.runProcessingState.findUnique({
          where: {
            organizationId_runId_projectorName: {
              organizationId: intent.organizationId,
              runId: intent.runId,
              projectorName: FILES_PROJECTOR_NAME,
            },
          },
        }),
        inspectFileSourceSnapshot(
          transaction,
          intent.organizationId,
          intent.runId,
        ),
        transaction.findingsRunProjection.findUnique({
          where: { runId: intent.runId },
          include: {
            results: {
              orderBy: { catalogOrder: 'asc' },
              include: {
                references: {
                  orderBy: { ordinal: 'asc' },
                  include: {
                    event: { select: { canonicalEventId: true } },
                    artifactDeclaration: {
                      select: { canonicalArtifactId: true },
                    },
                  },
                },
              },
            },
          },
        }),
        transaction.runProcessingState.findUnique({
          where: {
            organizationId_runId_projectorName: {
              organizationId: intent.organizationId,
              runId: intent.runId,
              projectorName: FINDINGS_PROJECTOR_NAME,
            },
          },
        }),
        inspectFindingsSourceSnapshot(
          transaction,
          intent.organizationId,
          intent.runId,
        ),
      ]);
      const coreCurrent = Boolean(
        core &&
        core.projectorVersion === CORE_PROJECTOR_VERSION &&
        coreState?.state === 'READY' &&
        coreState.projectorVersion === CORE_PROJECTOR_VERSION &&
        core.sourceEventCount === raw._count._all &&
        core.sourceMaxSequence === raw._max.sequence &&
        coreState.sourceFingerprint === core.sourceFingerprint,
      );
      if (!coreCurrent || !core)
        throw new SummaryProcessingError('summary_core_stale', true);

      const filesCurrent = Boolean(
        currentFiles.complete &&
        files?.projectorVersion === FILES_PROJECTOR_VERSION &&
        filesState?.state === 'READY' &&
        filesState.projectorVersion === FILES_PROJECTOR_VERSION &&
        files.sourceFingerprint === currentFiles.fingerprint &&
        filesState.sourceFingerprint === currentFiles.fingerprint,
      );
      const filesCompleteness = filesCurrent
        ? 'complete'
        : currentFiles.count === 0
          ? 'missing'
          : currentFiles.complete
            ? 'stale'
            : 'incomplete';
      const findingsCurrent = Boolean(
        findings &&
        currentFindings.fingerprint !== null &&
        currentFindings.coreCurrent &&
        findings.projectorVersion === FINDINGS_PROJECTOR_VERSION &&
        findingsState?.state === 'READY' &&
        findingsState.projectorVersion === FINDINGS_PROJECTOR_VERSION &&
        findings.sourceFingerprint === currentFindings.fingerprint &&
        findingsState.sourceFingerprint === currentFindings.fingerprint &&
        findings.analyzerName === ANALYZER_NAME &&
        findings.analyzerVersion === ANALYZER_VERSION &&
        findings.catalogVersion === CATALOG_VERSION &&
        findings.coreVersion === core.projectorVersion &&
        findings.coreFingerprint === core.sourceFingerprint &&
        findings.coreCompleteness === core.evidenceCompleteness &&
        findings.filesCompleteness === filesCompleteness &&
        (filesCurrent
          ? findings.filesVersion === files!.projectorVersion &&
            findings.filesFingerprint === files!.sourceFingerprint
          : findings.filesVersion === null &&
            findings.filesFingerprint === null),
      );
      if (!findingsCurrent || !findings)
        throw new SummaryProcessingError('summary_findings_stale', true);

      const graphFingerprint = findingsGraphFingerprint(
        findings.results.map((result) => ({
          ...result,
          references: result.references.map((reference) => ({
            ordinal: reference.ordinal,
            eventId: reference.event.canonicalEventId,
            artifactId:
              reference.artifactDeclaration?.canonicalArtifactId ?? null,
            eventArtifactPointer: reference.eventArtifactPointer,
            jsonPointer: reference.jsonPointer,
            fileOrdinal: reference.fileOrdinal,
            entryId: reference.entryId,
          })),
        })),
      );

      const sourceFingerprint = summarySourceFingerprint({
        generatorName: SUMMARY_GENERATOR_NAME,
        generatorVersion: SUMMARY_GENERATOR_VERSION,
        formatVersion: SUMMARY_FORMAT_VERSION,
        templateVersion: SUMMARY_TEMPLATE_VERSION,
        core: {
          version: core.projectorVersion,
          fingerprint: core.sourceFingerprint,
          completeness: core.evidenceCompleteness,
        },
        files: filesCurrent
          ? {
              version: files!.projectorVersion,
              fingerprint: files!.sourceFingerprint,
              completeness: files!.completeness,
            }
          : {
              version: null,
              fingerprint: null,
              completeness: filesCompleteness,
            },
        findings: {
          projectorVersion: findings.projectorVersion,
          fingerprint: findings.sourceFingerprint,
          graphFingerprint,
          analyzerName: findings.analyzerName,
          analyzerVersion: findings.analyzerVersion,
          catalogVersion: findings.catalogVersion,
          outcome: findings.deterministicOutcome,
          coverage: findings.coverage,
        },
      });
      attempt.attemptedFingerprint = sourceFingerprint;

      const canonicalEventIds = [
        core.finishedEventId,
        ...core.tests.map((test) => test.sourceEventId),
        ...core.gitDiffs.map((diff) => diff.sourceEventId),
      ].filter((value): value is string => value !== null);
      const events = await transaction.evidenceEvent.findMany({
        where: {
          organizationId: intent.organizationId,
          runId: intent.runId,
          canonicalEventId: { in: [...new Set(canonicalEventIds)] },
        },
        select: { id: true, canonicalEventId: true },
      });
      const eventIds = new Map(
        events.map((event) => [event.canonicalEventId, event.id]),
      );
      if (events.length !== new Set(canonicalEventIds).size)
        throw new SummaryProcessingError(
          'summary_observation_evidence_missing',
          false,
        );
      const tests: SummaryTestObservation[] = core.tests.map((test) => ({
        outcome: test.outcome as SummaryTestObservation['outcome'],
        evidence: {
          kind: 'evidence',
          eventId: eventIds.get(test.sourceEventId)!,
        },
      }));
      const gitDiffs: SummaryGitDiffObservation[] = core.gitDiffs.map(
        (diff) => ({
          filesChanged:
            diff.filesChanged !== null &&
            diff.filesChanged <= BigInt(Number.MAX_SAFE_INTEGER)
              ? Number(diff.filesChanged)
              : null,
          evidence: {
            kind: 'evidence',
            eventId: eventIds.get(diff.sourceEventId)!,
          },
        }),
      );
      const summaryFindings: SummaryFinding[] = findings.results.map(
        (result) => ({
          resultKey: result.resultKey,
          ruleId: result.ruleId,
          ruleVersion: result.ruleVersion,
          severity: result.severity as SummaryFinding['severity'],
          outcome: result.outcome as SummaryFinding['outcome'],
          coverage: result.coverage as SummaryFinding['coverage'],
          reasonCodes: stringArray(result.reasonCodes),
        }),
      );
      const summary = generateSummary({
        organizationId: intent.organizationId,
        canonicalRunId: intent.run.canonicalRunId,
        sourceFingerprint,
        findingsSourceFingerprint: findings.sourceFingerprint,
        findingsOutcome: findings.deterministicOutcome as SummaryOutcome,
        findingsCoverage: findings.coverage as 'complete' | 'partial',
        coreComplete: core.evidenceCompleteness === 'complete',
        filesState: filesCompleteness,
        observedOutcome: core.observedOutcome as
          'succeeded' | 'failed' | 'cancelled' | 'unknown' | null,
        observedOutcomeEvidence:
          core.observedOutcome && core.finishedEventId
            ? {
                kind: 'evidence',
                eventId: eventIds.get(core.finishedEventId)!,
              }
            : null,
        tests,
        gitDiffs,
        findings: summaryFindings,
      });
      await context.hooks?.afterDependenciesRead?.();
      active(context, attempt.deadlineAt);

      const owns = await transaction.$queryRaw<Array<{ ok: number }>>(
        Prisma.sql`SELECT 1 AS ok FROM run_processing_states WHERE organization_id = ${intent.organizationId}::uuid AND run_id = ${intent.runId}::uuid AND projector_name = ${SUMMARY_PROJECTOR_NAME} AND state = 'processing' AND lease_id = ${attempt.leaseId}::uuid AND active_intent_id = ${intent.id}::uuid AND lease_expires_at > clock_timestamp() AND attempt_deadline_at > clock_timestamp() FOR UPDATE`,
      );
      if (!owns[0])
        throw new SummaryProcessingError('processing_lease_lost', true);
      const [existing, priorReceipt] = await Promise.all([
        transaction.summaryRunProjection.findUnique({
          where: { runId: intent.runId },
          select: {
            summaryKey: true,
            sourceFingerprint: true,
            projectorVersion: true,
            generatorName: true,
            generatorVersion: true,
            formatVersion: true,
            templateVersion: true,
          },
        }),
        transaction.processingApplicationReceipt.findUnique({
          where: {
            intentId_projectorName_projectorVersion: {
              intentId: intent.id,
              projectorName: SUMMARY_PROJECTOR_NAME,
              projectorVersion: SUMMARY_PROJECTOR_VERSION,
            },
          },
          select: { id: true },
        }),
      ]);
      const projectionCurrent = Boolean(
        existing?.summaryKey === summary.summaryKey &&
        existing?.sourceFingerprint === sourceFingerprint &&
        existing?.projectorVersion === SUMMARY_PROJECTOR_VERSION &&
        existing?.generatorName === SUMMARY_GENERATOR_NAME &&
        existing?.generatorVersion === SUMMARY_GENERATOR_VERSION &&
        existing?.formatVersion === SUMMARY_FORMAT_VERSION &&
        existing?.templateVersion === SUMMARY_TEMPLATE_VERSION,
      );
      if (!projectionCurrent) {
        await transaction.summaryRunProjection.upsert({
          where: { runId: intent.runId },
          create: {
            organizationId: intent.organizationId,
            repositoryId: intent.run.repositoryId,
            runId: intent.runId,
            projectorName: SUMMARY_PROJECTOR_NAME,
            projectorVersion: SUMMARY_PROJECTOR_VERSION,
            generatorName: SUMMARY_GENERATOR_NAME,
            generatorVersion: SUMMARY_GENERATOR_VERSION,
            formatVersion: SUMMARY_FORMAT_VERSION,
            templateVersion: SUMMARY_TEMPLATE_VERSION,
            summaryKey: summary.summaryKey,
            sourceFingerprint,
            coreVersion: core.projectorVersion,
            coreFingerprint: core.sourceFingerprint,
            coreCompleteness: core.evidenceCompleteness,
            filesVersion: filesCurrent ? files!.projectorVersion : null,
            filesFingerprint: filesCurrent ? files!.sourceFingerprint : null,
            filesCompleteness,
            findingsProjectorVersion: findings.projectorVersion,
            findingsFingerprint: findings.sourceFingerprint,
            findingsAnalyzerName: findings.analyzerName,
            findingsAnalyzerVersion: findings.analyzerVersion,
            findingsCatalogVersion: findings.catalogVersion,
            summaryOutcome: summary.outcome,
            sectionCount: summary.sectionCount,
            claimCount: summary.claimCount,
            claimsTruncated: summary.claimsTruncated,
          },
          update: {
            projectorName: SUMMARY_PROJECTOR_NAME,
            projectorVersion: SUMMARY_PROJECTOR_VERSION,
            generatorName: SUMMARY_GENERATOR_NAME,
            generatorVersion: SUMMARY_GENERATOR_VERSION,
            formatVersion: SUMMARY_FORMAT_VERSION,
            templateVersion: SUMMARY_TEMPLATE_VERSION,
            summaryKey: summary.summaryKey,
            sourceFingerprint,
            coreVersion: core.projectorVersion,
            coreFingerprint: core.sourceFingerprint,
            coreCompleteness: core.evidenceCompleteness,
            filesVersion: filesCurrent ? files!.projectorVersion : null,
            filesFingerprint: filesCurrent ? files!.sourceFingerprint : null,
            filesCompleteness,
            findingsProjectorVersion: findings.projectorVersion,
            findingsFingerprint: findings.sourceFingerprint,
            findingsAnalyzerName: findings.analyzerName,
            findingsAnalyzerVersion: findings.analyzerVersion,
            findingsCatalogVersion: findings.catalogVersion,
            summaryOutcome: summary.outcome,
            sectionCount: summary.sectionCount,
            claimCount: summary.claimCount,
            claimsTruncated: summary.claimsTruncated,
            updatedAt: new Date(),
          },
        });
        await transaction.summaryClaim.deleteMany({
          where: { runId: intent.runId },
        });
        const findingIds = new Map(
          findings.results.map((result) => [result.resultKey, result.id]),
        );
        for (const claim of summary.claims) {
          const row = await transaction.summaryClaim.create({
            data: {
              organizationId: intent.organizationId,
              runId: intent.runId,
              claimKey: claim.claimKey,
              stableId: claim.stableId,
              sectionId: claim.sectionId,
              sectionOrder: claim.sectionOrder,
              claimOrder: claim.claimOrder,
              claimClass: claim.class,
              templateId: claim.templateId,
              text: claim.text,
              supportCount: claim.supportCount,
              supportsTruncated: claim.supportsTruncated,
            },
          });
          await transaction.summaryClaimSupport.createMany({
            data: claim.supports.map(
              (support: SummarySupport, ordinal: number) => {
                if (support.kind === 'evidence')
                  return {
                    organizationId: intent.organizationId,
                    runId: intent.runId,
                    claimId: row.id,
                    claimClass: claim.class,
                    ordinal,
                    supportKind: support.kind,
                    eventId: support.eventId,
                    artifactDeclarationId: support.artifactId ?? null,
                    eventArtifactPointer: support.eventArtifactPointer ?? null,
                    jsonPointer: support.jsonPointer ?? null,
                    fileOrdinal: support.fileOrdinal ?? null,
                    entryId: support.entryId ?? null,
                  };
                const findingResultId = findingIds.get(support.resultKey);
                if (!findingResultId)
                  throw new SummaryProcessingError(
                    'summary_finding_support_missing',
                    false,
                  );
                return {
                  organizationId: intent.organizationId,
                  runId: intent.runId,
                  claimId: row.id,
                  claimClass: claim.class,
                  ordinal,
                  supportKind: support.kind,
                  findingResultId,
                  findingResultKey: support.resultKey,
                  findingRuleId: support.ruleId,
                  findingRuleVersion: support.ruleVersion,
                  findingsSourceFingerprint: support.findingsSourceFingerprint,
                };
              },
            ),
          });
        }
        await context.hooks?.afterClaimsReplaced?.();
      }
      if (!priorReceipt)
        await transaction.processingApplicationReceipt.create({
          data: {
            organizationId: intent.organizationId,
            runId: intent.runId,
            intentId: intent.id,
            projectorName: SUMMARY_PROJECTOR_NAME,
            projectorVersion: SUMMARY_PROJECTOR_VERSION,
          },
        });
      await transaction.processingAttemptFailure.deleteMany({
        where: {
          intentId: intent.id,
          projectorName: SUMMARY_PROJECTOR_NAME,
          projectorVersion: SUMMARY_PROJECTOR_VERSION,
        },
      });
      const changed = await transaction.$executeRaw(
        Prisma.sql`UPDATE run_processing_states SET state = 'ready', lease_id = NULL, lease_expires_at = NULL, attempt_deadline_at = NULL, active_intent_id = NULL, attempt_source_fingerprint = NULL, attempt_count = 0, source_event_count = ${summary.claimCount}, source_max_sequence = NULL, source_fingerprint = ${sourceFingerprint}, completed_at = clock_timestamp(), last_error_code = NULL WHERE organization_id = ${intent.organizationId}::uuid AND run_id = ${intent.runId}::uuid AND projector_name = ${SUMMARY_PROJECTOR_NAME} AND state = 'processing' AND lease_id = ${attempt.leaseId}::uuid AND active_intent_id = ${intent.id}::uuid`,
      );
      if (changed !== 1)
        throw new SummaryProcessingError('processing_lease_lost', true);
      return projectionCurrent ? 'already_applied' : 'applied';
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: timeout,
      timeout,
    },
  );
}

async function process(
  client: DatabaseClient,
  intentId: string,
  options: SummaryProcessingOptions,
  allowFailedReplay: boolean,
  context: SummaryProcessingContext,
): Promise<SummaryProcessingResult> {
  validate(options);
  const intent = await client.processingIntent.findUnique({
    where: { id: intentId },
    select: {
      id: true,
      organizationId: true,
      runId: true,
      kind: true,
      run: { select: { repositoryId: true, canonicalRunId: true } },
    },
  });
  if (!intent) throw new SummaryProcessingError('intent_not_found', false);
  if (!['EVIDENCE_BATCH_ACCEPTED', 'ARTIFACT_VERIFIED'].includes(intent.kind))
    throw new SummaryProcessingError('unsupported_intent_kind', false);
  const [durableFailure, processingState, current] = await Promise.all([
    client.processingAttemptFailure.findUnique({
      where: {
        intentId_projectorName_projectorVersion: {
          intentId,
          projectorName: SUMMARY_PROJECTOR_NAME,
          projectorVersion: SUMMARY_PROJECTOR_VERSION,
        },
      },
      select: { id: true, sourceFingerprint: true },
    }),
    client.runProcessingState.findUnique({
      where: {
        organizationId_runId_projectorName: {
          organizationId: intent.organizationId,
          runId: intent.runId,
          projectorName: SUMMARY_PROJECTOR_NAME,
        },
      },
      select: {
        state: true,
        activeIntentId: true,
        attemptFingerprint: true,
      },
    }),
    inspectSummarySourceSnapshot(client, intent.organizationId, intent.runId),
  ]);
  const priorFingerprint =
    durableFailure?.sourceFingerprint ??
    processingState?.attemptFingerprint ??
    null;
  const changedFingerprint =
    current.fingerprint !== null &&
    priorFingerprint !== null &&
    current.fingerprint !== priorFingerprint;
  const laterOwnerWithCurrentSource = Boolean(
    processingState?.state === 'FAILED' &&
    processingState.activeIntentId !== intent.id &&
    current.fingerprint !== null &&
    !durableFailure,
  );
  const allowFailedRecovery =
    allowFailedReplay || changedFingerprint || laterOwnerWithCurrentSource;
  if (
    (durableFailure || processingState?.state === 'FAILED') &&
    !allowFailedRecovery
  )
    return 'failed';
  const attempt = await acquire(
    client,
    intent.organizationId,
    intent.runId,
    intent.id,
    options,
    allowFailedRecovery,
  );
  if (!attempt) return 'busy';
  try {
    return await publish(client, intent, attempt, context);
  } catch (cause) {
    const error =
      cause instanceof SummaryProcessingError
        ? cause
        : new SummaryProcessingError('summary_projection_failed', true, {
            cause,
          });
    const state = await fail(
      client,
      {
        organizationId: intent.organizationId,
        runId: intent.runId,
        intentId: intent.id,
        attempt,
      },
      error,
      options,
    );
    if (state === 'failed') return 'failed';
    throw error;
  }
}

export function processSummaryIntent(
  client: DatabaseClient,
  intentId: string,
  options: SummaryProcessingOptions,
  context: SummaryProcessingContext = {},
): Promise<SummaryProcessingResult> {
  return process(client, intentId, options, false, context);
}

/** Explicit single-intent replay boundary; operator-facing bulk replay is deferred. */
export function replaySummaryIntent(
  client: DatabaseClient,
  intentId: string,
  options: SummaryProcessingOptions,
  context: SummaryProcessingContext = {},
): Promise<SummaryProcessingResult> {
  return process(client, intentId, options, true, context);
}
