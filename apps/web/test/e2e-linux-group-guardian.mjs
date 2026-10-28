import { fork } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

import {
  cleanupOwnedProcessAuthority,
  createLinuxProcessGroupAuthority,
  finalizeOwnedProcessAuthorityAfterAbsence,
} from './e2e-owned-process.mjs';
import {
  completeCleanupBudgetMs,
  E2E_LIFECYCLE_BOUNDS,
  remainingLifecycleMs,
} from './e2e-lifecycle-timing.mjs';
import { waitForFinalConvergence } from './e2e-linux-guardian-state.mjs';
import {
  captureDirectChildAuthority,
  emitE2ePhase,
  inspectLinuxOwnedGroup,
} from './e2e-process-control.mjs';
import {
  parentResourceEnvironment,
  parentResourcePlanFromEnvironment,
} from './e2e-resource-registry.mjs';

const CHILD_MARKER = 'bbx-e2e-linux-controller-child-v1';
const expectedControllerPath = fileURLToPath(
  new URL('./e2e-controller.mjs', import.meta.url),
);
const plan = parentResourcePlanFromEnvironment(['playwright']);
const resource = plan.get('playwright');
const bootstrapPause = process.env.BBX_E2E_INTERNAL_GUARDIAN_BOOTSTRAP_PAUSE;
if (
  bootstrapPause !== undefined &&
  (process.env.BBX_E2E_INTERNAL_CONTROLLER_CONTEXT !==
    'bbx-e2e-controller-harness-v1' ||
    ![
      'before-configuration',
      'during-controller-creation',
      'before-armed-ack',
      'after-terminal-result',
    ].includes(bootstrapPause))
)
  throw new Error('Invalid Linux guardian bootstrap pause.');

let authority;
let controller;
let operationDeadlineAt;
let outerDeadlineAt;
let listenerPort;
let cleanupPromise;
let operationTimer;
let armTimer;
let terminalSent = false;
let terminalAcknowledged = false;
let terminalExitCode = 1;
let launchAuthorized = false;
let controllerExitCode = null;
let controllerSignal = null;

function portIsFree(port) {
  return new Promise((resolveFree) => {
    const probe = createServer();
    probe.once('error', () => resolveFree(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolveFree(true)));
  });
}

function sendTerminal(result) {
  if (terminalSent) return false;
  terminalSent = true;
  if (process.connected) process.send?.(result);
  emitE2ePhase('linux-group-guardian-terminal-result-sent');
  return true;
}

function exitAfterTerminal(exitCode) {
  if (terminalAcknowledged || !process.connected) process.exit(exitCode);
  const remainingMs = remainingLifecycleMs(outerDeadlineAt);
  if (remainingMs < 1) process.exit(exitCode);
  const timer = setTimeout(
    () => process.exit(exitCode === 0 ? 1 : exitCode),
    Math.min(remainingMs, E2E_LIFECYCLE_BOUNDS.terminalAcknowledgementMs),
  );
  timer.unref();
}

function validatedLaunchConfiguration(message) {
  if (
    message?.type !== 'launch-configuration' ||
    message.version !== 1 ||
    message.resourceId !== resource.resourceId ||
    message.role !== 'playwright' ||
    message.controllerPath !== expectedControllerPath ||
    !Array.isArray(message.controllerArguments) ||
    message.controllerArguments.length > 128 ||
    message.controllerArguments.some(
      (argument) =>
        typeof argument !== 'string' ||
        argument.length > 32_768 ||
        argument.includes('\0'),
    ) ||
    typeof message.ownershipToken !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(message.ownershipToken) ||
    !Number.isSafeInteger(message.operationDeadlineAt) ||
    !Number.isSafeInteger(message.outerDeadlineAt) ||
    message.outerDeadlineAt - message.operationDeadlineAt !==
      completeCleanupBudgetMs() ||
    message.operationDeadlineAt <= Date.now() ||
    !Number.isSafeInteger(message.listenerPort) ||
    message.listenerPort < 1024 ||
    message.listenerPort > 65_535
  )
    throw new Error('Invalid Linux group guardian configuration.');
  return Object.freeze({
    controllerArguments: [...message.controllerArguments],
    ownershipToken: message.ownershipToken,
    operationDeadlineAt: message.operationDeadlineAt,
    outerDeadlineAt: message.outerDeadlineAt,
    listenerPort: message.listenerPort,
  });
}

