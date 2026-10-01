import { describe, expect, it, vi } from 'vitest';
import { createWorker, type WorkerResources } from './worker.js';

function resources(): WorkerResources {
  return {
    verify: vi.fn(async () => undefined),
    relayCycle: vi.fn(async () => 0),
    consumerCycle: vi.fn(async () => 0),
    close: vi.fn(async () => undefined),
  };
}

describe('worker lifecycle', () => {
  it('is lazy and start/stop are idempotent with owned resources closed once', async () => {
    const owned = resources();
    const open = vi.fn(async () => owned);
    const worker = createWorker(open, { pollDelayMs: 20, shutdownWaitMs: 200 });
    expect(open).not.toHaveBeenCalled();
    await Promise.all([worker.start(), worker.start()]);
    expect(worker.isRunning()).toBe(true);
    expect(open).toHaveBeenCalledOnce();
    expect(owned.verify).toHaveBeenCalledOnce();
    await Promise.all([worker.stop(), worker.stop()]);
    expect(worker.isRunning()).toBe(false);
    expect(owned.close).toHaveBeenCalledOnce();
  });

  it('closes resources when infrastructure verification fails', async () => {
    const owned = resources();
    vi.mocked(owned.verify).mockRejectedValueOnce(new Error('unavailable'));
    const worker = createWorker(async () => owned, {
      pollDelayMs: 20,
      shutdownWaitMs: 200,
    });
    await expect(worker.start()).rejects.toThrow('unavailable');
    expect(owned.close).toHaveBeenCalledOnce();
    expect(worker.isRunning()).toBe(false);
  });

  it('backs off empty cycles and reports safe cycle codes', async () => {
    vi.useFakeTimers();
    const owned = resources();
    vi.mocked(owned.relayCycle).mockRejectedValue(new Error('secret sentinel'));
    const onError = vi.fn();
    const worker = createWorker(async () => owned, {
      pollDelayMs: 50,
      shutdownWaitMs: 200,
      onError,
    });
    await worker.start();
    await vi.advanceTimersByTimeAsync(49);
    expect(owned.consumerCycle).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('relay_cycle_failed');
    const stopped = worker.stop();
    await vi.runAllTimersAsync();
    await stopped;
    vi.useRealTimers();
  });

  it('aborts an in-flight consumer and waits for it before closing resources', async () => {
    let observedSignal: AbortSignal | undefined;
    const owned = resources();
    owned.consumerCycle = vi.fn(
      (signal: AbortSignal) =>
        new Promise<number>((resolve) => {
          observedSignal = signal;
          signal.addEventListener('abort', () => resolve(0), { once: true });
        }),
    );
    const worker = createWorker(async () => owned, {
      pollDelayMs: 20,
      shutdownWaitMs: 200,
    });
    await worker.start();
    await worker.stop();
    expect(observedSignal?.aborted).toBe(true);
    expect(owned.close).toHaveBeenCalledOnce();
    expect(vi.mocked(owned.close).mock.invocationCallOrder[0]).toBeGreaterThan(
      vi.mocked(owned.consumerCycle).mock.invocationCallOrder[0]!,
    );
  });
});
