import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import {
  createDatabaseClient,
  createPgmqProcessingQueue,
  ingestEvidenceBatch,
  processCoreIntent,
  processFindingsIntent,
  PROCESSING_QUEUE_NAME,
  provisionProcessingQueue,
  type IngestEvidenceBatchInput,
  type ProcessingQueue,
  type ProcessingQueueMessage,
} from '@blackbox/database';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  consumeProcessingCycle,
  type ProcessingConsumerConfig,
} from './composition.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString)
  throw new Error('TEST_DATABASE_URL is required for worker queue tests.');
const handle = createDatabaseClient({ connectionString });
const queue = createPgmqProcessingQueue(handle.client);
const config: ProcessingConsumerConfig = {
  processing: {
    leaseSeconds: 10,
    attemptTimeoutMs: 2_000,
    transitionMarginMs: 100,
    maxAttempts: 2,
    retryBaseSeconds: 1,
    retryMaxSeconds: 1,
    eventPageSize: 100,
    maxEvents: 100,
    maxProjectedChildren: 1_000,
  },
  findingsProcessing: {
    leaseSeconds: 10,
    attemptTimeoutMs: 2_000,
    transitionMarginMs: 100,
    maxAttempts: 2,
    retryBaseSeconds: 1,
    retryMaxSeconds: 1,
  },
  queueBatchSize: 1,
  visibilityTimeoutSeconds: 1,
  poisonReadLimit: 2,
};

beforeAll(() => provisionProcessingQueue(handle.client));
beforeEach(() =>
  handle.client.$queryRawUnsafe(
    'SELECT pgmq.purge_queue($1)',
    PROCESSING_QUEUE_NAME,
  ),
);
afterAll(() => handle.dispose());

async function artifactIntent(): Promise<{
  intentId: string;
  runId: string;
}> {
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
  const artifact = await handle.client.artifactDeclaration.create({
    data: {
      organizationId: organization.id,
      runId: run.id,
      canonicalArtifactId,
      kind: 'git-file-list',
      mediaType: 'application/json',
      byteLength: 2n,
      sha256: 'a'.repeat(64),
      redactionApplied: false,
      characterEncoding: 'utf-8',
      rawReference: {
        artifactId: canonicalArtifactId,
        kind: 'git-file-list',
        mediaType: 'application/json',
        byteLength: 2,
        sha256: 'a'.repeat(64),
        redaction: { applied: false },
        characterEncoding: 'utf-8',
      },
    },
  });
  const intent = await handle.client.processingIntent.create({
    data: {
      organizationId: organization.id,
      runId: run.id,
      artifactDeclarationId: artifact.id,
      kind: 'ARTIFACT_VERIFIED',
    },
    select: { id: true },
  });
  return { intentId: intent.id, runId: run.id };
}

async function evidenceIntent(): Promise<{
  intentId: string;
  organizationId: string;
  runId: string;
}> {
  const organization = await handle.client.organization.create({ data: {} });
  const repository = await handle.client.repository.create({
    data: { organizationId: organization.id },
  });
  const canonicalRunId = randomUUID();
  await ingestEvidenceBatch(handle.client, {
    organizationId: organization.id,
    repositoryId: repository.id,
    batch: {
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
    } satisfies IngestEvidenceBatchInput['batch'],
  });
  return handle.client.processingIntent
    .findFirstOrThrow({
      where: { organizationId: organization.id },
      select: { id: true, runId: true },
    })
    .then(({ id, runId }) => ({
      intentId: id,
      organizationId: organization.id,
      runId,
    }));
}

