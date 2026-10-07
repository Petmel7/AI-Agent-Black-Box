import { createHash, randomUUID } from 'node:crypto';

import {
  ANALYZER_NAME,
  ANALYZER_VERSION,
  CATALOG_VERSION,
  evaluateCatalog,
  type AnalyzerCommand,
  type AnalyzerFile,
} from '@blackbox/analyzers';

import { Prisma } from './generated/client/client.js';
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
import { lockRunSourceSet } from './run-source-lock.js';

export const FINDINGS_PROJECTOR_NAME = 'findings';
export const FINDINGS_PROJECTOR_VERSION = 1;

export interface FindingsProcessingOptions {
  leaseSeconds: number;
  attemptTimeoutMs: number;
  transitionMarginMs: number;
  maxAttempts: number;
  retryBaseSeconds: number;
  retryMaxSeconds: number;
}

export interface FindingsProcessingContext {
  signal?: AbortSignal;
  hooks?: {
    afterDependenciesRead?: () => void | Promise<void>;
    afterResultsReplaced?: () => void | Promise<void>;
  };
}

export type FindingsProcessingResult =
  'applied' | 'already_applied' | 'busy' | 'failed';

export class FindingsProcessingError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = 'FindingsProcessingError';
  }
}

type Attempt = {
  leaseId: string;
  deadlineAt: Date;
  attemptedFingerprint: string | null;
};

function validate(options: FindingsProcessingOptions): void {
  for (const value of Object.values(options))
    if (!Number.isSafeInteger(value) || value < 1)
      throw new TypeError(
        'Findings processing bounds must be positive safe integers.',
      );
  if (
    options.leaseSeconds * 1_000 <=
    options.attemptTimeoutMs + options.transitionMarginMs
  )
    throw new TypeError(
      'Findings lease must exceed attempt timeout plus transition margin.',
    );
}

