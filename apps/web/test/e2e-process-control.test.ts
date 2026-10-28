import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, rmdir, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve, sep } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

// @ts-expect-error -- this Node-owned test helper intentionally executes as ESM.
import * as processControlModule from './e2e-process-control.mjs';
// @ts-expect-error -- this Node-owned test helper intentionally executes as ESM.
import * as ownedProcessModule from './e2e-owned-process.mjs';

interface LinuxIdentity {
  processId: number;
  parentProcessId: number;
  processGroupId: number;
  sessionId: number;
  startTime: string;
  state: string;
  zombie: boolean;
}

interface OwnershipIdentity extends LinuxIdentity {
  ownershipToken: string;
}

interface ProcessControlRuntime {
  platform?: string;
  windowsJobSupervisor?: boolean;
  ownershipIdentity?: OwnershipIdentity;
  recordedMembers?: LinuxIdentity[];
  windowsJobEvidence?: {
    supervisorPid: number;
    jobCleanupCompleted: boolean;
  };
  inspectLinuxOwnership?: () => {
    state: 'owned' | 'absent';
    members: LinuxIdentity[];
  };
  signalProcessGroup?: (
    processGroupId: number,
    signal: NodeJS.Signals,
  ) => boolean;
  waitForOwnedGroupExit?: (
    inspect: ProcessControlRuntime['inspectLinuxOwnership'],
    timeoutMs: number,
  ) => Promise<void>;
  terminateWindowsSupervisor?: (child: ChildProcess) => boolean;
  waitForOwnedProcessExit?: (
    child: ChildProcess,
    timeoutMs: number,
  ) => Promise<void>;
}

const {
  assertSupportedE2ePlatform,
  captureDirectChildAuthority,
  captureLinuxGroupMemberIdentity,
  captureLinuxOwnershipIdentity,
  inspectLinuxOwnedGroup,
  parseLinuxProcessStat,
  probeProcessState,
  terminateDirectChild,
  terminateOwnedProcess,
} = processControlModule as unknown as {
  assertSupportedE2ePlatform: (platform?: string) => string;
  captureDirectChildAuthority: (
    child: ChildProcess,
    runtime: {
      platform: string;
      parentProcessId?: number;
      readLinuxProcessIdentity: (
        processId: number,
      ) => LinuxIdentity | undefined;
    },
  ) => unknown;
  captureLinuxOwnershipIdentity: (
    processId: number,
    token: string,
    readers: {
      readIdentity: (processId: number) => LinuxIdentity | undefined;
      readToken: (processId: number) => string | undefined;
    },
  ) => OwnershipIdentity;
  captureLinuxGroupMemberIdentity: (
    processId: number,
    ownership: OwnershipIdentity,
    parentProcessId: number,
    readers: {
      readIdentity: (processId: number) => LinuxIdentity | undefined;
      readToken: (processId: number) => string | undefined;
    },
  ) => LinuxIdentity;
  inspectLinuxOwnedGroup: (
    ownership: OwnershipIdentity,
    recordedMembers: LinuxIdentity[],
    io: {
      listProcessIds: () => number[];
      readIdentity: (processId: number) => LinuxIdentity | undefined;
      readToken: (processId: number) => string | undefined;
    },
  ) => { state: 'owned' | 'absent'; members: LinuxIdentity[] };
  parseLinuxProcessStat: (processId: number, value: string) => LinuxIdentity;
  probeProcessState: (
    processId: number,
    kill?: (processId: number, signal: 0) => true,
  ) => 'live' | 'absent' | 'unverifiable';
  terminateDirectChild: (
    authority: unknown,
    runtime?: {
      readLinuxProcessIdentity?: (
        processId: number,
      ) => LinuxIdentity | undefined;
      terminateDirectChild?: (
        child: ChildProcess,
        signal: NodeJS.Signals,
      ) => boolean;
      waitForOwnedProcessExit?: (
        child: ChildProcess,
        timeoutMs: number,
      ) => Promise<void>;
    },
  ) => Promise<{ alreadyAbsent: boolean; forced: boolean }>;
  terminateOwnedProcess: (
    child: ChildProcess,
    runtime?: ProcessControlRuntime,
  ) => Promise<{ alreadyAbsent: boolean; forced: boolean }>;
};

