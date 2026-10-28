import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertSupportedE2ePlatform,
  captureDirectChildAuthority,
  captureLinuxGroupMemberIdentity,
  captureLinuxOwnershipIdentity,
  inspectLinuxOwnedGroup,
  probeProcessState,
  readLinuxProcessIdentity,
  terminateDirectChild,
  terminateLinuxOwnedGroup,
  terminateOwnedProcess,
} from './e2e-process-control.mjs';

const ROLE = /^[a-z][a-z0-9-]{0,31}$/;
const windowsSupervisorPath = fileURLToPath(
  new URL('./e2e-windows-job-supervisor.ps1', import.meta.url),
);
const ownedTempRoot = resolve(tmpdir());
const OWNED_DIRECTORY =
  /^(?:bbx-e2e-(?:output|server-worker)-[1-9][0-9]*|bbx-e2e-layer-[1-9][0-9]*-[1-9][0-9]*|bbx-e2e-(?:playwright|playwright-owner|server-application|server-worker)-[a-f0-9]{48})$/;

export function exactOwnedTempDirectory(path) {
  if (typeof path !== 'string' || !isAbsolute(path))
    throw new Error('Invalid exact owned temporary directory.');
  const normalized = resolve(path);
  if (
    path !== normalized ||
    dirname(normalized) !== ownedTempRoot ||
    !OWNED_DIRECTORY.test(basename(normalized))
  )
    throw new Error('Invalid exact owned temporary directory.');
  return normalized;
}

function validMetadataDirectory(path) {
  try {
    exactOwnedTempDirectory(path);
    return true;
  } catch {
    return false;
  }
}

export async function assertExactOwnedTempDirectoryTarget(path) {
  const normalized = exactOwnedTempDirectory(path);
  let information;
  try {
    information = await lstat(normalized);
  } catch (error) {
    if (error?.code === 'ENOENT')
      return Object.freeze({ alreadyAbsent: true, path: normalized });
    throw error;
  }
  if (!information.isDirectory() || information.isSymbolicLink())
    throw new Error('Owned temporary directory is indirect.');
  const resolvedTarget = await realpath(normalized);
  if (resolvedTarget !== normalized)
    throw new Error('Owned temporary directory changed through indirection.');
  return Object.freeze({ alreadyAbsent: false, path: normalized });
}

export async function removeExactOwnedTempDirectory(path) {
  const target = await assertExactOwnedTempDirectoryTarget(path);
  if (target.alreadyAbsent) return { alreadyAbsent: true };
  const normalized = target.path;
  await rm(normalized, { recursive: true, force: false });
  return { alreadyAbsent: false };
}

function startupTimeoutError() {
  return Object.assign(new Error('Owned-process startup deadline exhausted.'), {
    code: 'owned-process-startup-timeout',
  });
}

function validateOptions(options) {
  if (
    typeof options.executable !== 'string' ||
    options.executable.length === 0 ||
    !Array.isArray(options.arguments) ||
    options.arguments.length > 128 ||
    options.arguments.some(
      (argument) =>
        typeof argument !== 'string' ||
        argument.length > 32_768 ||
        argument.includes('\0'),
    ) ||
    typeof options.workingDirectory !== 'string' ||
    !ROLE.test(options.role) ||
    !validMetadataDirectory(options.metadataDirectory) ||
    (options.startupDeadline !== undefined &&
      (!Number.isFinite(options.startupDeadline) ||
        options.startupDeadline <= 0)) ||
    (options.launchDelayMs !== undefined &&
      (!Number.isSafeInteger(options.launchDelayMs) ||
        options.launchDelayMs < 0 ||
        options.launchDelayMs > 10_000)) ||
    (options.recordLinuxMetadata !== undefined &&
      typeof options.recordLinuxMetadata !== 'boolean')
  )
    throw new Error('Invalid owned-process launch configuration.');
}

