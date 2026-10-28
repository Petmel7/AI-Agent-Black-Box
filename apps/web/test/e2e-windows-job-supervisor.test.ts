import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it as vitestIt } from 'vitest';

// @ts-expect-error -- this Node-owned test helper intentionally executes as ESM.
import * as processControlModule from './e2e-process-control.mjs';

const { probeProcessState } = processControlModule as unknown as {
  probeProcessState: (processId: number) => string;
};
const supervisorPath = fileURLToPath(
  new URL('./e2e-windows-job-supervisor.ps1', import.meta.url),
);
const fixturePath = fileURLToPath(
  new URL('./e2e-controller-fixture.mjs', import.meta.url),
);
const ownedDirectories = new Set<string>();
const activeSupervisors = new Set<ChildProcess>();
let ownedDirectorySequence = 0n;

function nextOwnedOutputDirectory() {
  ownedDirectorySequence += 1n;
  const ownedIdentity = (BigInt(process.pid) << 32n) + ownedDirectorySequence;
  return join(tmpdir(), `bbx-e2e-output-${ownedIdentity}`);
}

function powershellPath() {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!systemRoot) throw new Error('Windows system root is unavailable.');
  return join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
}

async function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Unable to allocate Windows Job fixture port.'));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function portIsFree(port: number) {
  return new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

