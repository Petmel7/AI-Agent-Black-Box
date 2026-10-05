import { describe, expect, it, vi } from 'vitest';

import type { ProcessingQueue } from '@blackbox/database';
import {
  consumeProcessingCycle,
  createProductionWorker,
} from './composition.js';

const config = {
  databaseUrl: 'postgresql://worker:secret@localhost:5432/blackbox',
  worker: { pollDelayMs: 100, shutdownWaitMs: 100 },
  relay: {
    batchSize: 1,
    leaseSeconds: 10,
    maxAttempts: 2,
    retryBaseSeconds: 1,
    retryMaxSeconds: 2,
  },
  processing: {
    eventPageSize: 10,
    maxEvents: 100,
    maxProjectedChildren: 100,
    leaseSeconds: 20,
    attemptTimeoutMs: 10_000,
    transitionMarginMs: 1_000,
    maxAttempts: 2,
    retryBaseSeconds: 1,
    retryMaxSeconds: 2,
  },
  filesProcessing: {
    maxArtifacts: 10,
    maxCumulativeBytes: 20_000_000,
    maxEntries: 100,
    maxProjectedRows: 100,
    storageConcurrency: 2,
    leaseSeconds: 20,
    attemptTimeoutMs: 10_000,
    transitionMarginMs: 1_000,
    maxAttempts: 2,
    retryBaseSeconds: 1,
    retryMaxSeconds: 2,
  },
  storage: {
    url: 'https://example.supabase.co',
    serviceRoleKey: 'service-role-sentinel',
    bucket: 'private-artifacts',
    connectTimeoutMs: 100,
    inactivityTimeoutMs: 100,
  },
  queueBatchSize: 1,
  visibilityTimeoutSeconds: 30,
  poisonReadLimit: 2,
};

describe('production worker composition', () => {
  it('constructs lazily without opening a database or queue', () => {
    const worker = createProductionWorker(config);
    expect(worker.isRunning()).toBe(false);
  });

  it('validates visibility and connection configuration without echoing values', () => {
    expect(() =>
      createProductionWorker({
        ...config,
        visibilityTimeoutSeconds: 10,
      }),
    ).toThrow('visibility');
    expect(() =>
      createProductionWorker({ ...config, databaseUrl: 'sentinel' }),
    ).toThrow('WORKER_DATABASE_URL must be a PostgreSQL URL.');
    expect(() =>
      createProductionWorker({ ...config, databaseUrl: 'sentinel' }),
    ).not.toThrow(/sentinel/);
    expect(() =>
      createProductionWorker({
        ...config,
        processing: {
          ...config.processing,
          attemptTimeoutMs: 19_000,
          transitionMarginMs: 1_000,
        },
      }),
    ).toThrow('attempt deadline plus transition margin');
  });

  it('archives a durable failure only when the poison threshold is reached', async () => {
    const archive = vi.fn(async () => true);
    let readCount = 1;
    const queue: ProcessingQueue = {
      verify: async () => undefined,
      send: async () => 1,
      read: async () => [
        {
          messageId: 7,
          readCount: readCount++,
          payload: {
            schemaVersion: 1 as const,
            intentId: '00000000-0000-4000-8000-000000000001',
          },
        },
      ],
      archive,
    };
    const processIntent = vi.fn(async () => 'failed' as const);
    await consumeProcessingCycle({} as never, queue, config, undefined, {
      processIntent,
    });
    expect(archive).not.toHaveBeenCalled();
    await consumeProcessingCycle({} as never, queue, config, undefined, {
      processIntent,
    });
    expect(archive).toHaveBeenCalledWith(7);
  });

  it('converges a commit/archive crash through exact-receipt replay', async () => {
    const archive = vi.fn(async () => true);
    const queue: ProcessingQueue = {
      verify: async () => undefined,
      send: async () => 1,
      read: async () => [
        {
          messageId: 8,
          readCount: 1,
          payload: {
            schemaVersion: 1 as const,
            intentId: '00000000-0000-4000-8000-000000000002',
          },
        },
      ],
      archive,
    };
    const processIntent = vi
      .fn()
      .mockResolvedValueOnce('applied')
      .mockResolvedValueOnce('already_applied');
    await consumeProcessingCycle({} as never, queue, config, undefined, {
      processIntent,
      afterProcessBeforeArchive: () => {
        throw new Error('crash');
      },
    });
    expect(archive).not.toHaveBeenCalled();
    await consumeProcessingCycle({} as never, queue, config, undefined, {
      processIntent,
    });
    expect(archive).toHaveBeenCalledWith(8);
  });

  it('dispatches artifact intents to the files projector and archives successful application', async () => {
    const archive = vi.fn(async () => true);
    const intentId = '00000000-0000-4000-8000-000000000003';
    const queue: ProcessingQueue = {
      verify: async () => undefined,
      send: async () => 1,
      read: async () => [
        { messageId: 9, readCount: 1, payload: { schemaVersion: 1, intentId } },
      ],
      archive,
    };
    const client = {
      processingIntent: {
        findUnique: vi.fn(async () => ({ kind: 'ARTIFACT_VERIFIED' })),
      },
    } as never;
    const processFiles = vi.fn(async () => 'applied' as const);
    const artifactReader = vi.fn();
    const consumerConfig = { ...config, artifactReader };
    await consumeProcessingCycle(client, queue, consumerConfig, undefined, {
      processFilesIntent: processFiles,
    });
    expect(processFiles).toHaveBeenCalledWith(
      client,
      intentId,
      artifactReader,
      config.filesProcessing,
      {},
    );
    expect(archive).toHaveBeenCalledWith(9);
  });

  it('fails a mismatched artifact intent closed and converges at the poison threshold', async () => {
    const archive = vi.fn(async () => true);
    const queue: ProcessingQueue = {
      verify: async () => undefined,
      send: async () => 1,
      read: async () => [
        {
          messageId: 10,
          readCount: 2,
          payload: {
            schemaVersion: 1,
            intentId: '00000000-0000-4000-8000-000000000004',
          },
        },
      ],
      archive,
    };
    const client = {
      processingIntent: {
        findUnique: vi.fn(async () => ({ kind: 'ARTIFACT_VERIFIED' })),
      },
    } as never;
    const withoutFiles = {
      processing: config.processing,
      queueBatchSize: config.queueBatchSize,
      visibilityTimeoutSeconds: config.visibilityTimeoutSeconds,
      poisonReadLimit: config.poisonReadLimit,
    };
    await consumeProcessingCycle(client, queue, withoutFiles);
    expect(archive).toHaveBeenCalledWith(10);
  });
});
