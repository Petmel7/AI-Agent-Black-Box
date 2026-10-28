import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

import {
  assertSupportedE2ePlatform,
  captureDirectChildAuthority,
  emitE2ePhase,
  terminateDirectChild,
  waitForOwnedProcessExit,
} from './e2e-process-control.mjs';
import {
  cleanupOwnedProcessAuthority,
  createLinuxProcessGroupAuthority,
  exactOwnedTempDirectory,
  removeExactOwnedTempDirectory,
  retainOwnedProcessAuthority,
  validateCurrentLinuxGroupAuthority,
} from './e2e-owned-process.mjs';
import {
  boundedLifecycleWaitMs,
  E2E_LIFECYCLE_BOUNDS,
  completeCleanupBudgetMs,
  createLifecycleTimeline,
  parseInternalDuration,
  remainingLifecycleMs,
} from './e2e-lifecycle-timing.mjs';
import { startWindowsLayerJob } from './e2e-windows-layer-job.mjs';
import {
  isLinuxControllerGuardianChild,
  runLinuxControllerGuardian,
} from './e2e-linux-controller-guardian.mjs';
import {
  createParentResourcePlan,
  parentResourceEnvironment,
  parentResourcePlanFromEnvironment,
} from './e2e-resource-registry.mjs';

const ownerPath = fileURLToPath(
  new URL('./e2e-playwright-owner.mjs', import.meta.url),
);
const controllerPath = fileURLToPath(import.meta.url);
const INTERNAL_MARKER = 'bbx-e2e-controller-harness-v1';
const internalTest =
  process.env.BBX_E2E_INTERNAL_CONTROLLER_CONTEXT === INTERNAL_MARKER;
const protocolFault = internalTest
  ? process.env.BBX_E2E_INTERNAL_PROTOCOL_FAULT
  : undefined;
if (
  protocolFault !== undefined &&
  ![
    'duplicate-launch-authority',
    'unknown-after-launch-settlement',
    'unknown-pending-spawn',
    'unknown-pending-handoff',
    'unknown-before-ownership-ready',
    'unknown-running',
    'unknown-cleaning',
    'unknown-after-terminal-result',
  ].includes(protocolFault)
)
  throw new Error('Invalid internal Playwright protocol fault.');
const platform = assertSupportedE2ePlatform();
const configuredTimeout = process.env.BBX_E2E_INTERNAL_OPERATION_TIMEOUT_MS;
const operationDeadlineMs =
  internalTest && configuredTimeout !== undefined
    ? parseInternalDuration(configuredTimeout, {
        minimum: 100,
        maximum: 10_000,
        label: 'internal Playwright operation timeout',
      })
    : 233_000;
const delegatedLinuxCleanup =
  platform === 'linux' && isLinuxControllerGuardianChild();
if (platform === 'linux' && !process.connected && !delegatedLinuxCleanup) {
  const exitCode = await runLinuxControllerGuardian({
    controllerPath,
    controllerArguments: process.argv.slice(2),
    environment: process.env,
    operationDeadlineMs,
  });
  process.exit(exitCode);
}
const lifecycleTiming = createLifecycleTimeline(operationDeadlineMs);
const operationDeadlineAt = delegatedLinuxCleanup
  ? Number(process.env.BBX_E2E_OPERATION_DEADLINE_AT)
  : lifecycleTiming.operationDeadlineAt;
const outerDeadlineAt = delegatedLinuxCleanup
  ? Number(process.env.BBX_E2E_OUTER_DEADLINE_AT)
  : lifecycleTiming.outerDeadlineAt;
if (
  !Number.isSafeInteger(operationDeadlineAt) ||
  !Number.isSafeInteger(outerDeadlineAt) ||
  outerDeadlineAt - operationDeadlineAt !== completeCleanupBudgetMs() ||
  outerDeadlineAt <= Date.now()
)
  throw new Error('Invalid controller lifecycle authority.');

const requiredResources =
  platform === 'win32' ? ['playwright', 'playwright-owner'] : ['playwright'];
const resourcePlan = process.env.BBX_E2E_PARENT_RESOURCE_IDS
  ? parentResourcePlanFromEnvironment(requiredResources)
  : createParentResourcePlan(requiredResources);
