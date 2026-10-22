import { spawnSync } from 'node:child_process';

const PHASE = /^[a-z0-9-]+$/;

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
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error('Owned E2E process did not exit.')),
        timeoutMs,
      ),
    ),
  ]);
}

function terminate(child, signal) {
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function processIsAbsent(processId) {
  if (!Number.isSafeInteger(processId) || processId < 1) return false;
  try {
    process.kill(processId, 0);
    return false;
  } catch (error) {
    return error?.code === 'ESRCH';
  }
}

export async function terminateOwnedProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null)
    return { alreadyAbsent: true };
  terminate(child, 'SIGTERM');
  try {
    await waitForOwnedProcessExit(child, 5_000);
  } catch {
    if (processIsAbsent(child.pid)) return { alreadyAbsent: true };
    terminate(child, 'SIGKILL');
    try {
      await waitForOwnedProcessExit(child, 5_000);
    } catch (error) {
      if (!processIsAbsent(child.pid)) throw error;
      return { alreadyAbsent: true };
    }
  }
  if (
    child.exitCode === null &&
    child.signalCode === null &&
    !processIsAbsent(child.pid)
  )
    throw new Error('Owned E2E process cleanup did not converge.');
  return { alreadyAbsent: false };
}
