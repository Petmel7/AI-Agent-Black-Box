import { createHash, randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';

import {
  EvidenceEventSchema,
  GIT_FILE_LIST_MAX_BYTES,
  GitFileListV1Schema,
  type GitFileEntryV1,
} from '@blackbox/contracts';

import { Prisma } from './generated/client/client.js';
import type { DatabaseClient } from './client.js';
import { lockRunSourceSet } from './run-source-lock.js';

export const FILES_PROJECTOR_NAME = 'files';
export const FILES_PROJECTOR_VERSION = 1;

export interface FileArtifactReadInput {
  objectKey: string;
  expectedBytes: number;
  expectedSha256: string;
  signal?: AbortSignal;
  deadlineAt: Date;
}

export type FileArtifactReader = (
  input: FileArtifactReadInput,
) => Promise<Uint8Array>;

export interface FileProcessingOptions {
  maxArtifacts: number;
  maxCumulativeBytes: number;
  maxEntries: number;
  maxProjectedRows: number;
  storageConcurrency: number;
  leaseSeconds: number;
  attemptTimeoutMs: number;
  transitionMarginMs: number;
  maxAttempts: number;
  retryBaseSeconds: number;
  retryMaxSeconds: number;
}

export interface FileProcessingContext {
  signal?: AbortSignal;
  hooks?: {
    beforePublish?: () => void | Promise<void>;
    afterRunSourceLock?: () => void | Promise<void>;
    afterRowsReplaced?: () => void | Promise<void>;
  };
}

export type FileProcessingResult =
  'applied' | 'already_applied' | 'busy' | 'failed';

export class FileProcessingError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = 'FileProcessingError';
  }
}

type SourceRow = {
  event_id: string;
  canonical_event_id: string;
  sequence: bigint;
  raw_event: Prisma.JsonValue;
  artifact_id: string | null;
  canonical_artifact_id: string | null;
  artifact_kind: string | null;
  media_type: string | null;
  byte_length: bigint | null;
  sha256: string | null;
  compression: string | null;
  character_encoding: string | null;
  raw_reference: Prisma.JsonValue | null;
  upload_id: string | null;
  object_key: string | null;
};

type FileSource = {
  eventId: string;
  canonicalEventId: string;
  sequence: number;
  diffId: string;
  fromSnapshotId: string;
  toSnapshotId: string;
  artifactDeclarationId: string;
  canonicalArtifactId: string;
  uploadId: string;
  objectKey: string;
  byteLength: number;
  sha256: string;
};

export interface FileSourceSnapshot {
  count: number;
  maxSequence: bigint | null;
  fingerprint: string;
  complete: boolean;
}

function validateOptions(options: FileProcessingOptions): void {
  for (const value of Object.values(options))
    if (!Number.isSafeInteger(value) || value < 1)
      throw new TypeError(
        'File processing bounds must be positive safe integers.',
      );
  if (
    options.leaseSeconds * 1_000 <=
    options.attemptTimeoutMs + options.transitionMarginMs
  )
    throw new TypeError(
      'Files lease must exceed attempt timeout plus transition margin.',
    );
  if (options.maxCumulativeBytes < GIT_FILE_LIST_MAX_BYTES)
    throw new TypeError(
      'Cumulative byte limit cannot be below one file-list artifact limit.',
    );
}

function active(context: FileProcessingContext, deadlineAt: Date): void {
  if (context.signal?.aborted)
    throw new FileProcessingError('processing_cancelled', true);
  if (Date.now() >= deadlineAt.getTime())
    throw new FileProcessingError('projection_attempt_deadline_exceeded', true);
}

