import { createServer, request } from 'node:http';
import { fileURLToPath } from 'node:url';

import {
  cleanupOwnedProcess,
  exportOwnedProcessAuthority,
  spawnOwnedProcess,
  validateCurrentLinuxGroupAuthority,
  validateCurrentLinuxGroupMemberAuthority,
} from './e2e-owned-process.mjs';
import {
  boundedLifecycleWaitMs,
  completeCleanupBudgetMs,
  E2E_LIFECYCLE_BOUNDS,
  parseInternalDuration,
} from './e2e-lifecycle-timing.mjs';
import { assertSupportedE2ePlatform } from './e2e-process-control.mjs';
import { parentResourcePlanFromEnvironment } from './e2e-resource-registry.mjs';

const INTERNAL_MARKER = 'bbx-e2e-harness-v1';
const webRoot = fileURLToPath(new URL('..', import.meta.url));
const launcher = fileURLToPath(
  new URL('../scripts/dashboard-next.mjs', import.meta.url),
);
const fixtureApp = fileURLToPath(
  new URL('./e2e-fixture-app.mjs', import.meta.url),
);
const controllerFixture = fileURLToPath(
  new URL('./e2e-controller-fixture.mjs', import.meta.url),
);
const appPort = Number(process.env.BBX_E2E_APP_PORT ?? '43122');
const proxyPort = Number(process.env.BBX_E2E_PROXY_PORT ?? '43121');
const proxyToken = process.env.BBX_E2E_TRUSTED_PROXY_TOKEN;
const internalTest =
  process.env.BBX_E2E_INTERNAL_TEST_CONTEXT === INTERNAL_MARKER;
const fixtureMode = process.env.BBX_E2E_INTERNAL_FIXTURE_MODE;
const internalTimeout = process.env.BBX_E2E_INTERNAL_STARTUP_TIMEOUT_MS;
const internalLaunchDelay = process.env.BBX_E2E_INTERNAL_LAUNCH_DELAY_MS;
const internalCleanupFailure =
  process.env.BBX_E2E_INTERNAL_WORKER_CLEANUP_FAILURE;
const platform = assertSupportedE2ePlatform();
const guardianOwnedLinuxGroup =
  platform === 'linux' &&
  process.env.BBX_E2E_LINUX_CONTROLLER_CHILD ===
    'bbx-e2e-linux-controller-child-v1';
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
    (!internalTest || !/^[1-9][0-9]{2,3}$/.test(internalTimeout))) ||
  (internalLaunchDelay !== undefined &&
    (!internalTest || !/^(0|[1-9][0-9]{0,3})$/.test(internalLaunchDelay))) ||
  (internalCleanupFailure !== undefined &&
    (!internalTest || internalCleanupFailure !== 'injected'))
)
  throw new Error('Invalid isolated dashboard E2E worker configuration.');
const startupTimeoutMs = internalTimeout
  ? parseInternalDuration(internalTimeout, {
      minimum: 100,
      maximum: 9_999,
      label: 'internal E2E startup timeout',
    })
  : 20_000;
const launchDelayMs = internalLaunchDelay ? Number(internalLaunchDelay) : 0;
const resourcePlan = parentResourcePlanFromEnvironment([
  ...(guardianOwnedLinuxGroup ? ['playwright'] : ['server-application']),
  ...(platform === 'win32' ? ['server-worker'] : []),
]);
const metadataDirectory = resourcePlan.get(
  guardianOwnedLinuxGroup ? 'playwright' : 'server-application',
).metadataDirectory;

let ownedApplication;
let cleanupPromise;
let requestedExitCode = 0;
let terminalResultSent = false;
let terminalAcknowledged = false;
let controllerDisconnected = false;
let ownershipAuthorityAcknowledged = false;
let launchAuthorized = false;
let linuxGroupAuthority;
let outerDeadlineAt;
let acknowledgeTerminalResult;
let acknowledgeOwnershipAuthority;
const terminalAcknowledgement = new Promise((resolveAcknowledgement) => {
  acknowledgeTerminalResult = resolveAcknowledgement;
});
const ownershipAuthorityAcknowledgement = new Promise(
  (resolveAcknowledgement) => {
    acknowledgeOwnershipAuthority = resolveAcknowledgement;
  },
);

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

async function waitForAcknowledgement() {
  let timeoutMs;
  try {
    timeoutMs =
      outerDeadlineAt === undefined
        ? E2E_LIFECYCLE_BOUNDS.terminalAcknowledgementMs
        : boundedLifecycleWaitMs(
            outerDeadlineAt,
            E2E_LIFECYCLE_BOUNDS.terminalAcknowledgementMs,
          );
  } catch {
    return false;
  }
  const timeout = new Promise((resolveTimeout) =>
    setTimeout(() => resolveTimeout(false), timeoutMs),
  );
  return Promise.race([terminalAcknowledgement.then(() => true), timeout]);
}

