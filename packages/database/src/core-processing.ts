import { randomUUID } from 'node:crypto';

import { Prisma } from './generated/client/client.js';
import type { DatabaseClient } from './client.js';
import {
  CORE_PROJECTOR_NAME,
  CORE_PROJECTOR_VERSION,
  InvalidCanonicalEventError,
  ProjectionCancelledError,
  ProjectionLimitError,
  projectCoreEvents,
  type CoreProjectorLimits,
  type CoreProjectionSnapshot,
} from './core-projector.js';

export interface CoreProcessingOptions extends CoreProjectorLimits {
  eventPageSize: number;
  leaseSeconds: number;
  attemptTimeoutMs: number;
  transitionMarginMs: number;
  maxAttempts: number;
  retryBaseSeconds: number;
  retryMaxSeconds: number;
}

export type CoreProcessingResult =
  'applied' | 'already_applied' | 'busy' | 'failed';

export interface CoreProcessingContext {
  signal?: AbortSignal;
  hooks?: {
    afterChildrenReplaced?: () => void | Promise<void>;
    beforeReceipt?: () => void | Promise<void>;
  };
}

interface ProcessingAttempt {
  leaseId: string;
  deadlineAt: Date;
  attemptedFingerprint: string | null;
}

class SafeProcessingError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(code);
    this.name = 'SafeProcessingError';
  }
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function validate(options: CoreProcessingOptions) {
  for (const value of Object.values(options))
    if (!Number.isSafeInteger(value) || value < 1)
      throw new TypeError('Processing bounds must be positive safe integers.');
  if (
    options.leaseSeconds * 1_000 <=
    options.attemptTimeoutMs + options.transitionMarginMs
  )
    throw new TypeError(
      'Projection lease must exceed the attempt deadline plus transition margin.',
    );
}

function assertActive(context: CoreProcessingContext, deadlineAt: Date) {
  if (context.signal?.aborted)
    throw new SafeProcessingError('processing_cancelled', true);
  if (Date.now() >= deadlineAt.getTime())
    throw new SafeProcessingError('projection_attempt_deadline_exceeded', true);
}

async function acquire(
  client: DatabaseClient,
  organizationId: string,
  runId: string,
  intentId: string,
  options: CoreProcessingOptions,
  allowFailedReplay: boolean,
): Promise<ProcessingAttempt | null> {
  const leaseId = randomUUID();
  const rows = await client.$queryRaw<
    Array<{ leaseId: string; deadlineAt: Date }>
  >(Prisma.sql`
    INSERT INTO run_processing_states (organization_id, run_id, projector_name, projector_version, state, lease_id, lease_expires_at,
                                       attempt_deadline_at, active_intent_id, attempt_count)
    VALUES (${organizationId}::uuid, ${runId}::uuid, ${CORE_PROJECTOR_NAME}, ${CORE_PROJECTOR_VERSION}, 'processing', ${leaseId}::uuid,
            clock_timestamp() + make_interval(secs => ${options.leaseSeconds}),
            clock_timestamp() + ${options.attemptTimeoutMs} * interval '1 millisecond', ${intentId}::uuid, 1)
    ON CONFLICT (organization_id, run_id, projector_name) DO UPDATE
       SET projector_version = EXCLUDED.projector_version, state = 'processing', lease_id = EXCLUDED.lease_id,
           lease_expires_at = EXCLUDED.lease_expires_at, attempt_deadline_at = EXCLUDED.attempt_deadline_at,
           active_intent_id = EXCLUDED.active_intent_id,
           attempt_source_fingerprint = CASE WHEN run_processing_states.active_intent_id = EXCLUDED.active_intent_id
                                             THEN run_processing_states.attempt_source_fingerprint ELSE NULL END,
           attempt_count = CASE WHEN run_processing_states.active_intent_id = EXCLUDED.active_intent_id
                                THEN run_processing_states.attempt_count + 1 ELSE 1 END,
           completed_at = NULL, last_error_code = NULL
     WHERE (run_processing_states.state <> 'processing'
            AND (${allowFailedReplay} OR run_processing_states.state <> 'failed' OR run_processing_states.active_intent_id <> EXCLUDED.active_intent_id)
            AND run_processing_states.available_at <= clock_timestamp())
        OR (run_processing_states.state = 'processing' AND run_processing_states.lease_expires_at <= clock_timestamp())
    RETURNING lease_id AS "leaseId", attempt_deadline_at AS "deadlineAt"
  `);
  return rows[0] ? { ...rows[0], attemptedFingerprint: null } : null;
}