const token = 'a'.repeat(43);
const identity = (overrides: Partial<LinuxIdentity> = {}): LinuxIdentity => ({
  processId: 4242,
  parentProcessId: 1,
  processGroupId: 4242,
  sessionId: 4242,
  startTime: '900719925474099312345',
  state: 'S',
  zombie: false,
  ...overrides,
});
const ownership: OwnershipIdentity = { ...identity(), ownershipToken: token };
const metadataDirectory = resolve(tmpdir(), 'bbx-e2e-server-worker-4242');

const {
  importOwnedProcessAuthority,
  exactOwnedTempDirectory,
  removeExactOwnedTempDirectory,
  retainOwnedProcessAuthority,
  spawnOwnedProcess,
} = ownedProcessModule as unknown as {
  importOwnedProcessAuthority: (
    value: unknown,
    expected?: { role?: string; metadataDirectory?: string },
  ) => Readonly<Record<string, unknown>>;
  exactOwnedTempDirectory: (path: string) => string;
  removeExactOwnedTempDirectory: (path: string) => Promise<unknown>;
  retainOwnedProcessAuthority: (
    current: unknown,
    value: unknown,
    expected?: { role?: string; metadataDirectory?: string },
  ) => Readonly<Record<string, unknown>>;
  spawnOwnedProcess: (options: { runtimePlatform: string }) => Promise<never>;
};

function transferredAuthority() {
  return {
    version: 1,
    platform: process.platform,
    role: 'application',
    metadataDirectory,
    metadataDirectoryOwned: true,
    supervisorProcessId: 4242,
    actualProcessId: 4242,
    ownershipIdentity:
      process.platform === 'linux'
        ? ownership
        : process.platform === 'win32'
          ? null
          : { processId: 4242, ownershipToken: token },
    ownershipTokenDigest: createHash('sha256').update(token).digest('hex'),
  };
}

function child(overrides: { exitCode?: number | null } = {}): ChildProcess {
  return {
    pid: 4242,
    exitCode: overrides.exitCode ?? null,
    signalCode: null,
  } as unknown as ChildProcess;
}

function owned() {
  return { state: 'owned' as const, members: [identity()] };
}

function absent() {
  return { state: 'absent' as const, members: [] };
}

function linuxRuntime(overrides: Partial<ProcessControlRuntime> = {}) {
  return Object.assign(
    {
      platform: 'linux',
      ownershipIdentity: ownership,
      inspectLinuxOwnership: vi
        .fn()
        .mockReturnValueOnce(owned())
        .mockReturnValue(absent()),
      signalProcessGroup: vi.fn(() => true),
      waitForOwnedGroupExit: vi.fn(async () => undefined),
      waitForOwnedProcessExit: vi.fn(async () => undefined),
    },
    overrides,
  );
}

describe('Linux process identity', () => {
  it('parses a final parenthesized command boundary and exact start time text', () => {
    const value =
      '4242 (worker ) name) S 7 4242 4242 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 900719925474099312345 0';
    expect(parseLinuxProcessStat(4242, value)).toMatchObject({
      parentProcessId: 7,
      processGroupId: 4242,
      sessionId: 4242,
      startTime: '900719925474099312345',
      state: 'S',
      zombie: false,
    });
  });

  it('rejects a noncanonical or negative start time', () => {
    const prefix = '4242 (worker) S 7 4242 4242 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 ';
    expect(() => parseLinuxProcessStat(4242, `${prefix}-1 0`)).toThrow(
      'Malformed Linux process identity.',
    );
    expect(() => parseLinuxProcessStat(4242, `${prefix}01 0`)).toThrow(
      'Malformed Linux process identity.',
    );
  });

  it('captures only a token-matching group and session leader', () => {
    const captured = captureLinuxOwnershipIdentity(4242, token, {
      readIdentity: () => identity(),
      readToken: () => token,
    });
    expect(captured).toEqual(ownership);
    expect(Object.isFrozen(captured)).toBe(true);
  });

  it('captures a child only inside the pre-authorized group and session', () => {
    const member = identity({ processId: 4343, parentProcessId: 4242 });
    expect(
      captureLinuxGroupMemberIdentity(4343, ownership, 4242, {
        readIdentity: () => member,
        readToken: () => token,
      }),
    ).toEqual(member);
    expect(() =>
      captureLinuxGroupMemberIdentity(4343, ownership, 9999, {
        readIdentity: () => member,
        readToken: () => token,
      }),
    ).toThrow('does not match its group');
    expect(() =>
      captureLinuxGroupMemberIdentity(4343, ownership, 4242, {
        readIdentity: () => ({ ...member, sessionId: 9999 }),
        readToken: () => token,
      }),
    ).toThrow('does not match its group');
    expect(() =>
      captureLinuxGroupMemberIdentity(4343, ownership, 4242, {
        readIdentity: () => member,
        readToken: () => 'b'.repeat(43),
      }),
    ).toThrow('does not match its group');
  });
});

