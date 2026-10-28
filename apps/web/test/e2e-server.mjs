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
  retainOwnedProcessAuthority,
  validateCurrentLinuxGroupMemberAuthority,
} from './e2e-owned-process.mjs';
import {
  E2E_LIFECYCLE_BOUNDS,
  completeCleanupBudgetMs,
  deriveOuterWatchdogMs,
  parseInternalDuration,
  remainingLifecycleMs,
} from './e2e-lifecycle-timing.mjs';
import { startWindowsLayerJob } from './e2e-windows-layer-job.mjs';
import {
  createParentResourcePlan,
  parentResourceEnvironment,
  parentResourcePlanFromEnvironment,
} from './e2e-resource-registry.mjs';

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
const internalLaunchDelay = process.env.BBX_E2E_INTERNAL_LAUNCH_DELAY_MS;
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
  (internalTimeout !== undefined &&
    (!internalTest || !/^[1-9][0-9]{2,3}$/.test(internalTimeout))) ||
  (internalLaunchDelay !== undefined &&
    (!internalTest || !/^(0|[1-9][0-9]{0,3})$/.test(internalLaunchDelay)))
)
  throw new Error('Invalid isolated dashboard E2E server configuration.');
const launchReadinessMs = internalTimeout
  ? parseInternalDuration(internalTimeout, {
      minimum: 100,
      maximum: 9_999,
      label: 'internal E2E startup timeout',
    })
  : 20_000;
const lifecycleStartedAt = Date.now();
const lifecycleTiming = deriveOuterWatchdogMs(launchReadinessMs);
const inheritedOperationDeadlineAt = Number(
  process.env.BBX_E2E_OPERATION_DEADLINE_AT,
);
const inheritedOuterDeadlineAt = Number(process.env.BBX_E2E_OUTER_DEADLINE_AT);
if (
  guardianOwnedLinuxGroup &&
  (!Number.isSafeInteger(inheritedOperationDeadlineAt) ||
    !Number.isSafeInteger(inheritedOuterDeadlineAt) ||
    inheritedOuterDeadlineAt - inheritedOperationDeadlineAt !==
      completeCleanupBudgetMs() ||
    inheritedOuterDeadlineAt <= Date.now())
)
  throw new Error('Invalid inherited Linux lifecycle authority.');
const launchDeadlineAt = Math.min(
  lifecycleStartedAt + launchReadinessMs,
  guardianOwnedLinuxGroup
    ? inheritedOperationDeadlineAt
    : Number.MAX_SAFE_INTEGER,
);
const finalDeadlineAt = guardianOwnedLinuxGroup
  ? inheritedOuterDeadlineAt
  : lifecycleStartedAt + lifecycleTiming.outerWatchdogMs;
const requiredResources = guardianOwnedLinuxGroup
  ? ['playwright']
  : platform === 'win32'
    ? ['server-application', 'server-worker']
    : ['server-application'];
const resourcePlan = process.env.BBX_E2E_PARENT_RESOURCE_IDS
  ? parentResourcePlanFromEnvironment(requiredResources)
  : createParentResourcePlan(requiredResources);
const sharedLinuxAuthority = guardianOwnedLinuxGroup
  ? validateCurrentLinuxGroupMemberAuthority(
      JSON.parse(process.env.BBX_E2E_LINUX_GROUP_AUTHORITY ?? 'null'),
      {
        role: 'playwright',
        metadataDirectory: resourcePlan.get('playwright').metadataDirectory,
      },
    )
  : undefined;

emitE2ePhase('server-controller-start', { pid: process.pid });
const groupOwnershipToken =
  platform === 'linux' && !guardianOwnedLinuxGroup
    ? randomBytes(32).toString('base64url')
    : undefined;
const worker = fork(workerPath, [], {
  detached: !guardianOwnedLinuxGroup,
  env: parentResourceEnvironment(
    resourcePlan,
    platform === 'linux' && !guardianOwnedLinuxGroup
      ? { ...process.env, BBX_E2E_OWNERSHIP_TOKEN: groupOwnershipToken }
      : process.env,
  ),
  stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  windowsHide: true,
});
const workerAuthority = captureDirectChildAuthority(worker);
const workerMetadataDirectory = resourcePlan.get(
  guardianOwnedLinuxGroup ? 'playwright' : 'server-application',
).metadataDirectory;
emitE2ePhase('server-worker-spawned', { pid: worker.pid ?? 0 });

let closing = false;
let ready = false;
let terminalResult;
let terminalResultCount = 0;
let applicationAuthority;
let applicationAuthorityCount = 0;
let workerLayerAuthority;
let workerLaunchSettled = false;
let workerExitBeforeLaunch;
const registryAuthorityAcknowledgements = new Map();
const startupWatchdog = setTimeout(
  () => {
    void shutdown(1, 'server-startup-timeout');
  },
  guardianOwnedLinuxGroup
    ? Math.max(1, launchDeadlineAt - Date.now())
    : lifecycleTiming.outerWatchdogMs,
);
startupWatchdog.unref();