async function loadEvents(
  transaction: Prisma.TransactionClient,
  runId: string,
  options: CoreProcessingOptions,
  context: CoreProcessingContext,
  deadlineAt: Date,
): Promise<unknown[]> {
  const values: unknown[] = [];
  let after: bigint | null = null;
  while (true) {
    assertActive(context, deadlineAt);
    const page: Array<{ sequence: bigint; rawEvent: Prisma.JsonValue }> =
      await transaction.evidenceEvent.findMany({
        where: {
          runId,
          ...(after === null ? {} : { sequence: { gt: after } }),
        },
        orderBy: { sequence: 'asc' },
        take: Math.min(
          options.eventPageSize,
          options.maxEvents + 1 - values.length,
        ),
        select: { sequence: true, rawEvent: true },
      });
    for (const row of page) values.push(row.rawEvent);
    assertActive(context, deadlineAt);
    if (values.length > options.maxEvents)
      throw new ProjectionLimitError('event_limit_exceeded');
    if (page.length < options.eventPageSize || page.length === 0) break;
    after = page.at(-1)!.sequence;
  }
  return values;
}

function parentData(
  organizationId: string,
  repositoryId: string,
  runId: string,
  snapshot: CoreProjectionSnapshot,
) {
  return {
    organizationId,
    repositoryId,
    runId,
    projectorName: snapshot.projectorName,
    projectorVersion: snapshot.projectorVersion,
    sourceEventCount: snapshot.source.eventCount,
    sourceMaxSequence:
      snapshot.source.maxSequence === null
        ? null
        : BigInt(snapshot.source.maxSequence),
    sourceFingerprint: snapshot.source.fingerprint,
    startedEventId: snapshot.run.started?.eventId ?? null,
    startedSequence: snapshot.run.started
      ? BigInt(snapshot.run.started.sequence)
      : null,
    finishedEventId: snapshot.run.finished?.eventId ?? null,
    finishedSequence: snapshot.run.finished
      ? BigInt(snapshot.run.finished.sequence)
      : null,
    adapter: snapshot.run.adapter,
    provider: snapshot.run.provider,
    observedOutcome: snapshot.run.observedOutcome,
    durationMs:
      snapshot.run.durationMs === null ? null : BigInt(snapshot.run.durationMs),
    evidenceCompleteness: snapshot.run.evidenceCompleteness,
    completenessReasons: json(snapshot.run.completenessReasons),
    commandCount: snapshot.run.commandCount,
    toolCallCount: snapshot.run.toolCallCount,
    testObservationState: snapshot.run.testObservationState,
    testCounts: json(snapshot.run.testCounts),
    tokenAggregates: json(snapshot.run.tokenAggregates),
    filesChanged:
      snapshot.run.filesChanged === null
        ? null
        : BigInt(snapshot.run.filesChanged),
    updatedAt: new Date(),
  };
}