describe('supported ownership platforms', () => {
  it.each(['darwin', 'freebsd', 'aix'])(
    'rejects %s before any launch configuration can mutate state',
    async (platform) => {
      expect(() => assertSupportedE2ePlatform(platform)).toThrow(
        'Unsupported E2E ownership platform.',
      );
      await expect(
        spawnOwnedProcess({ runtimePlatform: platform }),
      ).rejects.toMatchObject({ code: 'unsupported-e2e-platform' });
    },
  );
});

describe('Linux group ownership revalidation', () => {
  function inspect(
    identities: Record<number, LinuxIdentity | undefined>,
    tokens: Record<number, string | undefined>,
    recorded: LinuxIdentity[] = [],
  ) {
    return () =>
      inspectLinuxOwnedGroup(ownership, recorded, {
        listProcessIds: () => Object.keys(identities).map(Number),
        readIdentity: (processId) => identities[processId],
        readToken: (processId) => tokens[processId],
      });
  }

  it('permits an exact identity and ownership token', () => {
    expect(inspect({ 4242: identity() }, { 4242: token })()).toEqual(owned());
  });

  it.each([
    ['start time', { startTime: '2' }],
    ['session', { sessionId: 9999 }],
    ['process group', { processGroupId: 9999 }],
  ])('rejects a changed %s', (_label, change) => {
    const current = identity(change);
    const run = inspect({ 4242: current }, { 4242: token });
    expect(run).toThrow(/identity changed|session identity changed/);
  });

  it.each([undefined, 'wrong-token'])(
    'rejects an absent or wrong token',
    (value) => {
      expect(inspect({ 4242: identity() }, { 4242: value })).toThrow(
        'Owned Linux group token identity changed.',
      );
    },
  );

  it('accepts a root-exited member only with exact recorded ownership', () => {
    const member = identity({
      processId: 4343,
      parentProcessId: 1,
      startTime: '22',
    });
    expect(inspect({ 4343: member }, { 4343: token }, [member])()).toEqual({
      state: 'owned',
      members: [member],
    });
  });

  it('accepts an uninstrumented root-exited descendant with exact group, session, and token identity', () => {
    const member = identity({
      processId: 4343,
      parentProcessId: 1,
      startTime: '22',
    });
    expect(inspect({ 4343: member }, { 4343: token })()).toEqual({
      state: 'owned',
      members: [member],
    });
  });

  it('rejects a root-exited group when its recorded member was replaced', () => {
    const recorded = identity({ processId: 4343, startTime: '22' });
    const replacement = identity({ processId: 4343, startTime: '23' });
    expect(inspect({ 4343: replacement }, { 4343: token }, [recorded])).toThrow(
      'Recorded Linux member identity changed.',
    );
  });

  it('accepts a verified member that becomes a zombie with unreadable environment', () => {
    const recorded = identity({ processId: 4343, startTime: '22' });
    const zombie = { ...recorded, state: 'Z', zombie: true };
    expect(
      inspect({ 4343: zombie }, { 4343: undefined }, [recorded])(),
    ).toEqual({ state: 'owned', members: [zombie] });
  });

  it('rejects a previously unseen zombie with unreadable environment', () => {
    const zombie = identity({
      processId: 4343,
      startTime: '22',
      state: 'Z',
      zombie: true,
    });
    expect(inspect({ 4343: zombie }, { 4343: undefined })).toThrow(
      'token identity changed',
    );
  });

  it('rejects PID reuse when a recorded member becomes an unreadable zombie', () => {
    const recorded = identity({ processId: 4343, startTime: '22' });
    const replacement = identity({
      processId: 4343,
      startTime: '23',
      state: 'Z',
      zombie: true,
    });
    expect(
      inspect({ 4343: replacement }, { 4343: undefined }, [recorded]),
    ).toThrow('token identity changed');
  });
});