function windowsPowerShellPath(environment) {
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

export async function spawnOwnedProcess(options) {
  const platform = assertSupportedE2ePlatform(options.runtimePlatform);
  validateOptions(options);
  if (options.launchDelayMs)
    await new Promise((resolveDelay) =>
      setTimeout(resolveDelay, options.launchDelayMs),
    );
  if (
    options.startupDeadline !== undefined &&
    Date.now() >= options.startupDeadline
  )
    throw startupTimeoutError();
  const linuxGroupAuthority =
    platform === 'linux'
      ? validateCurrentLinuxGroupMemberAuthority(options.linuxGroupAuthority, {
          role: options.role,
          metadataDirectory: options.metadataDirectory,
        })
      : undefined;
  const ownershipToken =
    linuxGroupAuthority?.ownershipIdentity.ownershipToken ??
    randomBytes(32).toString('base64url');
  const ownershipTokenDigest = createHash('sha256')
    .update(ownershipToken)
    .digest('hex');
  const childEnvironment = {
    ...options.environment,
    BBX_E2E_OWNERSHIP_TOKEN: ownershipToken,
  };
  let executable = options.executable;
  let arguments_ = options.arguments;
  let configurationPath;
  if (platform === 'win32') {
    await mkdir(options.metadataDirectory, { recursive: true });
    configurationPath = resolve(
      options.metadataDirectory,
      'windows-job-input.json',
    );
    if (dirname(configurationPath) !== resolve(options.metadataDirectory))
      throw new Error('Unsafe Windows Job input path.');
    await writeFile(
      configurationPath,
      JSON.stringify({
        version: 1,
        executable: options.executable,
        arguments: options.arguments,
        workingDirectory: options.workingDirectory,
        role: options.role,
        ownerPid: process.pid,
      }),
      { encoding: 'utf8', flag: 'wx' },
    );
    executable = windowsPowerShellPath(childEnvironment);
    arguments_ = [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      windowsSupervisorPath,
      configurationPath,
    ];
  }
  const child = spawn(executable, arguments_, {
    cwd: options.workingDirectory,
    detached: false,
    env: childEnvironment,
    stdio: options.stdio ?? 'inherit',
    windowsHide: true,
  });
  const outcome = new Promise((resolveOutcome) => {
    child.once('error', (error) =>
      resolveOutcome({ type: 'spawn-error', error }),
    );
    child.once('exit', (code, signal) =>
      resolveOutcome({ type: 'exit', code, signal }),
    );
  });
  await new Promise((resolveSpawn, reject) => {
    child.once('spawn', resolveSpawn);
    child.once('error', reject);
  });
  let actualChildProcessId;
  if (platform === 'win32') {
    try {
      options.phase?.(`${options.role}-supervisor-spawned`, { pid: child.pid });
      const startedPath = resolve(
        options.metadataDirectory,
        'windows-job-started.json',
      );
      const deadline = options.startupDeadline ?? Date.now() + 10_000;
      while (Date.now() < deadline) {
        try {
          const started = JSON.parse(await readFile(startedPath, 'utf8'));
          if (
            started.version !== 1 ||
            !Number.isSafeInteger(started.childPid) ||
            started.childPid < 1
          )
            throw new Error('Invalid Windows Job startup evidence.');
          actualChildProcessId = started.childPid;
          break;
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
        if (child.exitCode !== null || child.signalCode !== null)
          throw new Error(
            'Windows Job supervisor exited before child startup.',
          );
        await new Promise((resolveWait) => setTimeout(resolveWait, 25));
      }
      if (actualChildProcessId === undefined) throw startupTimeoutError();
      options.phase?.(`${options.role}-spawned`, {
        pid: actualChildProcessId,
      });
    } catch (error) {
      if (
        child.exitCode === null &&
        child.signalCode === null &&
        !child.kill('SIGKILL')
      )
        throw new AggregateError(
          [error, new Error('Windows Job supervisor startup cleanup failed.')],
          'Owned-process startup and cleanup both failed.',
        );
      await Promise.race([
        outcome,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('Windows Job startup cleanup timed out.')),
            5_000,
          ),
        ),
      ]);
      for (const name of [
        'windows-job-input.json',
        'windows-job-started.json',
        'windows-job-result.json',
      ])
        await rm(resolve(options.metadataDirectory, name), { force: true });
      if (options.metadataDirectoryOwned)
        await removeExactOwnedTempDirectory(options.metadataDirectory);
      throw error;
    }
  }
  let ownershipIdentity;
  let directChildAuthority;
  if (platform === 'linux') {
    ownershipIdentity = linuxGroupAuthority.ownershipIdentity;
    directChildAuthority = captureDirectChildAuthority(child);
    const member = captureLinuxGroupMemberIdentity(
      child.pid,
      ownershipIdentity,
      process.pid,
    );
    if (options.recordLinuxMetadata !== false) {
      await mkdir(options.metadataDirectory, { recursive: true });
      await writeFile(
        resolve(options.metadataDirectory, 'owned-root.json'),
        JSON.stringify({
          processId: member.processId,
          parentProcessId: member.parentProcessId,
          processGroupId: member.processGroupId,
          sessionId: member.sessionId,
          startTime: member.startTime,
          tokenDigest: ownershipTokenDigest,
        }),
        { encoding: 'utf8', flag: 'wx' },
      );
    }
  }
  if (platform !== 'win32')
    options.phase?.(`${options.role}-spawned`, { pid: child.pid });
  return Object.freeze({
    child,
    outcome,
    role: options.role,
    metadataDirectory: resolve(options.metadataDirectory),
    metadataDirectoryOwned: options.metadataDirectoryOwned === true,
    configurationPath,
    actualChildProcessId,
    ownershipIdentity,
    directChildAuthority,
    groupAuthority: linuxGroupAuthority,
    ownershipTokenDigest,
  });
}