const guardianLaunchAuthority = delegatedLinuxCleanup
  ? await new Promise((resolveAuthority, rejectAuthority) => {
      const timeout = setTimeout(
        () => rejectAuthority(new Error('Linux guardian authority timed out.')),
        Math.min(2_000, remainingLifecycleMs(operationDeadlineAt)),
      );
      process.once('message', (message) => {
        clearTimeout(timeout);
        try {
          if (
            message?.type !== 'guardian-launch-authority' ||
            message.version !== 1 ||
            message.role !== 'playwright' ||
            message.resourceId !== resourcePlan.get('playwright').resourceId ||
            message.operationDeadlineAt !== operationDeadlineAt ||
            message.outerDeadlineAt !== outerDeadlineAt
          )
            throw new Error('Invalid Linux guardian launch authority.');
          resolveAuthority(
            validateCurrentLinuxGroupAuthority(message.authority, {
              role: 'playwright',
              metadataDirectory:
                resourcePlan.get('playwright').metadataDirectory,
            }),
          );
        } catch (error) {
          rejectAuthority(error);
        }
      });
    })
  : undefined;

emitE2ePhase('controller-start', { pid: process.pid });
const ownerEnvironment = { ...process.env };
delete ownerEnvironment.PW_DISABLE_TS_ESM;
const groupOwnershipToken =
  platform === 'linux'
    ? delegatedLinuxCleanup
      ? process.env.BBX_E2E_OWNERSHIP_TOKEN
      : randomBytes(32).toString('base64url')
    : undefined;
if (
  platform === 'linux' &&
  (typeof groupOwnershipToken !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(groupOwnershipToken))
)
  throw new Error('Invalid controller ownership token.');
if (groupOwnershipToken !== undefined)
  ownerEnvironment.BBX_E2E_OWNERSHIP_TOKEN = groupOwnershipToken;
if (delegatedLinuxCleanup)
  ownerEnvironment.BBX_E2E_LINUX_GROUP_AUTHORITY = JSON.stringify(
    guardianLaunchAuthority,
  );
Object.assign(ownerEnvironment, parentResourceEnvironment(resourcePlan, {}));
if (protocolFault === 'unknown-pending-spawn')
  ownerEnvironment.BBX_E2E_INTERNAL_OWNER_LAUNCH_DELAY_MS = '750';
const owner = fork(ownerPath, process.argv.slice(2), {
  detached: !delegatedLinuxCleanup,
  env: ownerEnvironment,
  stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  windowsHide: true,
});
const directOwnerAuthority = captureDirectChildAuthority(owner);
const outputResource = resourcePlan.get('playwright');
const outputPath = outputResource.metadataDirectory;
exactOwnedTempDirectory(outputPath);
emitE2ePhase('playwright-owner-spawned', { pid: owner.pid ?? 0 });

let finishing = false;
let terminalResult = null;
let resultCount = 0;
let ownershipAuthority;
let ownershipAuthorityCount = 0;
let ownerLayerAuthority;
const registryAuthorityAcknowledgements = new Map();
let watchdogExpired = false;
let protocolFaultSent = false;

function injectProtocolFaultForPhase(phase) {
  if (protocolFaultSent || !owner.connected) return;
  const expectedPhase = new Map([
    ['unknown-after-launch-settlement', 'owner-launch-authority-received'],
    ['unknown-pending-spawn', 'playwright-spawn-pending'],
    ['unknown-pending-handoff', 'playwright-ownership-handoff-requested'],
    ['unknown-before-ownership-ready', 'playwright-ownership-handoff-complete'],
    ['unknown-running', 'playwright-spawn-requested'],
    ['unknown-cleaning', 'playwright-owner-cleanup-start'],
  ]).get(protocolFault);
  if (phase !== expectedPhase) return;
  protocolFaultSent = true;
  owner.send({ type: 'unknown-protocol-message', version: 1 });
  emitE2ePhase('controller-protocol-fault-injected');
}
const operationTimer = delegatedLinuxCleanup
  ? undefined
  : setTimeout(() => {
      emitE2ePhase('controller-operation-deadline');
      void finish(1, 'operation-timeout', true);
    }, remainingLifecycleMs(operationDeadlineAt));