describe('owned E2E process cleanup', () => {
  it('accepts an already-absent exact Linux group idempotently', async () => {
    const runtime = linuxRuntime({
      inspectLinuxOwnership: vi.fn(() => absent()),
    });
    await expect(
      terminateOwnedProcess(child({ exitCode: 0 }), runtime),
    ).resolves.toEqual({ alreadyAbsent: true, forced: false });
    expect(runtime.signalProcessGroup).not.toHaveBeenCalled();
  });

  it('signals only the captured exact Linux group', async () => {
    const runtime = linuxRuntime();
    await expect(terminateOwnedProcess(child(), runtime)).resolves.toEqual({
      alreadyAbsent: false,
      forced: false,
    });
    expect(runtime.signalProcessGroup).toHaveBeenCalledTimes(1);
    expect(runtime.signalProcessGroup).toHaveBeenCalledWith(4242, 'SIGTERM');
  });

  it('prevents SIGKILL when identity changes after SIGTERM', async () => {
    const inspectLinuxOwnership = vi
      .fn()
      .mockReturnValueOnce(owned())
      .mockImplementationOnce(() => {
        throw new Error('Owned Linux root identity changed.');
      });
    const runtime = linuxRuntime({
      inspectLinuxOwnership,
      waitForOwnedGroupExit: vi.fn(async () => {
        throw new Error('term timeout');
      }),
    });
    await expect(terminateOwnedProcess(child(), runtime)).rejects.toThrow(
      'Owned Linux root identity changed.',
    );
    expect(runtime.signalProcessGroup).toHaveBeenCalledTimes(1);
  });

  it('allows a verified zombie to be reaped before the deadline', async () => {
    const live = identity();
    const zombie = { ...live, state: 'Z', zombie: true };
    const inspectLinuxOwnership = vi
      .fn()
      .mockReturnValueOnce({ state: 'owned', members: [live] })
      .mockReturnValueOnce({ state: 'owned', members: [zombie] })
      .mockReturnValue({ state: 'absent', members: [] });
    const runtime = linuxRuntime({
      inspectLinuxOwnership,
      waitForOwnedGroupExit: vi.fn(async (inspect) => {
        expect(inspect?.().state).toBe('owned');
        expect(inspect?.().state).toBe('absent');
      }),
    });
    await expect(terminateOwnedProcess(child(), runtime)).resolves.toEqual({
      alreadyAbsent: false,
      forced: false,
    });
    expect(runtime.signalProcessGroup).toHaveBeenCalledTimes(1);
    expect(runtime.signalProcessGroup).toHaveBeenCalledWith(4242, 'SIGTERM');
  });

  it('does not signal a zombie that persists through the final deadline', async () => {
    const live = identity();
    const zombie = { ...live, state: 'Z', zombie: true };
    const inspectLinuxOwnership = vi
      .fn()
      .mockReturnValueOnce({ state: 'owned', members: [live] })
      .mockReturnValue({ state: 'owned', members: [zombie] });
    const runtime = linuxRuntime({
      inspectLinuxOwnership,
      waitForOwnedGroupExit: vi.fn(async () => {
        throw new Error('deadline');
      }),
    });
    await expect(terminateOwnedProcess(child(), runtime)).rejects.toThrow(
      'zombie did not reap',
    );
    expect(runtime.signalProcessGroup).toHaveBeenCalledTimes(1);
    expect(runtime.signalProcessGroup).toHaveBeenCalledWith(4242, 'SIGTERM');
  });

  it('never permits the test runner group to replace captured ownership', async () => {
    const runnerGroup = process.pid;
    const runtime = linuxRuntime({
      ownershipIdentity: { ...ownership, processGroupId: runnerGroup },
      inspectLinuxOwnership: vi.fn(() => {
        throw new Error('Owned Linux root identity changed.');
      }),
    });
    await expect(terminateOwnedProcess(child(), runtime)).rejects.toThrow(
      'Owned Linux root identity changed.',
    );
    expect(runtime.signalProcessGroup).not.toHaveBeenCalled();
  });

  it('accepts an exited Windows supervisor only with Job cleanup evidence', async () => {
    await expect(
      terminateOwnedProcess(child({ exitCode: 0 }), {
        platform: 'win32',
        windowsJobSupervisor: true,
        windowsJobEvidence: {
          supervisorPid: 4242,
          jobCleanupCompleted: true,
        },
      }),
    ).resolves.toEqual({ alreadyAbsent: true, forced: false });
  });

  it('rejects arbitrary Windows ChildProcess cleanup without a Job owner', async () => {
    await expect(
      terminateOwnedProcess(child(), { platform: 'win32' }),
    ).rejects.toThrow('lacks a captured Job owner');
  });

  it('rejects an exited Windows supervisor without exact evidence', async () => {
    await expect(
      terminateOwnedProcess(child({ exitCode: 0 }), {
        platform: 'win32',
        windowsJobSupervisor: true,
      }),
    ).rejects.toThrow('lacks verified Job cleanup evidence');
  });

  it('uses the captured Windows child handle for a live supervisor', async () => {
    const ownedChild = child();
    const runtime = {
      platform: 'win32',
      windowsJobSupervisor: true,
      terminateWindowsSupervisor: vi.fn(() => true),
      waitForOwnedProcessExit: vi.fn(async () => {
        Object.defineProperty(ownedChild, 'exitCode', {
          configurable: true,
          value: 1,
        });
      }),
    };
    await expect(terminateOwnedProcess(ownedChild, runtime)).resolves.toEqual({
      alreadyAbsent: false,
      forced: true,
    });
    expect(runtime.terminateWindowsSupervisor).toHaveBeenCalledWith(ownedChild);
  });

  it('fails closed when exact supervisor termination is denied', async () => {
    const runtime = {
      platform: 'win32',
      windowsJobSupervisor: true,
      terminateWindowsSupervisor: vi.fn(() => false),
      waitForOwnedProcessExit: vi.fn(async () => undefined),
    };
    await expect(terminateOwnedProcess(child(), runtime)).rejects.toThrow(
      'Windows supervisor termination failed.',
    );
  });
});

