import { fork } from 'node:child_process';
import { lstat, rm, rmdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  INTERNAL_CONTROLLER_MARKER,
  runConfigurationFromEnvironment,
  validateRunConfiguration,
} from './e2e-controller.mjs';
import { emitE2ePhase, terminateOwnedProcess } from './e2e-process-control.mjs';

const playwrightCli = fileURLToPath(
  new URL('../node_modules/@playwright/test/cli.js', import.meta.url),
);
const fixturePath = fileURLToPath(
  new URL('./e2e-controller-fixture.mjs', import.meta.url),
);
const ownerPath = fileURLToPath(import.meta.url);
const webRoot = fileURLToPath(new URL('..', import.meta.url));
const internalOnlyKeys = Object.freeze([
  'BBX_E2E_INTERNAL_FIXTURE_MODE',
  'BBX_E2E_INTERNAL_CLEANUP_FAILURE',
  'BBX_E2E_INTERNAL_CLEANUP_RESULT_MODE',
  'BBX_E2E_INTERNAL_LIFECYCLE_MODE',
  'BBX_E2E_INTERNAL_PRESERVE_PATH',
  'BBX_E2E_INTERNAL_PROTOCOL_MODE',
  'BBX_E2E_INTERNAL_PHASE_TIMEOUT_MS',
  'BBX_E2E_INTERNAL_OUTER_TIMEOUT_MS',
]);

function internalMarkerIsExact(environment) {
  return (
    environment.BBX_E2E_INTERNAL_CONTROLLER_CONTEXT ===
    INTERNAL_CONTROLLER_MARKER
  );
}