export function exportOwnedProcessAuthority(handle) {
  if (!handle?.child || !ROLE.test(handle.role))
    throw new Error('Invalid owned-process authority source.');
  if (handle.groupAuthority !== undefined) return handle.groupAuthority;
  const supervisorProcessId = handle.child.pid;
  if (!Number.isSafeInteger(supervisorProcessId) || supervisorProcessId < 1)
    throw new Error('Owned-process authority has no supervisor PID.');
  return Object.freeze({
    version: 1,
    platform: process.platform,
    role: handle.role,
    metadataDirectory: handle.metadataDirectory,
    metadataDirectoryOwned: handle.metadataDirectoryOwned,
    supervisorProcessId,
    actualProcessId: handle.actualChildProcessId ?? supervisorProcessId,
    ownershipIdentity:
      handle.ownershipIdentity === undefined
        ? null
        : Object.freeze({ ...handle.ownershipIdentity }),
    ownershipTokenDigest: handle.ownershipTokenDigest,
  });
}

function canonicalAuthority(value, expected = {}) {
  if (value?.platform !== undefined) assertSupportedE2ePlatform(value.platform);
  if (
    !value ||
    value.version !== 1 ||
    value.platform !== process.platform ||
    !ROLE.test(value.role) ||
    !validMetadataDirectory(value.metadataDirectory) ||
    typeof value.metadataDirectoryOwned !== 'boolean' ||
    !Number.isSafeInteger(value.supervisorProcessId) ||
    value.supervisorProcessId < 1 ||
    !Number.isSafeInteger(value.actualProcessId) ||
    value.actualProcessId < 1 ||
    typeof value.ownershipTokenDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.ownershipTokenDigest) ||
    (expected.role !== undefined && value.role !== expected.role) ||
    (expected.metadataDirectory !== undefined &&
      resolve(value.metadataDirectory) !== resolve(expected.metadataDirectory))
  )
    throw new Error('Invalid owned-process cleanup authority.');
  let ownershipIdentity = null;
  if (value.platform === 'linux') {
    const identity = value.ownershipIdentity;
    if (
      !identity ||
      identity.processId !== value.supervisorProcessId ||
      identity.processGroupId !== identity.processId ||
      identity.sessionId !== identity.processId ||
      !Number.isSafeInteger(identity.parentProcessId) ||
      !/^(0|[1-9][0-9]*)$/.test(identity.startTime) ||
      typeof identity.ownershipToken !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(identity.ownershipToken) ||
      createHash('sha256').update(identity.ownershipToken).digest('hex') !==
        value.ownershipTokenDigest
    )
      throw new Error('Invalid Linux owned-process cleanup authority.');
    ownershipIdentity = Object.freeze({ ...identity });
  } else if (value.ownershipIdentity !== null) {
    if (
      !Number.isSafeInteger(value.ownershipIdentity.processId) ||
      value.ownershipIdentity.processId !== value.supervisorProcessId ||
      typeof value.ownershipIdentity.ownershipToken !== 'string'
    )
      throw new Error('Invalid unsupported owned-process cleanup authority.');
    ownershipIdentity = Object.freeze({ ...value.ownershipIdentity });
  }
  return Object.freeze({
    version: 1,
    platform: value.platform,
    role: value.role,
    metadataDirectory: resolve(value.metadataDirectory),
    metadataDirectoryOwned: value.metadataDirectoryOwned,
    supervisorProcessId: value.supervisorProcessId,
    actualProcessId: value.actualProcessId,
    ownershipIdentity,
    ownershipTokenDigest: value.ownershipTokenDigest,
  });
}