async function retainAuthorityAboveController(
  authority,
  resource,
  layerProcessId,
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
    ownedPaths: [],
    authority,
  });
  emitE2ePhase('server-upper-authority-requested');
  const accepted = await Promise.race([
    acknowledgement.then(() => true),
    new Promise((resolveTimeout) =>
      setTimeout(
        () => resolveTimeout(false),
        E2E_LIFECYCLE_BOUNDS.terminalAcknowledgementMs,
      ),
    ),
  ]);
  if (!accepted)
    throw new Error('Upper E2E ownership authority was not acknowledged.');
}

async function authorizeWorkerLaunch() {
  if (guardianOwnedLinuxGroup) {
    applicationAuthority = sharedLinuxAuthority;
    applicationAuthorityCount = 1;
    emitE2ePhase('application-ownership-authority-retained');
  } else if (platform === 'linux') {
    applicationAuthority = createLinuxProcessGroupAuthority(worker, {
      platform,
      role: 'application',
      metadataDirectory: workerMetadataDirectory,
      metadataDirectoryOwned: true,
      ownershipToken: groupOwnershipToken,
    });
    applicationAuthorityCount = 1;
    await retainAuthorityAboveController(
      applicationAuthority,
      'server-application',
      worker.pid,
    );
    emitE2ePhase('application-ownership-authority-retained');
  } else {
    const layerJob = await startWindowsLayerJob({
      targetChild: worker,
      role: 'server-worker',
      metadataDirectory: resourcePlan.get('server-worker').metadataDirectory,
      phase: emitE2ePhase,
      startupDeadline: launchDeadlineAt,
    });
    workerLayerAuthority = layerJob.authority;
    await retainAuthorityAboveController(
      workerLayerAuthority,
      'server-worker',
      worker.pid,
    );
  }
  if (!worker.connected)
    throw new Error('Worker IPC disconnected before launch authorization.');
  if (Date.now() >= launchDeadlineAt)
    throw Object.assign(new Error('Application startup deadline exhausted.'), {
      code: 'owned-process-startup-timeout',
    });
  worker.send({
    type: 'launch-authority',
    version: 1,
    authority: applicationAuthority ?? null,
    launchDeadlineAt,
    operationDeadlineAt: guardianOwnedLinuxGroup
      ? inheritedOperationDeadlineAt
      : launchDeadlineAt,
    outerDeadlineAt: finalDeadlineAt,
  });
  emitE2ePhase('worker-launch-authority-sent');
}

