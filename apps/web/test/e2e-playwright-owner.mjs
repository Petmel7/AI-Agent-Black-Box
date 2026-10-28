import { lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  cleanupOwnedProcess,
  exportOwnedProcessAuthority,
  removeExactOwnedTempDirectory,
  spawnOwnedProcess,
  validateCurrentLinuxGroupMemberAuthority,
} from './e2e-owned-process.mjs';
import {
  boundedLifecycleWaitMs,
  completeCleanupBudgetMs,
  E2E_LIFECYCLE_BOUNDS,
  remainingLifecycleMs,
} from './e2e-lifecycle-timing.mjs';
import { assertSupportedE2ePlatform } from './e2e-process-control.mjs';
import { createPlaywrightProtocol } from './e2e-playwright-protocol.mjs';
import spawnGuard from './e2e-playwright-spawn-guard.cjs';
import { parentResourcePlanFromEnvironment } from './e2e-resource-registry.mjs';

const INTERNAL_MARKER = 'bbx-e2e-controller-harness-v1';
const playwrightCli = fileURLToPath(
  new URL('../node_modules/@playwright/test/cli.js', import.meta.url),
);
const fixturePath = fileURLToPath(
  new URL('./e2e-controller-fixture.mjs', import.meta.url),
);
const standardTopologyConfig = fileURLToPath(
  new URL('./e2e-standard-topology.playwright.config.mjs', import.meta.url),
);
const guardedPlaywrightCli = fileURLToPath(
  new URL('./e2e-playwright-cli-guard.mjs', import.meta.url),
);
const webRoot = fileURLToPath(new URL('..', import.meta.url));
const resourcePlan = parentResourcePlanFromEnvironment([
  'playwright',
  ...(process.platform === 'win32' ? ['playwright-owner'] : []),
]);
const outputPath = resourcePlan.get('playwright').metadataDirectory;
const internalTest =
  process.env.BBX_E2E_INTERNAL_CONTROLLER_CONTEXT === INTERNAL_MARKER;
const internalMode = process.env.BBX_E2E_INTERNAL_CONTROLLER_MODE ?? 'hang';
const internalLaunchDelay = process.env.BBX_E2E_INTERNAL_OWNER_LAUNCH_DELAY_MS;
const internalSpawnFailure = process.env.BBX_E2E_INTERNAL_OWNER_SPAWN_FAILURE;
const platform = assertSupportedE2ePlatform();
const externalLinuxGroupCleanup =
  platform === 'linux' &&
  process.env.BBX_E2E_LINUX_CONTROLLER_CHILD ===
    'bbx-e2e-linux-controller-child-v1';
if (
  internalLaunchDelay !== undefined &&
  (!internalTest || !/^(?:[1-9][0-9]{0,3})$/.test(internalLaunchDelay))
)
  throw new Error('Invalid internal owner launch delay.');
if (
  internalSpawnFailure !== undefined &&
  (!internalTest || internalSpawnFailure !== 'injected')
)
  throw new Error('Invalid internal owner spawn failure.');
const launchDelayMs = internalLaunchDelay ? Number(internalLaunchDelay) : 0;

function insideOwnedOutput(path) {
  return path === outputPath;
}

if (!insideOwnedOutput(outputPath))
  throw new Error('Invalid process-owned Playwright output path.');
