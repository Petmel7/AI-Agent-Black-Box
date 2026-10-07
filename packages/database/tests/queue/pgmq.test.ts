import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { EvidenceBatchSchema } from '@blackbox/contracts';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDatabaseClient,
  createPgmqProcessingQueue,
  ingestEvidenceBatch,
  MalformedQueueMessageError,
  PROCESSING_QUEUE_NAME,
  provisionProcessingQueue,
  processCoreIntent,
  processFindingsIntent,
  relayProcessingCycle,
} from '../../src/index.js';

const connectionString = process.env.TEST_DATABASE_URL!;
const handle = createDatabaseClient({ connectionString });
const pool = new Pool({ connectionString, max: 2 });
const queue = createPgmqProcessingQueue(handle.client);
const coreOptions = {
  leaseSeconds: 10,
  attemptTimeoutMs: 2_000,
  transitionMarginMs: 100,
  maxAttempts: 2,
  retryBaseSeconds: 1,
  retryMaxSeconds: 1,
  eventPageSize: 100,
  maxEvents: 100,
  maxProjectedChildren: 1_000,
};
const findingsOptions = {
  leaseSeconds: 10,
  attemptTimeoutMs: 2_000,
  transitionMarginMs: 100,
  maxAttempts: 2,
  retryBaseSeconds: 1,
  retryMaxSeconds: 1,
};

beforeAll(async () => {
  await provisionProcessingQueue(handle.client);
  await pool.query('SELECT pgmq.purge_queue($1)', [PROCESSING_QUEUE_NAME]);
});
afterAll(async () => {
  await Promise.all([handle.dispose(), pool.end()]);
});

describe('private pgmq processing queue', () => {
  it('redelivers an applied findings intent and converges on one receipt before archive', async () => {
    const organization = await handle.client.organization.create({ data: {} });
    const repository = await handle.client.repository.create({
      data: { organizationId: organization.id },
    });
    const canonicalRunId = randomUUID();
    const accepted = EvidenceBatchSchema.parse({
      schemaVersion: 1,
      batchId: randomUUID(),
      runId: canonicalRunId,
      sentAt: '2026-10-07T00:00:00.000Z',
      events: [
        {
          schemaVersion: 1,
          eventId: randomUUID(),
          runId: canonicalRunId,
          sequence: 0,
          kind: 'run.started',
          observedAt: '2026-10-07T00:00:00.000Z',
          source: { component: 'collector' },
          payload: { adapter: 'codex-jsonl', provider: 'codex' },
        },
        {
          schemaVersion: 1,
          eventId: randomUUID(),
          runId: canonicalRunId,
          sequence: 1,
          kind: 'run.finished',
          observedAt: '2026-10-07T00:00:01.000Z',
          source: { component: 'collector' },
          payload: { outcome: 'succeeded', durationMs: 1 },
        },
      ],
    });
    await ingestEvidenceBatch(handle.client, {
      organizationId: organization.id,
      repositoryId: repository.id,
      batch: accepted,
    });
    const intent = await handle.client.processingIntent.findFirstOrThrow({
      where: { organizationId: organization.id },
      select: { id: true, runId: true },
    });
    const messageId = await queue.send({
      schemaVersion: 1,
      intentId: intent.id,
    });
    const first = await queue.read(1, 1);
    expect(first).toEqual([
      {
        messageId,
        readCount: 1,
        payload: { schemaVersion: 1, intentId: intent.id },
      },
    ]);
    await expect(
      processCoreIntent(handle.client, intent.id, coreOptions),
    ).resolves.toBe('applied');
    await expect(
      processFindingsIntent(handle.client, intent.id, findingsOptions),
    ).resolves.toBe('applied');
    await delay(1_100);
    const repeated = await queue.read(2, 1);
    expect(repeated).toEqual([
      {
        messageId,
        readCount: 2,
        payload: { schemaVersion: 1, intentId: intent.id },
      },
    ]);
    await expect(
      processFindingsIntent(handle.client, intent.id, findingsOptions),
    ).resolves.toBe('already_applied');
    expect(await queue.archive(messageId)).toBe(true);
    expect(
      await handle.client.processingApplicationReceipt.count({
        where: { intentId: intent.id, projectorName: 'findings' },
      }),
    ).toBe(1);
    expect(
      await handle.client.findingRuleResult.count({
        where: { runId: intent.runId },
      }),
    ).toBe(9);
  });

  it('relays a real artifact intent through the unchanged opaque payload', async () => {
    const organization = await handle.client.organization.create({ data: {} });
    const repository = await handle.client.repository.create({
      data: { organizationId: organization.id },
    });
    const run = await handle.client.run.create({
      data: {
        organizationId: organization.id,
        repositoryId: repository.id,
        canonicalRunId: randomUUID(),
      },
    });
    const canonicalArtifactId = randomUUID();
    const reference = {
      artifactId: canonicalArtifactId,
      kind: 'git-file-list',
      mediaType: 'application/json',
      byteLength: 2,
      sha256: 'a'.repeat(64),
      redaction: { applied: false },
      characterEncoding: 'utf-8',
    };
    const artifact = await handle.client.artifactDeclaration.create({
      data: {
        organizationId: organization.id,
        runId: run.id,
        canonicalArtifactId,
        kind: reference.kind,
        mediaType: reference.mediaType,
        byteLength: 2n,
        sha256: reference.sha256,
        redactionApplied: false,
        characterEncoding: 'utf-8',
        rawReference: reference,
      },
    });
    const targetIntent = await handle.client.processingIntent.create({
      data: {
        organizationId: organization.id,
        runId: run.id,
        artifactDeclarationId: artifact.id,
        kind: 'ARTIFACT_VERIFIED',
        availableAt: new Date(0),
      },
    });
    await relayProcessingCycle(handle.client, queue, {
      batchSize: 1,
      leaseSeconds: 10,
      maxAttempts: 2,
      retryBaseSeconds: 1,
      retryMaxSeconds: 2,
    });
    const messages = await queue.read(2, 1);
    expect(messages[0]?.payload).toEqual({
      schemaVersion: 1,
      intentId: targetIntent.id,
    });
    expect(
      await handle.client.processingIntent.findUniqueOrThrow({
        where: { id: targetIntent.id },
        select: { state: true, queueMessageId: true },
      }),
    ).toEqual({
      state: 'DELIVERED',
      queueMessageId: BigInt(messages[0]!.messageId),
    });
    expect(await queue.archive(messages[0]!.messageId)).toBe(true);
  });

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
