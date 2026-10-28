import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  exactOwnedTempDirectory,
  importOwnedProcessAuthority,
  removeExactOwnedTempDirectory,
} from './e2e-owned-process.mjs';
import {
  completeCleanupBudgetMs,
  remainingLifecycleMs,
} from './e2e-lifecycle-timing.mjs';
import {
  assertSupportedE2ePlatform,
  probeProcessState,
} from './e2e-process-control.mjs';

const execFileAsync = promisify(execFile);
const guardianPath = fileURLToPath(
  new URL('./e2e-windows-layer-job-guardian.ps1', import.meta.url),
);
const INTERNAL_FAULT_CONTEXT = 'bbx-e2e-layer-job-fault-v1';

function startupTimeoutError() {
  return Object.assign(new Error('Windows layer Job startup timed out.'), {
    code: 'owned-process-startup-timeout',
  });
}

async function guardianExitError(processId, resultPath) {
  try {
    const evidence = JSON.parse(await readFile(resultPath, 'utf8'));
    if (
      evidence.version === 1 &&
      evidence.cleanupCompleted === false &&
      Number.isInteger(evidence.failureStage) &&
      evidence.failureStage >= 1 &&
      evidence.failureStage <= 7
    )
      return new Error(
        `Windows layer Job guardian failed at stage ${evidence.failureStage}.`,
      );
  } catch (error) {
    if (error?.code !== 'ENOENT')
      return new Error('Windows layer Job failure evidence was invalid.');
  }
  return new Error(
    `Windows layer Job guardian ${processId} exited before assignment.`,
  );
}

async function launchGuardian(configurationPath, environment) {
  const { stdout } = await execFileAsync(
    powershellPath(environment),
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      guardianPath,
      '-LaunchConfigurationPath',
      configurationPath,
    ],
    {
      encoding: 'utf8',
      env: environment,
      timeout: 5_000,
      windowsHide: true,
    },
  );
  const lines = stdout
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
  if (lines.length !== 1)
    throw new Error('Invalid Windows layer Job launch evidence.');
  const launched = JSON.parse(lines[0]);
  if (
    launched.version !== 1 ||
    !Number.isSafeInteger(launched.processId) ||
    launched.processId < 1 ||
    typeof launched.creationTime !== 'string' ||
    !/^[1-9][0-9]*$/.test(launched.creationTime)
  )
    throw new Error('Invalid Windows layer Job launch evidence.');
  return Object.freeze({ ...launched });
}

