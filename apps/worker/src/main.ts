import { createWorker } from './worker.js';
import { runWorkerUntilShutdown } from './runtime.js';

await runWorkerUntilShutdown(createWorker());
