import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { runWorkerUntilShutdown } from './runtime.js';

describe('worker runtime', () => {
  it('stops once and removes both signal listeners', async () => {
    const signals = new EventEmitter();
    const worker = {
      isRunning: () => true,
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };

    const running = runWorkerUntilShutdown(worker, signals);

    await vi.waitFor(() => expect(worker.start).toHaveBeenCalledOnce());
    expect(signals.listenerCount('SIGINT')).toBe(1);
    expect(signals.listenerCount('SIGTERM')).toBe(1);

    signals.emit('SIGTERM');
    signals.emit('SIGINT');
    await running;

    expect(worker.stop).toHaveBeenCalledOnce();
    expect(signals.listenerCount('SIGINT')).toBe(0);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
  });
});
