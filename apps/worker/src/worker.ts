export interface WorkerLifecycle {
  isRunning(): boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createWorker(): WorkerLifecycle {
  let running = false;

  return {
    isRunning: () => running,
    start: async () => {
      running = true;
    },
    stop: async () => {
      running = false;
    },
  };
}