function active(context: FindingsProcessingContext, deadlineAt: Date): void {
  if (context.signal?.aborted)
    throw new FindingsProcessingError('processing_cancelled', true);
  if (Date.now() >= deadlineAt.getTime())
    throw new FindingsProcessingError(
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

export interface FindingsSourceSnapshot {
  fingerprint: string | null;
  coreCurrent: boolean;
  filesCurrent: boolean;
  filesCompleteness: 'complete' | 'missing' | 'stale' | 'incomplete';
}

/** Recomputes dependency identity without running rules or reading artifacts. */
export async function inspectFindingsSourceSnapshot(
  client: DatabaseClient | Prisma.TransactionClient,
  organizationId: string,
  runId: string,
): Promise<FindingsSourceSnapshot> {
  const [raw, core, coreState, files, filesState, currentFiles] =
    await Promise.all([
      client.evidenceEvent.aggregate({
        where: { runId },
        _count: { _all: true },
        _max: { sequence: true },
      }),
      client.coreRunProjection.findUnique({ where: { runId } }),
      client.runProcessingState.findUnique({
        where: {
          organizationId_runId_projectorName: {
            organizationId,
            runId,
            projectorName: CORE_PROJECTOR_NAME,
          },
        },
      }),
      client.fileRunProjection.findUnique({ where: { runId } }),
      client.runProcessingState.findUnique({
        where: {
          organizationId_runId_projectorName: {
            organizationId,
            runId,
            projectorName: FILES_PROJECTOR_NAME,
          },
        },
      }),
      inspectFileSourceSnapshot(client, organizationId, runId),
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
  return {
    coreCurrent,
    filesCurrent,
    filesCompleteness,
    fingerprint:
      !coreCurrent || !core
        ? null
        : fingerprint({
            analyzerName: ANALYZER_NAME,
            analyzerVersion: ANALYZER_VERSION,
            catalogVersion: CATALOG_VERSION,
            core: {
              version: core.projectorVersion,
              fingerprint: core.sourceFingerprint,
              completeness: core.evidenceCompleteness,
            },
            files:
              filesCurrent && files
                ? {
                    version: files.projectorVersion,
                    fingerprint: files.sourceFingerprint,
                    completeness: files.completeness,
                  }
                : {
                    version: null,
                    fingerprint: currentFiles.fingerprint,
                    completeness: filesCompleteness,
                  },
          }),
  };
}

function commandIdentity(value: Prisma.JsonValue | null): {
  value: string | null;
  available: boolean;
} {
  if (!value || Array.isArray(value) || typeof value !== 'object')
    return { value: null, available: false };
  const capture = value as Record<string, Prisma.JsonValue>;
  return capture.state === 'captured' &&
    typeof capture.excerpt === 'string' &&
    capture.truncated === false
    ? { value: capture.excerpt, available: true }
    : { value: null, available: false };
}

function changeKind(
  before: Prisma.JsonValue | null,
  after: Prisma.JsonValue | null,
  originalEntryId: string | null,
): AnalyzerFile['changeKind'] {
  if (originalEntryId) return 'renamed';
  if (before === null && after !== null) return 'added';
  if (before !== null && after === null) return 'deleted';
  if (before !== null && after !== null) return 'modified';
  return 'unavailable';
}

async function acquire(
  client: DatabaseClient,
  organizationId: string,
  runId: string,
  intentId: string,
  options: FindingsProcessingOptions,
  allowFailedRecovery: boolean,
): Promise<Attempt | null> {
  const leaseId = randomUUID();
  const rows = await client.$queryRaw<
    Array<{ leaseId: string; deadlineAt: Date }>
  >(Prisma.sql`
    INSERT INTO run_processing_states (organization_id, run_id, projector_name, projector_version, state, lease_id, lease_expires_at, attempt_deadline_at, active_intent_id, attempt_count)
    VALUES (${organizationId}::uuid, ${runId}::uuid, ${FINDINGS_PROJECTOR_NAME}, ${FINDINGS_PROJECTOR_VERSION}, 'processing', ${leaseId}::uuid,
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
  error: FindingsProcessingError,
  options: FindingsProcessingOptions,
): Promise<'failed' | 'retrying' | 'lost'> {
  return client.$transaction(async (transaction) => {
    const rows = await transaction.$queryRaw<
      Array<{ state: 'failed' | 'retrying'; attemptCount: number }>
    >(Prisma.sql`
      WITH owned AS (
        SELECT id, CASE WHEN ${input.attempt.attemptedFingerprint}::text IS NOT NULL AND attempt_source_fingerprint IS DISTINCT FROM ${input.attempt.attemptedFingerprint}::text THEN 1 ELSE attempt_count END AS scoped_attempt_count
        FROM run_processing_states
        WHERE organization_id = ${input.organizationId}::uuid AND run_id = ${input.runId}::uuid AND projector_name = ${FINDINGS_PROJECTOR_NAME}
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
            projectorName: FINDINGS_PROJECTOR_NAME,
            projectorVersion: FINDINGS_PROJECTOR_VERSION,
          },
        },
        create: {
          organizationId: input.organizationId,
          runId: input.runId,
          intentId: input.intentId,
          projectorName: FINDINGS_PROJECTOR_NAME,
          projectorVersion: FINDINGS_PROJECTOR_VERSION,
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

async function publish(
  client: DatabaseClient,
  intent: {
    id: string;
    organizationId: string;
    runId: string;
    run: { repositoryId: string; canonicalRunId: string };
  },
  attempt: Attempt,
  options: FindingsProcessingOptions,
  context: FindingsProcessingContext,
): Promise<FindingsProcessingResult> {
  const timeout = Math.max(1, attempt.deadlineAt.getTime() - Date.now());
  return client.$transaction(
    async (transaction) => {
      active(context, attempt.deadlineAt);
      await lockRunSourceSet(transaction, intent.runId);
      const [raw, core, coreState, fileProjection, fileState, currentFiles] =
        await Promise.all([
          transaction.evidenceEvent.aggregate({
            where: { runId: intent.runId },
            _count: { _all: true },
            _max: { sequence: true },
          }),
          transaction.coreRunProjection.findUnique({
            where: { runId: intent.runId },
            include: {
              commands: { orderBy: { operationId: 'asc' } },
              tests: true,
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
            include: {
              files: {
                orderBy: [{ sourceSequence: 'asc' }, { ordinal: 'asc' }],
              },
            },
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
        ]);
      if (
        !core ||
        core.projectorVersion !== CORE_PROJECTOR_VERSION ||
        coreState?.state !== 'READY' ||
        coreState.projectorVersion !== CORE_PROJECTOR_VERSION ||
        core.sourceEventCount !== raw._count._all ||
        core.sourceMaxSequence !== raw._max.sequence ||
        coreState.sourceFingerprint !== core.sourceFingerprint
      )
        throw new FindingsProcessingError('findings_core_stale', true);

      const filesCurrent =
        currentFiles.complete &&
        fileProjection?.projectorVersion === FILES_PROJECTOR_VERSION &&
        fileState?.state === 'READY' &&
        fileState.projectorVersion === FILES_PROJECTOR_VERSION &&
        fileProjection.sourceFingerprint === currentFiles.fingerprint &&
        fileState.sourceFingerprint === currentFiles.fingerprint;
      const filesStatus = filesCurrent
        ? 'complete'
        : currentFiles.count === 0
          ? 'missing'
          : currentFiles.complete
            ? 'stale'
            : 'incomplete';
      const files: AnalyzerFile[] = filesCurrent
        ? fileProjection.files.map((file) => ({
            displayPath: file.displayPath,
            originalDisplayPath: file.originalDisplayPath,
            displayAmbiguous: file.displayAmbiguous,
            displayReason: file.displayReason,
            attribution: file.attribution as AnalyzerFile['attribution'],
            changeKind: changeKind(
              file.beforeState,
              file.afterState,
              file.originalEntryId,
            ),
            evidence: {
              eventId: file.sourceEventId,
              artifactId: file.artifactDeclarationId,
              eventArtifactPointer: '/payload/fileListArtifact',
              jsonPointer: `/files/${file.ordinal}`,
              fileOrdinal: file.ordinal,
              entryId: file.entryId,
            },
          }))
        : [];
      const commandCanonicalEventIds = [
        ...new Set(
          core.commands.flatMap((command) => {
            const eventId = command.startEventId ?? command.finishEventId;
            return eventId === null ? [] : [eventId];
          }),
        ),
      ];
      const commandEvents =
        commandCanonicalEventIds.length === 0
          ? []
          : await transaction.evidenceEvent.findMany({
              where: {
                organizationId: intent.organizationId,
                runId: intent.runId,
                canonicalEventId: { in: commandCanonicalEventIds },
              },
              select: { id: true, canonicalEventId: true },
            });
      const commandEventIds = new Map(
        commandEvents.map((event) => [event.canonicalEventId, event.id]),
      );
      const commands: AnalyzerCommand[] = core.commands.map((command) => {
        const identity = commandIdentity(command.commandCapture);
        const canonicalEventId = command.startEventId ?? command.finishEventId;
        const eventId =
          canonicalEventId === null
            ? undefined
            : commandEventIds.get(canonicalEventId);
        if (eventId === undefined)
          throw new FindingsProcessingError(
            'findings_command_evidence_missing',
            false,
          );
        return {
          operationId: command.operationId,
          state: command.state as AnalyzerCommand['state'],
          outcome: command.outcome,
          commandIdentity: identity.value,
          identityAvailable: identity.available,
          evidence: { eventId },
        };
      });
      const evaluation = evaluateCatalog({
        organizationId: intent.organizationId,
        canonicalRunId: intent.run.canonicalRunId,
        coreComplete: core.evidenceCompleteness === 'complete',
        filesState: filesStatus,
        files,
        commands,
        successfulTestCount: core.tests.filter(
          (test) => test.outcome === 'passed',
        ).length,
      });
      const sourceFingerprint = fingerprint({
        analyzerName: ANALYZER_NAME,
        analyzerVersion: ANALYZER_VERSION,
        catalogVersion: CATALOG_VERSION,
        core: {
          version: core.projectorVersion,
          fingerprint: core.sourceFingerprint,
          completeness: core.evidenceCompleteness,
        },
        files: filesCurrent
          ? {
              version: fileProjection.projectorVersion,
              fingerprint: fileProjection.sourceFingerprint,
              completeness: fileProjection.completeness,
            }
          : {
              version: null,
              fingerprint: currentFiles.fingerprint,
              completeness: filesStatus,
            },
      });
      attempt.attemptedFingerprint = sourceFingerprint;
      await context.hooks?.afterDependenciesRead?.();
      active(context, attempt.deadlineAt);
      const owns = await transaction.$queryRaw<Array<{ ok: number }>>(
        Prisma.sql`SELECT 1 AS ok FROM run_processing_states WHERE organization_id = ${intent.organizationId}::uuid AND run_id = ${intent.runId}::uuid AND projector_name = ${FINDINGS_PROJECTOR_NAME} AND state = 'processing' AND lease_id = ${attempt.leaseId}::uuid AND active_intent_id = ${intent.id}::uuid AND lease_expires_at > clock_timestamp() AND attempt_deadline_at > clock_timestamp() FOR UPDATE`,
      );
      if (!owns[0])
        throw new FindingsProcessingError('processing_lease_lost', true);
      const [existing, priorReceipt] = await Promise.all([
        transaction.findingsRunProjection.findUnique({
          where: { runId: intent.runId },
          select: {
            sourceFingerprint: true,
            projectorVersion: true,
            analyzerName: true,
            analyzerVersion: true,
            catalogVersion: true,
          },
        }),
        transaction.processingApplicationReceipt.findUnique({
          where: {
            intentId_projectorName_projectorVersion: {
              intentId: intent.id,
              projectorName: FINDINGS_PROJECTOR_NAME,
              projectorVersion: FINDINGS_PROJECTOR_VERSION,
            },
          },
          select: { id: true },
        }),
      ]);
      const projectionCurrent = Boolean(
        existing?.sourceFingerprint === sourceFingerprint &&
        existing.projectorVersion === FINDINGS_PROJECTOR_VERSION &&
        existing.analyzerName === ANALYZER_NAME &&
        existing.analyzerVersion === ANALYZER_VERSION &&
        existing.catalogVersion === CATALOG_VERSION,
      );
      if (!projectionCurrent) {
        await transaction.findingsRunProjection.upsert({
          where: { runId: intent.runId },
          create: {
            organizationId: intent.organizationId,
            repositoryId: intent.run.repositoryId,
            runId: intent.runId,
            projectorName: FINDINGS_PROJECTOR_NAME,
            projectorVersion: FINDINGS_PROJECTOR_VERSION,
            analyzerName: ANALYZER_NAME,
            analyzerVersion: ANALYZER_VERSION,
            catalogVersion: CATALOG_VERSION,
            sourceFingerprint,
            coreVersion: core.projectorVersion,
            coreFingerprint: core.sourceFingerprint,
            coreCompleteness: core.evidenceCompleteness,
            filesVersion: filesCurrent ? fileProjection.projectorVersion : null,
            filesFingerprint: filesCurrent
              ? fileProjection.sourceFingerprint
              : null,
            filesCompleteness: filesStatus,
            deterministicOutcome: evaluation.deterministicOutcome,
            coverage: evaluation.coverage,
            triggeredCount: evaluation.results.filter(
              (result) => result.outcome === 'triggered',
            ).length,
            unknownCount: evaluation.results.filter(
              (result) => result.outcome === 'unknown',
            ).length,
            highCount: evaluation.results.filter(
              (result) =>
                result.outcome === 'triggered' && result.severity === 'high',
            ).length,
            mediumCount: evaluation.results.filter(
              (result) =>
                result.outcome === 'triggered' && result.severity === 'medium',
            ).length,
          },
          update: {
            projectorName: FINDINGS_PROJECTOR_NAME,
            projectorVersion: FINDINGS_PROJECTOR_VERSION,
            analyzerName: ANALYZER_NAME,
            analyzerVersion: ANALYZER_VERSION,
            catalogVersion: CATALOG_VERSION,
            sourceFingerprint,
            coreVersion: core.projectorVersion,
            coreFingerprint: core.sourceFingerprint,
            coreCompleteness: core.evidenceCompleteness,
            filesVersion: filesCurrent ? fileProjection.projectorVersion : null,
            filesFingerprint: filesCurrent
              ? fileProjection.sourceFingerprint
              : null,
            filesCompleteness: filesStatus,
            deterministicOutcome: evaluation.deterministicOutcome,
            coverage: evaluation.coverage,
            triggeredCount: evaluation.results.filter(
              (result) => result.outcome === 'triggered',
            ).length,
            unknownCount: evaluation.results.filter(
              (result) => result.outcome === 'unknown',
            ).length,
            highCount: evaluation.results.filter(
              (result) =>
                result.outcome === 'triggered' && result.severity === 'high',
            ).length,
            mediumCount: evaluation.results.filter(
              (result) =>
                result.outcome === 'triggered' && result.severity === 'medium',
            ).length,
            updatedAt: new Date(),
          },
        });
        await transaction.findingRuleResult.deleteMany({
          where: { runId: intent.runId },
        });
        for (const [catalogOrder, result] of evaluation.results.entries()) {
          const row = await transaction.findingRuleResult.create({
            data: {
              organizationId: intent.organizationId,
              runId: intent.runId,
              resultKey: result.resultKey,
              catalogOrder,
              ruleId: result.id,
              ruleVersion: result.version,
              severity: result.severity,
              outcome: result.outcome,
              coverage: result.coverage,
              reasonCodes:
                result.reasonCodes as unknown as Prisma.InputJsonValue,
              explanation: result.explanation,
              matchCount: result.matchCount,
              matches: result.matches as unknown as Prisma.InputJsonValue,
              matchesTruncated: result.matchesTruncated,
              referencesTruncated: result.referencesTruncated,
            },
          });
          if (result.references.length)
            await transaction.findingEvidenceReference.createMany({
              data: result.references.map((reference, ordinal) => ({
                organizationId: intent.organizationId,
                runId: intent.runId,
                resultId: row.id,
                ordinal,
                eventId: reference.eventId,
                artifactDeclarationId: reference.artifactId ?? null,
                eventArtifactPointer: reference.eventArtifactPointer ?? null,
                jsonPointer: reference.jsonPointer ?? null,
                fileOrdinal: reference.fileOrdinal ?? null,
                entryId: reference.entryId ?? null,
              })),
            });
        }
        await context.hooks?.afterResultsReplaced?.();
      }
      if (!priorReceipt)
        await transaction.processingApplicationReceipt.create({
          data: {
            organizationId: intent.organizationId,
            runId: intent.runId,
            intentId: intent.id,
            projectorName: FINDINGS_PROJECTOR_NAME,
            projectorVersion: FINDINGS_PROJECTOR_VERSION,
          },
        });
      await transaction.processingAttemptFailure.deleteMany({
        where: {
          intentId: intent.id,
          projectorName: FINDINGS_PROJECTOR_NAME,
          projectorVersion: FINDINGS_PROJECTOR_VERSION,
        },
      });
      const changed = await transaction.$executeRaw(
        Prisma.sql`UPDATE run_processing_states SET state = 'ready', lease_id = NULL, lease_expires_at = NULL, attempt_deadline_at = NULL, active_intent_id = NULL, attempt_source_fingerprint = NULL, attempt_count = 0, source_event_count = 9, source_max_sequence = NULL, source_fingerprint = ${sourceFingerprint}, completed_at = clock_timestamp(), last_error_code = NULL WHERE organization_id = ${intent.organizationId}::uuid AND run_id = ${intent.runId}::uuid AND projector_name = ${FINDINGS_PROJECTOR_NAME} AND state = 'processing' AND lease_id = ${attempt.leaseId}::uuid AND active_intent_id = ${intent.id}::uuid`,
      );
      if (changed !== 1)
        throw new FindingsProcessingError('processing_lease_lost', true);
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
  options: FindingsProcessingOptions,
  allowFailedReplay: boolean,
  context: FindingsProcessingContext,
): Promise<FindingsProcessingResult> {
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
  if (!intent) throw new FindingsProcessingError('intent_not_found', false);
  if (!['EVIDENCE_BATCH_ACCEPTED', 'ARTIFACT_VERIFIED'].includes(intent.kind))
    throw new FindingsProcessingError('unsupported_intent_kind', false);
  const [durableFailure, processingState, current] = await Promise.all([
    client.processingAttemptFailure.findUnique({
      where: {
        intentId_projectorName_projectorVersion: {
          intentId,
          projectorName: FINDINGS_PROJECTOR_NAME,
          projectorVersion: FINDINGS_PROJECTOR_VERSION,
        },
      },
      select: { id: true, sourceFingerprint: true },
    }),
    client.runProcessingState.findUnique({
      where: {
        organizationId_runId_projectorName: {
          organizationId: intent.organizationId,
          runId: intent.runId,
          projectorName: FINDINGS_PROJECTOR_NAME,
        },
      },
      select: {
        state: true,
        activeIntentId: true,
        attemptFingerprint: true,
      },
    }),
    inspectFindingsSourceSnapshot(client, intent.organizationId, intent.runId),
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
    return await publish(client, intent, attempt, options, context);
  } catch (cause) {
    const error =
      cause instanceof FindingsProcessingError
        ? cause
        : new FindingsProcessingError('findings_projection_failed', true, {
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

export function processFindingsIntent(
  client: DatabaseClient,
  intentId: string,
  options: FindingsProcessingOptions,
  context: FindingsProcessingContext = {},
): Promise<FindingsProcessingResult> {
  return process(client, intentId, options, false, context);
}

/** Explicit single-intent replay boundary; operator-facing bulk replay is deferred. */
export function replayFindingsIntent(
  client: DatabaseClient,
  intentId: string,
  options: FindingsProcessingOptions,
  context: FindingsProcessingContext = {},
): Promise<FindingsProcessingResult> {
  return process(client, intentId, options, true, context);
}