async function waitForGuardianTerminalEvidence(
  processId,
  resultPath,
  deadlineAt,
) {
  while (Date.now() < deadlineAt) {
    let terminalEvidence = false;
    try {
      const evidence = JSON.parse(await readFile(resultPath, 'utf8'));
      terminalEvidence =
        evidence.version === 1 &&
        (evidence.cleanupCompleted === true ||
          (evidence.cleanupCompleted === false &&
            Number.isInteger(evidence.failureStage) &&
            evidence.failureStage >= 1 &&
            evidence.failureStage <= 7));
    } catch (error) {
      if (error?.code !== 'ENOENT')
        throw new Error('Windows layer Job terminal evidence was invalid.');
    }
    if (terminalEvidence && probeProcessState(processId) === 'absent') return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error('Windows layer Job failed start did not converge.');
}

function powershellPath(environment) {
  const systemRoot = environment.SystemRoot ?? environment.WINDIR;
  if (!systemRoot) throw new Error('Windows system root is unavailable.');
  return resolve(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
}

export async function captureWindowsProcessIdentity(processId) {
  if (!Number.isSafeInteger(processId) || processId < 1)
    throw new Error('Invalid Windows process identity request.');
  const { stdout } = await execFileAsync(
    powershellPath(process.env),
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      guardianPath,
      '-CaptureIdentityProcessId',
      String(processId),
    ],
    { encoding: 'utf8', timeout: 5_000, windowsHide: true },
  );
  const lines = stdout
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
  if (lines.length !== 1)
    throw new Error('Invalid Windows process identity evidence.');
  const identity = JSON.parse(lines[0]);
  if (
    identity.version !== 1 ||
    identity.processId !== processId ||
    typeof identity.creationTime !== 'string' ||
    !/^[1-9][0-9]*$/.test(identity.creationTime)
  )
    throw new Error('Invalid Windows process identity evidence.');
  return Object.freeze({ ...identity });
}

export async function startWindowsLayerJob(options) {
  if (assertSupportedE2ePlatform() !== 'win32')
    throw new Error('Windows layer Job requires Windows.');
  if (
    !options?.targetChild ||
    !Number.isSafeInteger(options.targetChild.pid) ||
    options.targetChild.pid < 1 ||
    typeof options.role !== 'string' ||
    !/^[a-z][a-z0-9-]{0,31}$/.test(options.role)
  )
    throw new Error('Invalid Windows layer Job request.');
  const metadataDirectory = exactOwnedTempDirectory(options.metadataDirectory);
  if (
    options.faultInjection !== undefined &&
    (options.internalFaultContext !== INTERNAL_FAULT_CONTEXT ||
      ![
        'owner-identity',
        'target-identity',
        'target-exit',
        'convergence-timeout',
      ].includes(options.faultInjection))
  )
    throw new Error('Invalid Windows layer Job fault injection.');

  const startupDeadline = options.startupDeadline ?? Date.now() + 10_000;
  const targetIdentity = await captureWindowsProcessIdentity(
    options.targetChild.pid,
  );
  const ownerIdentity = await captureWindowsProcessIdentity(process.pid);
  if (
    options.targetChild.exitCode !== null ||
    options.targetChild.signalCode !== null
  )
    throw new Error('Windows layer target exited before identity handoff.');
  if (options.faultInjection === 'target-exit') {
    options.targetChild.kill('SIGKILL');
    await new Promise((resolveExit) =>
      options.targetChild.once('exit', resolveExit),
    );
  }

  await mkdir(metadataDirectory, { recursive: false });
  const configurationPath = resolve(
    metadataDirectory,
    'windows-layer-job.json',
  );
  const targetCreationTime =
    options.faultInjection === 'target-identity'
      ? String(BigInt(targetIdentity.creationTime) + 1n)
      : targetIdentity.creationTime;
  const ownerCreationTime =
    options.faultInjection === 'owner-identity'
      ? String(BigInt(ownerIdentity.creationTime) + 1n)
      : ownerIdentity.creationTime;
  await writeFile(
    configurationPath,
    JSON.stringify({
      version: 2,
      context: 'bbx-e2e-layer-job-v2',
      targetPid: options.targetChild.pid,
      targetCreationTime,
      ownerPid: process.pid,
      ownerCreationTime,
      cleanupTimeoutMs: completeCleanupBudgetMs(),
      ...(options.faultInjection === 'convergence-timeout'
        ? { faultInjection: 'convergence-timeout' }
        : {}),
    }),
    { encoding: 'utf8', flag: 'wx' },
  );
  const guardian = await launchGuardian(
    configurationPath,
    options.faultInjection === 'convergence-timeout'
      ? {
          ...process.env,
          BBX_E2E_INTERNAL_LAYER_JOB_FAULT_CONTEXT: INTERNAL_FAULT_CONTEXT,
        }
      : process.env,
  );
  const startedPath = resolve(
    metadataDirectory,
    'windows-layer-job-started.json',
  );
  try {
    while (Date.now() < startupDeadline) {
      try {
        const started = JSON.parse(await readFile(startedPath, 'utf8'));
        if (
          started.version !== 2 ||
          started.targetPid !== options.targetChild.pid ||
          started.targetCreationTime !== targetIdentity.creationTime ||
          started.ownerPid !== process.pid ||
          started.ownerCreationTime !== ownerIdentity.creationTime
        )
          throw new Error('Invalid Windows layer Job startup evidence.');
        const ownershipTokenDigest = createHash('sha256')
          .update(randomBytes(32))
          .digest('hex');
        const authority = importOwnedProcessAuthority(
          {
            version: 1,
            platform: 'win32',
            role: options.role,
            metadataDirectory,
            metadataDirectoryOwned: true,
            supervisorProcessId: guardian.processId,
            actualProcessId: options.targetChild.pid,
            ownershipIdentity: null,
            ownershipTokenDigest,
          },
          { role: options.role, metadataDirectory },
        );
        options.phase?.('windows-layer-job-guardian-ready', {
          pid: guardian.processId,
        });
        return Object.freeze({
          authority,
          guardianProcessId: guardian.processId,
          metadataDirectory,
        });
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      if (probeProcessState(guardian.processId) === 'absent')
        throw await guardianExitError(
          guardian.processId,
          resolve(metadataDirectory, 'windows-layer-job-result.json'),
        );
      if (remainingLifecycleMs(startupDeadline) < 1)
        throw startupTimeoutError();
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    throw startupTimeoutError();
  } catch (error) {
    if (
      probeProcessState(guardian.processId) !== 'absent' &&
      options.targetChild.exitCode === null &&
      options.targetChild.signalCode === null
    )
      options.targetChild.kill('SIGKILL');
    await waitForGuardianTerminalEvidence(
      guardian.processId,
      resolve(metadataDirectory, 'windows-layer-job-result.json'),
      startupDeadline + completeCleanupBudgetMs(),
    );
    await removeExactOwnedTempDirectory(metadataDirectory);
    throw error;
  }
}