try {
  await lstat(outputPath);
  throw new Error('Process-owned Playwright output path already exists.');
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

function send(message) {
  if (process.connected) process.send?.(message);
}

function phase(name, details = {}) {
  send({ type: 'phase', name, details });
}

let cleanupPromise;
let requestedExitCode = 0;
let expectedDisconnect = false;
let pendingShutdown = false;
let ownershipReady = false;
let ownedProcess;
let ownedProcessPromise;
let spawnPending = false;
let operationDeadlineAt;
let outerDeadlineAt;
let operationTimer;
const protocol = createPlaywrightProtocol();
let resolveLaunchAuthority;
let rejectLaunchAuthority;
const launchAuthorityPromise = new Promise((resolvePromise, rejectPromise) => {
  resolveLaunchAuthority = resolvePromise;
  rejectLaunchAuthority = rejectPromise;
});
let resolveAcknowledgement;
let resolveOwnershipAuthorityAcknowledgement;
const acknowledgement = new Promise((resolvePromise) => {
  resolveAcknowledgement = resolvePromise;
});
const ownershipAuthorityAcknowledgement = new Promise((resolvePromise) => {
  resolveOwnershipAuthorityAcknowledgement = resolvePromise;
});
let protocolFailure;
const failureCodes = [];

function recordFailure(code) {
  if (!/^[a-z0-9-]{1,64}$/.test(code))
    throw new Error('Invalid owner failure classification.');
  if (!failureCodes.includes(code) && failureCodes.length < 8)
    failureCodes.push(code);
}

function failProtocol(error) {
  const firstFailure = protocolFailure === undefined;
  const transition = protocol.fail(
    typeof error?.code === 'string'
      ? error.code
      : 'playwright-protocol-message',
  );
  requestedExitCode = 1;
  pendingShutdown = true;
  protocolFailure ??= error ?? transition.error;
  recordFailure(
    typeof protocolFailure?.code === 'string'
      ? protocolFailure.code
      : 'playwright-protocol-message',
  );
  if (firstFailure) phase('owner-protocol-failed', { 'error-code': 1 });
  rejectLaunchAuthority(protocolFailure);
  void cleanup(1);
}
process.on('message', (message) => {
  const type = message?.type;
  const transition = protocol.receive(type, message?.version);
  if (!transition.accepted) {
    failProtocol(transition.error);
    return;
  }
  if (type === 'shutdown') {
    if (
      !Number.isSafeInteger(message.cleanupDeadlineAt) ||
      message.cleanupDeadlineAt !== outerDeadlineAt
    ) {
      failProtocol(new Error('Invalid owner cleanup deadline.'));
      return;
    }
    pendingShutdown = true;
    if (ownershipReady) void cleanup(130);
  } else if (type === 'launch-authority') {
    try {
      if (
        !Number.isSafeInteger(message.operationDeadlineAt) ||
        !Number.isSafeInteger(message.outerDeadlineAt) ||
        message.outerDeadlineAt - message.operationDeadlineAt !==
          completeCleanupBudgetMs() ||
        message.outerDeadlineAt <= Date.now()
      )
        throw new Error('Invalid owner lifecycle deadline.');
      operationDeadlineAt = message.operationDeadlineAt;
      outerDeadlineAt = message.outerDeadlineAt;
      const authority =
        platform === 'linux'
          ? validateCurrentLinuxGroupMemberAuthority(message.authority, {
              role: 'playwright',
              metadataDirectory: outputPath,
            })
          : message.authority === null
            ? null
            : (() => {
                throw new Error('Unexpected Windows launch authority.');
              })();
      phase('owner-launch-authority-received');
      resolveLaunchAuthority(authority);
    } catch (error) {
      failProtocol(error);
    }
  } else if (type === 'ownership-authority-ack') {
    resolveOwnershipAuthorityAcknowledgement();
  } else if (type === 'result-ack') {
    phase('owner-terminal-result-acknowledged');
    resolveAcknowledgement();
  }
});

const linuxGroupAuthority = await launchAuthorityPromise.catch(() => undefined);

if (protocolFailure !== undefined) await cleanup(1);

const operationDelayMs = remainingLifecycleMs(operationDeadlineAt);
if (operationDelayMs < 1) {
  pendingShutdown = true;
  requestedExitCode = 1;
} else {
  operationTimer = setTimeout(() => {
    phase('owner-operation-deadline');
    pendingShutdown = true;
    void cleanup(1);
  }, operationDelayMs);
  operationTimer.unref();
}

let childEnvironment = {
  ...process.env,
  BBX_E2E_OWNED_OUTPUT_DIR: outputPath,
  ...(internalTest && internalMode === 'signal' && process.platform !== 'win32'
    ? { BBX_E2E_INTERNAL_CONTROLLER_MODE: 'hang' }
    : {}),
  PW_DISABLE_TS_ESM: '1',
};
if (externalLinuxGroupCleanup)
  childEnvironment = spawnGuard.createGuardedEnvironment(
    childEnvironment,
    linuxGroupAuthority,
  );
const playwrightEntrypoint =
  externalLinuxGroupCleanup && process.platform === 'linux'
    ? [guardedPlaywrightCli, playwrightCli]
    : [playwrightCli];
const arguments_ = internalTest
  ? internalMode === 'actual-topology'
    ? [
        ...playwrightEntrypoint,
        'test',
        `--config=${standardTopologyConfig}`,
        `--output=${outputPath}`,
      ]
    : [fixturePath]
  : [
      ...playwrightEntrypoint,
      'test',
      '--config=playwright.config.mjs',
      `--output=${outputPath}`,
      ...process.argv.slice(2),
    ];
if (protocol.snapshot().state !== 'launch-authorized') await cleanup(1);
spawnPending = true;
phase('playwright-spawn-pending');
ownedProcessPromise =
  internalSpawnFailure === 'injected'
    ? new Promise((_, rejectSpawn) =>
        setTimeout(
          () =>
            rejectSpawn(
              Object.assign(
                new Error('Injected owned-process spawn failure.'),
                {
                  code: 'owned-process-spawn-failed',
                },
              ),
            ),
          launchDelayMs || 250,
        ),
      )
    : spawnOwnedProcess({
        executable: process.execPath,
        arguments: arguments_,
        workingDirectory: webRoot,
        environment: childEnvironment,
        metadataDirectory: outputPath,
        metadataDirectoryOwned: false,
        role: 'playwright',
        phase,
        linuxGroupAuthority,
        startupDeadline: operationDeadlineAt,
        launchDelayMs,
      });
try {
  ownedProcess = await ownedProcessPromise;
} catch (error) {
  spawnPending = false;
  recordFailure('owned-process-spawn-failed');
  if (protocolFailure === undefined) {
    requestedExitCode = 1;
    pendingShutdown = true;
  }
  await cleanup(1);
  throw error;
}
spawnPending = false;
if (protocolFailure !== undefined || pendingShutdown) await cleanup(1);
const child = ownedProcess.child;
if (platform === 'win32') {
  send({
    type: 'ownership-authority',
    version: 1,
    authority: exportOwnedProcessAuthority(ownedProcess),
  });
  phase('playwright-ownership-handoff-requested');
  const ownershipAuthorityAccepted = await Promise.race([
    ownershipAuthorityAcknowledgement.then(() => true),
    new Promise((resolveTimeout) =>
      setTimeout(
        () => resolveTimeout(false),
        boundedLifecycleWaitMs(
          operationDeadlineAt,
          E2E_LIFECYCLE_BOUNDS.terminalAcknowledgementMs,
        ),
      ),
    ),
  ]);
  if (!ownershipAuthorityAccepted) {
    requestedExitCode = 1;
    await cleanupOwnedProcess(ownedProcess, {
      deadlineAt: outerDeadlineAt,
    }).catch(() => undefined);
    if (insideOwnedOutput(outputPath))
      await removeExactOwnedTempDirectory(outputPath).catch(() => undefined);
    process.exit(1);
  }
} else {
  const retained = protocol.transition(
    'launch-authorized',
    'authority-retained',
  );
  if (!retained.accepted) await cleanup(1);
}
phase('playwright-ownership-handoff-complete');
ownershipReady = true;
const running = protocol.transition('authority-retained', 'running');
if (!running.accepted) await cleanup(1);
phase('playwright-spawn-requested', { pid: child.pid ?? 0 });
if (process.platform !== 'win32' && internalTest && internalMode === 'signal')
  child.kill('SIGTERM');

async function outputIsAbsent() {
  try {
    await lstat(outputPath);
    return false;
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
}

async function sendTerminalResult(result) {
  const sent = protocol.transition('cleaning', 'terminal-sent');
  if (!sent.accepted) throw sent.error;
  await new Promise((resolvePromise, reject) => {
    if (!process.connected) {
      reject(new Error('Controller IPC disconnected before terminal result.'));
      return;
    }
    process.send?.(result, (error) =>
      error ? reject(error) : resolvePromise(),
    );
  });
  phase('owner-terminal-result-sent', { 'exit-code': result.exitCode });
  await Promise.race([
    acknowledgement,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error('Controller did not acknowledge result.')),
        boundedLifecycleWaitMs(
          outerDeadlineAt,
          E2E_LIFECYCLE_BOUNDS.terminalAcknowledgementMs,
        ),
      ),
    ),
  ]);
}