async function cleanup(exitCode = requestedExitCode) {
  if (cleanupPromise !== undefined) return cleanupPromise;
  requestedExitCode = exitCode;
  cleanupPromise = Promise.resolve().then(async () => {
    const cleanupFailures = [];
    let forcedProcessCleanup = false;
    try {
      if (proxy.listening)
        await new Promise((resolveClose, rejectClose) =>
          proxy.close((error) => (error ? rejectClose(error) : resolveClose())),
        );
    } catch (error) {
      cleanupFailures.push(error);
    }
    try {
      if (ownedApplication !== undefined && !guardianOwnedLinuxGroup)
        forcedProcessCleanup = (
          await cleanupOwnedProcess(
            ownedApplication,
            platform === 'win32'
              ? {
                  beforeMetadataCleanup: async () => {
                    if (!(await portIsFree(appPort)))
                      throw new Error(
                        'Application listener remained before metadata cleanup.',
                      );
                  },
                }
              : {},
          )
        ).forced;
    } catch (error) {
      cleanupFailures.push(error);
    }
    if (internalCleanupFailure === 'injected')
      cleanupFailures.push(new Error('Injected worker cleanup failure.'));
    const cleanupErrorCode = cleanupFailures.length === 0 ? 0 : 1;
    if (cleanupErrorCode !== 0) requestedExitCode = 1;
    phase(
      cleanupErrorCode === 0
        ? 'worker-cleanup-complete'
        : 'worker-cleanup-failed',
      cleanupErrorCode === 0
        ? {
            pid: process.pid,
            'forced-process-cleanup': forcedProcessCleanup ? 1 : 0,
          }
        : {
            'error-code': cleanupErrorCode,
            'failure-count': cleanupFailures.length,
          },
    );
    if (!controllerDisconnected && process.connected) {
      if (terminalResultSent) requestedExitCode = 1;
      else {
        terminalResultSent = true;
        send({
          type: 'terminal-result',
          version: 1,
          exitCode: requestedExitCode,
          cleanupSucceeded: cleanupErrorCode === 0,
          cleanupErrorCode,
        });
        if (!(await waitForAcknowledgement())) requestedExitCode = 1;
      }
    }
    if (process.connected) process.disconnect();
    await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
    process.exit(requestedExitCode);
  });
  return cleanupPromise;
}

function portIsFree(port) {
  return new Promise((resolveFree) => {
    const probe = createServer();
    probe.once('error', () => resolveFree(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolveFree(true)));
  });
}

async function fail(code) {
  send({ type: 'fatal', code });
  await cleanup(1);
}

function probeApplication(timeoutMs) {
  return new Promise((resolveProbe) => {
    const probe = request(
      { host: '127.0.0.1', port: appPort, path: '/health', method: 'GET' },
      (response) => {
        response.resume();
        resolveProbe(response.statusCode === 200);
      },
    );
    probe.setTimeout(Math.max(1, Math.min(500, timeoutMs)), () =>
      probe.destroy(),
    );
    probe.once('error', () => resolveProbe(false));
    probe.end();
  });
}