async function beginCleanup(reasonCode) {
  if (cleanupPromise !== undefined) return cleanupPromise;
  if (authority === undefined && outerDeadlineAt === undefined) {
    process.exit(1);
    return;
  }
  cleanupPromise = Promise.resolve().then(async () => {
    if (armTimer !== undefined) clearTimeout(armTimer);
    if (operationTimer !== undefined) clearTimeout(operationTimer);
    emitE2ePhase('linux-group-guardian-cleanup-start', {
      'reason-code': reasonCode,
    });
    if (controller?.connected)
      controller.send({
        type: 'upper-cleanup',
        version: 1,
        exitCode: reasonCode === 0 ? 0 : 1,
        finalDeadlineAt: outerDeadlineAt,
      });

    let cleanupSucceeded = authority === undefined;
    let eventualConvergence = false;
    let failureCount = 0;
    if (authority !== undefined) {
      try {
        const cleanupResult = await cleanupOwnedProcessAuthority(authority, {
          deadlineAt: outerDeadlineAt,
          beforeMetadataCleanup: async () => {
            if (!(await portIsFree(listenerPort)))
              throw new Error('Owned Linux listener remained after cleanup.');
          },
        });
        if (cleanupResult.forced)
          emitE2ePhase('linux-group-guardian-forced-cleanup');
        cleanupSucceeded = true;
      } catch {
        failureCount += 1;
        const convergence = await waitForFinalConvergence({
          finalDeadlineAt: outerDeadlineAt,
          inspectGroup: () =>
            inspectLinuxOwnedGroup(authority.ownershipIdentity),
          listenerIsFree: () => portIsFree(listenerPort),
          finalizeAbsence: () =>
            finalizeOwnedProcessAuthorityAfterAbsence(authority),
        });
        failureCount += convergence.verificationFailures;
        eventualConvergence = convergence.converged;
        if (eventualConvergence)
          emitE2ePhase('linux-group-guardian-eventual-convergence');
      }
    }

    const controllerSucceeded =
      reasonCode === 0 && controllerSignal === null && controllerExitCode === 0;
    const exitCode =
      cleanupSucceeded && controllerSucceeded && failureCount === 0 ? 0 : 1;
    terminalExitCode = exitCode;
    sendTerminal({
      type: 'guardian-result',
      version: 1,
      exitCode,
      cleanupSucceeded: cleanupSucceeded && failureCount === 0,
      cleanupErrorCode: cleanupSucceeded && failureCount === 0 ? 0 : 1,
      failureCount,
      reasonCode,
      eventualConvergence,
    });
    emitE2ePhase('linux-group-guardian-cleanup-complete', {
      'cleanup-error-code': cleanupSucceeded && failureCount === 0 ? 0 : 1,
      'failure-count': failureCount,
    });
    exitAfterTerminal(exitCode);
  });
  return cleanupPromise;
}

