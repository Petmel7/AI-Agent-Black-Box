import {
  createDatabaseClient,
  createPgmqProcessingQueue,
  processCoreIntent,
  relayProcessingCycle,
  type CoreProcessingOptions,
  type DatabaseClient,
  type ProcessingQueue,
  type RelayOptions,
} from '@blackbox/database';
import {
  createWorker,
  type WorkerLifecycle,
  type WorkerOptions,
  type WorkerResources,
} from './worker.js';

export interface ProductionWorkerConfig {
  databaseUrl: string;
  worker: WorkerOptions;
  relay: RelayOptions;
  processing: CoreProcessingOptions;
  queueBatchSize: number;
  visibilityTimeoutSeconds: number;
  poisonReadLimit: number;
}

export interface ProcessingConsumerConfig {
  processing: CoreProcessingOptions;
  queueBatchSize: number;
  visibilityTimeoutSeconds: number;
  poisonReadLimit: number;
}

export interface ProcessingConsumerHooks {
  afterProcessBeforeArchive?: () => void | Promise<void>;
  processIntent?: typeof processCoreIntent;
}

export async function consumeProcessingCycle(
  client: DatabaseClient,
  queue: ProcessingQueue,
  config: ProcessingConsumerConfig,
  signal?: AbortSignal,
  hooks: ProcessingConsumerHooks = {},
): Promise<number> {
  let messages;
  try {
    messages = await queue.read(
      config.visibilityTimeoutSeconds,
      config.queueBatchSize,
    );
  } catch (error) {
    const malformed = error as { messageId?: unknown; readCount?: unknown };
    if (
      typeof malformed.messageId === 'number' &&
      typeof malformed.readCount === 'number' &&
      malformed.readCount >= config.poisonReadLimit
    )
      await queue.archive(malformed.messageId);
    throw error;
  }
  await Promise.all(
    messages.map(async (message) => {
      try {
        const result = await (hooks.processIntent ?? processCoreIntent)(
          client,
          message.payload.intentId,
          config.processing,
          signal ? { signal } : {},
        );
        if (result === 'applied' || result === 'already_applied') {
          await hooks.afterProcessBeforeArchive?.();
          await queue.archive(message.messageId);
        } else if (
          result === 'failed' &&
          message.readCount >= config.poisonReadLimit
        ) {
          await queue.archive(message.messageId);
        }
      } catch (error) {
        const safe = error as { retryable?: unknown };
        if (
          safe.retryable === false &&
          message.readCount >= config.poisonReadLimit
        )
          await queue.archive(message.messageId);
        /* Otherwise visibility expiry is the retry acknowledgement. */
      }
    }),
  );
  return messages.length;
}

function requiredUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('WORKER_DATABASE_URL is required.');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error('WORKER_DATABASE_URL must be a PostgreSQL URL.');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol))
    throw new Error('WORKER_DATABASE_URL must be a PostgreSQL URL.');
  return trimmed;
}

export function createProductionWorker(
  config: ProductionWorkerConfig,
): WorkerLifecycle {
  const databaseUrl = requiredUrl(config.databaseUrl);
  for (const value of [
    config.queueBatchSize,
    config.visibilityTimeoutSeconds,
    config.poisonReadLimit,
  ])
    if (!Number.isSafeInteger(value) || value < 1)
      throw new TypeError('Queue bounds must be positive safe integers.');
  if (
    config.processing.leaseSeconds * 1_000 <=
    config.processing.attemptTimeoutMs + config.processing.transitionMarginMs
  )
    throw new TypeError(
      'Projection lease must exceed the attempt deadline plus transition margin.',
    );
  if (config.visibilityTimeoutSeconds <= config.processing.leaseSeconds)
    throw new TypeError(
      'Queue visibility timeout must exceed the projection lease.',
    );
  return createWorker(async (): Promise<WorkerResources> => {
    const handle = createDatabaseClient({ connectionString: databaseUrl });
    const queue = createPgmqProcessingQueue(handle.client);
    return {
      verify: () => queue.verify(),
      relayCycle: () =>
        relayProcessingCycle(handle.client, queue, config.relay),
      consumerCycle: (signal) =>
        consumeProcessingCycle(handle.client, queue, config, signal),
      close: () => handle.dispose(),
    };
  }, config.worker);
}
