import { readdirSync, readFileSync } from 'node:fs';

import {
  boundedLifecycleWaitMs,
  E2E_LIFECYCLE_BOUNDS,
} from './e2e-lifecycle-timing.mjs';

const PHASE = /^[a-z0-9-]+$/;
const PROCESS_GROUP_POLL_MS = 25;
const CANONICAL_INTEGER = /^(0|[1-9][0-9]*)$/;
const LINUX_PROCESS_STATE = /^[RSDZTtXxKWPI]$/;

export function assertSupportedE2ePlatform(platform = process.platform) {
  if (platform !== 'linux' && platform !== 'win32')
    throw Object.assign(new Error('Unsupported E2E ownership platform.'), {
      code: 'unsupported-e2e-platform',
    });
  return platform;
}

export function emitE2ePhase(name, details = {}) {
  if (!PHASE.test(name)) throw new Error('Invalid E2E phase name.');
  const suffix = Object.entries(details)
    .map(([key, value]) => {
      if (!PHASE.test(key) || !Number.isSafeInteger(value) || value < 0)
        throw new Error('Invalid E2E phase detail.');
      return `${key}=${value}`;
    })
    .join(' ');
  process.stdout.write(`BBX_E2E_PHASE ${name}${suffix ? ` ${suffix}` : ''}\n`);
}

