import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { runConfigurationFromEnvironment } from './e2e-controller.mjs';
import { emitE2ePhase, terminateOwnedProcess } from './e2e-process-control.mjs';

const INTERNAL_MARKER = 'bbx-e2e-server-harness-v2';
const workerPath = fileURLToPath(
  new URL('./e2e-server-worker.mjs', import.meta.url),
);
const configuration = runConfigurationFromEnvironment(process.env);
const proxyToken = process.env.BBX_E2E_TRUSTED_PROXY_TOKEN;
const internalTest =
  process.env.BBX_E2E_INTERNAL_TEST_CONTEXT === INTERNAL_MARKER;
const internalTimeout = process.env.BBX_E2E_INTERNAL_STARTUP_TIMEOUT_MS;
if (
  !proxyToken ||
  !/^[A-Za-z0-9_-]{32,256}$/.test(proxyToken) ||
  (process.env.BBX_E2E_INTERNAL_FIXTURE_MODE !== undefined && !internalTest) ||
  (internalTimeout !== undefined &&
    (!internalTest || !/^[1-9][0-9]{2,4}$/.test(internalTimeout)))
)
  throw new Error('Invalid isolated dashboard E2E server configuration.');
const startupTimeoutMs = internalTimeout ? Number(internalTimeout) : 25_000;
if (startupTimeoutMs < 100 || startupTimeoutMs > 60_000)
  throw new Error('Invalid E2E server startup timeout.');

emitE2ePhase('server-controller-start', {
  'app-port': configuration.appPort,
  'proxy-port': configuration.proxyPort,
});
const worker = fork(workerPath, [], {
  detached: false,
  env: process.env,
  stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  windowsHide: true,
});
emitE2ePhase('server-worker-spawned', { pid: worker.pid ?? 0 });

let cleanupPromise;
let ready = false;
let requestedExitCode = 0;
const startupWatchdog = setTimeout(
  () => void shutdown(1, 'server-startup-timeout'),
  startupTimeoutMs,
);
startupWatchdog.unref();

async function shutdown(
  exitCode = requestedExitCode,
  phase = 'server-shutdown',
) {
  if (cleanupPromise !== undefined) return cleanupPromise;
  requestedExitCode = exitCode;
  cleanupPromise = Promise.resolve().then(async () => {
    clearTimeout(startupWatchdog);
    emitE2ePhase(phase);
    let forced = false;
    try {
      const outcome = await terminateOwnedProcess(worker, {
        requestShutdown: () => {
          if (worker.connected) worker.send({ type: 'shutdown' });
          else worker.kill('SIGTERM');
        },
        cooperativeTimeoutMs: 5_000,
        forcedTimeoutMs: 5_000,
      });
      forced = outcome.forced;
    } catch {
      forced = true;
      requestedExitCode = 1;
    }
    if (forced) requestedExitCode = 1;
    emitE2ePhase('server-controller-cleanup-complete', {
      forced: forced ? 1 : 0,
    });
    process.exit(requestedExitCode);
  });
  return cleanupPromise;
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
worker.once('exit', (code, signal) => {
  if (cleanupPromise === undefined)
    void shutdown(
      code === 0 && signal === null && ready ? 0 : 1,
      'server-worker-exited',
    );
});
process.on('message', (message) => {
  if (message?.type === 'shutdown')
    void shutdown(0, 'server-shutdown-requested');
});
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => void shutdown(0, 'server-signal'));
