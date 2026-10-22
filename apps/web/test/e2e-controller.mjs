import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  emitE2ePhase,
  terminateOwnedProcess,
  waitForOwnedProcessExit,
} from './e2e-process-control.mjs';

const ownerPath = fileURLToPath(
  new URL('./e2e-playwright-owner.mjs', import.meta.url),
);
const INTERNAL_MARKER = 'bbx-e2e-controller-harness-v1';
const internalTest =
  process.env.BBX_E2E_INTERNAL_CONTROLLER_CONTEXT === INTERNAL_MARKER;
const configuredTimeout = Number(process.env.BBX_E2E_INTERNAL_OUTER_TIMEOUT_MS);
const outerTimeoutMs =
  internalTest &&
  Number.isSafeInteger(configuredTimeout) &&
  configuredTimeout >= 100 &&
  configuredTimeout <= 10_000
    ? configuredTimeout
    : 240_000;

emitE2ePhase('controller-start', { pid: process.pid });
const ownerEnvironment = { ...process.env };
delete ownerEnvironment.PW_DISABLE_TS_ESM;
const owner = fork(ownerPath, process.argv.slice(2), {
  detached: true,
  env: ownerEnvironment,
  stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  windowsHide: true,
});
emitE2ePhase('playwright-owner-spawned', { pid: owner.pid ?? 0 });

let finishing = false;
let terminalResult = null;
let resultCount = 0;
let watchdogExpired = false;
const watchdog = setTimeout(() => {
  watchdogExpired = true;
  void finish(1, 'outer-timeout', true);
}, outerTimeoutMs);
watchdog.unref();

async function finish(requestedExitCode, phase, terminate) {
  if (finishing) return;
  finishing = true;
  clearTimeout(watchdog);
  if (terminate && owner.connected) owner.send({ type: 'shutdown' });
  if (terminate) {
    try {
      await waitForOwnedProcessExit(owner, 10_000);
    } catch {
      await terminateOwnedProcess(owner);
    }
  }
  const finalExitCode =
    terminate && requestedExitCode === 0
      ? owner.exitCode === 0 &&
        owner.signalCode === null &&
        resultCount === 1 &&
        terminalResult !== null &&
        terminalResult.cleanupSucceeded
        ? terminalResult.exitCode
        : 1
      : requestedExitCode;
  emitE2ePhase('controller-watchdog-state', {
    expired: watchdogExpired ? 1 : 0,
  });
  emitE2ePhase(phase, { 'exit-code': finalExitCode });
  process.exit(finalExitCode);
}

owner.on('message', (message) => {
  if (message?.type === 'phase') emitE2ePhase(message.name, message.details);
  if (message?.type === 'result') {
    resultCount += 1;
    const valid =
      resultCount === 1 &&
      message.version === 1 &&
      Number.isInteger(message.exitCode) &&
      message.exitCode >= 0 &&
      message.exitCode <= 255 &&
      typeof message.cleanupSucceeded === 'boolean' &&
      Number.isInteger(message.cleanupErrorCode) &&
      message.cleanupErrorCode >= 0 &&
      message.cleanupErrorCode <= 255 &&
      (message.cleanupSucceeded
        ? message.cleanupErrorCode === 0
        : message.cleanupErrorCode !== 0);
    if (!valid) {
      terminalResult = null;
      return;
    }
    terminalResult = message;
    emitE2ePhase('controller-terminal-result-received', {
      'exit-code': message.exitCode,
      'cleanup-error-code': message.cleanupErrorCode,
    });
    if (owner.connected) owner.send({ type: 'result-ack', version: 1 });
  }
});
owner.once('error', () => void finish(1, 'playwright-owner-failed', true));
owner.once('exit', (code, signal) => {
  emitE2ePhase('playwright-owner-exit-observed', {
    'exit-code': code ?? 0,
    signaled: signal === null ? 0 : 1,
    'result-count': resultCount,
  });
  if (!finishing) {
    const validSuccess =
      code === 0 &&
      signal === null &&
      resultCount === 1 &&
      terminalResult !== null &&
      terminalResult.cleanupSucceeded;
    void finish(
      validSuccess ? terminalResult.exitCode : 1,
      'playwright-owner-exit',
      false,
    );
  }
});
owner.once('disconnect', () => {
  emitE2ePhase('controller-owner-ipc-disconnect', {
    'terminal-result-received': terminalResult === null ? 0 : 1,
  });
});
process.on('message', (message) => {
  if (message?.type === 'shutdown')
    void finish(0, 'controller-shutdown-requested', true);
});
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => void finish(130, 'controller-signal', true));