describe('direct-child emergency cleanup authority', () => {
  it.each([
    ['PID reuse', { startTime: '900719925474099312346' }],
    ['PGID reuse', { processGroupId: 5151 }],
  ])('rejects %s before signaling', async (_label, replacement) => {
    const ownedChild = child();
    const authority = captureDirectChildAuthority(ownedChild, {
      platform: 'linux',
      parentProcessId: 1,
      readLinuxProcessIdentity: () => identity(),
    });
    const terminate = vi.fn(() => true);
    await expect(
      terminateDirectChild(authority, {
        readLinuxProcessIdentity: () => identity(replacement),
        terminateDirectChild: terminate,
        waitForOwnedProcessExit: vi.fn(async () => undefined),
      }),
    ).rejects.toThrow('Direct child immutable identity changed.');
    expect(terminate).not.toHaveBeenCalled();
  });

  it('reaps only the captured direct child', async () => {
    const ownedChild = child();
    const authority = captureDirectChildAuthority(ownedChild, {
      platform: 'linux',
      parentProcessId: 1,
      readLinuxProcessIdentity: () => identity(),
    });
    const terminate = vi.fn(() => true);
    const wait = vi.fn(async () => {
      Object.defineProperty(ownedChild, 'exitCode', {
        configurable: true,
        value: 143,
      });
    });
    await expect(
      terminateDirectChild(authority, {
        readLinuxProcessIdentity: () => identity(),
        terminateDirectChild: terminate,
        waitForOwnedProcessExit: wait,
      }),
    ).resolves.toEqual({ alreadyAbsent: false, forced: false });
    expect(terminate).toHaveBeenCalledWith(ownedChild, 'SIGTERM');
  });
});

