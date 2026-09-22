import { describe, expect, it } from 'vitest';

import { createWorker } from './worker.js';

describe('worker lifecycle', () => {
  it('starts and stops cleanly without infrastructure', async () => {
    const worker = createWorker();

    expect(worker.isRunning()).toBe(false);
    await worker.start();
    expect(worker.isRunning()).toBe(true);
    await worker.stop();
    expect(worker.isRunning()).toBe(false);
  });
});