function safeNumber(value: bigint, code: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0)
    throw new FileProcessingError(code, false);
  return result;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function fingerprintRows(rows: SourceRow[]): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        projector: FILES_PROJECTOR_NAME,
        version: FILES_PROJECTOR_VERSION,
        sources: rows.map((row) => ({
          eventId: row.canonical_event_id,
          sequence: row.sequence.toString(),
          event: row.raw_event,
          artifactId: row.canonical_artifact_id,
          artifactKind: row.artifact_kind,
          mediaType: row.media_type,
          byteLength: row.byte_length?.toString() ?? null,
          sha256: row.sha256,
          compression: row.compression,
          characterEncoding: row.character_encoding,
          reference: row.raw_reference,
          uploadId: row.upload_id,
          objectKey: row.object_key,
        })),
      }),
    )
    .digest('hex');
}

async function sourceRows(
  client: DatabaseClient | Prisma.TransactionClient,
  organizationId: string,
  runId: string,
): Promise<SourceRow[]> {
  return client.$queryRaw<SourceRow[]>(Prisma.sql`
    SELECT event.id AS event_id, event.canonical_event_id, event.sequence, event.raw_event,
           artifact.id AS artifact_id, artifact.canonical_artifact_id,
           artifact.kind AS artifact_kind, artifact.media_type, artifact.byte_length,
           artifact.sha256, artifact.compression, artifact.character_encoding,
           artifact.raw_reference, upload.id AS upload_id, upload.object_key
      FROM evidence_events AS event
      LEFT JOIN evidence_event_artifacts AS link
        ON link.organization_id = event.organization_id AND link.run_id = event.run_id
       AND link.event_id = event.id AND link.json_pointer = '/payload/fileListArtifact'
      LEFT JOIN artifact_declarations AS artifact
        ON artifact.organization_id = link.organization_id AND artifact.run_id = link.run_id
       AND artifact.id = link.artifact_id
      LEFT JOIN artifact_upload_attempts AS upload
        ON upload.organization_id = artifact.organization_id AND upload.run_id = artifact.run_id
       AND upload.artifact_declaration_id = artifact.id AND upload.state = 'verified'
     WHERE event.organization_id = ${organizationId}::uuid
       AND event.run_id = ${runId}::uuid
       AND event.kind = 'git.diff.captured'
     ORDER BY event.sequence, event.id, upload.id
  `);
}

async function discoverSources(
  client: DatabaseClient | Prisma.TransactionClient,
  organizationId: string,
  runId: string,
  options: FileProcessingOptions,
): Promise<{
  sources: FileSource[];
  fingerprint: string;
  maxSequence: number | null;
}> {
  const rows = await sourceRows(client, organizationId, runId);
  const fingerprint = fingerprintRows(rows);
  if (rows.length > options.maxArtifacts)
    throw new FileProcessingError('file_artifact_count_exceeded', false);
  const seenEvents = new Set<string>();
  const sources: FileSource[] = [];
  let cumulativeBytes = 0;
  for (const row of rows) {
    if (seenEvents.has(row.event_id))
      throw new FileProcessingError(
        'file_artifact_verified_attempt_conflict',
        false,
      );
    seenEvents.add(row.event_id);
    const event = EvidenceEventSchema.safeParse(row.raw_event);
    if (!event.success || event.data.kind !== 'git.diff.captured')
      throw new FileProcessingError('invalid_canonical_git_diff', false);
    const reference = event.data.payload.fileListArtifact;
    if (
      !row.artifact_id ||
      !row.canonical_artifact_id ||
      !row.upload_id ||
      !row.object_key
    )
      throw new FileProcessingError('file_evidence_unverified', true);
    if (
      row.artifact_kind !== 'git-file-list' ||
      row.media_type !== 'application/json' ||
      row.character_encoding !== 'utf-8' ||
      row.compression !== null
    )
      throw new FileProcessingError(
        'unsupported_file_artifact_encoding',
        false,
      );
    if (
      reference.artifactId !== row.canonical_artifact_id ||
      reference.kind !== row.artifact_kind ||
      reference.mediaType !== row.media_type ||
      BigInt(reference.byteLength) !== row.byte_length ||
      reference.sha256 !== row.sha256 ||
      canonicalJson(reference) !== canonicalJson(row.raw_reference)
    )
      throw new FileProcessingError('file_artifact_reference_mismatch', false);
    const byteLength = safeNumber(
      row.byte_length!,
      'file_artifact_length_invalid',
    );
    if (byteLength > GIT_FILE_LIST_MAX_BYTES)
      throw new FileProcessingError('file_artifact_too_large', false);
    cumulativeBytes += byteLength;
    if (cumulativeBytes > options.maxCumulativeBytes)
      throw new FileProcessingError('file_cumulative_bytes_exceeded', false);
    sources.push({
      eventId: row.event_id,
      canonicalEventId: row.canonical_event_id,
      sequence: safeNumber(row.sequence, 'file_source_sequence_invalid'),
      diffId: event.data.payload.diffId,
      fromSnapshotId: event.data.payload.fromSnapshotId,
      toSnapshotId: event.data.payload.toSnapshotId,
      artifactDeclarationId: row.artifact_id,
      canonicalArtifactId: row.canonical_artifact_id,
      uploadId: row.upload_id,
      objectKey: row.object_key,
      byteLength,
      sha256: row.sha256!,
    });
  }
  return {
    sources,
    fingerprint,
    maxSequence: sources.at(-1)?.sequence ?? null,
  };
}

