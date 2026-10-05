import { createProductionWorker } from './composition.js';
import { runWorkerUntilShutdown } from './runtime.js';

function integer(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${name} must be a positive integer.`);
  return value;
}

const worker = createProductionWorker({
  databaseUrl: process.env.WORKER_DATABASE_URL ?? '',
  worker: {
    pollDelayMs: integer('WORKER_POLL_DELAY_MS', 1_000),
    shutdownWaitMs: integer('WORKER_SHUTDOWN_WAIT_MS', 30_000),
  },
  relay: {
    batchSize: integer('WORKER_RELAY_BATCH_SIZE', 20),
    leaseSeconds: integer('WORKER_RELAY_LEASE_SECONDS', 60),
    maxAttempts: integer('WORKER_RELAY_MAX_ATTEMPTS', 8),
    retryBaseSeconds: integer('WORKER_RETRY_BASE_SECONDS', 5),
    retryMaxSeconds: integer('WORKER_RETRY_MAX_SECONDS', 300),
  },
  processing: {
    eventPageSize: integer('WORKER_EVENT_PAGE_SIZE', 500),
    maxEvents: integer('WORKER_MAX_EVENTS_PER_RUN', 20_000),
    maxProjectedChildren: integer('WORKER_MAX_PROJECTED_CHILDREN', 20_000),
    leaseSeconds: integer('WORKER_PROJECTION_LEASE_SECONDS', 300),
    attemptTimeoutMs: integer('WORKER_PROJECTION_ATTEMPT_TIMEOUT_MS', 240_000),
    transitionMarginMs: integer(
      'WORKER_PROJECTION_TRANSITION_MARGIN_MS',
      5_000,
    ),
    maxAttempts: integer('WORKER_PROJECTION_MAX_ATTEMPTS', 5),
    retryBaseSeconds: integer('WORKER_RETRY_BASE_SECONDS', 5),
    retryMaxSeconds: integer('WORKER_RETRY_MAX_SECONDS', 300),
  },
  filesProcessing: {
    maxArtifacts: integer('WORKER_MAX_FILE_ARTIFACTS_PER_RUN', 100),
    maxCumulativeBytes: integer(
      'WORKER_MAX_FILE_ARTIFACT_BYTES_PER_RUN',
      100_000_000,
    ),
    maxEntries: integer('WORKER_MAX_FILE_ENTRIES_PER_RUN', 20_000),
    maxProjectedRows: integer('WORKER_MAX_FILE_ROWS_PER_RUN', 20_000),
    storageConcurrency: integer('WORKER_STORAGE_CONCURRENCY', 4),
    leaseSeconds: integer('WORKER_PROJECTION_LEASE_SECONDS', 300),
    attemptTimeoutMs: integer('WORKER_PROJECTION_ATTEMPT_TIMEOUT_MS', 240_000),
    transitionMarginMs: integer(
      'WORKER_PROJECTION_TRANSITION_MARGIN_MS',
      5_000,
    ),
    maxAttempts: integer('WORKER_PROJECTION_MAX_ATTEMPTS', 5),
    retryBaseSeconds: integer('WORKER_RETRY_BASE_SECONDS', 5),
    retryMaxSeconds: integer('WORKER_RETRY_MAX_SECONDS', 300),
  },
  storage: {
    url: process.env.SUPABASE_URL ?? '',
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
    bucket: process.env.ARTIFACT_STORAGE_BUCKET ?? '',
    connectTimeoutMs: integer('WORKER_STORAGE_CONNECT_TIMEOUT_MS', 10_000),
    inactivityTimeoutMs: integer(
      'WORKER_STORAGE_INACTIVITY_TIMEOUT_MS',
      15_000,
    ),
  },
  queueBatchSize: integer('WORKER_QUEUE_BATCH_SIZE', 10),
  visibilityTimeoutSeconds: integer('WORKER_QUEUE_VISIBILITY_SECONDS', 360),
  poisonReadLimit: integer('WORKER_POISON_READ_LIMIT', 5),
});

await runWorkerUntilShutdown(worker);
