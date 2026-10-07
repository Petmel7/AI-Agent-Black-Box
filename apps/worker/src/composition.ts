import {
  readVerifiedArtifact,
  SupabaseArtifactReader,
} from '@blackbox/artifact-storage';
import {
  createDatabaseClient,
  createPgmqProcessingQueue,
  processCoreIntent,
  processFilesIntent,
  processFindingsIntent,
  relayProcessingCycle,
  type CoreProcessingOptions,
  type FileProcessingOptions,
  type FindingsProcessingOptions,
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
  filesProcessing: FileProcessingOptions;
  findingsProcessing: FindingsProcessingOptions;
  storage: {
    url: string;
    serviceRoleKey: string;
    bucket: string;
    connectTimeoutMs: number;
    inactivityTimeoutMs: number;
  };
  queueBatchSize: number;
  visibilityTimeoutSeconds: number;
  poisonReadLimit: number;
}

export interface ProcessingConsumerConfig {
  processing: CoreProcessingOptions;
  queueBatchSize: number;
  visibilityTimeoutSeconds: number;
  poisonReadLimit: number;
  filesProcessing?: FileProcessingOptions;
  findingsProcessing: FindingsProcessingOptions;
  artifactReader?: Parameters<typeof processFilesIntent>[2];
}

export interface ProcessingConsumerHooks {
  afterProcessBeforeArchive?: () => void | Promise<void>;
  processIntent?: typeof processCoreIntent;
  processFilesIntent?: typeof processFilesIntent;
  processFindingsIntent?: typeof processFindingsIntent;
}

async function dispatchProcessingIntent(
  client: DatabaseClient,
  intentId: string,
  config: ProcessingConsumerConfig,
  signal?: AbortSignal,
  hooks: ProcessingConsumerHooks = {},
): Promise<'applied' | 'already_applied' | 'busy' | 'failed'> {
  if (!config.findingsProcessing) {
    const error = new Error(
      'findings_processing_configuration_required',
    ) as Error & {
      retryable: boolean;
    };
    error.retryable = false;
    throw error;
  }
  const intent = await client.processingIntent.findUnique({
    where: { id: intentId },
    select: { kind: true },
  });
  let result: 'applied' | 'already_applied' | 'busy' | 'failed';
  if (!intent)
    result = await (hooks.processIntent ?? processCoreIntent)(
      client,
      intentId,
      config.processing,
      signal ? { signal } : {},
    );
  else if (intent.kind === 'EVIDENCE_BATCH_ACCEPTED')
    result = await (hooks.processIntent ?? processCoreIntent)(
      client,
      intentId,
      config.processing,
      signal ? { signal } : {},
    );
  else if (
    intent.kind === 'ARTIFACT_VERIFIED' &&
    config.filesProcessing &&
    config.artifactReader
  )
    result = await (hooks.processFilesIntent ?? processFilesIntent)(
      client,
      intentId,
      config.artifactReader,
      config.filesProcessing,
      signal ? { signal } : {},
    );
  else {
    const error = new Error('unsupported_intent_kind') as Error & {
      retryable: boolean;
    };
    error.retryable = false;
    throw error;
  }
  if (result === 'applied' || result === 'already_applied')
    return (hooks.processFindingsIntent ?? processFindingsIntent)(
      client,
      intentId,
      config.findingsProcessing,
      signal ? { signal } : {},
    );
  return result;
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
        const result = await dispatchProcessingIntent(
          client,
          message.payload.intentId,
          config,
          signal,
          hooks,
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
  if (
    config.visibilityTimeoutSeconds <= config.processing.leaseSeconds ||
    config.visibilityTimeoutSeconds <= config.filesProcessing.leaseSeconds ||
    config.visibilityTimeoutSeconds <= config.findingsProcessing.leaseSeconds
  )
    throw new TypeError(
      'Queue visibility timeout must exceed the projection lease.',
    );
  return createWorker(async (): Promise<WorkerResources> => {
    const handle = createDatabaseClient({ connectionString: databaseUrl });
    const queue = createPgmqProcessingQueue(handle.client);
    const storage = new SupabaseArtifactReader({
      url: config.storage.url,
      serviceRoleKey: config.storage.serviceRoleKey,
      bucket: config.storage.bucket,
      connectTimeoutMs: config.storage.connectTimeoutMs,
    });
    const artifactReader: Parameters<typeof processFilesIntent>[2] = async (
      input,
    ) =>
      readVerifiedArtifact(storage, input.objectKey, {
        expectedBytes: input.expectedBytes,
        expectedSha256: input.expectedSha256,
        maximumBytes: 20_000_000,
        inactivityTimeoutMs: config.storage.inactivityTimeoutMs,
        attemptTimeoutMs: Math.max(1, input.deadlineAt.getTime() - Date.now()),
        ...(input.signal ? { signal: input.signal } : {}),
      });
    const consumerConfig: ProcessingConsumerConfig = {
      processing: config.processing,
      filesProcessing: config.filesProcessing,
      findingsProcessing: config.findingsProcessing,
      artifactReader,
      queueBatchSize: config.queueBatchSize,
      visibilityTimeoutSeconds: config.visibilityTimeoutSeconds,
      poisonReadLimit: config.poisonReadLimit,
    };
    return {
      verify: () => queue.verify(),
      relayCycle: () =>
        relayProcessingCycle(handle.client, queue, config.relay),
      consumerCycle: (signal) =>
        consumeProcessingCycle(handle.client, queue, consumerConfig, signal),
      close: () => handle.dispose(),
    };
  }, config.worker);
}