async function shutdown(exitCode, phase, requestWorkerShutdown = true) {
  if (closing) return;
  closing = true;
  clearTimeout(startupWatchdog);
  emitE2ePhase(phase);
  if (requestWorkerShutdown && worker.connected)
    worker.send({ type: 'shutdown' });
  const cleanupFailures = [];
  try {
    await waitForOwnedProcessExit(
      worker,
      guardianOwnedLinuxGroup
        ? remainingLifecycleMs(finalDeadlineAt)
        : completeCleanupBudgetMs(),
    );
  } catch (error) {
    cleanupFailures.push(error);
    if (!guardianOwnedLinuxGroup) {
      try {
        await terminateDirectChild(workerAuthority);
      } catch (terminationError) {
        cleanupFailures.push(terminationError);
      }
    }
  }
  if (applicationAuthority !== undefined && !guardianOwnedLinuxGroup) {
    try {
      await cleanupOwnedProcessAuthority(applicationAuthority, {
        beforeMetadataCleanup: async () => {
          for (const port of [proxyPort, appPort])
            if (!(await portIsFree(port)))
              throw new Error(
                'Owned listener remained before metadata cleanup.',
              );
        },
      });
    } catch (error) {
      cleanupFailures.push(error);
    }
  } else if (ready && !guardianOwnedLinuxGroup) {
    cleanupFailures.push(
      new Error('Ready application lacked retained cleanup authority.'),
    );
  }
  if (workerLayerAuthority !== undefined) {
    try {
      await cleanupOwnedProcessAuthority(workerLayerAuthority);
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  for (const port of guardianOwnedLinuxGroup
    ? [proxyPort]
    : [proxyPort, appPort]) {
    try {
      if (!(await portIsFree(port)))
        throw new Error('Owned listener remained after cleanup.');
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  if (!guardianOwnedLinuxGroup)
    try {
      await lstat(workerMetadataDirectory);
      cleanupFailures.push(
        new Error('Application ownership metadata remained after cleanup.'),
      );
    } catch (error) {
      if (error?.code !== 'ENOENT') cleanupFailures.push(error);
    }
  const validResult =
    terminalResultCount === 1 &&
    terminalResult?.cleanupSucceeded === true &&
    terminalResult.cleanupErrorCode === 0 &&
    Number.isInteger(terminalResult.exitCode) &&
    terminalResult.exitCode >= 0 &&
    terminalResult.exitCode <= 255;
  const finalExitCode =
    cleanupFailures.length === 0 && validResult
      ? exitCode === 0
        ? terminalResult.exitCode
        : exitCode
      : 1;
  const failureCount = cleanupFailures.length + (validResult ? 0 : 1);
  if (validResult && cleanupFailures.length === 0)
    emitE2ePhase('server-controller-cleanup-complete');
  else
    emitE2ePhase('server-controller-cleanup-failed', {
      'failure-count': failureCount,
    });
  process.exit(finalExitCode);
}

function portIsFree(port) {
  return new Promise((resolveFree) => {
    const probe = createServer();
    probe.once('error', () => resolveFree(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolveFree(true)));
  });
}

worker.on('message', (message) => {
  if (message?.type === 'phase') {
    emitE2ePhase(message.name, message.details);
    if (message.name === 'proxy-ready') {
      ready = true;
      clearTimeout(startupWatchdog);
    }
  } else if (message?.type === 'application-ownership-authority') {
    if (platform === 'linux') {
      void shutdown(1, 'application-ownership-authority-invalid');
      return;
    }
    applicationAuthorityCount += 1;
    void (async () => {
      try {
        if (applicationAuthorityCount !== 1 || message.version !== 1)
          throw new Error('Duplicate application cleanup authority.');
        applicationAuthority = retainOwnedProcessAuthority(
          applicationAuthority,
          message.authority,
          {
            role: 'application',
            metadataDirectory: workerMetadataDirectory,
          },
        );
        await retainAuthorityAboveController(
          applicationAuthority,
          'server-application',
          worker.pid,
        );
        if (worker.connected)
          worker.send({ type: 'application-ownership-authority-ack' });
        emitE2ePhase('application-ownership-authority-retained');
      } catch {
        void shutdown(1, 'application-ownership-authority-invalid');
      }
    })();
  } else if (message?.type === 'fatal') {
    const code =
      typeof message.code === 'string' && /^[a-z0-9-]+$/.test(message.code)
        ? message.code
        : 'unknown-worker-failure';
    process.stderr.write(`E2E server failed during ${code}.\n`);
    void shutdown(1, 'server-worker-failed', false);
  } else if (message?.type === 'terminal-result') {
    terminalResultCount += 1;
    const valid =
      terminalResultCount === 1 &&
      message.version === 1 &&
      Number.isInteger(message.exitCode) &&
      message.exitCode >= 0 &&
      message.exitCode <= 255 &&
      typeof message.cleanupSucceeded === 'boolean' &&
      Number.isInteger(message.cleanupErrorCode) &&
      message.cleanupErrorCode >= 0 &&
      message.cleanupErrorCode <= 1;
    if (!valid) {
      void shutdown(1, 'server-worker-result-invalid', false);
      return;
    }
    terminalResult = Object.freeze({
      exitCode: message.exitCode,
      cleanupSucceeded: message.cleanupSucceeded,
      cleanupErrorCode: message.cleanupErrorCode,
    });
    emitE2ePhase('server-terminal-result-received', {
      'exit-code': terminalResult.exitCode,
      'cleanup-error-code': terminalResult.cleanupErrorCode,
    });
    if (worker.connected) worker.send({ type: 'terminal-result-ack' });
    emitE2ePhase('server-terminal-result-acknowledged');
  }
});
worker.once('error', () => void shutdown(1, 'server-worker-spawn-failed'));
worker.once('exit', (code) => {
  if (!closing && !workerLaunchSettled) {
    workerExitBeforeLaunch = code;
    return;
  }
  if (!closing)
    void shutdown(
      code === 0 && ready && terminalResult?.exitCode === 0 ? 0 : 1,
      'server-worker-exited',
      false,
    );
});
process.on('message', (message) => {
  if (message?.type === 'owned-resource-authority-ack') {
    const acknowledge = registryAuthorityAcknowledgements.get(message.resource);
    if (
      message.version !== 1 ||
      message.resourceId !== resourcePlan.get(message.resource)?.resourceId
    ) {
      void shutdown(1, 'upper-authority-ack-invalid');
      return;
    }
    if (acknowledge === undefined) {
      void shutdown(1, 'upper-authority-ack-invalid');
      return;
    }
    registryAuthorityAcknowledgements.delete(message.resource);
    acknowledge();
    return;
  }
  if (message?.type === 'shutdown')
    void shutdown(0, 'server-shutdown-requested');
  if (
    internalTest &&
    message?.type === 'simulate-signal' &&
    (message.signal === 'SIGINT' || message.signal === 'SIGTERM')
  )
    void shutdown(message.signal === 'SIGINT' ? 130 : 143, 'server-signal');
});
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(
    signal,
    () => void shutdown(signal === 'SIGINT' ? 130 : 143, 'server-signal'),
  );

void authorizeWorkerLaunch()
  .then(() => {
    workerLaunchSettled = true;
    if (workerExitBeforeLaunch !== undefined && !closing)
      return shutdown(1, 'server-worker-exited', false);
  })
  .catch((error) => {
    workerLaunchSettled = true;
    return shutdown(
      1,
      error?.code === 'owned-process-startup-timeout'
        ? 'application-startup-timeout'
        : 'worker-launch-authority-failed',
      false,
    );
  });
