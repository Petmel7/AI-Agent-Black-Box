import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { fileURLToPath } from 'node:url';

import { terminateOwnedProcess } from './e2e-process-control.mjs';

const INTERNAL_MARKER = 'bbx-e2e-harness-v1';
const webRoot = fileURLToPath(new URL('..', import.meta.url));
const launcher = fileURLToPath(
  new URL('../scripts/dashboard-next.mjs', import.meta.url),
);
const fixtureApp = fileURLToPath(
  new URL('./e2e-fixture-app.mjs', import.meta.url),
);
const appPort = Number(process.env.BBX_E2E_APP_PORT ?? '43122');
const proxyPort = Number(process.env.BBX_E2E_PROXY_PORT ?? '43121');
const proxyToken = process.env.BBX_E2E_TRUSTED_PROXY_TOKEN;
const internalTest =
  process.env.BBX_E2E_INTERNAL_TEST_CONTEXT === INTERNAL_MARKER;
const fixtureMode = process.env.BBX_E2E_INTERNAL_FIXTURE_MODE;
const internalTimeout = process.env.BBX_E2E_INTERNAL_STARTUP_TIMEOUT_MS;
if (
  !Number.isSafeInteger(appPort) ||
  !Number.isSafeInteger(proxyPort) ||
  appPort < 1024 ||
  proxyPort < 1024 ||
  appPort === proxyPort ||
  !proxyToken ||
  !/^[A-Za-z0-9_-]{32,256}$/.test(proxyToken) ||
  (fixtureMode !== undefined && !internalTest) ||
  (internalTimeout !== undefined &&
    (!internalTest || !/^[1-9][0-9]{2,3}$/.test(internalTimeout)))
)
  throw new Error('Invalid isolated dashboard E2E worker configuration.');
const startupTimeoutMs = internalTimeout ? Number(internalTimeout) : 20_000;

let child;
let childOutcome;
let cleanupPromise;
let requestedExitCode = 0;
const proxy = createServer((incoming, response) => {
  const headers = { ...incoming.headers };
  for (const name of Object.keys(headers)) {
    const normalized = name.toLowerCase();
    if (
      normalized === 'forwarded' ||
      normalized === 'x-blackbox-proxy-token' ||
      normalized.startsWith('x-forwarded-')
    )
      delete headers[name];
  }
  headers.host = `127.0.0.1:${appPort}`;
  headers['x-forwarded-proto'] = 'https';
  headers['x-blackbox-proxy-token'] = proxyToken;
  const upstream = request(
    {
      host: '127.0.0.1',
      port: appPort,
      method: incoming.method,
      path: incoming.url,
      headers,
    },
    (upstreamResponse) => {
      response.writeHead(
        upstreamResponse.statusCode ?? 502,
        upstreamResponse.headers,
      );
      upstreamResponse.pipe(response);
    },
  );
  upstream.once('error', () => {
    if (!response.headersSent)
      response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Service unavailable');
  });
  incoming.pipe(upstream);
});

function send(message) {
  if (process.connected) process.send?.(message);
}

function phase(name, details = {}) {
  send({ type: 'phase', name, details });
}

async function cleanup(exitCode = requestedExitCode) {
  if (cleanupPromise !== undefined) return cleanupPromise;
  requestedExitCode = exitCode;
  cleanupPromise = Promise.resolve().then(async () => {
    if (proxy.listening)
      await new Promise((resolve) => proxy.close(() => resolve()));
    if (child !== undefined) await terminateOwnedProcess(child);
    phase('worker-cleanup-complete', { pid: process.pid });
    if (process.connected) process.disconnect();
    await new Promise((resolve) => setImmediate(resolve));
    process.exit(requestedExitCode);
  });
  return cleanupPromise;
}

async function fail(code) {
  send({ type: 'fatal', code });
  await cleanup(1);
}

function probeApplication() {
  return new Promise((resolve) => {
    const probe = request(
      { host: '127.0.0.1', port: appPort, path: '/health', method: 'GET' },
      (response) => {
        response.resume();
        resolve(response.statusCode === 200);
      },
    );
    probe.setTimeout(500, () => probe.destroy());
    probe.once('error', () => resolve(false));
    probe.end();
  });
}

async function start() {
  if (fixtureMode === 'pre-spawn-failure') {
    phase('application-pre-spawn-failure');
    await fail('application-pre-spawn-failure');
    return;
  }
  const arguments_ = internalTest
    ? [fixtureApp, fixtureMode ?? 'ready', String(appPort)]
    : [launcher, 'start', '--port', String(appPort)];
  child = spawn(process.execPath, arguments_, {
    cwd: webRoot,
    detached: true,
    env: internalTest
      ? process.env
      : {
          ...process.env,
          NODE_ENV: 'production',
          DASHBOARD_SERVER_BIND_HOST: '127.0.0.1',
          DASHBOARD_ALLOW_INSECURE_LOOPBACK: 'false',
        },
    stdio: 'inherit',
    windowsHide: true,
  });
  phase('application-spawned', { pid: child.pid ?? 0 });
  childOutcome = new Promise((resolve) => {
    child.once('error', () => resolve({ type: 'spawn-error' }));
    child.once('exit', (code, signal) =>
      resolve({ type: 'exit', code, signal }),
    );
  });

  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    const outcome = await Promise.race([
      probeApplication().then((ready) => ({ type: 'probe', ready })),
      childOutcome,
    ]);
    if (outcome.type !== 'probe') {
      await fail(
        outcome.type === 'spawn-error'
          ? 'application-spawn-failed'
          : 'application-exited-before-ready',
      );
      return;
    }
    if (outcome.ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (Date.now() >= deadline) {
    await fail('application-startup-timeout');
    return;
  }
  phase('application-ready', { pid: child.pid ?? 0 });
  await new Promise((resolve, reject) => {
    proxy.once('error', reject);
    proxy.listen(proxyPort, '127.0.0.1', resolve);
  });
  phase('proxy-ready', { pid: process.pid });

  await childOutcome;
  if (cleanupPromise === undefined) await fail('application-exited');
}

process.on('message', (message) => {
  if (message?.type === 'shutdown') void cleanup(0);
});
process.once('disconnect', () => void cleanup(0));
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => void cleanup(0));

start().catch(() => void fail('worker-start-failed'));
