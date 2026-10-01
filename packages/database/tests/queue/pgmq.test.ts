import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDatabaseClient,
  createPgmqProcessingQueue,
  MalformedQueueMessageError,
  PROCESSING_QUEUE_NAME,
  provisionProcessingQueue,
} from '../../src/index.js';

const connectionString = process.env.TEST_DATABASE_URL!;
const handle = createDatabaseClient({ connectionString });
const pool = new Pool({ connectionString, max: 2 });
const queue = createPgmqProcessingQueue(handle.client);

beforeAll(async () => {
  await provisionProcessingQueue(handle.client);
  await pool.query('SELECT pgmq.purge_queue($1)', [PROCESSING_QUEUE_NAME]);
});
afterAll(async () => {
  await Promise.all([handle.dispose(), pool.end()]);
});

describe('private pgmq processing queue', () => {
  it('provisions idempotently and sends, reads, and archives strict v1 messages', async () => {
    await provisionProcessingQueue(handle.client);
    const intentId = randomUUID();
    const messageId = await queue.send({ schemaVersion: 1, intentId });
    const messages = await queue.read(2, 1);
    expect(messages).toEqual([
      { messageId, readCount: 1, payload: { schemaVersion: 1, intentId } },
    ]);
    expect(await queue.archive(messageId)).toBe(true);
  });

  it('redelivers after visibility expiry and permits duplicate publication', async () => {
    const intentId = randomUUID();
    const first = await queue.send({ schemaVersion: 1, intentId });
    const second = await queue.send({ schemaVersion: 1, intentId });
    expect(second).not.toBe(first);
    const initial = await queue.read(1, 2);
    expect(initial).toHaveLength(2);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const repeated = await queue.read(2, 2);
    expect(repeated.map((value) => value.readCount)).toEqual([2, 2]);
    await Promise.all(repeated.map((value) => queue.archive(value.messageId)));
  });

  it('rejects malformed payloads without returning their content', async () => {
    await pool.query('SELECT pgmq.send($1, $2::jsonb)', [
      PROCESSING_QUEUE_NAME,
      JSON.stringify({
        schemaVersion: 1,
        intentId: randomUUID(),
        secret: 'sentinel',
      }),
    ]);
    const error = await queue.read(2, 1).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(MalformedQueueMessageError);
    expect(String(error)).not.toContain('sentinel');
    const malformed = error as MalformedQueueMessageError;
    expect(malformed.messageId).not.toBeNull();
    await queue.archive(malformed.messageId!);
  });

  it('fails safely during an outage and recovers through explicit provisioning', async () => {
    await pool.query('SELECT pgmq.drop_queue($1)', [PROCESSING_QUEUE_NAME]);
    await expect(queue.verify()).rejects.toMatchObject({
      code: 'queue_infrastructure_unavailable',
    });
    await provisionProcessingQueue(handle.client);
    await expect(queue.verify()).resolves.toBeUndefined();
  });
});