async function replaceChildren(
  transaction: Prisma.TransactionClient,
  organizationId: string,
  runId: string,
  snapshot: CoreProjectionSnapshot,
) {
  await Promise.all([
    transaction.coreCommandProjection.deleteMany({ where: { runId } }),
    transaction.coreToolProjection.deleteMany({ where: { runId } }),
    transaction.coreTestProjection.deleteMany({ where: { runId } }),
    transaction.coreGitSnapshotProjection.deleteMany({ where: { runId } }),
    transaction.coreGitDiffProjection.deleteMany({ where: { runId } }),
    transaction.coreErrorProjection.deleteMany({ where: { runId } }),
    transaction.coreUsageProjection.deleteMany({ where: { runId } }),
  ]);
  if (snapshot.commands.length)
    await transaction.coreCommandProjection.createMany({
      data: snapshot.commands.map((item) => ({
        organizationId,
        runId,
        operationId: item.operationId,
        startEventId: item.start?.eventId ?? null,
        startSequence: item.start ? BigInt(item.start.sequence) : null,
        finishEventId: item.finish?.eventId ?? null,
        finishSequence: item.finish ? BigInt(item.finish.sequence) : null,
        state: item.state,
        outcome: item.outcome,
        durationMs: item.durationMs === null ? null : BigInt(item.durationMs),
        exitCode: item.exitCode === null ? null : BigInt(item.exitCode),
        terminationSignal: item.terminationSignal,
        commandCapture:
          item.commandCapture === null
            ? Prisma.JsonNull
            : json(item.commandCapture),
        workingDirectory:
          item.workingDirectory === null
            ? Prisma.JsonNull
            : json(item.workingDirectory),
        stdoutCapture:
          item.stdoutCapture === null
            ? Prisma.JsonNull
            : json(item.stdoutCapture),
        stderrCapture:
          item.stderrCapture === null
            ? Prisma.JsonNull
            : json(item.stderrCapture),
      })),
    });
  if (snapshot.tools.length)
    await transaction.coreToolProjection.createMany({
      data: snapshot.tools.map((item) => ({
        organizationId,
        runId,
        operationId: item.operationId,
        startEventId: item.start?.eventId ?? null,
        startSequence: item.start ? BigInt(item.start.sequence) : null,
        finishEventId: item.finish?.eventId ?? null,
        finishSequence: item.finish ? BigInt(item.finish.sequence) : null,
        state: item.state,
        toolName: item.toolName,
        outcome: item.outcome,
        durationMs: item.durationMs === null ? null : BigInt(item.durationMs),
        inputCapture:
          item.inputCapture === null
            ? Prisma.JsonNull
            : json(item.inputCapture),
        outputCapture:
          item.outputCapture === null
            ? Prisma.JsonNull
            : json(item.outputCapture),
      })),
    });
  if (snapshot.tests.length)
    await transaction.coreTestProjection.createMany({
      data: snapshot.tests.map((item) => ({
        organizationId,
        runId,
        testRunId: item.testRunId,
        sourceEventId: item.source.eventId,
        sourceSequence: BigInt(item.source.sequence),
        commandId: item.commandId,
        framework: item.framework,
        outcome: item.outcome,
        counts: item.counts === null ? Prisma.JsonNull : json(item.counts),
        durationMs: item.durationMs === null ? null : BigInt(item.durationMs),
        reportArtifactId: item.reportArtifactId,
      })),
    });
  if (snapshot.gitSnapshots.length)
    await transaction.coreGitSnapshotProjection.createMany({
      data: snapshot.gitSnapshots.map((item) => ({
        organizationId,
        runId,
        snapshotId: item.snapshotId,
        sourceEventId: item.source.eventId,
        sourceSequence: BigInt(item.source.sequence),
        phase: item.phase,
        headCommit: item.headCommit,
        isDirty: item.isDirty,
        stagedFileCount:
          item.stagedFileCount === null ? null : BigInt(item.stagedFileCount),
        unstagedFileCount:
          item.unstagedFileCount === null
            ? null
            : BigInt(item.unstagedFileCount),
        untrackedFileCount:
          item.untrackedFileCount === null
            ? null
            : BigInt(item.untrackedFileCount),
        statusArtifactId: item.statusArtifactId,
      })),
    });
  if (snapshot.gitDiffs.length)
    await transaction.coreGitDiffProjection.createMany({
      data: snapshot.gitDiffs.map((item) => ({
        organizationId,
        runId,
        diffId: item.diffId,
        sourceEventId: item.source.eventId,
        sourceSequence: BigInt(item.source.sequence),
        fromSnapshotId: item.fromSnapshotId,
        toSnapshotId: item.toSnapshotId,
        filesChanged:
          item.filesChanged === null ? null : BigInt(item.filesChanged),
        linesAdded: item.linesAdded === null ? null : BigInt(item.linesAdded),
        linesDeleted:
          item.linesDeleted === null ? null : BigInt(item.linesDeleted),
        diffArtifactId: item.diffArtifactId,
        fileListArtifactId: item.fileListArtifactId,
      })),
    });
  if (snapshot.errors.length)
    await transaction.coreErrorProjection.createMany({
      data: snapshot.errors.map((item) => ({
        organizationId,
        runId,
        errorId: item.errorId,
        sourceEventId: item.source.eventId,
        sourceSequence: BigInt(item.source.sequence),
        category: item.category,
        code: item.code,
        retryable: item.retryable,
        messageCapture: json(item.messageCapture),
        relatedOperationId: item.relatedOperationId,
        relatedEventId: item.relatedEventId,
      })),
    });
  if (snapshot.usage.length)
    await transaction.coreUsageProjection.createMany({
      data: snapshot.usage.map((item) => ({
        organizationId,
        runId,
        sourceEventId: item.source.eventId,
        sourceSequence: BigInt(item.source.sequence),
        provider: item.provider,
        model: item.model,
        measurements: json(item.measurements),
      })),
    });
}

