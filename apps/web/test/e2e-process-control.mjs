import { performance } from 'node:perf_hooks';

const PHASE = /^[a-z0-9-]+$/;
const MAX_PHASE_TIMEOUT_MS = 300_000;

function childHasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function validateTimeout(timeoutMs) {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_PHASE_TIMEOUT_MS
  )
    throw new Error('Invalid owned-process phase timeout.');
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

export function emitE2eRecord(name, details) {
  if (!PHASE.test(name)) throw new Error('Invalid E2E record name.');
  const serialized = JSON.stringify({ name, ...details });
  if (serialized === undefined || serialized.includes('\n'))
    throw new Error('Invalid E2E record details.');
  process.stdout.write(`BBX_E2E_RECORD ${serialized}\n`);
}

export async function waitForOwnedProcessExit(child, timeoutMs) {
  validateTimeout(timeoutMs);
  if (childHasExited(child))
    return { exitCode: child.exitCode, signalCode: child.signalCode };

  const startedAt = performance.now();
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const onExit = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: child.exitCode, signalCode: child.signalCode });
    };
    const rejectAtDeadline = () => {
      if (settled) return;
      settled = true;
      child.removeListener('exit', onExit);
      const elapsedMs = Math.max(0, performance.now() - startedAt);
      reject(
        new Error(
          `Owned E2E process did not exit within its monotonic phase (${Math.round(
            elapsedMs,
          )} ms).`,
        ),
      );
    };
    child.once('exit', onExit);
    timer = setTimeout(rejectAtDeadline, timeoutMs);
    timer.unref?.();
    if (childHasExited(child)) onExit();
  });
}

export async function terminateOwnedProcess(
  child,
  {
    requestShutdown = () => child.kill('SIGTERM'),
    cooperativeTimeoutMs = 5_000,
    forcedTimeoutMs = 5_000,
  } = {},
) {
  validateTimeout(cooperativeTimeoutMs);
  validateTimeout(forcedTimeoutMs);
  if (childHasExited(child)) return { alreadyExited: true, forced: false };

  let requestFailed = false;
  try {
    requestShutdown();
  } catch {
    requestFailed = true;
  }
  if (!requestFailed) {
    try {
      await waitForOwnedProcessExit(child, cooperativeTimeoutMs);
      return { alreadyExited: false, forced: false };
    } catch {
      if (childHasExited(child)) return { alreadyExited: false, forced: false };
    }
  }

  const forced = true;
  child.kill('SIGKILL');
  await waitForOwnedProcessExit(child, forcedTimeoutMs);
  return { alreadyExited: false, forced };
}