describe('real PGMQ processing consumer', () => {
  it('creates one findings receipt and archives only after post-findings crash redelivery', async () => {
    const { intentId, runId } = await evidenceIntent();
    const messageId = await queue.send({ schemaVersion: 1, intentId });
    const archive = vi.fn((id: number) => queue.archive(id));
    const observedQueue = { ...queue, archive } satisfies ProcessingQueue;
    await expect(
      consumeProcessingCycle(handle.client, observedQueue, config, undefined, {
        afterProcessBeforeArchive: () => {
          throw new Error('post-findings pre-archive crash');
        },
      }),
    ).resolves.toBe(1);
    expect(archive).not.toHaveBeenCalled();
    expect(
      await handle.client.processingApplicationReceipt.count({
        where: { intentId, projectorName: 'findings' },
      }),
    ).toBe(1);
    expect(
      await handle.client.findingRuleResult.count({ where: { runId } }),
    ).toBe(9);
    await delay(1_100);
    await expect(
      consumeProcessingCycle(handle.client, observedQueue, config),
    ).resolves.toBe(1);
    expect(archive).toHaveBeenCalledWith(messageId);
    expect(
      await handle.client.processingApplicationReceipt.count({
        where: { intentId, projectorName: 'findings' },
      }),
    ).toBe(1);
    await expect(queue.read(1, 1)).resolves.toEqual([]);
  });

  it('keeps a failed findings gate visible until poison convergence', async () => {
    const { intentId, organizationId, runId } = await evidenceIntent();
    await expect(
      processCoreIntent(handle.client, intentId, config.processing),
    ).resolves.toBe('applied');
    await expect(
      processFindingsIntent(
        handle.client,
        intentId,
        { ...config.findingsProcessing, maxAttempts: 1 },
        {
          hooks: {
            afterDependenciesRead: () => {
              throw new Error('force exhausted findings intent');
            },
          },
        },
      ),
    ).resolves.toBe('failed');
    const messageId = await queue.send({ schemaVersion: 1, intentId });
    const archive = vi.fn((id: number) => queue.archive(id));
    const observedQueue = { ...queue, archive } satisfies ProcessingQueue;
    await expect(
      consumeProcessingCycle(handle.client, observedQueue, config),
    ).resolves.toBe(1);
    expect(archive).not.toHaveBeenCalled();
    await delay(1_100);
    await expect(
      consumeProcessingCycle(handle.client, observedQueue, config),
    ).resolves.toBe(1);
    expect(archive).toHaveBeenCalledWith(messageId);
    expect(
      await handle.client.processingApplicationReceipt.count({
        where: { intentId, projectorName: 'findings' },
      }),
    ).toBe(0);
    await expect(
      handle.client.runProcessingState.findUniqueOrThrow({
        where: {
          organizationId_runId_projectorName: {
            organizationId,
            runId,
            projectorName: 'findings',
          },
        },
        select: { state: true, activeIntentId: true },
      }),
    ).resolves.toEqual({ state: 'FAILED', activeIntentId: intentId });
    expect(
      await handle.client.processingAttemptFailure.count({
        where: { intentId, projectorName: 'findings' },
      }),
    ).toBe(1);
    await expect(queue.read(1, 1)).resolves.toEqual([]);
  });

  it('recovers the process/archive window through visibility redelivery', async () => {
    const intentId = randomUUID();
    await queue.send({ schemaVersion: 1, intentId });
    const processIntent = vi.fn(async () => 'applied' as const);
    const processFindings = vi
      .fn()
      .mockResolvedValueOnce('applied')
      .mockResolvedValueOnce('already_applied');
    await expect(
      consumeProcessingCycle(handle.client, queue, config, undefined, {
        processIntent,
        processFindingsIntent: processFindings,
        afterProcessBeforeArchive: () => {
          throw new Error('simulated crash window');
        },
      }),
    ).resolves.toBe(1);
    expect(processIntent).toHaveBeenCalledOnce();
    await delay(1_100);
    await expect(
      consumeProcessingCycle(handle.client, queue, config, undefined, {
        processIntent,
        processFindingsIntent: processFindings,
      }),
    ).resolves.toBe(1);
    expect(processIntent).toHaveBeenCalledTimes(2);
    expect(processFindings).toHaveBeenCalledTimes(2);
    await expect(queue.read(1, 1)).resolves.toEqual([]);
  });

  it('retries a mismatched artifact intent by visibility and archives at the poison limit', async () => {
    const { intentId, runId } = await artifactIntent();
    const payload = { schemaVersion: 1 as const, intentId };
    const messageId = await queue.send(payload);
    const deliveries: ProcessingQueueMessage[] = [];
    const archive = vi.fn((id: number) => queue.archive(id));
    const observedQueue = {
      ...queue,
      read: async (visibilityTimeoutSeconds: number, quantity: number) => {
        const messages = await queue.read(visibilityTimeoutSeconds, quantity);
        deliveries.push(...messages);
        return messages;
      },
      archive,
    } satisfies ProcessingQueue;
    await expect(
      consumeProcessingCycle(handle.client, observedQueue, config),
    ).resolves.toBe(1);
    expect(deliveries).toEqual([{ messageId, readCount: 1, payload }]);
    expect(archive).not.toHaveBeenCalled();
    await delay(1_100);
    await expect(
      consumeProcessingCycle(handle.client, observedQueue, config),
    ).resolves.toBe(1);
    expect(deliveries).toEqual([
      { messageId, readCount: 1, payload },
      { messageId, readCount: 2, payload },
    ]);
    expect(archive).toHaveBeenCalledOnce();
    expect(archive).toHaveBeenCalledWith(messageId);
    await expect(queue.read(1, 1)).resolves.toEqual([]);
    expect(
      await handle.client.processingApplicationReceipt.count({
        where: { intentId, projectorName: 'files' },
      }),
    ).toBe(0);
    expect(
      await handle.client.fileRunProjection.count({ where: { runId } }),
    ).toBe(0);
  });
});