export async function waitForOwnedProcessExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    const onExit = () => {
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => {
      child.off('exit', onExit);
      reject(new Error('Owned E2E process did not exit.'));
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

function ownedProcessId(child) {
  if (!Number.isSafeInteger(child.pid) || child.pid < 1)
    throw new Error('Owned E2E process has no valid PID.');
  return child.pid;
}

export function probeProcessState(processId, kill = process.kill) {
  if (!Number.isSafeInteger(processId) || processId < 1)
    throw new Error('Invalid process probe PID.');
  try {
    kill(processId, 0);
    return 'live';
  } catch (error) {
    if (error?.code === 'ESRCH') return 'absent';
    if (error?.code === 'EPERM') return 'unverifiable';
    throw error;
  }
}

export function parseLinuxProcessStat(processId, value) {
  if (!Number.isSafeInteger(processId) || processId < 1)
    throw new Error('Invalid Linux process identity PID.');
  const open = value.indexOf('(');
  const close = value.lastIndexOf(') ');
  if (
    open < 1 ||
    close <= open ||
    value.slice(0, open).trim() !== String(processId)
  )
    throw new Error('Malformed Linux process identity.');
  const fields = value
    .slice(close + 2)
    .trim()
    .split(/\s+/);
  // The suffix begins with proc(5) field 3. Start time is field 22.
  if (fields.length < 20 || !LINUX_PROCESS_STATE.test(fields[0]))
    throw new Error('Malformed Linux process identity.');
  const [state, rawParent, rawGroup, rawSession] = fields;
  const rawStartTime = fields[19];
  if (
    !CANONICAL_INTEGER.test(rawParent) ||
    !CANONICAL_INTEGER.test(rawGroup) ||
    !CANONICAL_INTEGER.test(rawSession) ||
    !CANONICAL_INTEGER.test(rawStartTime)
  )
    throw new Error('Malformed Linux process identity.');
  const parentProcessId = Number(rawParent);
  const processGroupId = Number(rawGroup);
  const sessionId = Number(rawSession);
  if (
    !Number.isSafeInteger(parentProcessId) ||
    !Number.isSafeInteger(processGroupId) ||
    processGroupId < 1 ||
    !Number.isSafeInteger(sessionId) ||
    sessionId < 1
  )
    throw new Error('Malformed Linux process identity.');
  BigInt(rawStartTime);
  return {
    processId,
    parentProcessId,
    processGroupId,
    sessionId,
    startTime: rawStartTime,
    state,
    dead: state === 'X' || state === 'x',
    terminal: state === 'Z' || state === 'X' || state === 'x',
    zombie: state === 'Z',
  };
}

export function readLinuxProcessIdentity(processId, readFile = readFileSync) {
  if (process.platform !== 'linux') return undefined;
  if (!Number.isSafeInteger(processId) || processId < 1)
    throw new Error('Invalid Linux process identity PID.');
  try {
    return parseLinuxProcessStat(
      processId,
      readFile(`/proc/${processId}/stat`, 'utf8'),
    );
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ESRCH') return undefined;
    throw error;
  }
}

function readLinuxOwnershipToken(processId, readFile = readFileSync) {
  try {
    const environment = readFile(`/proc/${processId}/environ`);
    for (const entry of Buffer.from(environment).toString('utf8').split('\0'))
      if (entry.startsWith('BBX_E2E_OWNERSHIP_TOKEN='))
        return entry.slice('BBX_E2E_OWNERSHIP_TOKEN='.length);
    return undefined;
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ESRCH') return undefined;
    if (error?.code === 'EPERM' || error?.code === 'EACCES') return undefined;
    throw error;
  }
}

export function captureLinuxOwnershipIdentity(
  processId,
  ownershipToken,
  readers = {},
) {
  if (typeof ownershipToken !== 'string' || ownershipToken.length < 43)
    throw new Error('Invalid E2E ownership token.');
  const readIdentity = readers.readIdentity ?? readLinuxProcessIdentity;
  const readToken = readers.readToken ?? readLinuxOwnershipToken;
  const identity = readIdentity(processId);
  if (!identity) throw new Error('Owned Linux root exited before capture.');
  if (
    identity.processId !== identity.processGroupId ||
    identity.processId !== identity.sessionId
  )
    throw new Error('Owned Linux root is not its group and session leader.');
  if (readToken(processId) !== ownershipToken)
    throw new Error('Owned Linux root token does not match.');
  return Object.freeze({ ...identity, ownershipToken });
}

export function captureLinuxGroupMemberIdentity(
  processId,
  ownership,
  expectedParentProcessId,
  readers = {},
) {
  if (!ownership || typeof ownership.ownershipToken !== 'string')
    throw new Error('Missing immutable Linux ownership identity.');
  const readIdentity = readers.readIdentity ?? readLinuxProcessIdentity;
  const readToken = readers.readToken ?? readLinuxOwnershipToken;
  const identity = readIdentity(processId);
  if (!identity) throw new Error('Owned Linux member exited before capture.');
  if (
    identity.parentProcessId !== expectedParentProcessId ||
    identity.processGroupId !== ownership.processGroupId ||
    identity.sessionId !== ownership.sessionId ||
    readToken(processId) !== ownership.ownershipToken
  )
    throw new Error('Owned Linux member identity does not match its group.');
  return Object.freeze({ ...identity });
}

function linuxProcessIds(readDirectory = readdirSync) {
  return readDirectory('/proc', { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[1-9][0-9]*$/.test(entry.name))
    .map((entry) => Number(entry.name))
    .filter(Number.isSafeInteger);
}

function sameLinuxIdentity(actual, expected) {
  return (
    actual.processId === expected.processId &&
    actual.processGroupId === expected.processGroupId &&
    actual.sessionId === expected.sessionId &&
    actual.startTime === expected.startTime
  );
}

export function sameImmutableLinuxIdentity(actual, expected) {
  return sameLinuxIdentity(actual, expected);
}

export function inspectLinuxOwnedGroup(
  ownership,
  recordedMembers = [],
  io = {},
) {
  if (!ownership || typeof ownership.ownershipToken !== 'string')
    throw new Error('Missing immutable Linux ownership identity.');
  const readIdentity = io.readIdentity ?? readLinuxProcessIdentity;
  const readToken = io.readToken ?? readLinuxOwnershipToken;
  const listProcessIds = io.listProcessIds ?? linuxProcessIds;
  const members = [];
  for (const processId of listProcessIds()) {
    const identity = readIdentity(processId);
    if (!identity) continue;
    if (
      identity.processId === ownership.processId &&
      identity.processGroupId !== ownership.processGroupId
    )
      throw new Error('Owned Linux root process-group identity changed.');
    if (identity.processGroupId !== ownership.processGroupId) continue;
    if (identity.sessionId !== ownership.sessionId)
      throw new Error('Owned Linux group session identity changed.');
    const token = readToken(processId);
    if (token !== ownership.ownershipToken) {
      const recorded = recordedMembers.find(
        (member) => member.processId === identity.processId,
      );
      if (
        !identity.terminal ||
        token !== undefined ||
        recorded === undefined ||
        !sameLinuxIdentity(identity, recorded)
      )
        throw new Error('Owned Linux group token identity changed.');
    }
    members.push(identity);
  }
  if (members.length === 0) return { state: 'absent', members: [] };
  const root = members.find(
    (member) => member.processId === ownership.processId,
  );
  if (root && !sameLinuxIdentity(root, ownership))
    throw new Error('Owned Linux root identity changed.');
  for (const recorded of recordedMembers) {
    const current = members.find(
      (member) => member.processId === recorded.processId,
    );
    if (current && !sameLinuxIdentity(current, recorded))
      throw new Error('Recorded Linux member identity changed.');
  }
  return { state: 'owned', members };
}

function signalProcessGroup(processGroupId, signal) {
  try {
    process.kill(-processGroupId, signal);
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM')
      throw new Error('Owned E2E process group is not signalable.', {
        cause: error,
      });
    throw error;
  }
  return true;
}

function convergenceBound(runtime, name, defaultValue) {
  const requested = runtime[name] ?? defaultValue;
  return runtime.deadlineAt === undefined
    ? requested
    : boundedLifecycleWaitMs(runtime.deadlineAt, requested);
}

async function waitForOwnedGroupExit(inspect, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (inspect().state === 'absent') return;
    await new Promise((resolve) => setTimeout(resolve, PROCESS_GROUP_POLL_MS));
  }
  if (inspect().state === 'absent') return;
  throw new Error('Owned E2E process group did not exit.');
}

export async function terminateLinuxOwnedGroup(
  ownership,
  recordedMembers = [],
  runtime = {},
) {
  const inspectWithMembers =
    runtime.inspectLinuxOwnership ??
    ((members) => inspectLinuxOwnedGroup(ownership, members));
  const signalGroup = runtime.signalProcessGroup ?? signalProcessGroup;
  const waitForGroupExit =
    runtime.waitForOwnedGroupExit ?? waitForOwnedGroupExit;
  const first = inspectWithMembers(recordedMembers);
  if (first.state === 'absent') return { alreadyAbsent: true, forced: false };
  const verifiedMembers = Object.freeze(
    [...recordedMembers, ...first.members].filter(
      (member, index, members) =>
        members.findIndex(
          (candidate) => candidate.processId === member.processId,
        ) === index,
    ),
  );
  const inspect = () => inspectWithMembers(verifiedMembers);
  const liveBeforeTerm = first.members.some((member) => !member.terminal);
  if (liveBeforeTerm && !signalGroup(ownership.processGroupId, 'SIGTERM'))
    return { alreadyAbsent: true, forced: false };
  let forced = false;
  try {
    await waitForGroupExit(
      inspect,
      convergenceBound(
        runtime,
        'termConvergenceMs',
        E2E_LIFECYCLE_BOUNDS.termConvergenceMs,
      ),
    );
  } catch (terminationError) {
    forced = true;
    const beforeKill = inspect();
    if (beforeKill.state === 'absent') return { alreadyAbsent: false, forced };
    const liveBeforeKill = beforeKill.members.some(
      (member) => !member.terminal,
    );
    if (!liveBeforeKill) {
      forced = false;
      try {
        await waitForGroupExit(
          inspect,
          convergenceBound(
            runtime,
            'killConvergenceMs',
            E2E_LIFECYCLE_BOUNDS.killConvergenceMs,
          ),
        );
      } catch (error) {
        throw new Error(
          'Owned E2E terminal process did not reap before the deadline.',
          {
            cause: error ?? terminationError,
          },
        );
      }
      if (inspect().state !== 'absent')
        throw new Error('Owned E2E terminal cleanup did not converge.');
      return { alreadyAbsent: false, forced };
    }
    if (!signalGroup(ownership.processGroupId, 'SIGKILL'))
      return { alreadyAbsent: false, forced };
    try {
      await waitForGroupExit(
        inspect,
        convergenceBound(
          runtime,
          'killConvergenceMs',
          E2E_LIFECYCLE_BOUNDS.killConvergenceMs,
        ),
      );
    } catch (error) {
      throw new Error('Owned E2E process group survived SIGKILL.', {
        cause: error ?? terminationError,
      });
    }
  }
  if (inspect().state !== 'absent')
    throw new Error('Owned E2E process group cleanup did not converge.');
  return { alreadyAbsent: false, forced };
}

export function captureDirectChildAuthority(child, runtime = {}) {
  const processId = ownedProcessId(child);
  const platform = assertSupportedE2ePlatform(
    runtime.platform ?? process.platform,
  );
  const linuxIdentity =
    platform === 'linux'
      ? (runtime.readLinuxProcessIdentity ?? readLinuxProcessIdentity)(
          processId,
        )
      : undefined;
  if (platform === 'linux' && linuxIdentity === undefined)
    throw new Error('Direct child exited before identity capture.');
  const parentProcessId = runtime.parentProcessId ?? process.pid;
  if (platform === 'linux' && linuxIdentity.parentProcessId !== parentProcessId)
    throw new Error('Captured process is not a direct child.');
  return Object.freeze({
    child,
    platform,
    processId,
    parentProcessId,
    linuxIdentity: linuxIdentity && Object.freeze({ ...linuxIdentity }),
  });
}

export async function terminateDirectChild(authority, runtime = {}) {
  if (
    !authority?.child ||
    !Number.isSafeInteger(authority.processId) ||
    authority.processId < 1 ||
    authority.child.pid !== authority.processId
  )
    throw new Error('Invalid direct-child authority.');
  const child = authority.child;
  const waitForChildExit =
    runtime.waitForOwnedProcessExit ?? waitForOwnedProcessExit;
  if (child.exitCode !== null || child.signalCode !== null)
    return { alreadyAbsent: true, forced: false };

  const revalidate = () => {
    if (authority.platform !== 'linux') return;
    const current = (
      runtime.readLinuxProcessIdentity ?? readLinuxProcessIdentity
    )(authority.processId);
    if (current === undefined) return;
    if (!sameLinuxIdentity(current, authority.linuxIdentity))
      throw new Error('Direct child immutable identity changed.');
  };
  revalidate();
  const terminate =
    runtime.terminateDirectChild ??
    ((ownedChild, signal) => ownedChild.kill(signal));
  if (terminate(child, 'SIGTERM') !== true)
    throw new Error('Direct child termination failed.');
  try {
    await waitForChildExit(
      child,
      convergenceBound(
        runtime,
        'termConvergenceMs',
        E2E_LIFECYCLE_BOUNDS.termConvergenceMs,
      ),
    );
    return { alreadyAbsent: false, forced: false };
  } catch (terminationError) {
    revalidate();
    if (terminate(child, 'SIGKILL') !== true)
      throw new Error('Direct child forced termination failed.', {
        cause: terminationError,
      });
    await waitForChildExit(
      child,
      convergenceBound(
        runtime,
        'killConvergenceMs',
        E2E_LIFECYCLE_BOUNDS.killConvergenceMs,
      ),
    );
    return { alreadyAbsent: false, forced: true };
  }
}

export async function terminateOwnedProcess(child, runtime = {}) {
  const processId = ownedProcessId(child);
  const platform = assertSupportedE2ePlatform(
    runtime.platform ?? process.platform,
  );
  const waitForChildExit =
    runtime.waitForOwnedProcessExit ?? waitForOwnedProcessExit;

  if (platform === 'win32') {
    if (runtime.windowsJobSupervisor !== true)
      throw new Error('Windows cleanup lacks a captured Job owner.');
    const evidence = runtime.windowsJobEvidence;
    if (child.exitCode !== null || child.signalCode !== null) {
      if (
        !evidence ||
        evidence.supervisorPid !== processId ||
        evidence.jobCleanupCompleted !== true
      )
        throw new Error(
          'Exited Windows supervisor lacks verified Job cleanup evidence.',
        );
      return { alreadyAbsent: true, forced: false };
    }
    const terminateSupervisor =
      runtime.terminateWindowsSupervisor ??
      ((ownedChild) => ownedChild.kill('SIGKILL'));
    if (terminateSupervisor(child) !== true)
      throw new Error('Windows supervisor termination failed.');
    await waitForChildExit(
      child,
      convergenceBound(
        runtime,
        'killConvergenceMs',
        E2E_LIFECYCLE_BOUNDS.killConvergenceMs,
      ),
    );
    if (child.exitCode === null && child.signalCode === null)
      throw new Error('Owned Windows supervisor did not exit.');
    return { alreadyAbsent: false, forced: true };
  }

  const signalGroup = runtime.signalProcessGroup ?? signalProcessGroup;
  if (platform === 'linux') {
    const ownership = runtime.ownershipIdentity;
    const recordedMembers = runtime.recordedMembers ?? [];
    const result = await terminateLinuxOwnedGroup(ownership, recordedMembers, {
      inspectLinuxOwnership: runtime.inspectLinuxOwnership,
      signalProcessGroup: signalGroup,
      waitForOwnedGroupExit: runtime.waitForOwnedGroupExit,
      deadlineAt: runtime.deadlineAt,
    });
    if (child.exitCode === null && child.signalCode === null)
      await waitForChildExit(
        child,
        convergenceBound(
          runtime,
          'killConvergenceMs',
          E2E_LIFECYCLE_BOUNDS.killConvergenceMs,
        ),
      );
    return result;
  }

  throw new Error('Unsupported E2E ownership platform.');
}
