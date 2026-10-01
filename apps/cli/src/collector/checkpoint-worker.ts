import { parentPort, workerData } from 'node:worker_threads';

import { createGitCheckpointWorkerMessage, GitReader } from './git.js';
import { Redactor, type RedactorOptions } from './redaction.js';

interface CheckpointWorkerData {
  initialCwd: string;
  nonce: string;
  redactorOptions: RedactorOptions;
  repositoryRoot?: string;
}

const input = workerData as CheckpointWorkerData;

try {
  const redactor = new Redactor(input.redactorOptions);
  const snapshot = GitReader.open(
    input.initialCwd,
    input.repositoryRoot,
  ).capture('checkpoint', (value) => redactor.redact(value).text);
  parentPort?.postMessage(
    createGitCheckpointWorkerMessage(snapshot, input.nonce),
  );
} catch {
  process.exitCode = 1;
} finally {
  parentPort?.close();
}