async function publish(
  client: DatabaseClient,
  intent: {
    id: string;
    organizationId: string;
    runId: string;
    run: { repositoryId: string };
  },
  attempt: ProcessingAttempt,
  options: CoreProcessingOptions,
  context: CoreProcessingContext,
): Promise<CoreProcessingResult> {
  assertActive(context, attempt.deadlineAt);
  const timeout = Math.max(1, attempt.deadlineAt.getTime() - Date.now());
  return client.$transaction(
    async (transaction) => {
      assertActive(context, attempt.deadlineAt);
      await transaction.$queryRaw(
        Prisma.sql`SELECT id FROM runs WHERE id = ${intent.runId}::uuid FOR UPDATE`,
      );
      assertActive(context, attempt.deadlineAt);
      const priorReceipt =
        await transaction.processingApplicationReceipt.findUnique({
          where: {
            intentId_projectorName_projectorVersion: {
              intentId: intent.id,
              projectorName: CORE_PROJECTOR_NAME,
              projectorVersion: CORE_PROJECTOR_VERSION,
            },
          },
          select: { id: true },
        });
      if (priorReceipt) {
        const changed = await transaction.$executeRaw(Prisma.sql`
        UPDATE run_processing_states AS state SET state = 'ready', lease_id = NULL, lease_expires_at = NULL,
               attempt_deadline_at = NULL, active_intent_id = NULL, attempt_source_fingerprint = NULL, attempt_count = 0,
               source_event_count = projection.source_event_count, source_max_sequence = projection.source_max_sequence,
               source_fingerprint = projection.source_fingerprint, completed_at = clock_timestamp(), last_error_code = NULL
          FROM core_run_projections AS projection
         WHERE state.organization_id = ${intent.organizationId}::uuid AND state.run_id = ${intent.runId}::uuid
           AND state.projector_name = ${CORE_PROJECTOR_NAME} AND state.state = 'processing' AND state.lease_id = ${attempt.leaseId}::uuid
           AND state.active_intent_id = ${intent.id}::uuid AND state.lease_expires_at > clock_timestamp()
           AND state.attempt_deadline_at > clock_timestamp()
           AND projection.organization_id = state.organization_id AND projection.run_id = state.run_id
      `);
        if (changed !== 1)
          throw new SafeProcessingError('processing_lease_lost', true);
        return 'already_applied';
      }
      const events = await loadEvents(
        transaction,
        intent.runId,
        options,
        context,
        attempt.deadlineAt,
      );
      const snapshot = projectCoreEvents(events, options, () => {
        return (
          context.signal?.aborted === true ||
          Date.now() >= attempt.deadlineAt.getTime()
        );
      });
      attempt.attemptedFingerprint = snapshot.source.fingerprint;
      assertActive(context, attempt.deadlineAt);
      const existing = await transaction.coreRunProjection.findUnique({
        where: { runId: intent.runId },
        select: { projectorVersion: true, sourceFingerprint: true },
      });
      if (
        !existing ||
        existing.projectorVersion !== CORE_PROJECTOR_VERSION ||
        existing.sourceFingerprint !== snapshot.source.fingerprint
      ) {
        const data = parentData(
          intent.organizationId,
          intent.run.repositoryId,
          intent.runId,
          snapshot,
        );
        await transaction.coreRunProjection.upsert({
          where: { runId: intent.runId },
          create: data,
          update: data,
        });
        await replaceChildren(
          transaction,
          intent.organizationId,
          intent.runId,
          snapshot,
        );
        await context.hooks?.afterChildrenReplaced?.();
        assertActive(context, attempt.deadlineAt);
      }
      const ownsLiveAttempt = await transaction.$queryRaw<
        Array<{ ok: number }>
      >(
        Prisma.sql`SELECT 1 AS ok FROM run_processing_states
                    WHERE organization_id = ${intent.organizationId}::uuid AND run_id = ${intent.runId}::uuid
                      AND projector_name = ${CORE_PROJECTOR_NAME} AND state = 'processing'
                      AND lease_id = ${attempt.leaseId}::uuid AND active_intent_id = ${intent.id}::uuid
                      AND lease_expires_at > clock_timestamp() AND attempt_deadline_at > clock_timestamp()
                    FOR UPDATE`,
      );
      if (!ownsLiveAttempt[0])
        throw new SafeProcessingError('processing_lease_lost', true);
      await context.hooks?.beforeReceipt?.();
      assertActive(context, attempt.deadlineAt);
      await transaction.processingAttemptFailure.deleteMany({
        where: {
          intentId: intent.id,
          projectorName: CORE_PROJECTOR_NAME,
          projectorVersion: CORE_PROJECTOR_VERSION,
        },
      });
      await transaction.processingApplicationReceipt.create({
        data: {
          organizationId: intent.organizationId,
          runId: intent.runId,
          intentId: intent.id,
          projectorName: CORE_PROJECTOR_NAME,
          projectorVersion: CORE_PROJECTOR_VERSION,
        },
      });
      const changed = await transaction.$executeRaw(Prisma.sql`
      UPDATE run_processing_states SET state = 'ready', lease_id = NULL, lease_expires_at = NULL, source_event_count = ${snapshot.source.eventCount},
             attempt_deadline_at = NULL, active_intent_id = NULL, attempt_source_fingerprint = NULL, attempt_count = 0,
             source_max_sequence = ${snapshot.source.maxSequence === null ? null : BigInt(snapshot.source.maxSequence)}, source_fingerprint = ${snapshot.source.fingerprint},
             completed_at = clock_timestamp(), last_error_code = NULL
       WHERE organization_id = ${intent.organizationId}::uuid AND run_id = ${intent.runId}::uuid AND projector_name = ${CORE_PROJECTOR_NAME}
         AND state = 'processing' AND lease_id = ${attempt.leaseId}::uuid AND active_intent_id = ${intent.id}::uuid
         AND lease_expires_at > clock_timestamp() AND attempt_deadline_at > clock_timestamp()
    `);
      if (changed !== 1)
        throw new SafeProcessingError('processing_lease_lost', true);
      return existing?.sourceFingerprint === snapshot.source.fingerprint &&
        existing.projectorVersion === CORE_PROJECTOR_VERSION
        ? 'already_applied'
        : 'applied';
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: timeout,
      timeout,
    },
  );
}