async function cleanup(exitCode = requestedExitCode) {
  requestedExitCode = Math.max(requestedExitCode, exitCode);
  if (cleanupPromise !== undefined) return cleanupPromise;
  const currentState = protocol.snapshot().state;
  if (currentState !== 'cleaning') {
    const started = protocol.transition(
      [
        'awaiting-authority',
        'launch-authorized',
        'authority-retained',
        'running',
      ],
      'cleaning',
    );
    if (!started.accepted) requestedExitCode = 1;
  }
  if (operationTimer !== undefined) clearTimeout(operationTimer);
  cleanupPromise = Promise.resolve().then(async () => {
    phase('playwright-owner-cleanup-start', { pid: process.pid });
    const cleanupFailures = [];
    let processAlreadyAbsent = false;
    if (spawnPending && ownedProcessPromise !== undefined)
      try {
        ownedProcess ??= await ownedProcessPromise;
      } catch (error) {
        if (protocolFailure === undefined && !pendingShutdown)
          cleanupFailures.push(error);
      }
    if (ownedProcess !== undefined && !externalLinuxGroupCleanup) {
      try {
        const processCleanup = await cleanupOwnedProcess(ownedProcess, {
          deadlineAt: outerDeadlineAt,
        });
        processAlreadyAbsent = processCleanup.alreadyAbsent;
        if (processCleanup.forced) phase('playwright-owner-forced-cleanup');
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    try {
      if (!insideOwnedOutput(outputPath))
        throw new Error('Refusing unsafe Playwright output cleanup.');
      if (
        internalTest &&
        process.env.BBX_E2E_INTERNAL_CLEANUP_FAILURE === 'injected'
      )
        throw new Error('Injected owned cleanup failure.');
      if (platform === 'win32') await removeExactOwnedTempDirectory(outputPath);
    } catch (error) {
      cleanupFailures.push(error);
      if (insideOwnedOutput(outputPath))
        try {
          await removeExactOwnedTempDirectory(outputPath);
        } catch (fallbackError) {
          cleanupFailures.push(fallbackError);
        }
    }
    try {
      if (platform === 'win32' && !(await outputIsAbsent()))
        throw new Error('Owned Playwright output remained after cleanup.');
    } catch (error) {
      cleanupFailures.push(error);
    }
    const cleanupErrorCode = cleanupFailures.length === 0 ? 0 : 1;
    if (cleanupErrorCode !== 0) {
      requestedExitCode = 1;
      phase('playwright-owner-cleanup-failed', {
        'error-code': cleanupErrorCode,
        'failure-count': cleanupFailures.length,
      });
    }
    phase('playwright-owner-cleanup-complete', {
      pid: process.pid,
      'cleanup-error-code': cleanupErrorCode,
      'process-already-absent': processAlreadyAbsent ? 1 : 0,
    });
    try {
      await sendTerminalResult({
        type: 'result',
        version: 1,
        exitCode: protocolFailure === undefined ? requestedExitCode : 1,
        cleanupSucceeded: cleanupErrorCode === 0,
        cleanupErrorCode,
        failureCount: failureCodes.length,
        primaryFailureCode: failureCodes[0] ?? null,
        secondaryFailureCode: failureCodes[1] ?? null,
      });
    } catch {
      requestedExitCode = 1;
    }
    expectedDisconnect = true;
    if (process.connected) process.disconnect();
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    const closed = protocol.transition('terminal-acknowledged', 'closed');
    if (!closed.accepted) requestedExitCode = 1;
    process.exit(requestedExitCode);
  });
  return cleanupPromise;
}

void ownedProcess.outcome.then((outcome) => {
  const code = outcome.type === 'exit' ? outcome.code : null;
  const signal = outcome.type === 'exit' ? outcome.signal : null;
  const expectedWindowsSignal =
    process.platform === 'win32' &&
    internalTest &&
    internalMode === 'signal' &&
    code !== 0;
  phase('playwright-child-exit', {
    'exit-code': expectedWindowsSignal ? 0 : (code ?? 0),
    signaled: expectedWindowsSignal || signal !== null ? 1 : 0,
  });
  void cleanup(
    expectedWindowsSignal ? 130 : (code ?? (signal === null ? 1 : 130)),
  );
});
if (pendingShutdown) void cleanup(130);
process.once('disconnect', () => {
  phase('owner-ipc-disconnect', { expected: expectedDisconnect ? 1 : 0 });
  if (protocol.snapshot().state !== 'terminal-acknowledged') void cleanup(130);
});
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    if (externalLinuxGroupCleanup)
      process.exit(signal === 'SIGINT' ? 130 : 143);
    else void cleanup(130);
  });