async function createController(configuration) {
  emitE2ePhase('linux-group-guardian-controller-creation-start');
  if (bootstrapPause === 'during-controller-creation')
    await new Promise((resolvePause) => setTimeout(resolvePause, 5_000));
  if (cleanupPromise !== undefined || !process.connected) return false;
  const controllerEnvironment = parentResourceEnvironment(plan, {
    ...process.env,
    BBX_E2E_LINUX_CONTROLLER_CHILD: CHILD_MARKER,
    BBX_E2E_OPERATION_DEADLINE_AT: String(configuration.operationDeadlineAt),
    BBX_E2E_OUTER_DEADLINE_AT: String(configuration.outerDeadlineAt),
    BBX_E2E_OWNERSHIP_TOKEN: configuration.ownershipToken,
  });
  controller = fork(expectedControllerPath, configuration.controllerArguments, {
    detached: true,
    env: controllerEnvironment,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    windowsHide: true,
  });
  captureDirectChildAuthority(controller);
  authority = createLinuxProcessGroupAuthority(controller, {
    platform: 'linux',
    role: 'playwright',
    metadataDirectory: resource.metadataDirectory,
    metadataDirectoryOwned: true,
    ownershipToken: configuration.ownershipToken,
  });
  controller.once('error', () => void beginCleanup(5));
  controller.once('exit', (code, signal) => {
    controllerExitCode = code;
    controllerSignal = signal;
    if (cleanupPromise === undefined)
      void beginCleanup(signal === null && code === 0 ? 0 : 5);
  });
  return true;
}

process.on('message', async (message) => {
  if (message?.type === 'launch-configuration') {
    if (controller !== undefined || cleanupPromise !== undefined) {
      void beginCleanup(4);
      return;
    }
    try {
      const configuration = validatedLaunchConfiguration(message);
      operationDeadlineAt = configuration.operationDeadlineAt;
      outerDeadlineAt = configuration.outerDeadlineAt;
      listenerPort = configuration.listenerPort;
      if (!(await createController(configuration))) return;
      process.send?.({
        type: 'guardian-armed',
        version: 1,
        resourceId: resource.resourceId,
        role: 'playwright',
        authority,
        operationDeadlineAt,
        outerDeadlineAt,
      });
      emitE2ePhase('linux-group-guardian-armed', { pid: process.pid });
      armTimer = setTimeout(
        () => void beginCleanup(4),
        Math.min(
          remainingLifecycleMs(operationDeadlineAt),
          E2E_LIFECYCLE_BOUNDS.terminalAcknowledgementMs,
        ),
      );
      armTimer.unref();
    } catch {
      process.exit(1);
    }
    return;
  }
  if (message?.type === 'guardian-armed-ack') {
    const valid =
      authority !== undefined &&
      !launchAuthorized &&
      message.version === 1 &&
      message.resourceId === resource.resourceId &&
      message.role === 'playwright' &&
      message.operationDeadlineAt === operationDeadlineAt &&
      message.outerDeadlineAt === outerDeadlineAt;
    if (!valid) {
      void beginCleanup(4);
      return;
    }
    launchAuthorized = true;
    if (armTimer !== undefined) clearTimeout(armTimer);
    operationTimer = setTimeout(
      () => void beginCleanup(1),
      remainingLifecycleMs(operationDeadlineAt),
    );
    operationTimer.unref();
    controller.send({
      type: 'guardian-launch-authority',
      version: 1,
      resourceId: resource.resourceId,
      role: 'playwright',
      authority,
      operationDeadlineAt,
      outerDeadlineAt,
    });
    emitE2ePhase('linux-group-guardian-controller-authorized');
    return;
  }
  if (message?.type === 'cleanup-now') {
    const valid =
      authority !== undefined &&
      message.version === 1 &&
      Number.isInteger(message.reasonCode) &&
      message.reasonCode >= 0 &&
      message.reasonCode <= 8 &&
      message.finalDeadlineAt === outerDeadlineAt;
    void beginCleanup(valid ? message.reasonCode : 4);
    return;
  }
  if (message?.type === 'result-ack') {
    if (message.version !== 1 || !terminalSent) {
      void beginCleanup(4);
      return;
    }
    terminalAcknowledged = true;
    process.exit(terminalExitCode);
    return;
  }
  void beginCleanup(4);
});

process.once('disconnect', () => {
  if (controller === undefined) process.exit(1);
  else void beginCleanup(3);
});
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    if (controller === undefined) process.exit(1);
    else void beginCleanup(3);
  });

if (process.connected)
  process.send?.({
    type: 'guardian-ready',
    version: 1,
    processId: process.pid,
  });
else process.exit(1);