async function recordFailure(
  client: DatabaseClient,
  organizationId: string,
  runId: string,
  intentId: string,
  attempt: ProcessingAttempt,
  code: string,
  retryable: boolean,
  options: CoreProcessingOptions,
): Promise<'failed' | 'retrying' | 'lease_lost'> {
  return client.$transaction(async (transaction) => {
    const rows = await transaction.$queryRaw<
      Array<{
        state: 'failed' | 'retrying';
        attemptCount: number;
        sourceFingerprint: string | null;
      }>
    >(Prisma.sql`
    WITH owned AS (
      SELECT id,
             CASE WHEN ${attempt.attemptedFingerprint}::text IS NOT NULL
                            AND attempt_source_fingerprint IS DISTINCT FROM ${attempt.attemptedFingerprint}::text
                  THEN 1 ELSE attempt_count END AS scoped_attempt_count
        FROM run_processing_states
       WHERE organization_id = ${organizationId}::uuid AND run_id = ${runId}::uuid
         AND projector_name = ${CORE_PROJECTOR_NAME} AND state = 'processing'
         AND lease_id = ${attempt.leaseId}::uuid AND active_intent_id = ${intentId}::uuid
         AND lease_expires_at > clock_timestamp()
       FOR UPDATE
    )
    UPDATE run_processing_states AS processing
       SET state = CASE WHEN NOT ${retryable} OR owned.scoped_attempt_count >= ${options.maxAttempts}
                        THEN 'failed'::"RunProcessingStatus" ELSE 'retrying'::"RunProcessingStatus" END,
           lease_id = NULL, lease_expires_at = NULL, attempt_deadline_at = NULL,
           attempt_source_fingerprint = CASE WHEN ${attempt.attemptedFingerprint}::text IS NULL
                                             THEN processing.attempt_source_fingerprint
                                             ELSE ${attempt.attemptedFingerprint}::text END,
           attempt_count = owned.scoped_attempt_count,
           available_at = CASE WHEN NOT ${retryable} OR owned.scoped_attempt_count >= ${options.maxAttempts}
                               THEN clock_timestamp()
                               ELSE clock_timestamp() + LEAST(${options.retryMaxSeconds},
                                    ${options.retryBaseSeconds} * power(2, LEAST(30, GREATEST(0, owned.scoped_attempt_count - 1)))) * interval '1 second' END,
           completed_at = CASE WHEN NOT ${retryable} OR owned.scoped_attempt_count >= ${options.maxAttempts}
                               THEN clock_timestamp() ELSE NULL END,
           last_error_code = ${code}
      FROM owned
     WHERE processing.id = owned.id
     RETURNING processing.state::text AS state, processing.attempt_count AS "attemptCount",
               processing.attempt_source_fingerprint AS "sourceFingerprint"
  `);
    const changed = rows[0];
    if (!changed) return 'lease_lost';
    if (changed.state === 'retrying') {
      await transaction.processingAttemptFailure.deleteMany({
        where: {
          intentId,
          projectorName: CORE_PROJECTOR_NAME,
          projectorVersion: CORE_PROJECTOR_VERSION,
        },
      });
    } else {
      await transaction.processingAttemptFailure.upsert({
        where: {
          intentId_projectorName_projectorVersion: {
            intentId,
            projectorName: CORE_PROJECTOR_NAME,
            projectorVersion: CORE_PROJECTOR_VERSION,
          },
        },
        create: {
          organizationId,
          runId,
          intentId,
          projectorName: CORE_PROJECTOR_NAME,
          projectorVersion: CORE_PROJECTOR_VERSION,
          sourceFingerprint: changed.sourceFingerprint,
          attemptCount: changed.attemptCount,
          errorCode: code,
        },
        update: {
          sourceFingerprint: changed.sourceFingerprint,
          attemptCount: changed.attemptCount,
          errorCode: code,
          failedAt: new Date(),
        },
      });
    }
    return changed.state;
  });
}

