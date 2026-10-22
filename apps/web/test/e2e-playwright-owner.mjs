import { spawn } from 'node:child_process';
import { lstat, rm } from 'node:fs/promises';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { terminateOwnedProcess } from './e2e-process-control.mjs';

const INTERNAL_MARKER = 'bbx-e2e-controller-harness-v1';
const playwrightCli = fileURLToPath(
  new URL('../node_modules/@playwright/test/cli.js', import.meta.url),
);
const fixturePath = fileURLToPath(
  new URL('./e2e-controller-fixture.mjs', import.meta.url),
);
const webRoot = fileURLToPath(new URL('..', import.meta.url));
const outputRoot = resolve(tmpdir());
const outputPath = resolve(outputRoot, `bbx-e2e-output-${process.pid}`);
const internalTest =
  process.env.BBX_E2E_INTERNAL_CONTROLLER_CONTEXT === INTERNAL_MARKER;
const internalMode = process.env.BBX_E2E_INTERNAL_CONTROLLER_MODE ?? 'hang';

function insideOwnedOutput(path) {
  const child = relative(outputRoot, path);
  return (
    child !== '' &&
    !child.startsWith(`..${sep}`) &&
    !child.includes(sep) &&
    /^bbx-e2e-output-[1-9][0-9]*$/.test(basename(path)) &&
    dirname(path) === outputRoot
  );
}

if (!insideOwnedOutput(outputPath))
  throw new Error('Invalid process-owned Playwright output path.');
try {
  await lstat(outputPath);
  throw new Error('Process-owned Playwright output path already exists.');
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

function send(message) {
  if (process.connected) process.send?.(message);
}

function phase(name, details = {}) {
  send({ type: 'phase', name, details });
}

const arguments_ = internalTest
  ? [fixturePath]
  : [
      playwrightCli,
      'test',
      '--config=playwright.config.mjs',
      `--output=${outputPath}`,
      ...process.argv.slice(2),
    ];

const child = spawn(process.execPath, arguments_, {
  cwd: webRoot,
  detached: true,
  env: {
    ...process.env,
    BBX_E2E_OWNED_OUTPUT_DIR: outputPath,
    ...(internalTest && internalMode === 'signal'
      ? { BBX_E2E_INTERNAL_CONTROLLER_MODE: 'hang' }
      : {}),
    PW_DISABLE_TS_ESM: '1',
  },
  stdio: 'inherit',
  windowsHide: true,
});
phase('playwright-spawn-requested', { pid: child.pid ?? 0 });
child.once('spawn', () => {
  phase('playwright-spawned', { pid: child.pid ?? 0 });
  if (internalTest && internalMode === 'signal') child.kill('SIGTERM');
});

let cleanupPromise;
let requestedExitCode = 1;
let terminalResultSent = false;
let terminalAcknowledged = false;
let expectedDisconnect = false;
let resolveAcknowledgement;
const acknowledgement = new Promise((resolvePromise) => {
  resolveAcknowledgement = resolvePromise;
});

async function outputIsAbsent() {
  try {
    await lstat(outputPath);
    return false;
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
}

async function sendTerminalResult(result) {
  if (terminalResultSent) throw new Error('Duplicate terminal result.');
  terminalResultSent = true;
  await new Promise((resolvePromise, reject) => {
    if (!process.connected) {
      reject(new Error('Controller IPC disconnected before terminal result.'));
      return;
    }
    process.send?.(result, (error) =>
      error ? reject(error) : resolvePromise(),
    );
  });
  phase('owner-terminal-result-sent', { 'exit-code': result.exitCode });
  await Promise.race([
    acknowledgement,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error('Controller did not acknowledge result.')),
        5_000,
      ),
    ),
  ]);
}

async function cleanup(exitCode = requestedExitCode) {
  if (cleanupPromise !== undefined) return cleanupPromise;
  requestedExitCode = exitCode;
  cleanupPromise = Promise.resolve().then(async () => {
    phase('playwright-owner-cleanup-start', { pid: process.pid });
    let cleanupErrorCode = 0;
    let processAlreadyAbsent = false;
    try {
      const processCleanup = await terminateOwnedProcess(child);
      processAlreadyAbsent = processCleanup.alreadyAbsent;
      if (!insideOwnedOutput(outputPath))
        throw new Error('Refusing unsafe Playwright output cleanup.');
      if (
        internalTest &&
        process.env.BBX_E2E_INTERNAL_CLEANUP_FAILURE === 'injected'
      )
        throw new Error('Injected owned cleanup failure.');
      await rm(outputPath, { recursive: true, force: true });
      if (!(await outputIsAbsent()))
        throw new Error('Owned Playwright output remained after cleanup.');
    } catch {
      cleanupErrorCode = 1;
      requestedExitCode = 1;
      if (insideOwnedOutput(outputPath))
        await rm(outputPath, { recursive: true, force: true }).catch(
          () => undefined,
        );
    }
    phase('playwright-owner-cleanup-complete', {
      pid: process.pid,
      'cleanup-error-code': cleanupErrorCode,
      'process-already-absent': processAlreadyAbsent ? 1 : 0,
    });
    await sendTerminalResult({
      type: 'result',
      version: 1,
      exitCode: requestedExitCode,
      cleanupSucceeded: cleanupErrorCode === 0,
      cleanupErrorCode,
    });
    expectedDisconnect = true;
    if (process.connected) process.disconnect();
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    process.exit(0);
  });
  return cleanupPromise;
}

child.once('error', () => void cleanup(1));
child.once('exit', (code, signal) => {
  phase('playwright-child-exit', {
    'exit-code': code ?? 0,
    signaled: signal === null ? 0 : 1,
  });
  void cleanup(code ?? (signal === null ? 1 : 130));
});
process.on('message', (message) => {
  if (message?.type === 'shutdown') void cleanup(130);
  if (
    message?.type === 'result-ack' &&
    terminalResultSent &&
    !terminalAcknowledged
  ) {
    terminalAcknowledged = true;
    phase('owner-terminal-result-acknowledged');
    resolveAcknowledgement();
  }
});
process.once('disconnect', () => {
  phase('owner-ipc-disconnect', { expected: expectedDisconnect ? 1 : 0 });
  if (!terminalResultSent) void cleanup(130);
});
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => void cleanup(130));
