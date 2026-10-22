import { fork, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const serverPath = fileURLToPath(new URL('./e2e-server.mjs', import.meta.url));
const playwrightControllerPath = fileURLToPath(
  new URL('./e2e-controller.mjs', import.meta.url),
);
const nextEnvironmentPath = fileURLToPath(
  new URL('../next-env.d.ts', import.meta.url),
);
const active = new Set<ChildProcess>();

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Unable to allocate a fixture port.'));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

function startController(mode: string, appPort: number, proxyPort: number) {
  const child = fork(serverPath, [], {
    detached: true,
    env: {
      ...process.env,
      BBX_E2E_APP_PORT: String(appPort),
      BBX_E2E_PROXY_PORT: String(proxyPort),
      BBX_E2E_TRUSTED_PROXY_TOKEN: 'fixture_proxy_token_012345678901',
      BBX_E2E_INTERNAL_TEST_CONTEXT: 'bbx-e2e-harness-v1',
      BBX_E2E_INTERNAL_FIXTURE_MODE: mode,
      BBX_E2E_INTERNAL_STARTUP_TIMEOUT_MS: '2000',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  active.add(child);
  let output = '';
  child.stdout?.on('data', (chunk) => (output += String(chunk)));
  child.stderr?.on('data', (chunk) => (output += String(chunk)));
  return { child, output: () => output };
}

function startPlaywrightController(
  port: number,
  options: {
    mode?: 'hang' | 'success' | 'failure' | 'signal' | 'already-absent';
    cleanupFailure?: boolean;
    outerTimeoutMs?: number;
  } = {},
) {
  const child = fork(playwrightControllerPath, [], {
    detached: true,
    env: {
      ...process.env,
      BBX_E2E_INTERNAL_CONTROLLER_CONTEXT: 'bbx-e2e-controller-harness-v1',
      BBX_E2E_INTERNAL_CONTROLLER_PORT: String(port),
      BBX_E2E_INTERNAL_CONTROLLER_MODE: options.mode ?? 'hang',
      ...(options.cleanupFailure
        ? { BBX_E2E_INTERNAL_CLEANUP_FAILURE: 'injected' }
        : {}),
      ...(options.outerTimeoutMs === undefined
        ? {}
        : {
            BBX_E2E_INTERNAL_OUTER_TIMEOUT_MS: String(options.outerTimeoutMs),
          }),
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  active.add(child);
  let output = '';
  child.stdout?.on('data', (chunk) => (output += String(chunk)));
  child.stderr?.on('data', (chunk) => (output += String(chunk)));
  return { child, output: () => output };
}

async function pathExists(path: string) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(
  condition: () => boolean,
  message: string,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

async function waitForExit(child: ChildProcess, timeoutMs = 5_000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error('Controller did not exit.')),
        timeoutMs,
      ),
    ),
  ]);
}

function processAbsent(processId: number) {
  try {
    process.kill(processId, 0);
    return false;
  } catch {
    return true;
  }
}

async function portIsFree(port: number) {
  return new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

function phasePid(output: string, phase: string) {
  const match = new RegExp(`BBX_E2E_PHASE ${phase} pid=([0-9]+)`).exec(output);
  return match ? Number(match[1]) : undefined;
}

async function stopController(child: ChildProcess) {
  if (child.exitCode === null && child.signalCode === null && child.connected)
    child.send({ type: 'shutdown' });
  await waitForExit(child);
  active.delete(child);
}

afterEach(async () => {
  for (const child of active) {
    if (child.exitCode === null && child.signalCode === null) {
      if (process.platform === 'win32' && child.pid !== undefined)
        spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
      else child.kill('SIGKILL');
    }
    await waitForExit(child).catch(() => undefined);
  }
  active.clear();
});

describe('E2E server supervision', () => {
  it('spawns, reaches readiness, and cleans only its exact processes and ports', async () => {
    const appPort = await freePort();
    const proxyPort = await freePort();
    const sentinelPort = await freePort();
    const sentinel = createServer().listen(sentinelPort, '127.0.0.1');
    const controller = startController('ready', appPort, proxyPort);
    try {
      await waitFor(
        () => controller.output().includes('BBX_E2E_PHASE proxy-ready'),
        `Controller did not become ready.\n${controller.output()}`,
      );
      const workerPid = phasePid(controller.output(), 'server-worker-spawned');
      const appPid = phasePid(controller.output(), 'application-spawned');
      expect(workerPid).toBeTypeOf('number');
      expect(appPid).toBeTypeOf('number');
      expect((await fetch(`http://127.0.0.1:${proxyPort}/health`)).status).toBe(
        200,
      );
      await stopController(controller.child);
      await waitFor(
        () => processAbsent(workerPid!) && processAbsent(appPid!),
        'Owned E2E processes remained after shutdown.',
      );
      expect(await portIsFree(appPort)).toBe(true);
      expect(await portIsFree(proxyPort)).toBe(true);
      expect(await portIsFree(sentinelPort)).toBe(false);
      expect(controller.output()).toContain(
        'BBX_E2E_PHASE server-controller-cleanup-complete',
      );
    } finally {
      sentinel.close();
    }
  }, 15_000);

  it('propagates a failure before application spawn', async () => {
    const appPort = await freePort();
    const proxyPort = await freePort();
    const controller = startController('pre-spawn-failure', appPort, proxyPort);
    await waitForExit(controller.child);
    active.delete(controller.child);
    expect(controller.child.exitCode).toBe(1);
    expect(controller.output()).toContain(
      'BBX_E2E_PHASE application-pre-spawn-failure',
    );
    expect(controller.output()).not.toContain(
      'BBX_E2E_PHASE application-spawned',
    );
    expect(await portIsFree(appPort)).toBe(true);
    expect(await portIsFree(proxyPort)).toBe(true);
  }, 15_000);

  it('fails on the explicit startup timeout and removes the stalled child', async () => {
    const appPort = await freePort();
    const proxyPort = await freePort();
    const controller = startController('stall', appPort, proxyPort);
    await waitForExit(controller.child);
    active.delete(controller.child);
    const appPid = phasePid(controller.output(), 'application-spawned');
    expect(controller.child.exitCode).toBe(1);
    expect(controller.output()).toMatch(
      /BBX_E2E_PHASE (server-startup-timeout|server-worker-failed)/,
    );
    await waitFor(
      () => appPid !== undefined && processAbsent(appPid),
      'Stalled fixture child remained after startup timeout.',
    );
    expect(await portIsFree(appPort)).toBe(true);
    expect(await portIsFree(proxyPort)).toBe(true);
  }, 15_000);

  it('cleans worker, application, and listeners when the controller is externally terminated', async () => {
    const appPort = await freePort();
    const proxyPort = await freePort();
    const controller = startController('ready', appPort, proxyPort);
    await waitFor(
      () => controller.output().includes('BBX_E2E_PHASE proxy-ready'),
      `Controller did not become ready.\n${controller.output()}`,
    );
    const workerPid = phasePid(controller.output(), 'server-worker-spawned')!;
    const appPid = phasePid(controller.output(), 'application-spawned')!;
    if (process.platform === 'win32' && controller.child.pid !== undefined)
      spawnSync('taskkill.exe', ['/PID', String(controller.child.pid), '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    else controller.child.kill('SIGKILL');
    await waitForExit(controller.child);
    active.delete(controller.child);
    await waitFor(
      () => processAbsent(workerPid) && processAbsent(appPid),
      'Owned processes remained after external controller termination.',
    );
    expect(await portIsFree(appPort)).toBe(true);
    expect(await portIsFree(proxyPort)).toBe(true);
  }, 15_000);
});

describe('top-level Playwright ownership', () => {
  it('returns success only after a successful child and exact cleanup', async () => {
    const port = await freePort();
    const controller = startPlaywrightController(port, { mode: 'success' });
    await waitForExit(controller.child, 10_000);
    active.delete(controller.child);
    const ownerPid = phasePid(controller.output(), 'playwright-owner-spawned')!;
    const outputPath = join(tmpdir(), `bbx-e2e-output-${ownerPid}`);

    expect(controller.child.exitCode).toBe(0);
    expect(controller.output()).toContain(
      'BBX_E2E_PHASE playwright-child-exit exit-code=0 signaled=0',
    );
    expect(controller.output()).toContain(
      'BBX_E2E_PHASE playwright-owner-cleanup-complete',
    );
    expect(controller.output()).toContain('cleanup-error-code=0');
    expect(controller.output()).toContain(
      'BBX_E2E_PHASE controller-terminal-result-received exit-code=0 cleanup-error-code=0',
    );
    expect(controller.output()).toContain(
      'BBX_E2E_PHASE owner-terminal-result-acknowledged',
    );
    expect(controller.output()).toContain(
      'BBX_E2E_PHASE controller-owner-ipc-disconnect terminal-result-received=1',
    );
    expect(controller.output()).toContain(
      'BBX_E2E_PHASE playwright-owner-exit-observed exit-code=0 signaled=0 result-count=1',
    );
    expect(controller.output()).toContain(
      'BBX_E2E_PHASE controller-watchdog-state expired=0',
    );
    expect(await pathExists(outputPath)).toBe(false);
    expect(await portIsFree(port)).toBe(true);
  }, 15_000);

  it('preserves a nonzero child failure after cleanup', async () => {
    const port = await freePort();
    const controller = startPlaywrightController(port, { mode: 'failure' });
    await waitForExit(controller.child, 10_000);
    active.delete(controller.child);

    expect(controller.child.exitCode).toBe(17);
    expect(controller.output()).toContain(
      'BBX_E2E_PHASE playwright-child-exit exit-code=17 signaled=0',
    );
    expect(controller.output()).toContain(
      'BBX_E2E_PHASE controller-terminal-result-received exit-code=17 cleanup-error-code=0',
    );
    expect(await portIsFree(port)).toBe(true);
  }, 15_000);

  it('fails when the child is terminated by a signal', async () => {
    const port = await freePort();
    const controller = startPlaywrightController(port, { mode: 'signal' });
    await waitForExit(controller.child, 10_000);
    active.delete(controller.child);

    expect(controller.child.exitCode).toBe(130);
    expect(controller.output()).toContain(
      'BBX_E2E_PHASE playwright-child-exit exit-code=0 signaled=1',
    );
    expect(await portIsFree(port)).toBe(true);
  }, 15_000);

  it('accepts already-absent cleanup only after exact absence is verified', async () => {
    const port = await freePort();
    const controller = startPlaywrightController(port, {
      mode: 'already-absent',
    });
    await waitForExit(controller.child, 10_000);
    active.delete(controller.child);
    const ownerPid = phasePid(controller.output(), 'playwright-owner-spawned')!;
    const outputPath = join(tmpdir(), `bbx-e2e-output-${ownerPid}`);

    expect(controller.child.exitCode).toBe(0);
    expect(controller.output()).toContain('process-already-absent=1');
    expect(controller.output()).toContain('cleanup-error-code=0');
    expect(await pathExists(outputPath)).toBe(false);
  }, 15_000);

  it('turns a material cleanup failure into a controller failure', async () => {
    const port = await freePort();
    const controller = startPlaywrightController(port, {
      mode: 'hang',
      cleanupFailure: true,
    });
    await waitFor(
      () =>
        controller.output().includes('BBX_E2E_PHASE controller-fixture-ready'),
      `Controller fixture did not become ready.\n${controller.output()}`,
      10_000,
    );
    controller.child.send({ type: 'shutdown' });
    await waitForExit(controller.child, 10_000);
    active.delete(controller.child);
    const ownerPid = phasePid(controller.output(), 'playwright-owner-spawned')!;
    const outputPath = join(tmpdir(), `bbx-e2e-output-${ownerPid}`);

    expect(controller.child.exitCode).toBe(1);
    expect(controller.output()).toContain('cleanup-error-code=1');
    expect(controller.output()).toContain(
      'BBX_E2E_PHASE controller-terminal-result-received exit-code=1 cleanup-error-code=1',
    );
    expect(await pathExists(outputPath)).toBe(false);
  }, 15_000);

  it('does not replace an acknowledged success after IPC disconnect', async () => {
    const port = await freePort();
    const controller = startPlaywrightController(port, { mode: 'success' });
    await waitForExit(controller.child, 10_000);
    active.delete(controller.child);
    const output = controller.output();

    expect(controller.child.exitCode).toBe(0);
    expect(output.match(/owner-terminal-result-sent/g)).toHaveLength(1);
    expect(output.match(/controller-terminal-result-received/g)).toHaveLength(
      1,
    );
    expect(output.indexOf('controller-terminal-result-received')).toBeLessThan(
      output.indexOf('controller-owner-ipc-disconnect'),
    );
    expect(output).not.toContain('playwright-owner-failed');
  }, 15_000);

  it('fails on watchdog expiry and waits for exact owned cleanup', async () => {
    const port = await freePort();
    const controller = startPlaywrightController(port, {
      mode: 'hang',
      outerTimeoutMs: 250,
    });
    await waitForExit(controller.child, 15_000);
    active.delete(controller.child);
    const ownerPid = phasePid(controller.output(), 'playwright-owner-spawned')!;
    const fixturePid = phasePid(controller.output(), 'playwright-spawned')!;
    const descendantPid = phasePid(
      controller.output(),
      'controller-fixture-ready',
    )!;
    const outputPath = join(tmpdir(), `bbx-e2e-output-${ownerPid}`);

    expect(controller.child.exitCode).toBe(1);
    expect(controller.output()).toContain(
      'BBX_E2E_PHASE controller-watchdog-state expired=1',
    );
    expect(controller.output()).toContain('BBX_E2E_PHASE outer-timeout');
    await waitFor(
      () =>
        processAbsent(ownerPid) &&
        processAbsent(fixturePid) &&
        processAbsent(descendantPid),
      'Watchdog cleanup left an owned process running.',
      10_000,
    );
    expect(await pathExists(outputPath)).toBe(false);
    expect(await portIsFree(port)).toBe(true);
  }, 20_000);

  it('cleans an externally terminated controller without touching a concurrent owner', async () => {
    const originalNextEnvironment = await readFile(nextEnvironmentPath);
    const firstPort = await freePort();
    const secondPort = await freePort();
    const first = startPlaywrightController(firstPort);
    const second = startPlaywrightController(secondPort);
    await waitFor(
      () =>
        first.output().includes('BBX_E2E_PHASE controller-fixture-ready') &&
        second.output().includes('BBX_E2E_PHASE controller-fixture-ready'),
      `Controllers did not become ready.\n${first.output()}\n${second.output()}`,
      10_000,
    );
    const firstOwner = phasePid(first.output(), 'playwright-owner-spawned')!;
    const firstPlaywright = phasePid(first.output(), 'playwright-spawned')!;
    const firstDescendant = phasePid(
      first.output(),
      'controller-fixture-ready',
    )!;
    const secondOwner = phasePid(second.output(), 'playwright-owner-spawned')!;
    const secondOutputPath = join(tmpdir(), `bbx-e2e-output-${secondOwner}`);
    const firstOutputPath = join(tmpdir(), `bbx-e2e-output-${firstOwner}`);
    expect(await pathExists(firstOutputPath)).toBe(true);
    expect(await pathExists(secondOutputPath)).toBe(true);

    if (process.platform === 'win32' && first.child.pid !== undefined)
      spawnSync('taskkill.exe', ['/PID', String(first.child.pid), '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    else first.child.kill('SIGKILL');
    await waitForExit(first.child);
    active.delete(first.child);
    await waitFor(
      () =>
        processAbsent(firstOwner) &&
        processAbsent(firstPlaywright) &&
        processAbsent(firstDescendant),
      'The surviving owner did not clean the terminated controller tree.',
      10_000,
    );
    await waitFor(
      () => !processAbsent(secondOwner),
      'The concurrent owner was unexpectedly terminated.',
    );
    await waitFor(
      () => !processAbsent(phasePid(second.output(), 'playwright-spawned')!),
      'The concurrent Playwright fixture was unexpectedly terminated.',
    );
    await waitFor(
      () =>
        !processAbsent(phasePid(second.output(), 'controller-fixture-ready')!),
      'The concurrent descendant was unexpectedly terminated.',
    );
    expect(await pathExists(firstOutputPath)).toBe(false);
    expect(await pathExists(secondOutputPath)).toBe(true);
    expect(await portIsFree(firstPort)).toBe(true);
    expect(await portIsFree(secondPort)).toBe(false);
    expect(await readFile(nextEnvironmentPath)).toEqual(
      originalNextEnvironment,
    );

    second.child.send({ type: 'shutdown' });
    await waitForExit(second.child, 15_000);
    active.delete(second.child);
    expect(await pathExists(secondOutputPath)).toBe(false);
    expect(await portIsFree(secondPort)).toBe(true);
    expect(await readFile(nextEnvironmentPath)).toEqual(
      originalNextEnvironment,
    );
  }, 30_000);
});
