import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

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

  it('keeps the built entrypoint alive until a termination signal', () => {
    const entrypointPath = fileURLToPath(
      new URL('../dist/main.js', import.meta.url),
    );
    const entrypointUrl = pathToFileURL(entrypointPath).href;
    const script = `
      let entrypointResolved = false;
      const entrypoint = import(${JSON.stringify(entrypointUrl)}).then(() => {
        entrypointResolved = true;
      });

      await new Promise((resolve, reject) => {
        const shutdownTimer = setTimeout(() => {
          if (entrypointResolved) {
            reject(new Error('Worker entrypoint exited before shutdown'));
            return;
          }

          process.emit('SIGTERM');
          resolve();
        }, 300);

        shutdownTimer.unref();
      });

      await entrypoint;
    `;

    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', script],
      {
        encoding: 'utf8',
        timeout: 5_000,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });
});