describe('transferred cleanup authority validation', () => {
  it('accepts one exact role- and metadata-bound authority', () => {
    const retained = retainOwnedProcessAuthority(
      undefined,
      transferredAuthority(),
      { role: 'application', metadataDirectory },
    );
    expect(retained.role).toBe('application');
    expect(Object.isFrozen(retained)).toBe(true);
  });

  it.each([
    ['missing', undefined],
    ['malformed', { ...transferredAuthority(), ownershipTokenDigest: '0' }],
    ['wrong role', { ...transferredAuthority(), role: 'playwright' }],
  ])('rejects %s authority', (_label, value) => {
    expect(() =>
      importOwnedProcessAuthority(value, {
        role: 'application',
        metadataDirectory,
      }),
    ).toThrow('cleanup authority');
  });

  it('rejects a duplicated authority before replacement', () => {
    const retained = retainOwnedProcessAuthority(
      undefined,
      transferredAuthority(),
    );
    expect(() =>
      retainOwnedProcessAuthority(retained, transferredAuthority()),
    ).toThrow('Duplicate owned-process cleanup authority.');
  });

  it.each([
    ['repository root', resolve(process.cwd(), 'bbx-e2e-output-9999')],
    [
      'sibling root',
      resolve(dirname(resolve(tmpdir())), 'bbx-e2e-output-9999'),
    ],
    ['nested child', resolve(tmpdir(), 'nested', 'bbx-e2e-output-9999')],
    [
      'parent traversal',
      `${resolve(tmpdir())}${sep}..${sep}bbx-e2e-output-9999`,
    ],
    ['UNC form', '\\\\localhost\\C$\\bbx-e2e-output-9999'],
    ['wrong basename', resolve(tmpdir(), 'bbx-e2e-output-9999-suffix')],
  ])('rejects an owned path under the %s', (_label, path) => {
    expect(() => exactOwnedTempDirectory(path)).toThrow(
      'Invalid exact owned temporary directory.',
    );
  });

  it('rejects a matching authority basename outside the exact temp root', () => {
    expect(() =>
      importOwnedProcessAuthority(
        {
          ...transferredAuthority(),
          metadataDirectory: resolve(
            process.cwd(),
            'bbx-e2e-server-worker-4242',
          ),
        },
        { role: 'application', metadataDirectory },
      ),
    ).toThrow('cleanup authority');
  });

  it('rejects a mismatched expected resource identity', () => {
    expect(() =>
      importOwnedProcessAuthority(transferredAuthority(), {
        role: 'application',
        metadataDirectory: resolve(tmpdir(), 'bbx-e2e-server-worker-4343'),
      }),
    ).toThrow('cleanup authority');
  });

  it('removes only a valid exact direct child of the temp root', async () => {
    const path = resolve(tmpdir(), `bbx-e2e-output-${process.pid}999`);
    await mkdir(path, { recursive: false });
    await expect(removeExactOwnedTempDirectory(path)).resolves.toEqual({
      alreadyAbsent: false,
    });
    await expect(removeExactOwnedTempDirectory(path)).resolves.toEqual({
      alreadyAbsent: true,
    });
  });

  it('rejects symbolic-link or junction indirection where supported', async () => {
    const target = resolve(tmpdir(), `bbx-e2e-path-target-${process.pid}`);
    const link = resolve(tmpdir(), `bbx-e2e-output-${process.pid}998`);
    await mkdir(target, { recursive: false });
    try {
      try {
        await symlink(
          target,
          link,
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      } catch (error) {
        const code =
          error && typeof error === 'object' && 'code' in error
            ? error.code
            : undefined;
        if (code === 'EPERM' || code === 'EACCES') return;
        throw error;
      }
      await expect(removeExactOwnedTempDirectory(link)).rejects.toThrow(
        /indirect|indirection/,
      );
    } finally {
      await unlink(link).catch(() => undefined);
      await rmdir(target).catch(() => undefined);
    }
  });
});

describe('non-Linux liveness probes', () => {
  it('treats only ESRCH as absent', () => {
    const kill = vi.fn(() => {
      throw Object.assign(new Error('missing'), { code: 'ESRCH' });
    });
    expect(probeProcessState(4242, kill)).toBe('absent');
  });

  it('treats EPERM as present but unverifiable', () => {
    const kill = vi.fn(() => {
      throw Object.assign(new Error('denied'), { code: 'EPERM' });
    });
    expect(probeProcessState(4242, kill)).toBe('unverifiable');
  });

  it('propagates unexpected probe errors', () => {
    const failure = Object.assign(new Error('unexpected'), { code: 'EIO' });
    expect(() =>
      probeProcessState(4242, () => {
        throw failure;
      }),
    ).toThrow(failure);
  });
});
