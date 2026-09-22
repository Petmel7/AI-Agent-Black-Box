import type { WorkerLifecycle } from './worker.js';

const shutdownSignals = ['SIGINT', 'SIGTERM'] as const;

type ShutdownSignal = (typeof shutdownSignals)[number];

export interface SignalSource {
  once(signal: ShutdownSignal, listener: () => void): unknown;
  removeListener(signal: ShutdownSignal, listener: () => void): unknown;
}

export async function runWorkerUntilShutdown(
  worker: WorkerLifecycle,
  signalSource: SignalSource = process,
): Promise<void> {
  let requestShutdown: () => void = () => undefined;
  const shutdownRequested = new Promise<void>((resolve) => {
    requestShutdown = resolve;
  });

  for (const signal of shutdownSignals) {
    signalSource.once(signal, requestShutdown);
  }

  // An unresolved promise and signal listeners do not keep Node's event loop
  // referenced, so the process needs an explicit handle until shutdown.
  const keepAlive = setInterval(() => undefined, 2_147_483_647);

  try {
    await worker.start();
    await shutdownRequested;
  } finally {
    clearInterval(keepAlive);

    for (const signal of shutdownSignals) {
      signalSource.removeListener(signal, requestShutdown);
    }

    await worker.stop();
  }
}
