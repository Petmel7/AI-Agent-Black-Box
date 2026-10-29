import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

import {
  cleanupOwnedProcessAuthority,
  importOwnedProcessAuthority,
} from './e2e-owned-process.mjs';
import {
  captureDirectChildAuthority,
  emitE2ePhase,
  inspectLinuxOwnedGroup,
  probeProcessState,
  terminateDirectChild,
  waitForOwnedProcessExit,
} from './e2e-process-control.mjs';
import {
  boundedLifecycleWaitMs,
  createLifecycleTimeline,
  E2E_LIFECYCLE_BOUNDS,
  remainingLifecycleMs,
} from './e2e-lifecycle-timing.mjs';
import { createLinuxSignalAuthorityState } from './e2e-linux-guardian-state.mjs';
import {
  createParentResourcePlan,
  createParentResourceRegistry,
  parentResourceEnvironment,
  parseParentResourcePlan,
} from './e2e-resource-registry.mjs';

const CHILD_MARKER = 'bbx-e2e-linux-controller-child-v1';
const groupGuardianPath = fileURLToPath(
  new URL('./e2e-linux-group-guardian.mjs', import.meta.url),
);

function ownedListenerPort(environment) {
  const raw =
    environment.BBX_E2E_INTERNAL_CONTROLLER_PORT ??
    environment.BBX_E2E_PROXY_PORT ??
    '43121';
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535)
    throw new Error('Invalid Linux E2E guardian listener port.');
  return port;
}

function portIsFree(port) {
  return new Promise((resolveFree) => {
    const probe = createServer();
    probe.once('error', () => resolveFree(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolveFree(true)));
  });
}

function waitForChildMessage(child, validate, timeoutMs, timeoutMessage) {
  return new Promise((resolveMessage, rejectMessage) => {
    let settled = false;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.off('message', onMessage);
      child.off('error', onError);
      child.off('exit', onExit);
      child.off('disconnect', onDisconnect);
      callback(value);
    };
    const timeout = setTimeout(
      () => settle(rejectMessage, new Error(timeoutMessage)),
      timeoutMs,
    );
    function onMessage(message) {
      try {
        if (validate(message)) settle(resolveMessage, message);
      } catch (error) {
        settle(rejectMessage, error);
      }
    }
    function onError(error) {
      settle(rejectMessage, error);
    }
    function onExit() {
      settle(rejectMessage, new Error('Linux E2E guardian exited early.'));
    }
    function onDisconnect() {
      settle(
        rejectMessage,
        new Error('Linux E2E guardian IPC disconnected early.'),
      );
    }
    child.on('message', onMessage);
    child.once('error', onError);
    child.once('exit', onExit);
    child.once('disconnect', onDisconnect);
  });
}

export function waitForProtocolAcknowledgement(child, validate, deadlineAt) {
  return waitForChildMessage(
    child,
    validate,
    boundedLifecycleWaitMs(
      deadlineAt,
      E2E_LIFECYCLE_BOUNDS.terminalAcknowledgementMs,
    ),
    'Linux E2E guardian acknowledgement timed out.',
  );
}

export function waitForLifecycleResult(child, validate, outerDeadlineAt) {
  const remainingMs = remainingLifecycleMs(outerDeadlineAt);
  if (remainingMs < 1)
    return Promise.reject(new Error('Linux E2E guardian deadline exhausted.'));
  return waitForChildMessage(
    child,
    validate,
    remainingMs,
    'Linux E2E guardian lifecycle result timed out.',
  );
}

export function isLinuxControllerGuardianChild(environment = process.env) {
  return environment.BBX_E2E_LINUX_CONTROLLER_CHILD === CHILD_MARKER;
}