export function createFinalLaunchPlan(
  configurationCandidate,
  controllerArguments,
  environment,
) {
  const configuration = validateRunConfiguration(configurationCandidate);
  const internalFixture = internalMarkerIsExact(environment);
  if (
    !internalFixture &&
    internalOnlyKeys.some((key) => environment[key] !== undefined)
  )
    throw new Error(
      'Internal E2E launch options require the exact authenticated marker.',
    );

  const childEnvironment = {
    ...environment,
    PW_DISABLE_TS_ESM: '1',
  };
  return Object.freeze(
    internalFixture
      ? {
          kind: 'authenticated-no-browser-fixture',
          modulePath: fixturePath,
          arguments: Object.freeze([]),
          environment: Object.freeze(childEnvironment),
          configuration,
        }
      : {
          kind: 'playwright',
          modulePath: playwrightCli,
          arguments: Object.freeze([
            'test',
            '--config=playwright.config.mjs',
            `--output=${configuration.outputPath}`,
            ...controllerArguments,
          ]),
          environment: Object.freeze(childEnvironment),
          configuration,
        },
  );
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

async function assertPathsInitiallyAbsent(configuration) {
  for (const path of [
    configuration.runRoot,
    configuration.outputPath,
    configuration.reportPath,
    configuration.resultPath,
  ])
    if (!(await pathIsAbsent(path)))
      throw new Error('E2E owner received an existing run-owned path.');
}

function parseInternalPhaseTimeout(environment) {
  if (!internalMarkerIsExact(environment)) return 10_000;
  const raw = environment.BBX_E2E_INTERNAL_PHASE_TIMEOUT_MS;
  if (raw === undefined) return 10_000;
  if (!/^[1-9][0-9]{2,4}$/.test(raw))
    throw new Error('Invalid internal owner phase timeout.');
  const timeout = Number(raw);
  if (timeout < 100 || timeout > 60_000)
    throw new Error('Invalid internal owner phase timeout.');
  return timeout;
}

function send(message) {
  if (!process.connected)
    return Promise.reject(new Error('Controller IPC is disconnected.'));
  return new Promise((resolvePromise, reject) => {
    process.send?.(message, (error) =>
      error ? reject(error) : resolvePromise(undefined),
    );
  });
}

function phase(name, details = {}) {
  if (process.connected) process.send?.({ type: 'phase', name, details });
  else emitE2ePhase(name, details);
}

async function removeOwnerPaths(configuration, preservePath) {
  const errors = [];
  for (const [name, path] of [
    ['output', configuration.outputPath],
    ['report', configuration.reportPath],
  ]) {
    if (preservePath === name) continue;
    try {
      await rm(path, { recursive: true, force: true });
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    await rmdir(configuration.runRoot);
  } catch (error) {
    if (error?.code !== 'ENOENT') errors.push(error);
  }

  const remainingPaths = [];
  for (const path of [
    configuration.outputPath,
    configuration.reportPath,
    configuration.resultPath,
    configuration.runRoot,
  ])
    if (!(await pathIsAbsent(path))) remainingPaths.push(path);
  return { errors, remainingPaths };
}

function childPrimary(outcome, requestedExitCode) {
  if (requestedExitCode !== undefined)
    return Object.freeze({
      exitCode: requestedExitCode,
      signal: outcome.signal ?? null,
    });
  if (outcome.type === 'spawn-error')
    return Object.freeze({ exitCode: 1, signal: null });
  return Object.freeze({
    exitCode: outcome.code ?? (outcome.signal === null ? 1 : 130),
    signal: outcome.signal,
  });
}

function cleanupResultForInternalRegression(cleanup, mode) {
  switch (mode) {
    case 'normal':
      return cleanup;
    case 'success-nonzero-error':
      return { ...cleanup, succeeded: true, errorCode: 1 };
    case 'success-remaining-path':
      return { ...cleanup, succeeded: true, remainingPathCount: 1 };
    case 'failure-zero-error':
      return { ...cleanup, succeeded: false, errorCode: 0 };
    case 'missing-remaining-path': {
      const incomplete = { ...cleanup };
      delete incomplete.remainingPathCount;
      return incomplete;
    }
    case 'invalid-remaining-path-domain':
      return { ...cleanup, remainingPathCount: 5 };
    case 'extra-cleanup-field':
      return { ...cleanup, unexpected: 1 };
    default:
      throw new Error('Invalid internal cleanup-result mode.');
  }
}

async function main() {
  const configuration = runConfigurationFromEnvironment(process.env);
  await assertPathsInitiallyAbsent(configuration);
  const launchPlan = createFinalLaunchPlan(
    configuration,
    process.argv.slice(2),
    process.env,
  );
  const phaseTimeoutMs = parseInternalPhaseTimeout(process.env);
  const protocolMode = internalMarkerIsExact(process.env)
    ? (process.env.BBX_E2E_INTERNAL_PROTOCOL_MODE ?? 'normal')
    : 'normal';
  if (
    ![
      'normal',
      'duplicate',
      'conflict',
      'malformed',
      'missing',
      'unacknowledged',
    ].includes(protocolMode)
  )
    throw new Error('Invalid internal terminal protocol mode.');
  const cleanupResultMode = internalMarkerIsExact(process.env)
    ? (process.env.BBX_E2E_INTERNAL_CLEANUP_RESULT_MODE ?? 'normal')
    : 'normal';
  if (
    ![
      'normal',
      'success-nonzero-error',
      'success-remaining-path',
      'failure-zero-error',
      'missing-remaining-path',
      'invalid-remaining-path-domain',
      'extra-cleanup-field',
    ].includes(cleanupResultMode)
  )
    throw new Error('Invalid internal cleanup-result mode.');
  const lifecycleMode = internalMarkerIsExact(process.env)
    ? (process.env.BBX_E2E_INTERNAL_LIFECYCLE_MODE ?? 'normal')
    : 'normal';
  if (!['normal', 'owner-ipc-disconnect'].includes(lifecycleMode))
    throw new Error('Invalid internal lifecycle mode.');

  phase('owner-configuration-validated', {
    'app-port': configuration.appPort,
    'proxy-port': configuration.proxyPort,
  });
  phase(
    launchPlan.kind === 'playwright'
      ? 'playwright-launch-seam'
      : 'fixture-launch-seam',
  );

  const child = fork(launchPlan.modulePath, [...launchPlan.arguments], {
    cwd: webRoot,
    detached: false,
    env: launchPlan.environment,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    windowsHide: true,
  });
  phase('playwright-spawn-requested', { pid: child.pid ?? 0 });
  child.once('spawn', () =>
    phase('playwright-spawned', { pid: child.pid ?? 0 }),
  );

  let resolveOutcome;
  let outcomeResolved = false;
  const childOutcome = new Promise((resolvePromise) => {
    resolveOutcome = (outcome) => {
      if (outcomeResolved) return;
      outcomeResolved = true;
      resolvePromise(outcome);
    };
  });
  child.once('error', () => resolveOutcome({ type: 'spawn-error' }));
  child.once('exit', (code, signal) => {
    phase('playwright-child-exit', {
      'exit-code': code ?? 0,
      signaled: signal === null ? 0 : 1,
    });
    resolveOutcome({ type: 'exit', code, signal });
  });

  let cleanupPromise;
  let expectedDisconnect = false;
  let resolveAcknowledgement;
  const acknowledgement = new Promise((resolvePromise) => {
    resolveAcknowledgement = resolvePromise;
  });

  process.on('message', (message) => {
    if (
      message?.type === 'result-ack' &&
      message.version === 2 &&
      message.configurationDigest === process.env.BBX_E2E_CONFIG_DIGEST
    )
      resolveAcknowledgement();
    if (message?.type === 'shutdown') void cleanup(130);
  });
  process.once('disconnect', () => {
    phase('owner-ipc-disconnect', { expected: expectedDisconnect ? 1 : 0 });
    if (!expectedDisconnect) void cleanup(130);
  });
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => void cleanup(130));
  if (lifecycleMode === 'owner-ipc-disconnect')
    child.once('spawn', () => {
      phase('owner-ipc-disconnect-injected');
      process.disconnect();
    });

  async function sendResultWithProtocol(result) {
    if (protocolMode === 'missing') return;
    if (protocolMode === 'malformed') {
      await send({ type: 'result', version: 2, primary: 'invalid' });
      return;
    }

    await send(result);
    phase('owner-terminal-result-sent', {
      'exit-code': result.primary.exitCode,
    });

    await Promise.race([
      acknowledgement,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('Controller did not acknowledge result.')),
          phaseTimeoutMs,
        ),
      ),
    ]);
    phase('owner-terminal-result-acknowledged');

    if (protocolMode === 'duplicate') await send(result);
    if (protocolMode === 'conflict')
      await send({
        ...result,
        primary: {
          ...result.primary,
          exitCode: result.primary.exitCode === 0 ? 17 : 0,
        },
      });
  }

  async function cleanup(requestedExitCode) {
    if (cleanupPromise !== undefined) return cleanupPromise;
    cleanupPromise = Promise.resolve().then(async () => {
      phase('playwright-owner-cleanup-start', { pid: process.pid });
      let termination = { forced: false, alreadyExited: true };
      if (!outcomeResolved) {
        termination = await terminateOwnedProcess(child, {
          requestShutdown: () => {
            if (
              launchPlan.kind === 'authenticated-no-browser-fixture' &&
              child.connected
            )
              child.send({ type: 'shutdown' });
            else child.kill('SIGTERM');
          },
          cooperativeTimeoutMs: phaseTimeoutMs,
          forcedTimeoutMs: phaseTimeoutMs,
        });
      }
      const outcome = await childOutcome;
      const primary = childPrimary(outcome, requestedExitCode);
      const preservePath = internalMarkerIsExact(process.env)
        ? process.env.BBX_E2E_INTERNAL_PRESERVE_PATH
        : undefined;
      const pathCleanup = await removeOwnerPaths(configuration, preservePath);
      const injectedFailure =
        internalMarkerIsExact(process.env) &&
        process.env.BBX_E2E_INTERNAL_CLEANUP_FAILURE === 'injected';
      const cleanupSucceeded =
        !termination.forced &&
        !injectedFailure &&
        pathCleanup.errors.length === 0 &&
        pathCleanup.remainingPaths.length === 0;
      const result = {
        type: 'result',
        version: 2,
        configurationDigest: process.env.BBX_E2E_CONFIG_DIGEST,
        primary,
        cleanup: cleanupResultForInternalRegression(
          {
            succeeded: cleanupSucceeded,
            errorCode: cleanupSucceeded ? 0 : 1,
            remainingPathCount: pathCleanup.remainingPaths.length,
          },
          cleanupResultMode,
        ),
        forcedDirectChildFallback: termination.forced,
      };
      phase('playwright-owner-cleanup-complete', {
        'cleanup-error-code': result.cleanup.errorCode,
        forced: termination.forced ? 1 : 0,
      });

      let ownerExitCode = 0;
      try {
        await sendResultWithProtocol(result);
      } catch {
        ownerExitCode = 1;
        phase('owner-terminal-protocol-failed');
      }
      expectedDisconnect = true;
      if (process.connected) process.disconnect();
      await new Promise((resolvePromise) => setImmediate(resolvePromise));
      process.exit(ownerExitCode);
    });
    return cleanupPromise;
  }

  void childOutcome.then((outcome) => {
    const requestedExitCode =
      outcome.type === 'spawn-error'
        ? 1
        : (outcome.code ?? (outcome.signal === null ? 1 : 130));
    void cleanup(requestedExitCode);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === ownerPath) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(
      `E2E Playwright owner failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
    if (process.connected) process.disconnect();
  }
}