/** Recomputes file-source identity without object I/O for query freshness checks. */
export async function inspectFileSourceSnapshot(
  client: DatabaseClient | Prisma.TransactionClient,
  organizationId: string,
  runId: string,
): Promise<FileSourceSnapshot> {
  const rows = await sourceRows(client, organizationId, runId);
  const events = new Map<string, bigint>();
  let complete = true;
  for (const row of rows) {
    if (events.has(row.event_id)) complete = false;
    else events.set(row.event_id, row.sequence);
    const event = EvidenceEventSchema.safeParse(row.raw_event);
    const reference =
      event.success && event.data.kind === 'git.diff.captured'
        ? event.data.payload.fileListArtifact
        : null;
    if (
      !reference ||
      !row.artifact_id ||
      !row.canonical_artifact_id ||
      !row.upload_id ||
      !row.object_key ||
      row.artifact_kind !== 'git-file-list' ||
      row.media_type !== 'application/json' ||
      row.character_encoding !== 'utf-8' ||
      row.compression !== null ||
      reference.artifactId !== row.canonical_artifact_id ||
      reference.kind !== row.artifact_kind ||
      reference.mediaType !== row.media_type ||
      BigInt(reference.byteLength) !== row.byte_length ||
      reference.sha256 !== row.sha256 ||
      canonicalJson(reference) !== canonicalJson(row.raw_reference)
    )
      complete = false;
  }
  const sequences = [...events.values()];
  return {
    count: events.size,
    maxSequence:
      sequences.length === 0
        ? null
        : sequences.reduce((maximum, value) =>
            value > maximum ? value : maximum,
          ),
    fingerprint: fingerprintRows(rows),
    complete,
  };
}

export function parseGitFileListArtifact(
  bytes: Uint8Array,
  source: Pick<FileSource, 'diffId' | 'fromSnapshotId' | 'toSnapshotId'>,
) {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  )
    throw new FileProcessingError('file_artifact_invalid_utf8', false);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new FileProcessingError('file_artifact_invalid_utf8', false, {
      cause: error,
    });
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new FileProcessingError('file_artifact_invalid_json', false, {
      cause: error,
    });
  }
  const parsed = GitFileListV1Schema.safeParse(json);
  if (!parsed.success)
    throw new FileProcessingError('file_artifact_schema_invalid', false);
  if (
    parsed.data.diffId !== source.diffId ||
    parsed.data.fromSnapshotId !== source.fromSnapshotId ||
    parsed.data.toSnapshotId !== source.toSnapshotId
  )
    throw new FileProcessingError(
      'file_artifact_root_identity_mismatch',
      false,
    );
  return parsed.data;
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  map: (value: T, signal: AbortSignal) => Promise<R>,
  parentSignal?: AbortSignal,
): Promise<R[]> {
  const controller = new AbortController();
  const abort = () => controller.abort(parentSignal?.reason);
  parentSignal?.addEventListener('abort', abort, { once: true });
  const results = new Array<R>(values.length);
  let cursor = 0;
  let firstError: unknown;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (!controller.signal.aborted && cursor < values.length) {
        const index = cursor++;
        try {
          results[index] = await map(values[index]!, controller.signal);
        } catch (error) {
          if (firstError === undefined) firstError = error;
          controller.abort(error);
        }
      }
    },
  );
  try {
    await Promise.allSettled(workers);
    if (firstError !== undefined) throw firstError;
    if (parentSignal?.aborted)
      throw new FileProcessingError('processing_cancelled', true);
    return results;
  } finally {
    parentSignal?.removeEventListener('abort', abort);
  }
}