async function process(
  client: DatabaseClient,
  intentId: string,
  options: CoreProcessingOptions,
  allowFailedReplay: boolean,
  context: CoreProcessingContext,
): Promise<CoreProcessingResult> {
  validate(options);
  const intent = await client.processingIntent.findUnique({
    where: { id: intentId },
    select: {
      id: true,
      organizationId: true,
      runId: true,
      kind: true,
      run: { select: { repositoryId: true } },
    },
  });
  if (!intent) throw new SafeProcessingError('intent_not_found', false);
  if (intent.kind !== 'EVIDENCE_BATCH_ACCEPTED')
    throw new SafeProcessingError('unsupported_intent_kind', false);
  const receipt = await client.processingApplicationReceipt.findUnique({
    where: {
      intentId_projectorName_projectorVersion: {
        intentId,
        projectorName: CORE_PROJECTOR_NAME,
        projectorVersion: CORE_PROJECTOR_VERSION,
      },
    },
    select: { id: true },
  });
  if (receipt) return 'already_applied';
  const durableFailure = await client.processingAttemptFailure.findUnique({
    where: {
      intentId_projectorName_projectorVersion: {
        intentId,
        projectorName: CORE_PROJECTOR_NAME,
        projectorVersion: CORE_PROJECTOR_VERSION,
      },
    },
    select: { id: true },
  });
  if (durableFailure && !allowFailedReplay) return 'failed';
  const current = await client.runProcessingState.findUnique({
    where: {
      organizationId_runId_projectorName: {
        organizationId: intent.organizationId,
        runId: intent.runId,
        projectorName: CORE_PROJECTOR_NAME,
      },
    },
    select: { state: true, activeIntentId: true },
  });
  if (
    !allowFailedReplay &&
    current?.state === 'FAILED' &&
    current.activeIntentId === intent.id
  )
    return 'failed';
  if (context.signal?.aborted)
    throw new SafeProcessingError('processing_cancelled', true);
  const attempt = await acquire(
    client,
    intent.organizationId,
    intent.runId,
    intent.id,
    options,
    allowFailedReplay,
  );
  if (!attempt) return 'busy';
  try {
    return await publish(client, intent, attempt, options, context);
  } catch (error) {
    const safe =
      error instanceof ProjectionLimitError ||
      error instanceof InvalidCanonicalEventError
        ? { code: error.code, retryable: false }
        : error instanceof ProjectionCancelledError
          ? { code: error.code, retryable: true }
          : error instanceof SafeProcessingError
            ? error
            : { code: 'projection_failed', retryable: true };
    const state = await recordFailure(
      client,
      intent.organizationId,
      intent.runId,
      intent.id,
      attempt,
      safe.code,
      safe.retryable,
      options,
    );
    if (state === 'failed') return 'failed';
    throw new SafeProcessingError(safe.code, safe.retryable);
  }
}

export function processCoreIntent(
  client: DatabaseClient,
  intentId: string,
  options: CoreProcessingOptions,
  context: CoreProcessingContext = {},
): Promise<CoreProcessingResult> {
  return process(client, intentId, options, false, context);
}

/** Explicit single-intent replay boundary; operator-facing bulk replay is deferred. */
export function replayCoreIntent(
  client: DatabaseClient,
  intentId: string,
  options: CoreProcessingOptions,
  context: CoreProcessingContext = {},
): Promise<CoreProcessingResult> {
  return process(client, intentId, options, true, context);
}