async function waitFor(
  condition: () => boolean,
  message: string,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

async function waitForAsync(
  condition: () => Promise<boolean>,
  message: string,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

async function waitForExit(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Windows Job supervisor did not exit.')),
      10_000,
    );
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function startSupervisor(options: {
  faultInjection?: 'assign-process';
  faultContext?: boolean;
  mode: 'success' | 'failure' | 'hang' | 'root-exit';
  port: number;
}) {
  const directory = nextOwnedOutputDirectory();
  ownedDirectories.add(directory);
  await mkdir(directory, { recursive: false });
  const configurationPath = join(directory, 'windows-job-input.json');
  await writeFile(
    configurationPath,
    JSON.stringify({
      version: 1,
      executable: process.execPath,
      arguments: [fixturePath],
      workingDirectory: fileURLToPath(new URL('..', import.meta.url)),
      role: 'playwright',
      ownerPid: process.pid,
      ...(options.faultInjection === undefined
        ? {}
        : { faultInjection: options.faultInjection }),
    }),
    { encoding: 'utf8', flag: 'wx' },
  );
  const child = spawn(
    powershellPath(),
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      supervisorPath,
      configurationPath,
    ],
    {
      env: {
        ...process.env,
        BBX_E2E_INTERNAL_CONTROLLER_CONTEXT: 'bbx-e2e-controller-harness-v1',
        BBX_E2E_INTERNAL_CONTROLLER_MODE: options.mode,
        BBX_E2E_INTERNAL_CONTROLLER_PORT: String(options.port),
        BBX_E2E_OWNED_OUTPUT_DIR: directory,
        BBX_E2E_OWNERSHIP_TOKEN: randomBytes(32).toString('base64url'),
        ...(options.faultInjection === undefined ||
        options.faultContext === false
          ? {}
          : {
              BBX_E2E_INTERNAL_JOB_FAULT_CONTEXT: 'bbx-e2e-job-fault-v1',
            }),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  activeSupervisors.add(child);
  let output = '';
  child.stdout?.on('data', (chunk) => (output += String(chunk)));
  child.stderr?.on('data', (chunk) => (output += String(chunk)));
  return { child, directory, output: () => output };
}

function phasePid(output: string, phase: string) {
  const match = new RegExp(`BBX_E2E_PHASE ${phase} pid=([0-9]+)`).exec(output);
  return match ? Number(match[1]) : undefined;
}

async function cleanupOwnedResources() {
  const failures: unknown[] = [];
  for (const child of activeSupervisors) {
    try {
      if (child.exitCode === null && child.signalCode === null) {
        if (!child.kill('SIGKILL'))
          throw new Error('Exact supervisor termination failed.');
        await waitForExit(child);
      }
      activeSupervisors.delete(child);
    } catch (error) {
      failures.push(error);
    }
  }
  for (const directory of ownedDirectories) {
    try {
      await rm(directory, { recursive: true, force: true });
      ownedDirectories.delete(directory);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0)
    throw new AggregateError(failures, 'Windows Job test teardown failed.');
}

async function runWithExactCleanup(
  action: () => Promise<void>,
  cleanup: () => Promise<void>,
) {
  let actionFailure: unknown;
  let cleanupFailure: unknown;
  try {
    await action();
  } catch (error) {
    actionFailure = error;
  } finally {
    try {
      await cleanup();
    } catch (error) {
      cleanupFailure = error;
    }
  }
  if (actionFailure !== undefined && cleanupFailure !== undefined)
    throw new AggregateError(
      [actionFailure, cleanupFailure],
      'Windows Job assertion and cleanup both failed.',
    );
  if (cleanupFailure !== undefined) throw cleanupFailure;
  if (actionFailure !== undefined) throw actionFailure;
}

function it(name: string, body: () => Promise<void>, timeout?: number) {
  return vitestIt(
    name,
    () => runWithExactCleanup(body, cleanupOwnedResources),
    timeout,
  );
}

async function expectRootResult(mode: 'success' | 'failure', exitCode: number) {
  const port = await freePort();
  const supervisor = await startSupervisor({ mode, port });
  await waitForExit(supervisor.child);
  const output = supervisor.output();
  expect(supervisor.child.exitCode).toBe(exitCode);
  expect(output.indexOf('windows-job-child-assigned')).toBeGreaterThan(
    output.indexOf('windows-job-child-created'),
  );
  expect(output.indexOf('windows-job-child-resumed')).toBeGreaterThan(
    output.indexOf('windows-job-child-assigned'),
  );
  expect(output.indexOf('windows-job-cleanup-complete')).toBeGreaterThan(
    output.indexOf('windows-job-child-result-observed'),
  );
  const evidence = JSON.parse(
    await readFile(
      join(supervisor.directory, 'windows-job-result.json'),
      'utf8',
    ),
  );
  expect(evidence).toMatchObject({
    supervisorPid: supervisor.child.pid,
    exitCode,
    childAssignedBeforeResume: true,
    jobCleanupCompleted: true,
  });
}

describe.skipIf(process.platform !== 'win32')('Windows Job supervisor', () => {
  it('stores only bounded non-secret launch metadata', async () => {
    const port = await freePort();
    const supervisor = await startSupervisor({ mode: 'hang', port });
    const configuration = JSON.parse(
      await readFile(
        join(supervisor.directory, 'windows-job-input.json'),
        'utf8',
      ),
    );
    expect(Object.keys(configuration).sort()).toEqual([
      'arguments',
      'executable',
      'ownerPid',
      'role',
      'version',
      'workingDirectory',
    ]);
    expect(JSON.stringify(configuration)).not.toContain(
      'BBX_E2E_OWNERSHIP_TOKEN',
    );
  });

  it('preserves a successful root result after ordered assignment', async () => {
    await expectRootResult('success', 0);
  });

  it('preserves a nonzero root result after ordered assignment', async () => {
    await expectRootResult('failure', 17);
  });

  it('terminates the exact suspended child when Job assignment fails', async () => {
    const port = await freePort();
    const supervisor = await startSupervisor({
      mode: 'hang',
      port,
      faultInjection: 'assign-process',
    });
    await waitForExit(supervisor.child);
    const output = supervisor.output();
    const childPid = phasePid(output, 'windows-job-child-created')!;

    expect(supervisor.child.exitCode).not.toBe(0);
    expect(childPid).toBeTypeOf('number');
    expect(output).toContain('windows-job-unassigned-child-terminated');
    expect(output).not.toContain('windows-job-child-assigned');
    expect(output).not.toContain('windows-job-child-resumed');
    expect(output).toContain(
      'BBX_E2E_PHASE windows-job-supervisor-failed error-code=1',
    );
    await waitFor(
      () => probeProcessState(childPid) === 'absent',
      'Unassigned suspended child remained present.',
    );
    expect(await portIsFree(port)).toBe(true);
    await expect(
      readFile(join(supervisor.directory, 'windows-job-started.json'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects assignment fault injection outside the exact internal context', async () => {
    const port = await freePort();
    const supervisor = await startSupervisor({
      mode: 'hang',
      port,
      faultInjection: 'assign-process',
      faultContext: false,
    });
    await waitForExit(supervisor.child);

    expect(supervisor.child.exitCode).not.toBe(0);
    expect(supervisor.output()).not.toContain('windows-job-child-created');
    expect(await portIsFree(port)).toBe(true);
  });

  it('closes the Job after root exit and removes its surviving descendant', async () => {
    const port = await freePort();
    const supervisor = await startSupervisor({ mode: 'root-exit', port });
    await waitForExit(supervisor.child);
    const rootPid = phasePid(supervisor.output(), 'playwright-spawned')!;
    const descendantPid = phasePid(
      supervisor.output(),
      'controller-fixture-ready',
    )!;
    expect(supervisor.child.exitCode).toBe(0);
    await waitFor(
      () =>
        probeProcessState(rootPid) === 'absent' &&
        probeProcessState(descendantPid) === 'absent',
      'Windows Job members remained after root exit.',
    );
    expect(await portIsFree(port)).toBe(true);
  });

  it('closes the Job when the supervisor is externally terminated', async () => {
    const port = await freePort();
    const supervisor = await startSupervisor({ mode: 'hang', port });
    await waitFor(
      () => supervisor.output().includes('controller-fixture-ready'),
      'Windows Job fixture did not become ready.',
    );
    await waitForAsync(
      async () => !(await portIsFree(port)),
      'Windows Job fixture did not bind its port.',
    );
    const rootPid = phasePid(supervisor.output(), 'playwright-spawned')!;
    const descendantPid = phasePid(
      supervisor.output(),
      'controller-fixture-ready',
    )!;
    expect(supervisor.child.kill('SIGKILL')).toBe(true);
    await waitForExit(supervisor.child);
    await waitFor(
      () =>
        probeProcessState(rootPid) === 'absent' &&
        probeProcessState(descendantPid) === 'absent',
      'Supervisor termination did not close the Windows Job.',
    );
    expect(await portIsFree(port)).toBe(true);
  });

  it('keeps concurrent Jobs isolated', async () => {
    const firstPort = await freePort();
    let secondPort = await freePort();
    while (secondPort === firstPort) secondPort = await freePort();
    const first = await startSupervisor({ mode: 'hang', port: firstPort });
    const second = await startSupervisor({ mode: 'hang', port: secondPort });
    await waitFor(
      () =>
        first.output().includes('controller-fixture-ready') &&
        second.output().includes('controller-fixture-ready'),
      'Concurrent Windows Jobs did not become ready.',
    );
    await waitForAsync(
      async () =>
        !(await portIsFree(firstPort)) && !(await portIsFree(secondPort)),
      'Concurrent Windows Job listeners did not bind.',
    );
    const secondRoot = phasePid(second.output(), 'playwright-spawned')!;
    const secondDescendant = phasePid(
      second.output(),
      'controller-fixture-ready',
    )!;
    expect(first.child.kill('SIGKILL')).toBe(true);
    await waitForExit(first.child);
    await waitForAsync(
      () => portIsFree(firstPort),
      'First Windows Job listener remained.',
    );
    expect(probeProcessState(secondRoot)).toBe('live');
    expect(probeProcessState(secondDescendant)).toBe('live');
    expect(await portIsFree(secondPort)).toBe(false);
  });
});