export function createLinuxProcessGroupAuthority(child, options) {
  if (assertSupportedE2ePlatform(options.platform) !== 'linux')
    throw new Error('Linux process-group authority requires Linux.');
  if (!child || !ROLE.test(options.role))
    throw new Error('Invalid Linux process-group authority request.');
  const processId = child.pid;
  if (!Number.isSafeInteger(processId) || processId < 1)
    throw new Error('Linux process-group root has no valid PID.');
  if (
    typeof options.ownershipToken !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(options.ownershipToken)
  )
    throw new Error('Invalid E2E ownership token.');
  const ownershipIdentity = captureLinuxOwnershipIdentity(
    processId,
    options.ownershipToken,
  );
  return canonicalAuthority({
    version: 1,
    platform: 'linux',
    role: options.role,
    metadataDirectory: resolve(options.metadataDirectory),
    metadataDirectoryOwned: options.metadataDirectoryOwned === true,
    supervisorProcessId: processId,
    actualProcessId: processId,
    ownershipIdentity,
    ownershipTokenDigest: createHash('sha256')
      .update(options.ownershipToken)
      .digest('hex'),
  });
}

export function validateCurrentLinuxGroupAuthority(value, expected = {}) {
  const authority = canonicalAuthority(value, expected);
  if (authority.platform !== 'linux')
    throw new Error('Linux launch authority is required.');
  if (authority.supervisorProcessId !== process.pid)
    throw new Error('Linux launch authority does not own this process.');
  const current = readLinuxProcessIdentity(process.pid);
  if (
    current === undefined ||
    current.processId !== authority.ownershipIdentity.processId ||
    current.processGroupId !== authority.ownershipIdentity.processGroupId ||
    current.sessionId !== authority.ownershipIdentity.sessionId ||
    current.startTime !== authority.ownershipIdentity.startTime
  )
    throw new Error('Linux launch authority identity changed.');
  return authority;
}

export function validateCurrentLinuxGroupMemberAuthority(value, expected = {}) {
  const authority = canonicalAuthority(value, expected);
  if (authority.platform !== 'linux')
    throw new Error('Linux launch authority is required.');
  const current = readLinuxProcessIdentity(process.pid);
  if (
    current === undefined ||
    current.processGroupId !== authority.ownershipIdentity.processGroupId ||
    current.sessionId !== authority.ownershipIdentity.sessionId ||
    process.env.BBX_E2E_OWNERSHIP_TOKEN !==
      authority.ownershipIdentity.ownershipToken
  )
    throw new Error('Linux launch authority does not own this group member.');
  return authority;
}

