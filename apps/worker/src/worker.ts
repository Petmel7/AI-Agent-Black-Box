export interface WorkerLifecycle {
  isRunning(): boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface WorkerResources {
  verify(): Promise<void>;
  relayCycle(signal: AbortSignal): Promise<number>;
  consumerCycle(signal: AbortSignal): Promise<number>;
  close(): Promise<void>;
}

export interface WorkerOptions {
  pollDelayMs: number;
  shutdownWaitMs: number;
  onError?: (code: 'relay_cycle_failed' | 'consumer_cycle_failed') => void;
}

function validate(options: WorkerOptions) {
  if (
    !Number.isSafeInteger(options.pollDelayMs) ||
    options.pollDelayMs < 10 ||
    !Number.isSafeInteger(options.shutdownWaitMs) ||
    options.shutdownWaitMs < 1
  )
    throw new TypeError('Worker poll and shutdown bounds are invalid.');
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export function createWorker(
  openResources: () => Promise<WorkerResources>,
  options: WorkerOptions,
): WorkerLifecycle {
  validate(options);
  let running = false;
  let starting: Promise<void> | null = null;
  let stopping: Promise<void> | null = null;
  let resources: WorkerResources | null = null;
  let controller: AbortController | null = null;
  let loops: Promise<void>[] = [];

  const loop = async (kind: 'relay' | 'consumer', signal: AbortSignal) => {
    while (!signal.aborted) {
      let count = 0;
      try {
        count =
          kind === 'relay'
            ? await resources!.relayCycle(signal)
            : await resources!.consumerCycle(signal);
      } catch {
        options.onError?.(
          kind === 'relay' ? 'relay_cycle_failed' : 'consumer_cycle_failed',
        );
      }
      if (count === 0 || signal.aborted)
        await delay(options.pollDelayMs, signal);
    }
  };

  return {
    isRunning: () => running,
    async start() {
      if (running) return;
      if (starting) return starting;
      starting = (async () => {
        const opened = await openResources();
        try {
          await opened.verify();
        } catch (error) {
          await opened.close();
          throw error;
        }
        resources = opened;
        controller = new AbortController();
        running = true;
        loops = [
          loop('relay', controller.signal),
          loop('consumer', controller.signal),
        ];
      })();
      try {
        await starting;
      } finally {
        starting = null;
      }
    },
    async stop() {
      if (stopping) return stopping;
      stopping = (async () => {
        if (starting) {
          try {
            await starting;
          } catch {
            return;
          }
        }
        if (!resources) {
          running = false;
          return;
        }
        controller?.abort();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, options.shutdownWaitMs);
          timer.unref();
        });
        try {
          await Promise.race([
            Promise.allSettled(loops).then(() => undefined),
            timeout,
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
        const owned = resources;
        resources = null;
        running = false;
        loops = [];
        await owned.close();
      })();
      try {
        await stopping;
      } finally {
        stopping = null;
      }
    },
  };
}
