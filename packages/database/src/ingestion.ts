import type { EvidenceBatch } from '@blackbox/contracts';
import { extractArtifactReferences } from '@blackbox/contracts';

import {
  Prisma,
  type PrismaClient,
  type ProcessingIntentKind,
} from './generated/client/client.js';

export type IngestionDatabaseClient = PrismaClient;

export interface IngestEvidenceBatchInput {
  organizationId: string;
  repositoryId: string;
  batch: EvidenceBatch;
}

export interface IngestEvidenceBatchResult {
  outcome: 'accepted' | 'already_accepted';
  batchId: string;
  runId: string;
  receivedAt: Date;
}

export interface IngestionFailureHooks {
  beforeRunCreate?(): void | Promise<void>;
  beforeIntent?(): void | Promise<void>;
  beforeCommit?(): void | Promise<void>;
}

export class RepositoryNotFoundError extends Error {
  constructor() {
    super('Repository was not found.');
    this.name = 'RepositoryNotFoundError';
  }
}

export class EvidenceConflictError extends Error {
  constructor() {
    super('Evidence identity conflicts with stored evidence.');
    this.name = 'EvidenceConflictError';
  }
}

class RunCreationRaceError extends Error {
  constructor(readonly databaseCause: unknown) {
    super('A concurrent transaction created the canonical run.', {
      cause: databaseCause,
    });
    this.name = 'RunCreationRaceError';
  }
}

type ExactBatchRow = {
  id: string;
  received_at: Date;
  canonical_run_id: string;
  repository_id: string;
  content_matches: boolean;
};

const intentKind: ProcessingIntentKind = 'EVIDENCE_BATCH_ACCEPTED';
const MAX_TRANSACTION_ATTEMPTS = 3;

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

async function findBatch(
  client: Prisma.TransactionClient | PrismaClient,
  organizationId: string,
  canonicalBatchId: string,
  batch: EvidenceBatch,
): Promise<ExactBatchRow | undefined> {
  const rows = await client.$queryRaw<ExactBatchRow[]>(Prisma.sql`
    SELECT b.id,
           b.received_at,
           r.canonical_run_id,
           r.repository_id,
           (b.raw_batch = CAST(${JSON.stringify(batch)} AS jsonb)) AS content_matches
      FROM evidence_batches b
      JOIN runs r
        ON r.organization_id = b.organization_id
       AND r.id = b.run_id
     WHERE b.organization_id = CAST(${organizationId} AS uuid)
       AND b.canonical_batch_id = CAST(${canonicalBatchId} AS uuid)
  `);
  return rows[0];
}

function batchResult(
  row: ExactBatchRow,
  input: IngestEvidenceBatchInput,
): IngestEvidenceBatchResult {
  if (
    !row.content_matches ||
    row.canonical_run_id !== input.batch.runId ||
    row.repository_id !== input.repositoryId
  ) {
    throw new EvidenceConflictError();
  }
  return {
    outcome: 'already_accepted',
    batchId: input.batch.batchId,
    runId: input.batch.runId,
    receivedAt: row.received_at,
  };
}

function errorCodes(error: unknown): Set<string> {
  const codes = new Set<string>();
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current; depth += 1) {
    if (typeof current !== 'object') break;
    const record = current as Record<string, unknown>;
    for (const key of ['code', 'originalCode', 'sqlState']) {
      if (typeof record[key] === 'string') codes.add(record[key]);
    }
    current = record.cause;
  }
  return codes;
}

function isConstraintRace(error: unknown): boolean {
  const codes = errorCodes(error);
  return ['P2002', 'P2003', '23503', '23505', '23514'].some((code) =>
    codes.has(code),
  );
}

function isTransientTransactionFailure(error: unknown): boolean {
  const codes = errorCodes(error);
  return ['P2034', '40001', '40P01'].some((code) => codes.has(code));
}

