import { Prisma } from './generated/client/client.js';
import type { DatabaseClient } from './client.js';

export const PROCESSING_QUEUE_NAME = 'bbx_processing_v1';

export interface ProcessingQueuePayload {
  schemaVersion: 1;
  intentId: string;
}

export interface ProcessingQueueMessage {
  messageId: number;
  readCount: number;
  payload: ProcessingQueuePayload;
}

export class QueueInfrastructureError extends Error {
  readonly code = 'queue_infrastructure_unavailable';
  constructor() {
    super('Required processing queue infrastructure is unavailable.');
    this.name = 'QueueInfrastructureError';
  }
}

export class MalformedQueueMessageError extends Error {
  readonly code = 'malformed_queue_message';
  readonly messageId: number | null;
  readonly readCount: number | null;
  constructor(messageId: number | null, readCount: number | null) {
    super('A processing queue message is malformed.');
    this.name = 'MalformedQueueMessageError';
    this.messageId = messageId;
    this.readCount = readCount;
  }
}

function safeInteger(value: unknown): number | null {
  const numberValue =
    typeof value === 'bigint'
      ? Number(value)
      : typeof value === 'string'
        ? Number(value)
        : value;
  return typeof numberValue === 'number' &&
    Number.isSafeInteger(numberValue) &&
    numberValue >= 0
    ? numberValue
    : null;
}

function payload(value: unknown): ProcessingQueuePayload | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(',') !== 'intentId,schemaVersion' ||
    record.schemaVersion !== 1 ||
    typeof record.intentId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      record.intentId,
    )
  )
    return null;
  return { schemaVersion: 1, intentId: record.intentId };
}

function infrastructureFailure(): never {
  throw new QueueInfrastructureError();
}

export interface ProcessingQueue {
  verify(): Promise<void>;
  send(value: ProcessingQueuePayload): Promise<number>;
  read(
    visibilityTimeoutSeconds: number,
    quantity: number,
  ): Promise<ProcessingQueueMessage[]>;
  archive(messageId: number): Promise<boolean>;
}

export function createPgmqProcessingQueue(
  client: DatabaseClient,
): ProcessingQueue {
  return {
    async verify() {
      try {
        const rows = await client.$queryRaw<
          Array<{ extension_ok: boolean; queue_ok: boolean }>
        >(Prisma.sql`
          SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgmq') AS extension_ok,
                 EXISTS (SELECT 1 FROM pgmq.meta WHERE queue_name = ${PROCESSING_QUEUE_NAME}) AS queue_ok
        `);
        if (!rows[0]?.extension_ok || !rows[0]?.queue_ok)
          throw new QueueInfrastructureError();
      } catch (error) {
        if (error instanceof QueueInfrastructureError) throw error;
        infrastructureFailure();
      }
    },
    async send(value) {
      const parsed = payload(value);
      if (!parsed) throw new TypeError('Invalid processing queue payload.');
      try {
        const rows = await client.$queryRaw<
          Array<{ msg_id: bigint }>
        >(Prisma.sql`
          SELECT pgmq.send(${PROCESSING_QUEUE_NAME}, CAST(${JSON.stringify(parsed)} AS jsonb)) AS msg_id
        `);
        const messageId = safeInteger(rows[0]?.msg_id);
        if (messageId === null) throw new QueueInfrastructureError();
        return messageId;
      } catch (error) {
        if (error instanceof QueueInfrastructureError) throw error;
        infrastructureFailure();
      }
    },
    async read(visibilityTimeoutSeconds, quantity) {
      if (
        !Number.isSafeInteger(visibilityTimeoutSeconds) ||
        visibilityTimeoutSeconds < 1 ||
        !Number.isSafeInteger(quantity) ||
        quantity < 1
      )
        throw new TypeError(
          'Queue read bounds must be positive safe integers.',
        );
      try {
        const rows = await client.$queryRaw<
          Array<{ msg_id: bigint; read_ct: bigint; message: unknown }>
        >(Prisma.sql`
          SELECT msg_id, read_ct, message FROM pgmq.read(${PROCESSING_QUEUE_NAME}, ${visibilityTimeoutSeconds}, ${quantity})
        `);
        return rows.map((row) => {
          const messageId = safeInteger(row.msg_id);
          const readCount = safeInteger(row.read_ct);
          const parsed = payload(row.message);
          if (messageId === null || readCount === null || !parsed)
            throw new MalformedQueueMessageError(messageId, readCount);
          return { messageId, readCount, payload: parsed };
        });
      } catch (error) {
        if (error instanceof MalformedQueueMessageError) throw error;
        infrastructureFailure();
      }
    },
    async archive(messageId) {
      if (safeInteger(messageId) === null)
        throw new TypeError(
          'Queue message ID must be a non-negative safe integer.',
        );
      try {
        const rows = await client.$queryRaw<
          Array<{ archived: boolean }>
        >(Prisma.sql`
          SELECT pgmq.archive(CAST(${PROCESSING_QUEUE_NAME} AS text), CAST(${BigInt(messageId)} AS bigint)) AS archived
        `);
        if (rows[0]?.archived !== true) throw new QueueInfrastructureError();
        return true;
      } catch {
        infrastructureFailure();
      }
    },
  };
}

/** Explicit operations command; normal worker startup calls verify only. */
export async function provisionProcessingQueue(
  client: DatabaseClient,
): Promise<void> {
  try {
    await client.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS pgmq');
    await client.$queryRaw(
      Prisma.sql`SELECT pgmq.create(${PROCESSING_QUEUE_NAME})::text WHERE NOT EXISTS (SELECT 1 FROM pgmq.meta WHERE queue_name = ${PROCESSING_QUEUE_NAME})`,
    );
    await createPgmqProcessingQueue(client).verify();
  } catch (error) {
    if (error instanceof QueueInfrastructureError) throw error;
    infrastructureFailure();
  }
}
