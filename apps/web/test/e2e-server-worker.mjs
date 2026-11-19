import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { runConfigurationFromEnvironment } from './e2e-controller.mjs';
import { terminateOwnedProcess } from './e2e-process-control.mjs';

const INTERNAL_MARKER = 'bbx-e2e-server-harness-v2';
const webRoot = fileURLToPath(new URL('..', import.meta.url));
const launcher = fileURLToPath(
  new URL('../scripts/dashboard-next.mjs', import.meta.url),
);
const fixtureApp = fileURLToPath(
  new URL('./e2e-fixture-app.mjs', import.meta.url),
);
const configuration = runConfigurationFromEnvironment(process.env);
const proxyToken = process.env.BBX_E2E_TRUSTED_PROXY_TOKEN;
const internalTest =
  process.env.BBX_E2E_INTERNAL_TEST_CONTEXT === INTERNAL_MARKER;
const fixtureMode = process.env.BBX_E2E_INTERNAL_FIXTURE_MODE;
const internalTimeout = process.env.BBX_E2E_INTERNAL_STARTUP_TIMEOUT_MS;
if (
  !proxyToken ||
  !/^[A-Za-z0-9_-]{32,256}$/.test(proxyToken) ||
  (fixtureMode !== undefined && !internalTest) ||
  (internalTimeout !== undefined &&
    (!internalTest || !/^[1-9][0-9]{2,4}$/.test(internalTimeout)))
)
  throw new Error('Invalid isolated dashboard E2E worker configuration.');
const startupTimeoutMs = internalTimeout ? Number(internalTimeout) : 20_000;
if (startupTimeoutMs < 100 || startupTimeoutMs > 60_000)
  throw new Error('Invalid E2E worker startup timeout.');

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
  headers.host = `127.0.0.1:${configuration.appPort}`;
  headers['x-forwarded-proto'] = 'https';
  headers['x-blackbox-proxy-token'] = proxyToken;
  const upstream = request(
    {
      host: '127.0.0.1',
      port: configuration.appPort,
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
    let forced = false;
    if (proxy.listening)
      await new Promise((resolvePromise) =>
        proxy.close(() => resolvePromise(undefined)),
      );
    if (child !== undefined) {
      try {
        const termination = await terminateOwnedProcess(child, {
          requestShutdown: () => child.kill('SIGTERM'),
          cooperativeTimeoutMs: 5_000,
          forcedTimeoutMs: 5_000,
        });
        forced = termination.forced;
      } catch {
        forced = true;
      }
    }
    if (forced) requestedExitCode = 1;
    phase('worker-cleanup-complete', {
      pid: process.pid,
      forced: forced ? 1 : 0,
    });
    if (process.connected) process.disconnect();
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    process.exit(requestedExitCode);
  });
  return cleanupPromise;
}

async function fail(code) {
  send({ type: 'fatal', code });
  await cleanup(1);
}

function probeApplication() {
  return new Promise((resolvePromise) => {
    const probe = request(
      {
        host: '127.0.0.1',
        port: configuration.appPort,
        path: '/health',
        method: 'GET',
      },
      (response) => {
        response.resume();
        resolvePromise(response.statusCode === 200);
      },
    );
    probe.setTimeout(500, () => probe.destroy());
    probe.once('error', () => resolvePromise(false));
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
    ? [fixtureApp, fixtureMode ?? 'ready', String(configuration.appPort)]
    : [launcher, 'start', '--port', String(configuration.appPort)];
  child = spawn(process.execPath, arguments_, {
    cwd: webRoot,
    detached: false,
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
  childOutcome = new Promise((resolvePromise) => {
    child.once('error', () => resolvePromise({ type: 'spawn-error' }));
    child.once('exit', (code, signal) =>
      resolvePromise({ type: 'exit', code, signal }),
    );
  });

  const startedAt = performance.now();
  while (performance.now() - startedAt < startupTimeoutMs) {
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
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  if (performance.now() - startedAt >= startupTimeoutMs) {
    await fail('application-startup-timeout');
    return;
  }
  phase('application-ready', { pid: child.pid ?? 0 });
  await new Promise((resolvePromise, reject) => {
    proxy.once('error', reject);
    proxy.listen(
      { port: configuration.proxyPort, host: '127.0.0.1', exclusive: true },
      resolvePromise,
    );
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
