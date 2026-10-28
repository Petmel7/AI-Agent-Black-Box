'use strict';

/* eslint-disable @typescript-eslint/no-require-imports -- This fixture inspects the CommonJS preload boundary. */

const childProcess = require('node:child_process');
const { readFileSync } = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');

const ACTIVE_SYMBOL = Symbol.for('blackbox.e2e.playwrightSpawnGuard');
const GUARD_MARKER = 'BBX_E2E_PLAYWRIGHT_SPAWN_GUARD';
const ORACLE_EXIT = Object.freeze({
  blocked: 0,
  'tamper-succeeded': 3,
  'fixture-failed': 4,
});

function emitOracle(mode, outcome, code) {
  process.stdout.write(
    JSON.stringify({
      type: 'bbx-e2e-tamper-oracle',
      version: 1,
      mode,
      outcome,
      code,
    }),
  );
  process.exitCode = ORACLE_EXIT[outcome];
}

function emitLaunchOracle(mode, outcome, code) {
  process.stdout.write(
    JSON.stringify({
      type: 'bbx-e2e-launch-oracle',
      version: 1,
      mode,
      outcome,
      code,
    }),
  );
  process.exitCode = ORACLE_EXIT[outcome === 'blocked' ? 'blocked' : outcome];
}

function immutableValue(target, property, expected) {
  const descriptor = Object.getOwnPropertyDescriptor(target, property);
  return (
    descriptor?.value === expected &&
    descriptor.writable === false &&
    descriptor.configurable === false
  );
}

async function tamper(mode, target, property, guardedProperty) {
  const guardedContext = process.env[GUARD_MARKER] !== undefined;
  const attestation = globalThis[ACTIVE_SYMBOL];
  const guardedValue = attestation?.[guardedProperty];
  if (
    guardedContext &&
    (!Object.isFrozen(attestation) ||
      attestation?.version !== 2 ||
      typeof guardedValue !== 'function')
  ) {
    emitOracle(mode, 'fixture-failed', 'guard-attestation-invalid');
    return;
  }
  if (!guardedContext && attestation !== undefined) {
    emitOracle(mode, 'fixture-failed', 'unexpected-guard-attestation');
    return;
  }

  const replacement = function bbxTamperReplacement() {};
  let mutationError;
  try {
    target[property] = replacement;
  } catch (error) {
    mutationError = error;
  }

  if (mode === 'tamper-esm-spawn') syncBuiltinESMExports();
  const esmSpawn =
    mode === 'tamper-esm-spawn'
      ? (await import('node:child_process')).spawn
      : undefined;

  if (mutationError !== undefined) {
    if (
      guardedContext &&
      mutationError instanceof TypeError &&
      immutableValue(target, property, guardedValue) &&
      (mode !== 'tamper-esm-spawn' || esmSpawn === guardedValue)
    ) {
      emitOracle(mode, 'blocked', 'immutable-guard-preserved');
      return;
    }
    emitOracle(mode, 'fixture-failed', 'unexpected-mutation-error');
    return;
  }

  const descriptor = Object.getOwnPropertyDescriptor(target, property);
  if (
    target[property] === replacement &&
    descriptor?.value === replacement &&
    descriptor.writable === true &&
    descriptor.configurable === true &&
    (mode !== 'tamper-esm-spawn' || esmSpawn === replacement)
  ) {
    emitOracle(mode, 'tamper-succeeded', 'mutable-boundary-replaced');
    return;
  }
  emitOracle(mode, 'fixture-failed', 'mutation-result-inconsistent');
}

function invalidNodeOptions(mode) {
  const canonical = process.env.NODE_OPTIONS;
  const loader = process.env.BBX_E2E_TAMPER_LOADER;
  const preload = process.env.BBX_E2E_TAMPER_PRELOAD;
  if (
    typeof canonical !== 'string' ||
    typeof loader !== 'string' ||
    typeof preload !== 'string'
  )
    throw new Error('Invalid-launch fixture configuration is incomplete.');
  if (mode === 'alternate-require')
    return `--require=${JSON.stringify(preload)}`;
  if (mode === 'alternate-before')
    return `--require=${JSON.stringify(preload)} ${canonical}`;
  if (mode === 'alternate-after')
    return `${canonical} --require=${JSON.stringify(preload)}`;
  if (mode === 'import-before')
    return `--import=${JSON.stringify(loader)} ${canonical}`;
  if (mode === 'import-after')
    return `${canonical} --import=${JSON.stringify(loader)}`;
  if (mode === 'loader')
    return `${canonical} --loader=${JSON.stringify(loader)}`;
  if (mode === 'experimental-loader')
    return `${canonical} --experimental-loader=${JSON.stringify(loader)}`;
  throw new Error('Invalid-launch fixture mode is unknown.');
}