export async function runLinuxControllerGuardian({
  controllerPath,
  controllerArguments,
  environment,
  operationDeadlineMs,
}) {
  if (process.platform !== 'linux' || process.connected)
    throw new Error('Linux E2E guardian requires a direct top-level command.');
  const timing = createLifecycleTimeline(operationDeadlineMs);
  const bootstrapPause = environment.BBX_E2E_INTERNAL_GUARDIAN_BOOTSTRAP_PAUSE;
  if (
    bootstrapPause !== undefined &&
    (environment.BBX_E2E_INTERNAL_CONTROLLER_CONTEXT !==
      'bbx-e2e-controller-harness-v1' ||
      ![
        'before-configuration',
        'during-controller-creation',
        'before-armed-ack',
        'after-terminal-result',
      ].includes(bootstrapPause))
  )
    throw new Error('Invalid Linux guardian bootstrap pause.');
  const pauseAt = async (phase) => {
    if (bootstrapPause !== phase) return;
    emitE2ePhase(`linux-supervisor-${phase}`);
    await new Promise((resolvePause) => setTimeout(resolvePause, 5_000));
  };
  const plan = environment.BBX_E2E_PARENT_RESOURCE_IDS
    ? parseParentResourcePlan(environment.BBX_E2E_PARENT_RESOURCE_IDS, [
        'playwright',
      ])
    : createParentResourcePlan(['playwright']);
  const registry = createParentResourceRegistry(
    plan,
    importOwnedProcessAuthority,
  );
  const childEnvironment = parentResourceEnvironment(plan, environment);
  const groupGuardian = fork(groupGuardianPath, [], {
    detached: true,
    env: childEnvironment,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    windowsHide: true,
  });
  const groupGuardianAuthority = captureDirectChildAuthority(groupGuardian);
  const sendToGuardian = (message) => {
    if (!groupGuardian.connected) return false;
    try {
      groupGuardian.send(message, () => undefined);
      return true;
    } catch {
      return false;
    }
  };

  await waitForProtocolAcknowledgement(
    groupGuardian,
    (message) =>
      message?.type === 'guardian-ready' &&
      message.version === 1 &&
      message.processId === groupGuardian.pid,
    timing.operationDeadlineAt,
  );
  emitE2ePhase('linux-group-guardian-ready', { pid: groupGuardian.pid });
  await pauseAt('before-configuration');

  const ownershipToken = randomBytes(32).toString('base64url');
  const resource = plan.get('playwright');
  const listenerPort = ownedListenerPort(environment);
  const validGuardianResult = (message) =>
    message?.type === 'guardian-result' &&
    message.version === 1 &&
    Number.isInteger(message.exitCode) &&
    message.exitCode >= 0 &&
    message.exitCode <= 255 &&
    typeof message.cleanupSucceeded === 'boolean' &&
    (message.cleanupErrorCode === 0 || message.cleanupErrorCode === 1) &&
    message.cleanupSucceeded === (message.cleanupErrorCode === 0) &&
    Number.isInteger(message.failureCount) &&
    message.failureCount >= 0 &&
    message.failureCount <= 8 &&
    typeof message.eventualConvergence === 'boolean' &&
    Number.isInteger(message.reasonCode) &&
    message.reasonCode >= 0 &&
    message.reasonCode <= 8;
  const resultPromise = waitForLifecycleResult(
    groupGuardian,
    (message) => {
      if (message?.type !== 'guardian-result') return false;
      if (!validGuardianResult(message))
        throw new Error('Invalid Linux guardian result.');
      return true;
    },
    timing.outerDeadlineAt,
  ).then(
    (result) => ({ result, error: undefined }),
    (error) => ({ result: undefined, error }),
  );
  sendToGuardian({
    type: 'launch-configuration',
    version: 1,
    resourceId: resource.resourceId,
    role: 'playwright',
    ownershipToken,
    controllerPath,
    controllerArguments,
    listenerPort,
    operationDeadlineAt: timing.operationDeadlineAt,
    outerDeadlineAt: timing.outerDeadlineAt,
  });
  const armed = await waitForProtocolAcknowledgement(
    groupGuardian,
    (message) =>
      message?.type === 'guardian-armed' &&
      message.version === 1 &&
      message.resourceId === resource.resourceId &&
      message.role === 'playwright' &&
      message.operationDeadlineAt === timing.operationDeadlineAt &&
      message.outerDeadlineAt === timing.outerDeadlineAt,
    timing.operationDeadlineAt,
  );
  const retainedAuthority = registry.accept(
    {
      version: 1,
      resource: 'playwright',
      resourceId: resource.resourceId,
      authority: armed.authority,
    },
    'playwright',
  );
  emitE2ePhase('linux-controller-guardian-authority-retained');
  await pauseAt('before-armed-ack');
  sendToGuardian({
    type: 'guardian-armed-ack',
    version: 1,
    resourceId: resource.resourceId,
    role: 'playwright',
    operationDeadlineAt: timing.operationDeadlineAt,
    outerDeadlineAt: timing.outerDeadlineAt,
  });

  let requestedExitCode = 0;
  let cleanupRequested = false;
  const signalAuthority = createLinuxSignalAuthorityState();
  let fallbackPromise;

  const outputIsAbsent = async () => {
    try {
      await lstat(resource.metadataDirectory);
      return false;
    } catch (error) {
      if (error?.code === 'ENOENT') return true;
      throw error;
    }
  };

  const retainedResourcesConverged = async () =>
    inspectLinuxOwnedGroup(retainedAuthority.ownershipIdentity).state ===
      'absent' &&
    (await portIsFree(listenerPort)) &&
    (await outputIsAbsent());

  const supervisorFallback = () => {
    if (fallbackPromise !== undefined) return fallbackPromise;
    fallbackPromise = Promise.resolve().then(async () => {
      emitE2ePhase('linux-controller-guardian-failover-start');
      if (signalAuthority.snapshot().state === 'guardian-authority')
        signalAuthority.guardianCleaning();
      let cleanupResult;
      emitE2ePhase('linux-controller-supervisor-registry-completion-start');
      const completion = await registry.completeAfter(
        'playwright',
        async ({ authority, entry }) => {
          if (
            authority !== retainedAuthority ||
            entry.resourceId !== resource.resourceId ||
            entry.metadataDirectory !== resource.metadataDirectory
          )
            throw new Error('Linux guardian resource identity changed.');
          await terminateDirectChild(groupGuardianAuthority, {
            deadlineAt: timing.outerDeadlineAt,
            termConvergenceMs: 500,
            killConvergenceMs: 500,
          });
          if (
            probeProcessState(groupGuardianAuthority.processId) !== 'absent' ||
            (groupGuardian.exitCode === null &&
              groupGuardian.signalCode === null)
          )
            throw new Error('Linux group guardian absence was not proven.');
          emitE2ePhase('linux-controller-guardian-absence-confirmed');
          signalAuthority.supervisorFallback(true);
          if (remainingLifecycleMs(timing.outerDeadlineAt) < 1)
            throw new Error('Linux guardian fallback deadline exhausted.');
          emitE2ePhase('linux-controller-supervisor-fallback-cleanup-start');
          cleanupResult = await cleanupOwnedProcessAuthority(authority, {
            deadlineAt: timing.outerDeadlineAt,
            beforeMetadataCleanup: async () => {
              if (!(await portIsFree(listenerPort)))
                throw new Error(
                  'Owned Linux listener remained during failover.',
                );
            },
          });
          if (!(await retainedResourcesConverged()))
            throw new Error('Linux supervisor fallback did not converge.');
          if (!(await outputIsAbsent()))
            throw new Error('Linux supervisor output remained after cleanup.');
        },
      );
      if (completion.alreadyCompleted || cleanupResult === undefined)
        throw new Error('Linux supervisor cleanup was not first completion.');
      emitE2ePhase('linux-controller-supervisor-registry-completion-complete');
      if (cleanupResult.forced)
        emitE2ePhase('linux-controller-supervisor-fallback-forced-cleanup');
      signalAuthority.converged('supervisor');
      emitE2ePhase('linux-controller-supervisor-signal-converged');
      emitE2ePhase('linux-controller-supervisor-fallback-cleanup-complete');
      return cleanupResult;
    });
    return fallbackPromise;
  };

  const requestCleanup = (exitCode, reasonCode) => {
    requestedExitCode = Math.max(requestedExitCode, exitCode);
    if (cleanupRequested) return;
    cleanupRequested = true;
    if (signalAuthority.snapshot().state === 'guardian-authority')
      signalAuthority.guardianCleaning();
    if (signalAuthority.snapshot().state !== 'guardian-cleaning') return;
    emitE2ePhase('linux-controller-guardian-cleanup-start');
    sendToGuardian({
      type: 'cleanup-now',
      version: 1,
      reasonCode,
      finalDeadlineAt: timing.outerDeadlineAt,
    });
  };
  const operationTimer = setTimeout(() => {
    emitE2ePhase('linux-controller-guardian-operation-deadline');
    requestCleanup(1, 1);
  }, remainingLifecycleMs(timing.operationDeadlineAt));
  operationTimer.unref();
  for (const [signal, exitCode] of new Map([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ]))
    process.once(signal, () => requestCleanup(exitCode, 3));

  let guardianResult;
  try {
    const resultOutcome = await resultPromise;
    if (resultOutcome.error !== undefined) throw resultOutcome.error;
    guardianResult = resultOutcome.result;
  } catch {
    requestedExitCode = Math.max(requestedExitCode, 1);
    clearTimeout(operationTimer);
    try {
      await supervisorFallback();
    } catch {
      signalAuthority.failed();
    }
    const fallbackSucceeded = signalAuthority.snapshot().state === 'converged';
    emitE2ePhase('linux-controller-guardian-cleanup-complete', {
      'failure-count': fallbackSucceeded ? 0 : 1,
      'exit-code':
        requestedExitCode === 130 ? 130 : requestedExitCode === 143 ? 143 : 1,
    });
    return requestedExitCode === 130
      ? 130
      : requestedExitCode === 143
        ? 143
        : 1;
  }
  clearTimeout(operationTimer);
  emitE2ePhase('linux-controller-guardian-result-received');
  await pauseAt('after-terminal-result');
  let guardianResultTrusted = guardianResult.cleanupSucceeded;
  let guardianExitObserved = true;
  sendToGuardian({ type: 'result-ack', version: 1 });
  try {
    await waitForOwnedProcessExit(
      groupGuardian,
      boundedLifecycleWaitMs(
        timing.outerDeadlineAt,
        E2E_LIFECYCLE_BOUNDS.controllerReportingMarginMs,
      ),
    );
  } catch {
    guardianExitObserved = false;
  }
  if (guardianResultTrusted) {
    try {
      emitE2ePhase('linux-controller-guardian-registry-completion-start');
      const completion = await registry.completeAfter(
        'playwright',
        async ({ authority, entry }) => {
          if (
            authority !== retainedAuthority ||
            entry.resourceId !== resource.resourceId ||
            entry.metadataDirectory !== resource.metadataDirectory ||
            !validGuardianResult(guardianResult) ||
            !guardianResult.cleanupSucceeded ||
            !guardianExitObserved ||
            groupGuardian.signalCode !== null ||
            groupGuardian.exitCode !== guardianResult.exitCode ||
            probeProcessState(groupGuardianAuthority.processId) !== 'absent'
          )
            throw new Error('Linux guardian result was not trusted.');
          if (!(await retainedResourcesConverged()))
            throw new Error('Linux guardian cleanup did not converge.');
          if (!(await outputIsAbsent()))
            throw new Error('Linux guardian output remained after cleanup.');
        },
      );
      if (completion.alreadyCompleted)
        throw new Error('Linux guardian cleanup was not first completion.');
      emitE2ePhase('linux-controller-guardian-registry-completion-complete');
      signalAuthority.converged('guardian');
      emitE2ePhase('linux-controller-guardian-signal-converged');
    } catch {
      guardianResultTrusted = false;
    }
  }
  if (!guardianResultTrusted) {
    requestedExitCode = Math.max(requestedExitCode, 1);
    try {
      await supervisorFallback();
    } catch {
      signalAuthority.failed();
    }
  }
  const finalExitCode =
    signalAuthority.snapshot().state === 'converged' && requestedExitCode === 0
      ? guardianResult.exitCode
      : requestedExitCode === 130 || requestedExitCode === 143
        ? requestedExitCode
        : 1;
  emitE2ePhase('linux-controller-guardian-cleanup-complete', {
    'failure-count':
      guardianResult.failureCount +
      (signalAuthority.snapshot().state === 'failed' ? 1 : 0),
    'exit-code': finalExitCode,
  });
  emitE2ePhase('linux-controller-guardian-exit', {
    'exit-code': finalExitCode,
    'reason-code': guardianResult.reasonCode,
  });
  return finalExitCode;
}
