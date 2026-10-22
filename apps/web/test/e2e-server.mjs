import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  emitE2ePhase,
  terminateOwnedProcess,
  waitForOwnedProcessExit,
} from './e2e-process-control.mjs';

const INTERNAL_MARKER = 'bbx-e2e-harness-v1';
const workerPath = fileURLToPath(
  new URL('./e2e-server-worker.mjs', import.meta.url),
);
const appPort = Number(process.env.BBX_E2E_APP_PORT ?? '43122');
const proxyPort = Number(process.env.BBX_E2E_PROXY_PORT ?? '43121');
const proxyToken = process.env.BBX_E2E_TRUSTED_PROXY_TOKEN;
const internalTest =
  process.env.BBX_E2E_INTERNAL_TEST_CONTEXT === INTERNAL_MARKER;
const internalTimeout = process.env.BBX_E2E_INTERNAL_STARTUP_TIMEOUT_MS;
if (
  !Number.isSafeInteger(appPort) ||
  !Number.isSafeInteger(proxyPort) ||
  appPort < 1024 ||
  proxyPort < 1024 ||
  appPort === proxyPort ||
  !proxyToken ||
  !/^[A-Za-z0-9_-]{32,256}$/.test(proxyToken) ||
  (internalTimeout !== undefined &&
    (!internalTest || !/^[1-9][0-9]{2,3}$/.test(internalTimeout)))
)
  throw new Error('Invalid isolated dashboard E2E server configuration.');
const startupTimeoutMs = internalTimeout ? Number(internalTimeout) : 25_000;

emitE2ePhase('server-controller-start');
const worker = fork(workerPath, [], {
  detached: true,
  env: process.env,
  stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  windowsHide: true,
});
emitE2ePhase('server-worker-spawned', { pid: worker.pid ?? 0 });

let closing = false;
let ready = false;
const startupWatchdog = setTimeout(() => {
  void shutdown(1, 'server-startup-timeout');
}, startupTimeoutMs);
startupWatchdog.unref();

async function shutdown(exitCode, phase) {
  if (closing) return;
  closing = true;
  clearTimeout(startupWatchdog);
  emitE2ePhase(phase);
  if (worker.connected) worker.send({ type: 'shutdown' });
  try {
    await waitForOwnedProcessExit(worker, 5_000);
  } catch {
    await terminateOwnedProcess(worker);
  }
  emitE2ePhase('server-controller-cleanup-complete');
  process.exit(exitCode);
}

worker.on('message', (message) => {
  if (message?.type === 'phase') {
    emitE2ePhase(message.name, message.details);
    if (message.name === 'proxy-ready') {
      ready = true;
      clearTimeout(startupWatchdog);
    }
  } else if (message?.type === 'fatal') {
    const code =
      typeof message.code === 'string' && /^[a-z0-9-]+$/.test(message.code)
        ? message.code
        : 'unknown-worker-failure';
    process.stderr.write(`E2E server failed during ${code}.\n`);
    void shutdown(1, 'server-worker-failed');
  }
});
worker.once('error', () => void shutdown(1, 'server-worker-spawn-failed'));
worker.once('exit', (code) => {
  if (!closing)
    void shutdown(code === 0 && ready ? 0 : 1, 'server-worker-exited');
});
process.on('message', (message) => {
  if (message?.type === 'shutdown')
    void shutdown(0, 'server-shutdown-requested');
});
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => void shutdown(0, 'server-signal'));