async function start(startupDeadline) {
  if (fixtureMode === 'pre-spawn-failure') {
    phase('application-pre-spawn-failure');
    await fail('application-pre-spawn-failure');
    return;
  }
  const rootExitFixture = internalTest && fixtureMode === 'root-exit';
  const arguments_ = internalTest
    ? rootExitFixture
      ? [controllerFixture]
      : [fixtureApp, fixtureMode ?? 'ready', String(appPort)]
    : [launcher, 'start', '--port', String(appPort)];
  const environment = internalTest
    ? {
        ...process.env,
        BBX_E2E_OWNED_OUTPUT_DIR: metadataDirectory,
        ...(rootExitFixture
          ? {
              BBX_E2E_INTERNAL_CONTROLLER_CONTEXT:
                'bbx-e2e-controller-harness-v1',
              BBX_E2E_INTERNAL_CONTROLLER_MODE: 'root-exit',
              BBX_E2E_INTERNAL_CONTROLLER_PORT: String(appPort),
            }
          : {}),
      }
    : {
        ...process.env,
        NODE_ENV: 'production',
        DASHBOARD_SERVER_BIND_HOST: '127.0.0.1',
        DASHBOARD_ALLOW_INSECURE_LOOPBACK: 'false',
      };
  ownedApplication = await spawnOwnedProcess({
    executable: process.execPath,
    arguments: arguments_,
    workingDirectory: webRoot,
    environment,
    metadataDirectory,
    metadataDirectoryOwned: !guardianOwnedLinuxGroup,
    role: 'application',
    phase,
    startupDeadline,
    launchDelayMs,
    linuxGroupAuthority,
    recordLinuxMetadata: !guardianOwnedLinuxGroup,
  });
  if (platform === 'win32') {
    const authority = exportOwnedProcessAuthority(ownedApplication);
    send({
      type: 'application-ownership-authority',
      version: 1,
      authority,
    });
    phase('application-ownership-handoff-requested');
    const authorityRemaining = startupDeadline - Date.now();
    if (authorityRemaining <= 0)
      throw Object.assign(
        new Error('Application ownership handoff timed out.'),
        { code: 'owned-process-startup-timeout' },
      );
    const authorityAccepted = await Promise.race([
      ownershipAuthorityAcknowledgement.then(() => true),
      new Promise((resolveTimeout) =>
        setTimeout(() => resolveTimeout(false), authorityRemaining),
      ),
    ]);
    if (!authorityAccepted)
      throw Object.assign(
        new Error('Application ownership handoff timed out.'),
        { code: 'owned-process-startup-timeout' },
      );
  }
  phase('application-ownership-handoff-complete');
  while (Date.now() < startupDeadline) {
    const remaining = startupDeadline - Date.now();
    const outcome = await Promise.race([
      probeApplication(remaining).then((ready) => ({ type: 'probe', ready })),
      ownedApplication.outcome,
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
    const waitMs = Math.min(100, startupDeadline - Date.now());
    if (waitMs > 0)
      await new Promise((resolveWait) => setTimeout(resolveWait, waitMs));
  }
  if (Date.now() >= startupDeadline) {
    await fail('application-startup-timeout');
    return;
  }
  phase('application-ready', { pid: ownedApplication.child.pid ?? 0 });
  await new Promise((resolveListen, rejectListen) => {
    proxy.once('error', rejectListen);
    proxy.listen(proxyPort, '127.0.0.1', resolveListen);
  });
  phase('proxy-ready', { pid: process.pid });
  await ownedApplication.outcome;
  if (cleanupPromise === undefined) await fail('application-exited');
}

process.on('message', (message) => {
  if (message?.type === 'shutdown') void cleanup(0);
  else if (message?.type === 'launch-authority') {
    if (launchAuthorized) {
      void fail('duplicate-launch-authority');
      return;
    }
    try {
      if (
        message.version !== 1 ||
        !Number.isSafeInteger(message.launchDeadlineAt) ||
        !Number.isSafeInteger(message.operationDeadlineAt) ||
        !Number.isSafeInteger(message.outerDeadlineAt) ||
        message.outerDeadlineAt - message.operationDeadlineAt !==
          completeCleanupBudgetMs() ||
        message.launchDeadlineAt <= Date.now() ||
        message.launchDeadlineAt > Date.now() + startupTimeoutMs ||
        message.launchDeadlineAt > message.operationDeadlineAt ||
        message.outerDeadlineAt <= Date.now()
      )
        throw new Error('Invalid worker launch authority.');
      if (platform === 'linux')
        linuxGroupAuthority = guardianOwnedLinuxGroup
          ? validateCurrentLinuxGroupMemberAuthority(message.authority, {
              role: 'playwright',
              metadataDirectory,
            })
          : validateCurrentLinuxGroupAuthority(message.authority, {
              role: 'application',
              metadataDirectory,
            });
      else if (message.authority !== null)
        throw new Error('Unexpected Windows launch authority.');
      outerDeadlineAt = message.outerDeadlineAt;
      launchAuthorized = true;
      phase('worker-launch-authority-received');
      void start(message.launchDeadlineAt).catch((error) =>
        fail(
          error?.code === 'owned-process-startup-timeout'
            ? 'application-startup-timeout'
            : 'worker-start-failed',
        ),
      );
    } catch {
      void fail('invalid-launch-authority');
    }
  } else if (
    message?.type === 'application-ownership-authority-ack' &&
    !ownershipAuthorityAcknowledged
  ) {
    ownershipAuthorityAcknowledged = true;
    acknowledgeOwnershipAuthority();
  } else if (message?.type === 'terminal-result-ack' && terminalResultSent) {
    terminalAcknowledged = true;
    acknowledgeTerminalResult();
  }
});
process.once('disconnect', () => {
  controllerDisconnected = true;
  void cleanup(
    terminalResultSent && terminalAcknowledged ? requestedExitCode : 1,
  );
});
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => void cleanup(1));