operationTimer?.unref();
const watchdog = delegatedLinuxCleanup
  ? undefined
  : setTimeout(() => {
      watchdogExpired = true;
      emitE2ePhase('controller-watchdog-state', { expired: 1 });
      emitE2ePhase('outer-timeout', { 'exit-code': 1 });
      if (owner.connected)
        owner.send({
          type: 'shutdown',
          version: 1,
          cleanupDeadlineAt: outerDeadlineAt,
        });
      process.exit(1);
    }, remainingLifecycleMs(outerDeadlineAt));
watchdog?.unref();

async function retainAuthorityAboveController(
  authority,
  resource,
  layerProcessId,
  ownedPaths = [],
) {
  if (!process.connected) return;
  if (registryAuthorityAcknowledgements.has(resource))
    throw new Error('Duplicate upper E2E ownership authority.');
  let acknowledge;
  const acknowledgement = new Promise((resolveAcknowledgement) => {
    acknowledge = resolveAcknowledgement;
  });
  registryAuthorityAcknowledgements.set(resource, acknowledge);
  process.send?.({
    type: 'owned-resource-authority',
    version: 1,
    resource,
    resourceId: resourcePlan.get(resource).resourceId,
    layerProcessId,
    ownedPaths,
    authority,
  });
  emitE2ePhase('controller-upper-authority-requested');
  const accepted = await Promise.race([
    acknowledgement.then(() => true),
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
  if (!accepted)
    throw new Error('Upper E2E ownership authority was not acknowledged.');
}

async function authorizeOwnerLaunch() {
  if (platform === 'linux') {
    ownershipAuthority = delegatedLinuxCleanup
      ? guardianLaunchAuthority
      : createLinuxProcessGroupAuthority(owner, {
          platform,
          role: 'playwright',
          metadataDirectory: outputPath,
          metadataDirectoryOwned: true,
          ownershipToken: groupOwnershipToken,
        });
    ownershipAuthorityCount = 1;
    if (!delegatedLinuxCleanup)
      await retainAuthorityAboveController(
        ownershipAuthority,
        'playwright',
        owner.pid,
      );
    emitE2ePhase('controller-ownership-authority-retained');
  } else {
    const layerJob = await startWindowsLayerJob({
      targetChild: owner,
      role: 'playwright-owner',
      metadataDirectory: resourcePlan.get('playwright-owner').metadataDirectory,
      phase: emitE2ePhase,
      startupDeadline: operationDeadlineAt,
    });
    ownerLayerAuthority = layerJob.authority;
    await retainAuthorityAboveController(
      ownerLayerAuthority,
      'playwright-owner',
      owner.pid,
      [outputPath],
    );
    emitE2ePhase('controller-ownership-authority-retained');
  }
  if (!owner.connected)
    throw new Error('Owner IPC disconnected before launch authorization.');
  owner.send({
    type: 'launch-authority',
    version: 1,
    authority: ownershipAuthority ?? null,
    operationDeadlineAt,
    outerDeadlineAt,
  });
  if (protocolFault === 'duplicate-launch-authority')
    owner.send({
      type: 'launch-authority',
      version: 1,
      authority: ownershipAuthority ?? null,
      operationDeadlineAt,
      outerDeadlineAt,
    });
  emitE2ePhase('owner-launch-authority-sent');
}

async function finish(requestedExitCode, phase, terminate) {
  if (finishing) return;
  finishing = true;
  if (operationTimer !== undefined) clearTimeout(operationTimer);
  if (terminate && owner.connected && !delegatedLinuxCleanup)
    owner.send({
      type: 'shutdown',
      version: 1,
      cleanupDeadlineAt: outerDeadlineAt,
    });
  if (terminate) {
    try {
      await waitForOwnedProcessExit(
        owner,
        boundedLifecycleWaitMs(
          outerDeadlineAt,
          completeCleanupBudgetMs() -
            E2E_LIFECYCLE_BOUNDS.controllerReportingMarginMs,
        ),
      );
    } catch {
      try {
        if (delegatedLinuxCleanup) throw new Error('Upper cleanup active.');
        await terminateDirectChild(directOwnerAuthority, {
          deadlineAt: outerDeadlineAt,
        });
      } catch {
        requestedExitCode = 1;
      }
    }
  }
  let cleanupSucceeded = true;
  let cleanupFailureStage = 0;
  if (ownershipAuthority !== undefined && !delegatedLinuxCleanup) {
    try {
      const groupCleanup = await cleanupOwnedProcessAuthority(
        ownershipAuthority,
        {
          deadlineAt: outerDeadlineAt,
        },
      );
      if (groupCleanup.forced) emitE2ePhase('controller-forced-group-cleanup');
    } catch {
      cleanupSucceeded = false;
      cleanupFailureStage = 1;
    }
  } else if (!delegatedLinuxCleanup) {
    cleanupSucceeded = false;
    cleanupFailureStage = 2;
  }
  if (ownerLayerAuthority !== undefined && !delegatedLinuxCleanup) {
    try {
      await cleanupOwnedProcessAuthority(ownerLayerAuthority, {
        deadlineAt: outerDeadlineAt,
      });
    } catch {
      cleanupSucceeded = false;
      cleanupFailureStage = 3;
    }
  }
  if (internalTest) {
    const fixturePort = Number(process.env.BBX_E2E_INTERNAL_CONTROLLER_PORT);
    if (
      !Number.isSafeInteger(fixturePort) ||
      !(await portIsFree(fixturePort))
    ) {
      cleanupSucceeded = false;
      cleanupFailureStage = 4;
    }
  }
  if (cleanupSucceeded && !delegatedLinuxCleanup)
    try {
      await removeExactOwnedTempDirectory(outputPath);
      await lstat(outputPath);
      cleanupSucceeded = false;
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        cleanupSucceeded = false;
        cleanupFailureStage = 5;
      }
    }
  if (!cleanupSucceeded)
    emitE2ePhase('controller-cleanup-failed', {
      'failure-stage': cleanupFailureStage,
    });
  const finalExitCode =
    cleanupSucceeded && terminate && requestedExitCode === 0
      ? owner.exitCode === 0 &&
        owner.signalCode === null &&
        resultCount === 1 &&
        terminalResult !== null &&
        terminalResult.cleanupSucceeded
        ? terminalResult.exitCode
        : 1
      : cleanupSucceeded
        ? requestedExitCode
        : 1;
  emitE2ePhase('controller-watchdog-state', {
    expired: watchdogExpired ? 1 : 0,
  });
  emitE2ePhase(phase, { 'exit-code': finalExitCode });
  if (watchdog !== undefined) clearTimeout(watchdog);
  process.exit(finalExitCode);
}

function portIsFree(port) {
  return new Promise((resolveFree) => {
    const probe = createServer();
    probe.once('error', () => resolveFree(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolveFree(true)));
  });
}

owner.on('message', (message) => {
  if (message?.type === 'phase') {
    emitE2ePhase(message.name, message.details);
    injectProtocolFaultForPhase(message.name);
  }
  if (message?.type === 'ownership-authority') {
    if (platform === 'linux') {
      void finish(1, 'controller-ownership-authority-invalid', true);
      return;
    }
    ownershipAuthorityCount += 1;
    void (async () => {
      try {
        if (ownershipAuthorityCount !== 1 || message.version !== 1)
          throw new Error('Duplicate Playwright ownership authority.');
        ownershipAuthority = retainOwnedProcessAuthority(
          ownershipAuthority,
          message.authority,
          {
            role: 'playwright',
            metadataDirectory: outputPath,
          },
        );
        await retainAuthorityAboveController(
          ownershipAuthority,
          'playwright',
          owner.pid,
          [outputPath],
        );
        if (owner.connected)
          owner.send({ type: 'ownership-authority-ack', version: 1 });
        emitE2ePhase('controller-ownership-authority-retained');
      } catch {
        void finish(1, 'controller-ownership-authority-invalid', true);
      }
    })();
  } else if (message?.type === 'result') {
    resultCount += 1;
    const valid =
      resultCount === 1 &&
      message.version === 1 &&
      Number.isInteger(message.exitCode) &&
      message.exitCode >= 0 &&
      message.exitCode <= 255 &&
      typeof message.cleanupSucceeded === 'boolean' &&
      Number.isInteger(message.cleanupErrorCode) &&
      message.cleanupErrorCode >= 0 &&
      message.cleanupErrorCode <= 255 &&
      Number.isInteger(message.failureCount) &&
      message.failureCount >= 0 &&
      message.failureCount <= 8 &&
      (message.primaryFailureCode === null ||
        (typeof message.primaryFailureCode === 'string' &&
          /^[a-z0-9-]{1,64}$/.test(message.primaryFailureCode))) &&
      (message.secondaryFailureCode === null ||
        (typeof message.secondaryFailureCode === 'string' &&
          /^[a-z0-9-]{1,64}$/.test(message.secondaryFailureCode))) &&
      (message.failureCount === 0
        ? message.primaryFailureCode === null &&
          message.secondaryFailureCode === null
        : message.primaryFailureCode !== null) &&
      (message.cleanupSucceeded
        ? message.cleanupErrorCode === 0
        : message.cleanupErrorCode !== 0);
    if (!valid) {
      terminalResult = null;
      void finish(1, 'controller-terminal-result-invalid', true);
      return;
    }
    terminalResult = message;
    emitE2ePhase('controller-terminal-result-received', {
      'exit-code': message.exitCode,
      'cleanup-error-code': message.cleanupErrorCode,
      'failure-count': message.failureCount,
    });
    if (
      protocolFault === 'unknown-after-terminal-result' &&
      !protocolFaultSent &&
      owner.connected
    ) {
      protocolFaultSent = true;
      owner.send({ type: 'unknown-protocol-message', version: 1 });
      emitE2ePhase('controller-protocol-fault-injected');
      terminalResult = null;
      void finish(1, 'controller-terminal-protocol-invalid', true);
    } else if (owner.connected) owner.send({ type: 'result-ack', version: 1 });
  }
});
owner.once('error', () => void finish(1, 'playwright-owner-failed', true));
owner.once('exit', (code, signal) => {
  emitE2ePhase('playwright-owner-exit-observed', {
    'exit-code': code ?? 0,
    signaled: signal === null ? 0 : 1,
    'result-count': resultCount,
  });
  if (!finishing) {
    const validTerminalResult =
      signal === null &&
      resultCount === 1 &&
      terminalResult !== null &&
      terminalResult.cleanupSucceeded &&
      code === terminalResult.exitCode;
    void finish(
      validTerminalResult ? terminalResult.exitCode : 1,
      'playwright-owner-exit',
      false,
    );
  }
});
owner.once('disconnect', () => {
  emitE2ePhase('controller-owner-ipc-disconnect', {
    'terminal-result-received': terminalResult === null ? 0 : 1,
  });
  if (terminalResult === null && !finishing)
    void finish(1, 'controller-owner-ipc-lost', true);
});
process.on('message', (message) => {
  if (message?.type === 'owned-resource-authority-ack') {
    if (
      message.version !== 1 ||
      message.resourceId !== resourcePlan.get(message.resource)?.resourceId
    ) {
      void finish(1, 'upper-authority-ack-invalid', true);
      return;
    }
    const acknowledge = registryAuthorityAcknowledgements.get(message.resource);
    if (acknowledge === undefined) {
      void finish(1, 'upper-authority-ack-invalid', true);
      return;
    }
    registryAuthorityAcknowledgements.delete(message.resource);
    acknowledge();
    return;
  }
  if (message?.type === 'upper-cleanup') {
    const valid =
      delegatedLinuxCleanup &&
      message.version === 1 &&
      Number.isInteger(message.exitCode) &&
      [0, 1, 130, 143].includes(message.exitCode) &&
      message.finalDeadlineAt === outerDeadlineAt;
    void finish(
      valid ? message.exitCode : 1,
      valid ? 'controller-upper-cleanup' : 'controller-protocol-invalid',
      true,
    );
    return;
  }
  if (message?.type === 'shutdown')
    void finish(
      message.version === 1 ? 0 : 1,
      message.version === 1
        ? 'controller-shutdown-requested'
        : 'controller-protocol-invalid',
      true,
    );
  if (
    internalTest &&
    message?.type === 'simulate-signal' &&
    message.version === 1 &&
    (message.signal === 'SIGINT' || message.signal === 'SIGTERM')
  )
    void finish(
      message.signal === 'SIGINT' ? 130 : 143,
      'controller-signal',
      true,
    );
});
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    if (delegatedLinuxCleanup) process.exit(signal === 'SIGINT' ? 130 : 143);
    else
      void finish(signal === 'SIGINT' ? 130 : 143, 'controller-signal', true);
  });

void authorizeOwnerLaunch().catch(() =>
  finish(1, 'owner-launch-authority-failed', true),
);