async function attemptInvalidLaunch() {
  const mode = process.env.BBX_E2E_INVALID_LAUNCH_MODE;
  if (typeof mode !== 'string') {
    emitLaunchOracle('unknown', 'fixture-failed', 'invalid-mode-missing');
    return;
  }
  const environment = {
    ...process.env,
    NODE_OPTIONS: invalidNodeOptions(mode),
  };
  let child;
  try {
    child = childProcess.spawn(process.execPath, [__filename, 'attest'], {
      env: environment,
      stdio: 'ignore',
    });
  } catch (error) {
    if (error?.code === 'e2e-playwright-spawn-guard-invalid') {
      emitLaunchOracle(mode, 'blocked', 'guarded-spawn-rejected');
      return;
    }
    emitLaunchOracle(mode, 'fixture-failed', 'unexpected-launch-error');
    return;
  }

  let spawned = false;
  child.once('spawn', () => {
    spawned = true;
  });
  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ kind: 'timeout' });
    }, 10_000);
    child.once('error', () => {
      clearTimeout(timer);
      resolve({ kind: 'error' });
    });
    child.once('close', () => {
      clearTimeout(timer);
      resolve({ kind: 'close' });
    });
  });
  if (result.kind === 'timeout') {
    emitLaunchOracle(mode, 'fixture-failed', 'launched-child-timeout');
    return;
  }
  if (!spawned || result.kind !== 'close') {
    emitLaunchOracle(mode, 'fixture-failed', 'launched-child-error');
    return;
  }
  emitLaunchOracle(mode, 'tamper-succeeded', 'invalid-child-launched');
}

function identity(processId) {
  const stat = readFileSync(`/proc/${processId}/stat`, 'utf8');
  const fields = stat
    .slice(stat.lastIndexOf(')') + 2)
    .trim()
    .split(/\s+/);
  return { processGroupId: Number(fields[2]), sessionId: Number(fields[3]) };
}

async function main() {
  const mode = process.argv[2];
  const attestation = globalThis[ACTIVE_SYMBOL];
  if (mode === 'attest') {
    const { spawn } = await import('node:child_process');
    if (
      !Object.isFrozen(attestation) ||
      childProcess.spawn !== attestation?.guardedSpawn ||
      spawn !== attestation.guardedSpawn ||
      process.kill !== attestation.guardedKill
    )
      throw new Error('Canonical preload attestation was not installed.');
    process.stdout.write('attested');
    return;
  }
  if (mode === 'worker-child') {
    if (!Object.isFrozen(attestation))
      throw new Error('Worker did not inherit the canonical preload.');
    process.stdout.write('worker-attested');
    await new Promise((resolve) => setTimeout(resolve, 200));
    return;
  }
  if (mode === 'worker-parent') {
    const child = childProcess.spawn(
      process.execPath,
      [__filename, 'worker-child'],
      {
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (data) => (stdout += data));
    child.stderr.on('data', (data) => (stderr += data));
    const result = await new Promise((resolve) =>
      child.once('close', (code, signal) => resolve({ code, signal })),
    );
    if (
      result.code !== 0 ||
      result.signal !== null ||
      stdout !== 'worker-attested'
    )
      throw new Error(`Worker preload failed with ${stderr.length} bytes.`);
    process.stdout.write('worker-propagated');
    return;
  }
  if (mode === 'tamper-commonjs-spawn') {
    await tamper(mode, childProcess, 'spawn', 'guardedSpawn');
    return;
  }
  if (mode === 'tamper-process-kill') {
    await tamper(mode, process, 'kill', 'guardedKill');
    return;
  }
  if (mode === 'tamper-esm-spawn') {
    await tamper(mode, childProcess, 'spawn', 'guardedSpawn');
    return;
  }
  if (mode === 'invalid-launch') {
    await attemptInvalidLaunch();
    return;
  }
  if (mode === 'pinned-launcher') {
    const { launchProcess } = require(process.env.BBX_E2E_PINNED_LAUNCHER);
    const parent = identity(process.pid);
    let resolveExit;
    const exited = new Promise((resolve) => (resolveExit = resolve));
    const launched = await launchProcess({
      command: process.execPath,
      args: [__filename, 'worker-child'],
      env: process.env,
      cwd: process.cwd(),
      shell: false,
      stdio: 'pipe',
      tempDirectories: [],
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      attemptToGracefullyClose: async () => undefined,
      log: () => undefined,
      onExit: (code, signal) => resolveExit({ code, signal }),
    });
    const launchedIdentity = identity(launched.launchedProcess.pid);
    const outcome = await exited;
    if (
      outcome.code !== 0 ||
      outcome.signal !== null ||
      launchedIdentity.processGroupId !== parent.processGroupId ||
      launchedIdentity.sessionId !== parent.sessionId
    )
      throw new Error('Pinned Playwright launcher escaped the guarded group.');
    process.stdout.write('pinned-launcher-guarded');
    return;
  }
  throw new Error('Unknown preload probe mode.');
}

void main().catch((error) => {
  if (process.argv[2]?.startsWith('tamper-')) {
    emitOracle(process.argv[2], 'fixture-failed', 'unexpected-fixture-crash');
    return;
  }
  if (process.argv[2] === 'invalid-launch') {
    emitLaunchOracle(
      process.env.BBX_E2E_INVALID_LAUNCH_MODE ?? 'unknown',
      'fixture-failed',
      'unexpected-fixture-crash',
    );
    return;
  }
  process.stderr.write(String(error?.message ?? error));
  process.exitCode = 1;
});