async function insertNewBatch(
  client: PrismaClient,
  input: IngestEvidenceBatchInput,
  hooks: IngestionFailureHooks,
): Promise<IngestEvidenceBatchResult> {
  return client.$transaction(
    async (transaction) => {
      const repository = await transaction.repository.findUnique({
        where: {
          organizationId_id: {
            organizationId: input.organizationId,
            id: input.repositoryId,
          },
        },
        select: { id: true },
      });
      if (!repository) throw new RepositoryNotFoundError();

      const priorBatch = await findBatch(
        transaction,
        input.organizationId,
        input.batch.batchId,
        input.batch,
      );
      if (priorBatch) return batchResult(priorBatch, input);

      let run = await transaction.run.findUnique({
        where: {
          organizationId_canonicalRunId: {
            organizationId: input.organizationId,
            canonicalRunId: input.batch.runId,
          },
        },
        select: { id: true, repositoryId: true },
      });
      if (run && run.repositoryId !== input.repositoryId) {
        throw new EvidenceConflictError();
      }
      if (!run) {
        await hooks.beforeRunCreate?.();
        try {
          run = await transaction.run.create({
            data: {
              organizationId: input.organizationId,
              repositoryId: input.repositoryId,
              canonicalRunId: input.batch.runId,
            },
            select: { id: true, repositoryId: true },
          });
        } catch (error) {
          if (isConstraintRace(error)) throw new RunCreationRaceError(error);
          throw error;
        }
      }

      const accepted = await transaction.evidenceBatch.create({
        data: {
          organizationId: input.organizationId,
          runId: run.id,
          canonicalBatchId: input.batch.batchId,
          schemaVersion: input.batch.schemaVersion,
          sentAt: new Date(input.batch.sentAt),
          rawBatch: jsonValue(input.batch),
        },
        select: { id: true, receivedAt: true },
      });

      for (const [position, event] of input.batch.events.entries()) {
        const existingEvent = await transaction.evidenceEvent.findUnique({
          where: {
            organizationId_canonicalEventId: {
              organizationId: input.organizationId,
              canonicalEventId: event.eventId,
            },
          },
          select: { id: true, runId: true, rawEvent: true },
        });
        let eventId: string;
        if (existingEvent) {
          const matches = await transaction.$queryRaw<
            Array<{ matches: boolean }>
          >(
            Prisma.sql`SELECT ${existingEvent.rawEvent}::jsonb = CAST(${JSON.stringify(event)} AS jsonb) AS matches`,
          );
          if (existingEvent.runId !== run.id || !matches[0]?.matches) {
            throw new EvidenceConflictError();
          }
          eventId = existingEvent.id;
        } else {
          const created = await transaction.evidenceEvent.create({
            data: {
              organizationId: input.organizationId,
              runId: run.id,
              canonicalEventId: event.eventId,
              schemaVersion: event.schemaVersion,
              sequence: BigInt(event.sequence),
              kind: event.kind,
              observedAt: new Date(event.observedAt),
              occurredAt: event.occurredAt ? new Date(event.occurredAt) : null,
              rawEvent: jsonValue(event),
            },
            select: { id: true },
          });
          eventId = created.id;
        }

        await transaction.evidenceBatchEvent.create({
          data: {
            organizationId: input.organizationId,
            runId: run.id,
            batchId: accepted.id,
            eventId,
            position: BigInt(position),
          },
        });

        for (const located of extractArtifactReferences(event)) {
          const reference = located.reference;
          const existingArtifact =
            await transaction.artifactDeclaration.findUnique({
              where: {
                organizationId_canonicalArtifactId: {
                  organizationId: input.organizationId,
                  canonicalArtifactId: reference.artifactId,
                },
              },
              select: { id: true, runId: true, rawReference: true },
            });
          let artifactId: string;
          if (existingArtifact) {
            const matches = await transaction.$queryRaw<
              Array<{ matches: boolean }>
            >(
              Prisma.sql`SELECT ${existingArtifact.rawReference}::jsonb = CAST(${JSON.stringify(reference)} AS jsonb) AS matches`,
            );
            if (existingArtifact.runId !== run.id || !matches[0]?.matches) {
              throw new EvidenceConflictError();
            }
            artifactId = existingArtifact.id;
          } else {
            const created = await transaction.artifactDeclaration.create({
              data: {
                organizationId: input.organizationId,
                runId: run.id,
                canonicalArtifactId: reference.artifactId,
                kind: reference.kind,
                mediaType: reference.mediaType,
                byteLength: BigInt(reference.byteLength),
                sha256: reference.sha256,
                redactionApplied: reference.redaction.applied,
                redactionRuleset: reference.redaction.rulesetVersion ?? null,
                compression: reference.compression ?? null,
                characterEncoding: reference.characterEncoding ?? null,
                rawReference: jsonValue(reference),
              },
              select: { id: true },
            });
            artifactId = created.id;
          }
          const existingLink =
            await transaction.evidenceEventArtifact.findUnique({
              where: {
                eventId_jsonPointer: {
                  eventId,
                  jsonPointer: located.jsonPointer,
                },
              },
              select: { artifactId: true },
            });
          if (existingLink && existingLink.artifactId !== artifactId) {
            throw new EvidenceConflictError();
          }
          if (!existingLink) {
            await transaction.evidenceEventArtifact.create({
              data: {
                organizationId: input.organizationId,
                runId: run.id,
                eventId,
                artifactId,
                jsonPointer: located.jsonPointer,
              },
            });
          }
        }
      }

      await hooks.beforeIntent?.();
      await transaction.processingIntent.create({
        data: {
          organizationId: input.organizationId,
          runId: run.id,
          batchId: accepted.id,
          kind: intentKind,
        },
      });
      await hooks.beforeCommit?.();

      return {
        outcome: 'accepted',
        batchId: input.batch.batchId,
        runId: input.batch.runId,
        receivedAt: accepted.receivedAt,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

/** Persists a validated batch and its processing intent atomically. */
export async function ingestEvidenceBatch(
  client: PrismaClient,
  input: IngestEvidenceBatchInput,
  hooks: IngestionFailureHooks = {},
): Promise<IngestEvidenceBatchResult> {
  for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
    try {
      return await insertNewBatch(client, input, hooks);
    } catch (error) {
      if (
        error instanceof RepositoryNotFoundError ||
        error instanceof EvidenceConflictError
      ) {
        throw error;
      }

      if (error instanceof RunCreationRaceError) {
        const winningRun = await client.run.findUnique({
          where: {
            organizationId_canonicalRunId: {
              organizationId: input.organizationId,
              canonicalRunId: input.batch.runId,
            },
          },
          select: { repositoryId: true },
        });
        if (!winningRun) throw error.databaseCause;
        if (winningRun.repositoryId !== input.repositoryId) {
          throw new EvidenceConflictError();
        }
        if (attempt < MAX_TRANSACTION_ATTEMPTS) continue;
        throw error.databaseCause;
      }

      if (isConstraintRace(error) || isTransientTransactionFailure(error)) {
        const winner = await findBatch(
          client,
          input.organizationId,
          input.batch.batchId,
          input.batch,
        );
        if (winner) return batchResult(winner, input);
        if (isConstraintRace(error)) throw new EvidenceConflictError();
        if (attempt < MAX_TRANSACTION_ATTEMPTS) continue;
      }
      throw error;
    }
  }
  throw new Error('Transaction retry limit was exhausted.');
}