export function importOwnedProcessAuthority(value, expected = {}) {
  return canonicalAuthority(value, expected);
}

export function retainOwnedProcessAuthority(current, value, expected = {}) {
  if (current !== undefined)
    throw new Error('Duplicate owned-process cleanup authority.');
  return canonicalAuthority(value, expected);
}

async function readRecordedMembers(handle) {
  if (process.platform !== 'linux') return [];
  const records = [];
  for (const name of ['owned-root.json', 'owned-members.json']) {
    try {
      const parsed = JSON.parse(
        await readFile(resolve(handle.metadataDirectory, name), 'utf8'),
      );
      const members = Array.isArray(parsed) ? parsed : [parsed];
      if (members.length > 16)
        throw new Error('Invalid recorded ownership members.');
      records.push(
        ...members.map((member) => {
          if (
            !Number.isSafeInteger(member.processId) ||
            member.processId < 1 ||
            !Number.isSafeInteger(member.processGroupId) ||
            !Number.isSafeInteger(member.sessionId) ||
            !/^(0|[1-9][0-9]*)$/.test(member.startTime) ||
            member.tokenDigest !== handle.ownershipTokenDigest
          )
            throw new Error('Invalid recorded ownership member.');
          return Object.freeze({ ...member });
        }),
      );
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
  }
  return records;
}

async function pathIsAbsent(path) {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
}

async function waitForAuthorityAbsence(authority, deadlineAt) {
  const deadline = deadlineAt === undefined ? Date.now() + 5_000 : deadlineAt;
  while (Date.now() < deadline) {
    const supervisorAbsent =
      probeProcessState(authority.supervisorProcessId) === 'absent';
    const childAbsent =
      authority.actualProcessId === authority.supervisorProcessId ||
      probeProcessState(authority.actualProcessId) === 'absent';
    if (supervisorAbsent && childAbsent) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error('Owned-process authority did not converge to absence.');
}

async function verifyWindowsLayerJobConvergence(authority) {
  if (!['playwright-owner', 'server-worker'].includes(authority.role)) return;
  let evidence;
  try {
    evidence = JSON.parse(
      await readFile(
        resolve(authority.metadataDirectory, 'windows-layer-job-result.json'),
        'utf8',
      ),
    );
  } catch (error) {
    throw new Error('Windows layer Job lacks convergence evidence.', {
      cause: error,
    });
  }
  if (
    evidence.version !== 1 ||
    evidence.activeProcesses !== 0 ||
    evidence.cleanupCompleted !== true
  )
    throw new Error('Invalid Windows layer Job convergence evidence.');
}

export async function cleanupOwnedProcessAuthority(value, options = {}) {
  const authority = canonicalAuthority(value);
  let metadataTarget;
  let result = { alreadyAbsent: false, forced: false };
  if (authority.platform === 'linux') {
    result = await terminateLinuxOwnedGroup(
      authority.ownershipIdentity,
      await readRecordedMembers(authority),
      { deadlineAt: options.deadlineAt },
    );
  } else if (authority.platform === 'win32') {
    metadataTarget = await assertExactOwnedTempDirectoryTarget(
      authority.metadataDirectory,
    );
    await waitForAuthorityAbsence(authority, options.deadlineAt);
    if (!metadataTarget.alreadyAbsent)
      await verifyWindowsLayerJobConvergence(authority);
    result = { alreadyAbsent: true, forced: false };
  } else {
    throw new Error('Transferred cleanup authority is unsupported here.');
  }
  return cleanupAuthorityMetadata(authority, metadataTarget, result, options);
}

async function cleanupAuthorityMetadata(
  authority,
  metadataTarget,
  result,
  options,
) {
  if (options.beforeMetadataCleanup !== undefined) {
    if (typeof options.beforeMetadataCleanup !== 'function')
      throw new Error('Invalid pre-metadata cleanup verifier.');
    await options.beforeMetadataCleanup();
  }
  metadataTarget ??= await assertExactOwnedTempDirectoryTarget(
    authority.metadataDirectory,
  );
  for (const name of metadataTarget.alreadyAbsent
    ? []
    : [
        'owned-root.json',
        'owned-members.json',
        'windows-job-input.json',
        'windows-job-started.json',
        'windows-job-result.json',
        'windows-layer-job.json',
        'windows-layer-job-started.json',
        'windows-layer-job-result.json',
      ]) {
    await assertExactOwnedTempDirectoryTarget(authority.metadataDirectory);
    await rm(resolve(authority.metadataDirectory, name), { force: true });
  }
  if (authority.metadataDirectoryOwned)
    await removeExactOwnedTempDirectory(authority.metadataDirectory);
  if (
    authority.metadataDirectoryOwned &&
    !(await pathIsAbsent(authority.metadataDirectory))
  )
    throw new Error('Owned metadata remained after process cleanup.');
  return result;
}

export async function finalizeOwnedProcessAuthorityAfterAbsence(
  value,
  options = {},
) {
  const authority = canonicalAuthority(value);
  if (authority.platform !== 'linux')
    throw new Error('Final convergence is supported only for Linux groups.');
  const inspection = inspectLinuxOwnedGroup(authority.ownershipIdentity);
  if (inspection.state !== 'absent')
    throw new Error('Owned Linux group has not converged to absence.');
  return cleanupAuthorityMetadata(
    authority,
    undefined,
    { alreadyAbsent: true, forced: false },
    options,
  );
}

async function readWindowsJobEvidence(handle) {
  if (process.platform !== 'win32') return undefined;
  try {
    const parsed = JSON.parse(
      await readFile(
        resolve(handle.metadataDirectory, 'windows-job-result.json'),
        'utf8',
      ),
    );
    if (
      parsed.version !== 1 ||
      parsed.supervisorPid !== handle.child.pid ||
      !Number.isSafeInteger(parsed.childPid) ||
      parsed.childPid < 1 ||
      !Number.isInteger(parsed.exitCode) ||
      parsed.exitCode < 0 ||
      parsed.exitCode > 255 ||
      parsed.jobCreated !== true ||
      parsed.childAssignedBeforeResume !== true ||
      parsed.childResultObserved !== true ||
      parsed.jobCleanupCompleted !== true ||
      parsed.exitCode !== handle.child.exitCode
    )
      throw new Error('Invalid Windows Job cleanup evidence.');
    return Object.freeze(parsed);
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function cleanupOwnedProcess(handle, options = {}) {
  if (!handle?.child || !ROLE.test(handle.role))
    throw new Error('Invalid owned-process cleanup handle.');
  const result =
    process.platform === 'linux'
      ? await terminateDirectChild(handle.directChildAuthority, {
          deadlineAt: options.deadlineAt,
        })
      : await terminateOwnedProcess(handle.child, {
          windowsJobSupervisor: true,
          windowsJobEvidence: await readWindowsJobEvidence(handle),
          deadlineAt: options.deadlineAt,
        });
  if (options.beforeMetadataCleanup !== undefined) {
    if (typeof options.beforeMetadataCleanup !== 'function')
      throw new Error('Invalid pre-metadata cleanup verifier.');
    await options.beforeMetadataCleanup();
  }
  if (process.platform === 'win32') {
    const metadataTarget = await assertExactOwnedTempDirectoryTarget(
      handle.metadataDirectory,
    );
    for (const name of metadataTarget.alreadyAbsent
      ? []
      : [
          'windows-job-input.json',
          'windows-job-started.json',
          'windows-job-result.json',
        ]) {
      await assertExactOwnedTempDirectoryTarget(handle.metadataDirectory);
      await rm(resolve(handle.metadataDirectory, name), { force: true });
    }
    if (handle.metadataDirectoryOwned)
      await removeExactOwnedTempDirectory(handle.metadataDirectory);
  }
  return result;
}

export function ownedMetadataName(path) {
  return basename(path);
}