function original(entry: GitFileEntryV1): {
  entryId: string | null;
  path: string | null;
} {
  const current = entry.after ?? entry.before!;
  if (!entry.before || entry.before.entryId === current.entryId)
    return { entryId: null, path: current.originalPath ?? null };
  return { entryId: entry.before.entryId, path: entry.before.path };
}

async function acquire(
  client: DatabaseClient | Prisma.TransactionClient,
  organizationId: string,
  runId: string,
  intentId: string,
  options: FileProcessingOptions,
  resetAttemptBudget: boolean,
): Promise<{
  leaseId: string;
  deadlineAt: Date;
  attemptedFingerprint: string | null;
} | null> {
  const leaseId = randomUUID();
  const rows = await client.$queryRaw<
    Array<{ leaseId: string; deadlineAt: Date }>
  >(Prisma.sql`
    INSERT INTO run_processing_states (
      organization_id, run_id, projector_name, projector_version, state,
      lease_id, lease_expires_at, attempt_deadline_at, active_intent_id, attempt_count
    ) VALUES (
      ${organizationId}::uuid, ${runId}::uuid, ${FILES_PROJECTOR_NAME}, ${FILES_PROJECTOR_VERSION}, 'processing',
      ${leaseId}::uuid, clock_timestamp() + make_interval(secs => ${options.leaseSeconds}),
      clock_timestamp() + ${options.attemptTimeoutMs} * interval '1 millisecond', ${intentId}::uuid, 1
    )
    ON CONFLICT (organization_id, run_id, projector_name) DO UPDATE SET
      projector_version = EXCLUDED.projector_version, state = 'processing', lease_id = EXCLUDED.lease_id,
      lease_expires_at = EXCLUDED.lease_expires_at, attempt_deadline_at = EXCLUDED.attempt_deadline_at,
      active_intent_id = EXCLUDED.active_intent_id,
      attempt_source_fingerprint = CASE WHEN ${resetAttemptBudget} THEN NULL
                                        WHEN run_processing_states.active_intent_id = EXCLUDED.active_intent_id
                                        THEN run_processing_states.attempt_source_fingerprint ELSE NULL END,
      attempt_count = CASE WHEN ${resetAttemptBudget} THEN 1
                           WHEN run_processing_states.active_intent_id = EXCLUDED.active_intent_id
                           THEN run_processing_states.attempt_count + 1 ELSE 1 END,
      completed_at = NULL, last_error_code = NULL
    WHERE (run_processing_states.state <> 'processing'
           AND (${resetAttemptBudget}
                OR ((run_processing_states.state <> 'failed'
                     OR run_processing_states.active_intent_id <> EXCLUDED.active_intent_id)
                    AND run_processing_states.available_at <= clock_timestamp())))
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
    leaseId: string;
    attemptedFingerprint: string | null;
  },
  error: FileProcessingError,
  options: FileProcessingOptions,
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
             CASE WHEN ${input.attemptedFingerprint}::text IS NOT NULL
                        AND attempt_source_fingerprint IS DISTINCT FROM ${input.attemptedFingerprint}::text
                  THEN 1 ELSE attempt_count END AS scoped_attempt_count
        FROM run_processing_states
       WHERE organization_id = ${input.organizationId}::uuid AND run_id = ${input.runId}::uuid
         AND projector_name = ${FILES_PROJECTOR_NAME} AND state = 'processing'
         AND lease_id = ${input.leaseId}::uuid AND active_intent_id = ${input.intentId}::uuid
         AND lease_expires_at > clock_timestamp()
       FOR UPDATE
    )
    UPDATE run_processing_states AS processing SET
      state = CASE WHEN NOT ${error.retryable} OR owned.scoped_attempt_count >= ${options.maxAttempts}
                   THEN 'failed'::"RunProcessingStatus" ELSE 'retrying'::"RunProcessingStatus" END,
      lease_id = NULL, lease_expires_at = NULL, attempt_deadline_at = NULL,
      attempt_source_fingerprint = CASE WHEN ${input.attemptedFingerprint}::text IS NULL
                                        THEN processing.attempt_source_fingerprint ELSE ${input.attemptedFingerprint}::text END,
      attempt_count = owned.scoped_attempt_count,
      available_at = clock_timestamp() + LEAST(${options.retryMaxSeconds},
        ${options.retryBaseSeconds} * power(2, LEAST(30, GREATEST(0, owned.scoped_attempt_count - 1)))) * interval '1 second',
      completed_at = CASE WHEN NOT ${error.retryable} OR owned.scoped_attempt_count >= ${options.maxAttempts}
                          THEN clock_timestamp() ELSE NULL END,
      last_error_code = ${error.code}
      FROM owned WHERE processing.id = owned.id
    RETURNING processing.state::text AS state, processing.attempt_count AS "attemptCount",
              processing.attempt_source_fingerprint AS "sourceFingerprint"
  `);
    const changed = rows[0];
    if (!changed) return 'lease_lost';
    if (changed.state === 'retrying') {
      await transaction.processingAttemptFailure.deleteMany({
        where: {
          intentId: input.intentId,
          projectorName: FILES_PROJECTOR_NAME,
          projectorVersion: FILES_PROJECTOR_VERSION,
        },
      });
    } else {
      await transaction.processingAttemptFailure.upsert({
        where: {
          intentId_projectorName_projectorVersion: {
            intentId: input.intentId,
            projectorName: FILES_PROJECTOR_NAME,
            projectorVersion: FILES_PROJECTOR_VERSION,
          },
        },
        create: {
          organizationId: input.organizationId,
          runId: input.runId,
          intentId: input.intentId,
          projectorName: FILES_PROJECTOR_NAME,
          projectorVersion: FILES_PROJECTOR_VERSION,
          sourceFingerprint: changed.sourceFingerprint,
          attemptCount: changed.attemptCount,
          errorCode: error.code,
        },
        update: {
          sourceFingerprint: changed.sourceFingerprint,
          attemptCount: changed.attemptCount,
          errorCode: error.code,
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
  reader: FileArtifactReader,
  options: FileProcessingOptions,
  allowFailedReplay: boolean,
  context: FileProcessingContext = {},
): Promise<FileProcessingResult> {
  validateOptions(options);
  const intent = await client.processingIntent.findUnique({
    where: { id: intentId },
    select: {
      id: true,
      organizationId: true,
      runId: true,
      kind: true,
      artifactDeclarationId: true,
      run: { select: { repositoryId: true } },
    },
  });
  if (!intent) throw new FileProcessingError('intent_not_found', false);
  if (intent.kind !== 'ARTIFACT_VERIFIED' || !intent.artifactDeclarationId)
    throw new FileProcessingError('unsupported_intent_kind', false);
  const receipt = await client.processingApplicationReceipt.findUnique({
    where: {
      intentId_projectorName_projectorVersion: {
        intentId,
        projectorName: FILES_PROJECTOR_NAME,
        projectorVersion: FILES_PROJECTOR_VERSION,
      },
    },
    select: { id: true },
  });
  if (receipt) {
    if (!allowFailedReplay) return 'already_applied';
    const [projection, processing, current] = await Promise.all([
      client.fileRunProjection.findUnique({
        where: { runId: intent.runId },
        select: { projectorVersion: true, sourceFingerprint: true },
      }),
      client.runProcessingState.findUnique({
        where: {
          organizationId_runId_projectorName: {
            organizationId: intent.organizationId,
            runId: intent.runId,
            projectorName: FILES_PROJECTOR_NAME,
          },
        },
        select: {
          state: true,
          projectorVersion: true,
          sourceFingerprint: true,
        },
      }),
      inspectFileSourceSnapshot(client, intent.organizationId, intent.runId),
    ]);
    if (
      current.complete &&
      projection?.projectorVersion === FILES_PROJECTOR_VERSION &&
      projection.sourceFingerprint === current.fingerprint &&
      processing?.state === 'READY' &&
      processing.projectorVersion === FILES_PROJECTOR_VERSION &&
      processing.sourceFingerprint === current.fingerprint
    )
      return 'already_applied';
  }
  const acquisition = await client.$transaction(async (transaction) => {
    await lockRunSourceSet(transaction, intent.runId);
    const durableFailure =
      await transaction.processingAttemptFailure.findUnique({
        where: {
          intentId_projectorName_projectorVersion: {
            intentId,
            projectorName: FILES_PROJECTOR_NAME,
            projectorVersion: FILES_PROJECTOR_VERSION,
          },
        },
        select: { sourceFingerprint: true },
      });
    let resetForChangedFingerprint = false;
    if (durableFailure && !allowFailedReplay) {
      const currentSource = await inspectFileSourceSnapshot(
        transaction,
        intent.organizationId,
        intent.runId,
      );
      resetForChangedFingerprint =
        durableFailure.sourceFingerprint !== currentSource.fingerprint;
    }
    const attempt = await acquire(
      transaction,
      intent.organizationId,
      intent.runId,
      intent.id,
      options,
      allowFailedReplay || resetForChangedFingerprint,
    );
    if (attempt) return { attempt };
    const current = await transaction.runProcessingState.findUnique({
      where: {
        organizationId_runId_projectorName: {
          organizationId: intent.organizationId,
          runId: intent.runId,
          projectorName: FILES_PROJECTOR_NAME,
        },
      },
      select: { state: true, activeIntentId: true },
    });
    if (current?.state === 'PROCESSING') return { result: 'busy' as const };
    if (
      !allowFailedReplay &&
      !resetForChangedFingerprint &&
      (durableFailure !== null ||
        (current?.state === 'FAILED' && current.activeIntentId === intent.id))
    )
      return { result: 'failed' as const };
    return { result: 'busy' as const };
  });
  if ('result' in acquisition) return acquisition.result;
  const { attempt } = acquisition;
  try {
    active(context, attempt.deadlineAt);
    const sourceSnapshot = await inspectFileSourceSnapshot(
      client,
      intent.organizationId,
      intent.runId,
    );
    attempt.attemptedFingerprint = sourceSnapshot.fingerprint;
    const discovered = await discoverSources(
      client,
      intent.organizationId,
      intent.runId,
      options,
    );
    attempt.attemptedFingerprint = discovered.fingerprint;
    const parsed = await mapConcurrent(
      discovered.sources,
      options.storageConcurrency,
      async (source, signal) => {
        active(context, attempt.deadlineAt);
        const bytes = await reader({
          objectKey: source.objectKey,
          expectedBytes: source.byteLength,
          expectedSha256: source.sha256,
          signal,
          deadlineAt: attempt.deadlineAt,
        });
        active(context, attempt.deadlineAt);
        return { source, value: parseGitFileListArtifact(bytes, source) };
      },
      context.signal,
    );
    const entryCount = parsed.reduce(
      (count, item) => count + item.value.files.length,
      0,
    );
    if (
      entryCount > options.maxEntries ||
      entryCount > options.maxProjectedRows
    )
      throw new FileProcessingError('file_entry_limit_exceeded', false);
    await context.hooks?.beforePublish?.();
    active(context, attempt.deadlineAt);
    const timeout = Math.max(1, attempt.deadlineAt.getTime() - Date.now());
    const result = await client.$transaction(
      async (transaction) => {
        await lockRunSourceSet(transaction, intent.runId);
        await context.hooks?.afterRunSourceLock?.();
        const current = await discoverSources(
          transaction,
          intent.organizationId,
          intent.runId,
          options,
        );
        if (current.fingerprint !== discovered.fingerprint)
          throw new FileProcessingError('file_source_changed', true);
        const owns = await transaction.$queryRaw<
          Array<{ ok: number }>
        >(Prisma.sql`
        SELECT 1 AS ok FROM run_processing_states
         WHERE organization_id = ${intent.organizationId}::uuid AND run_id = ${intent.runId}::uuid
           AND projector_name = ${FILES_PROJECTOR_NAME} AND state = 'processing'
           AND lease_id = ${attempt.leaseId}::uuid AND active_intent_id = ${intent.id}::uuid
           AND lease_expires_at > clock_timestamp() AND attempt_deadline_at > clock_timestamp()
         FOR UPDATE
      `);
        if (!owns[0])
          throw new FileProcessingError('processing_lease_lost', true);
        const existing = await transaction.fileRunProjection.findUnique({
          where: { runId: intent.runId },
          select: { projectorVersion: true, sourceFingerprint: true },
        });
        const unchanged =
          existing?.projectorVersion === FILES_PROJECTOR_VERSION &&
          existing.sourceFingerprint === discovered.fingerprint;
        if (!unchanged) {
          await transaction.fileRunProjection.upsert({
            where: { runId: intent.runId },
            create: {
              organizationId: intent.organizationId,
              repositoryId: intent.run.repositoryId,
              runId: intent.runId,
              projectorName: FILES_PROJECTOR_NAME,
              projectorVersion: FILES_PROJECTOR_VERSION,
              sourceEventCount: discovered.sources.length,
              sourceMaxSequence:
                discovered.maxSequence === null
                  ? null
                  : BigInt(discovered.maxSequence),
              sourceFingerprint: discovered.fingerprint,
              completeness: 'complete',
              completenessReason: null,
              fileCount: entryCount,
            },
            update: {
              projectorName: FILES_PROJECTOR_NAME,
              projectorVersion: FILES_PROJECTOR_VERSION,
              sourceEventCount: discovered.sources.length,
              sourceMaxSequence:
                discovered.maxSequence === null
                  ? null
                  : BigInt(discovered.maxSequence),
              sourceFingerprint: discovered.fingerprint,
              completeness: 'complete',
              completenessReason: null,
              fileCount: entryCount,
              updatedAt: new Date(),
            },
          });
          await transaction.fileChangeProjection.deleteMany({
            where: { runId: intent.runId },
          });
          const rows = parsed.flatMap(({ source, value }) =>
            value.files.map((entry, ordinal) => {
              const prior = original(entry);
              return {
                organizationId: intent.organizationId,
                repositoryId: intent.run.repositoryId,
                runId: intent.runId,
                sourceEventId: source.eventId,
                sourceSequence: BigInt(source.sequence),
                diffId: source.diffId,
                fromSnapshotId: source.fromSnapshotId,
                toSnapshotId: source.toSnapshotId,
                artifactDeclarationId: source.artifactDeclarationId,
                uploadAttemptId: source.uploadId,
                ordinal,
                entryId: entry.entryId,
                originalEntryId: prior.entryId,
                displayPath: entry.path,
                originalDisplayPath: prior.path,
                displayAmbiguous: entry.displayAmbiguous ?? false,
                displayReason: entry.displayReason ?? null,
                beforeState: entry.before
                  ? (entry.before as Prisma.InputJsonValue)
                  : Prisma.JsonNull,
                afterState: entry.after
                  ? (entry.after as Prisma.InputJsonValue)
                  : Prisma.JsonNull,
                attribution: entry.attribution,
                reason: entry.reason ?? null,
              };
            }),
          );
          if (rows.length)
            await transaction.fileChangeProjection.createMany({ data: rows });
          await context.hooks?.afterRowsReplaced?.();
        }
        await transaction.processingApplicationReceipt.upsert({
          where: {
            intentId_projectorName_projectorVersion: {
              intentId: intent.id,
              projectorName: FILES_PROJECTOR_NAME,
              projectorVersion: FILES_PROJECTOR_VERSION,
            },
          },
          create: {
            organizationId: intent.organizationId,
            runId: intent.runId,
            intentId: intent.id,
            projectorName: FILES_PROJECTOR_NAME,
            projectorVersion: FILES_PROJECTOR_VERSION,
          },
          update: {},
        });
        await transaction.processingAttemptFailure.deleteMany({
          where: {
            intentId: intent.id,
            projectorName: FILES_PROJECTOR_NAME,
            projectorVersion: FILES_PROJECTOR_VERSION,
          },
        });
        const changed = await transaction.$executeRaw(Prisma.sql`
        UPDATE run_processing_states SET state = 'ready', lease_id = NULL, lease_expires_at = NULL,
          attempt_deadline_at = NULL, active_intent_id = NULL, attempt_source_fingerprint = NULL, attempt_count = 0,
          source_event_count = ${discovered.sources.length},
          source_max_sequence = ${discovered.maxSequence === null ? null : BigInt(discovered.maxSequence)},
          source_fingerprint = ${discovered.fingerprint}, completed_at = clock_timestamp(), last_error_code = NULL
         WHERE organization_id = ${intent.organizationId}::uuid AND run_id = ${intent.runId}::uuid
           AND projector_name = ${FILES_PROJECTOR_NAME} AND state = 'processing'
           AND lease_id = ${attempt.leaseId}::uuid AND active_intent_id = ${intent.id}::uuid
           AND lease_expires_at > clock_timestamp() AND attempt_deadline_at > clock_timestamp()
      `);
        if (changed !== 1)
          throw new FileProcessingError('processing_lease_lost', true);
        return unchanged ? 'already_applied' : 'applied';
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: timeout,
        timeout,
      },
    );
    return result;
  } catch (error) {
    const safe =
      error instanceof FileProcessingError
        ? error
        : typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            'retryable' in error
          ? new FileProcessingError(
              String((error as { code: unknown }).code),
              Boolean((error as { retryable: unknown }).retryable),
              { cause: error },
            )
          : new FileProcessingError('file_projection_failed', true, {
              cause: error,
            });
    const state = await fail(
      client,
      {
        organizationId: intent.organizationId,
        runId: intent.runId,
        intentId: intent.id,
        leaseId: attempt.leaseId,
        attemptedFingerprint: attempt.attemptedFingerprint,
      },
      safe,
      options,
    );
    if (state === 'failed') return 'failed';
    throw safe;
  }
}

export function processFilesIntent(
  client: DatabaseClient,
  intentId: string,
  reader: FileArtifactReader,
  options: FileProcessingOptions,
  context: FileProcessingContext = {},
): Promise<FileProcessingResult> {
  return process(client, intentId, reader, options, false, context);
}

/** Explicit bounded single-intent replay; bulk replay remains outside BBX-009B. */
export function replayFilesIntent(
  client: DatabaseClient,
  intentId: string,
  reader: FileArtifactReader,
  options: FileProcessingOptions,
  context: FileProcessingContext = {},
): Promise<FileProcessingResult> {
  return process(client, intentId, reader, options, true, context);
}
