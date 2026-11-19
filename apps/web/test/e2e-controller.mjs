import { fork } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import {
  emitE2ePhase,
  emitE2eRecord,
  terminateOwnedProcess,
  waitForOwnedProcessExit,
} from './e2e-process-control.mjs';

export const INTERNAL_CONTROLLER_MARKER = 'bbx-e2e-controller-harness-v2';

const RUN_ID = /^[a-f0-9]{64}$/;
const VERIFICATION_POLL_MS = 25;
const ownerPath = fileURLToPath(
  new URL('./e2e-playwright-owner.mjs', import.meta.url),
);
const controllerPath = fileURLToPath(import.meta.url);
const environmentKeys = Object.freeze({
  runIdentity: 'BBX_E2E_LIFECYCLE_RUN_ID',
  runRoot: 'BBX_E2E_RUN_ROOT',
  appPort: 'BBX_E2E_APP_PORT',
  proxyPort: 'BBX_E2E_PROXY_PORT',
  outputPath: 'BBX_E2E_OUTPUT_DIR',
  reportPath: 'BBX_E2E_REPORT_DIR',
  resultPath: 'BBX_E2E_RESULT_PATH',
  digest: 'BBX_E2E_CONFIG_DIGEST',
});

function canonicalPort(value, name) {
  const raw = String(value);
  if (!/^[1-9][0-9]{3,4}$/.test(raw)) throw new Error(`Invalid ${name}.`);
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535)
    throw new Error(`Invalid ${name}.`);
  return port;
}

function configurationDigest(configuration) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        configuration.runIdentity,
        configuration.runRoot,
        configuration.appPort,
        configuration.proxyPort,
        configuration.outputPath,
        configuration.reportPath,
        configuration.resultPath,
      ]),
    )
    .digest('hex');
}

export function validateRunConfiguration(candidate) {
  const runIdentity = String(candidate.runIdentity ?? '');
  if (!RUN_ID.test(runIdentity))
    throw new Error('Invalid E2E lifecycle run identity.');

  const appPort = canonicalPort(candidate.appPort, 'E2E application port');
  const proxyPort = canonicalPort(candidate.proxyPort, 'E2E proxy port');
  if (appPort === proxyPort)
    throw new Error('E2E application and proxy ports must be distinct.');

  const expectedRoot = resolve(tmpdir(), `bbx-e2e-${runIdentity}`);
  const runRoot = resolve(String(candidate.runRoot ?? ''));
  const outputPath = resolve(String(candidate.outputPath ?? ''));
  const reportPath = resolve(String(candidate.reportPath ?? ''));
  const resultPath = resolve(String(candidate.resultPath ?? ''));
  if (
    runRoot !== expectedRoot ||
    dirname(runRoot) !== resolve(tmpdir()) ||
    basename(runRoot) !== `bbx-e2e-${runIdentity}` ||
    outputPath !== join(runRoot, 'output') ||
    reportPath !== join(runRoot, 'report') ||
    resultPath !== join(runRoot, 'result.json')
  )
    throw new Error('Invalid exact E2E run-owned paths.');

  return Object.freeze({
    runIdentity,
    runRoot,
    appPort,
    proxyPort,
    outputPath,
    reportPath,
    resultPath,
  });
}

export function runConfigurationFromEnvironment(environment) {
  const configuration = validateRunConfiguration({
    runIdentity: environment[environmentKeys.runIdentity],
    runRoot: environment[environmentKeys.runRoot],
    appPort: environment[environmentKeys.appPort],
    proxyPort: environment[environmentKeys.proxyPort],
    outputPath: environment[environmentKeys.outputPath],
    reportPath: environment[environmentKeys.reportPath],
    resultPath: environment[environmentKeys.resultPath],
  });
  if (
    environment[environmentKeys.digest] !== configurationDigest(configuration)
  )
    throw new Error('E2E run configuration digest mismatch.');
  return configuration;
}

export function environmentForRunConfiguration(
  baseEnvironment,
  configurationCandidate,
) {
  const configuration = validateRunConfiguration(configurationCandidate);
  return {
    ...baseEnvironment,
    [environmentKeys.runIdentity]: configuration.runIdentity,
    [environmentKeys.runRoot]: configuration.runRoot,
    [environmentKeys.appPort]: String(configuration.appPort),
    [environmentKeys.proxyPort]: String(configuration.proxyPort),
    [environmentKeys.outputPath]: configuration.outputPath,
    [environmentKeys.reportPath]: configuration.reportPath,
    [environmentKeys.resultPath]: configuration.resultPath,
    [environmentKeys.digest]: configurationDigest(configuration),
  };
}

function reserveLoopbackPort() {
  return new Promise((resolvePromise, reject) => {
    const reservation = createServer();
    reservation.once('error', reject);
    reservation.listen({ port: 0, host: '127.0.0.1', exclusive: true }, () => {
      const address = reservation.address();
      if (!address || typeof address === 'string') {
        reservation.close();
        reject(new Error('Unable to reserve an E2E loopback port.'));
        return;
      }
      resolvePromise({ reservation, port: address.port });
    });
  });
}

function closeReservation(reservation) {
  return new Promise((resolvePromise, reject) => {
    reservation.close((error) =>
      error ? reject(error) : resolvePromise(undefined),
    );
  });
}

function listenOnExactPort(port) {
  return new Promise((resolvePromise, reject) => {
    const listener = createServer();
    listener.once('error', reject);
    listener.listen({ port, host: '127.0.0.1', exclusive: true }, () =>
      resolvePromise(listener),
    );
  });
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

async function assertInitialPathsAbsent(configuration) {
  for (const path of [
    configuration.runRoot,
    configuration.outputPath,
    configuration.reportPath,
    configuration.resultPath,
  ])
    if (!(await pathIsAbsent(path)))
      throw new Error('Generated E2E run-owned path already exists.');
}

export async function createRunAllocation() {
  const runIdentity = randomBytes(32).toString('hex');
  const first = await reserveLoopbackPort();
  let second;
  try {
    second = await reserveLoopbackPort();
  } catch (error) {
    await closeReservation(first.reservation);
    throw error;
  }
  const runRoot = resolve(tmpdir(), `bbx-e2e-${runIdentity}`);
  const configuration = validateRunConfiguration({
    runIdentity,
    runRoot,
    appPort: first.port,
    proxyPort: second.port,
    outputPath: join(runRoot, 'output'),
    reportPath: join(runRoot, 'report'),
    resultPath: join(runRoot, 'result.json'),
  });
  await assertInitialPathsAbsent(configuration);

  let released = false;
  return Object.freeze({
    configuration,
    async release() {
      if (released) return;
      released = true;
      await Promise.all([
        closeReservation(first.reservation),
        closeReservation(second.reservation),
      ]);
    },
  });
}

async function portIsFree(port) {
  const probe = createServer();
  return new Promise((resolvePromise) => {
    probe.once('error', () => resolvePromise(false));
    probe.listen({ port, host: '127.0.0.1', exclusive: true }, () =>
      probe.close(() => resolvePromise(true)),
    );
  });
}

export async function verifyRunResources(configurationCandidate) {
  const configuration = validateRunConfiguration(configurationCandidate);
  const remainingPaths = [];
  for (const path of [
    configuration.outputPath,
    configuration.reportPath,
    configuration.resultPath,
    configuration.runRoot,
  ])
    if (!(await pathIsAbsent(path))) remainingPaths.push(path);

  const remainingPorts = [];
  for (const port of [configuration.appPort, configuration.proxyPort])
    if (!(await portIsFree(port))) remainingPorts.push(port);

  return Object.freeze({
    clean: remainingPaths.length === 0 && remainingPorts.length === 0,
    remainingPaths: Object.freeze(remainingPaths),
    remainingPorts: Object.freeze(remainingPorts),
  });
}

async function removeExactRunPaths(configurationCandidate) {
  const configuration = validateRunConfiguration(configurationCandidate);
  for (const path of [
    configuration.outputPath,
    configuration.reportPath,
    configuration.resultPath,
  ])
    await rm(path, {
      recursive: path !== configuration.resultPath,
      force: true,
    });
  await rmdir(configuration.runRoot).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });
}

function verificationDelay(deadline) {
  const remainingMs = Math.max(0, deadline - performance.now());
  if (remainingMs === 0) return Promise.resolve();
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, Math.min(VERIFICATION_POLL_MS, remainingMs));
  });
}

function cleanupErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export async function convergeRunResources(
  configurationCandidate,
  timeoutMs,
  {
    initialObservation,
    observe = verifyRunResources,
    remove = removeExactRunPaths,
  } = {},
) {
  const configuration = validateRunConfiguration(configurationCandidate);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
    throw new Error('Invalid exact-resource verification timeout.');

  const deadline = performance.now() + timeoutMs;
  const firstObservation = initialObservation ?? (await observe(configuration));
  let lastObservation = firstObservation;
  let observationCount = 1;
  const cleanupErrors = [];

  while (!lastObservation.clean && performance.now() < deadline) {
    try {
      await remove(configuration);
    } catch (error) {
      cleanupErrors.push(cleanupErrorMessage(error));
    }
    lastObservation = await observe(configuration);
    observationCount += 1;
    if (!lastObservation.clean) await verificationDelay(deadline);
  }

  return Object.freeze({
    clean: lastObservation.clean,
    firstObservation,
    lastObservation,
    observationCount,
    cleanupErrors: Object.freeze(cleanupErrors),
  });
}

function validPrimary(primary) {
  return (
    primary !== null &&
    typeof primary === 'object' &&
    Number.isInteger(primary.exitCode) &&
    primary.exitCode >= 0 &&
    primary.exitCode <= 255 &&
    (primary.signal === null ||
      (typeof primary.signal === 'string' &&
        /^SIG[A-Z0-9]+$/.test(primary.signal)))
  );
}

function validCleanup(cleanup, forcedDirectChildFallback) {
  if (
    cleanup === null ||
    typeof cleanup !== 'object' ||
    Array.isArray(cleanup) ||
    Object.keys(cleanup).sort().join(',') !==
      'errorCode,remainingPathCount,succeeded' ||
    typeof cleanup.succeeded !== 'boolean' ||
    !Number.isInteger(cleanup.errorCode) ||
    (cleanup.errorCode !== 0 && cleanup.errorCode !== 1) ||
    !Number.isInteger(cleanup.remainingPathCount) ||
    cleanup.remainingPathCount < 0 ||
    cleanup.remainingPathCount > 4
  )
    return false;

  if (cleanup.succeeded)
    return (
      cleanup.errorCode === 0 &&
      cleanup.remainingPathCount === 0 &&
      forcedDirectChildFallback === false
    );
  return cleanup.errorCode === 1;
}

function validOwnerEnvelope(message, digest) {
  return (
    message?.type === 'result' &&
    message.version === 2 &&
    message.configurationDigest === digest
  );
}

function validOwnerResult(message, digest) {
  return (
    validOwnerEnvelope(message, digest) &&
    validPrimary(message.primary) &&
    typeof message.forcedDirectChildFallback === 'boolean' &&
    validCleanup(message.cleanup, message.forcedDirectChildFallback)
  );
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value))
    return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function parseInternalTimeout(environment, key, fallback, minimum) {
  if (
    environment.BBX_E2E_INTERNAL_CONTROLLER_CONTEXT !==
    INTERNAL_CONTROLLER_MARKER
  )
    return fallback;
  const raw = environment[key];
  if (raw === undefined) return fallback;
  if (!/^[1-9][0-9]{1,5}$/.test(raw))
    throw new Error(`Invalid internal E2E timeout: ${key}.`);
  const timeout = Number(raw);
  if (timeout < minimum || timeout > 60_000)
    throw new Error(`Invalid internal E2E timeout: ${key}.`);
  return timeout;
}

function parseInternalVerificationMode(environment) {
  const key = 'BBX_E2E_INTERNAL_VERIFICATION_MODE';
  const value = environment[key];
  if (
    environment.BBX_E2E_INTERNAL_CONTROLLER_CONTEXT !==
    INTERNAL_CONTROLLER_MARKER
  ) {
    if (value !== undefined)
      throw new Error('Internal verification mode requires exact marker.');
    return 'normal';
  }
  const mode = value ?? 'normal';
  if (
    ![
      'normal',
      'controller-transient-path',
      'result-transient-remove',
      'result-persistence-failure',
      'final-transient-observation',
      'controller-persistent-port',
    ].includes(mode)
  )
    throw new Error('Invalid internal exact-resource verification mode.');
  return mode;
}

export async function runController({
  environment = process.env,
  arguments: controllerArguments = process.argv.slice(2),
} = {}) {
  const allocation = await createRunAllocation();
  const configuration = allocation.configuration;
  const ownerEnvironment = environmentForRunConfiguration(
    { ...environment },
    configuration,
  );
  delete ownerEnvironment.PW_DISABLE_TS_ESM;
  runConfigurationFromEnvironment(ownerEnvironment);

  emitE2eRecord('run-configuration', {
    configuration,
    configurationDigest: ownerEnvironment[environmentKeys.digest],
  });
  await allocation.release();

  const phaseTimeoutMs = parseInternalTimeout(
    ownerEnvironment,
    'BBX_E2E_INTERNAL_PHASE_TIMEOUT_MS',
    10_000,
    100,
  );
  const outerTimeoutMs = parseInternalTimeout(
    ownerEnvironment,
    'BBX_E2E_INTERNAL_OUTER_TIMEOUT_MS',
    240_000,
    250,
  );
  const internalProtocolMode =
    ownerEnvironment.BBX_E2E_INTERNAL_CONTROLLER_CONTEXT ===
    INTERNAL_CONTROLLER_MARKER
      ? ownerEnvironment.BBX_E2E_INTERNAL_PROTOCOL_MODE
      : undefined;
  const internalVerificationMode =
    parseInternalVerificationMode(ownerEnvironment);

  let resultObservationCount = 0;
  let resultTransientRemovalInjected = false;
  const observeResources = async (phase) => {
    const observation = await verifyRunResources(configuration);
    if (phase === 'result') resultObservationCount += 1;
    if (
      internalVerificationMode === 'final-transient-observation' &&
      phase === 'result' &&
      resultObservationCount === 2 &&
      observation.clean
    )
      return Object.freeze({
        clean: false,
        remainingPaths: Object.freeze([configuration.resultPath]),
        remainingPorts: Object.freeze([]),
      });
    return observation;
  };
  const removeResources = async (phase) => {
    if (
      internalVerificationMode === 'result-transient-remove' &&
      phase === 'result' &&
      !resultTransientRemovalInjected
    ) {
      resultTransientRemovalInjected = true;
      throw new Error('Injected transient exact result-path removal failure.');
    }
    await removeExactRunPaths(configuration);
  };

  emitE2ePhase('controller-start', { pid: process.pid });
  const owner = fork(ownerPath, controllerArguments, {
    detached: false,
    env: ownerEnvironment,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    windowsHide: true,
  });
  emitE2ePhase('playwright-owner-spawned', { pid: owner.pid ?? 0 });

  let firstTerminalResult = null;
  let firstPrimaryResult = null;
  let firstCleanupResult = null;
  let ownerForcedFallbackObserved = false;
  const protocolIssues = new Set();
  let controllerForcedFallback = false;
  let completionStarted = false;
  let resolveCompletion;
  const completion = new Promise((resolvePromise) => {
    resolveCompletion = resolvePromise;
  });
  const ownerExit = new Promise((resolvePromise) => {
    owner.once('exit', (code, signal) => {
      emitE2ePhase('playwright-owner-exit-observed', {
        'exit-code': code ?? 0,
        signaled: signal === null ? 0 : 1,
      });
      resolvePromise({ code, signal });
      if (!completionStarted)
        void beginCompletion('playwright-owner-exit', undefined, false);
    });
  });

  owner.on('message', (message) => {
    if (message?.type === 'phase') emitE2ePhase(message.name, message.details);
    if (message?.type !== 'result') return;

    const digest = ownerEnvironment[environmentKeys.digest];
    if (validOwnerEnvelope(message, digest)) {
      if (firstPrimaryResult === null && validPrimary(message.primary))
        firstPrimaryResult = deepFreeze(
          JSON.parse(JSON.stringify(message.primary)),
        );
      if (typeof message.forcedDirectChildFallback === 'boolean') {
        ownerForcedFallbackObserved ||= message.forcedDirectChildFallback;
        if (
          firstCleanupResult === null &&
          validCleanup(message.cleanup, message.forcedDirectChildFallback)
        )
          firstCleanupResult = deepFreeze(
            JSON.parse(JSON.stringify(message.cleanup)),
          );
      }
    }
    if (!validOwnerResult(message, digest)) {
      protocolIssues.add('malformed-terminal-result');
      return;
    }

    const immutableMessage = deepFreeze(JSON.parse(JSON.stringify(message)));
    if (firstTerminalResult === null) {
      firstTerminalResult = immutableMessage;
      emitE2ePhase('controller-terminal-result-received', {
        'exit-code': message.primary.exitCode,
        'cleanup-error-code': message.cleanup.errorCode,
      });
      if (internalProtocolMode !== 'unacknowledged' && owner.connected)
        owner.send({
          type: 'result-ack',
          version: 2,
          configurationDigest: digest,
        });
      return;
    }

    const repeatedIssue =
      JSON.stringify(firstTerminalResult) === JSON.stringify(immutableMessage)
        ? 'duplicate-terminal-result'
        : 'conflicting-terminal-result';
    protocolIssues.add(repeatedIssue);
    emitE2ePhase('controller-terminal-result-repeated', {
      conflicting: repeatedIssue === 'conflicting-terminal-result' ? 1 : 0,
    });
  });
  owner.once('error', () => {
    protocolIssues.add('owner-process-error');
    if (!completionStarted)
      void beginCompletion('playwright-owner-error', 1, true);
  });
  owner.once('disconnect', () => {
    emitE2ePhase('controller-owner-ipc-disconnect', {
      'terminal-result-received': firstTerminalResult === null ? 0 : 1,
    });
    if (firstTerminalResult === null) {
      protocolIssues.add('owner-ipc-disconnect-before-terminal-result');
      if (!completionStarted)
        void beginCompletion(
          'owner-ipc-disconnect',
          firstPrimaryResult === null ? 1 : undefined,
          false,
        );
    }
  });

  let watchdog;
  const signalHandlers = new Map();
  function handleCatchableSignal(signal) {
    emitE2ePhase('controller-signal-handler-entered', {
      signal: signal === 'SIGINT' ? 2 : 15,
    });
    return beginCompletion(`controller-${signal.toLowerCase()}`, 130, true);
  }
  const parentMessageHandler = (message) => {
    if (message?.type === 'shutdown')
      void beginCompletion('controller-shutdown-requested', 130, true);
    if (
      message?.type === 'internal-signal' &&
      ownerEnvironment.BBX_E2E_INTERNAL_CONTROLLER_CONTEXT ===
        INTERNAL_CONTROLLER_MARKER &&
      (message.signal === 'SIGINT' || message.signal === 'SIGTERM')
    )
      void signalHandlers.get(message.signal)?.();
  };
  process.on('message', parentMessageHandler);

  const parentDisconnectHandler = () => {
    emitE2ePhase('controller-parent-ipc-disconnect');
    protocolIssues.add('controller-parent-ipc-disconnect');
    if (!completionStarted)
      void beginCompletion('controller-parent-ipc-disconnect', 1, true);
  };
  if (process.connected) process.once('disconnect', parentDisconnectHandler);

  for (const signal of ['SIGINT', 'SIGTERM']) {
    const handler = () => handleCatchableSignal(signal);
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }

  watchdog = setTimeout(
    () => void beginCompletion('outer-timeout', 1, true),
    outerTimeoutMs,
  );
  watchdog.unref();

  async function beginCompletion(reason, requestedExitCode, requestShutdown) {
    if (completionStarted) return completion;
    completionStarted = true;
    clearTimeout(watchdog);
    process.removeListener('message', parentMessageHandler);
    process.removeListener('disconnect', parentDisconnectHandler);
    for (const [signal, handler] of signalHandlers)
      process.removeListener(signal, handler);

    let ownerOutcome;
    try {
      if (requestShutdown) {
        const termination = await terminateOwnedProcess(owner, {
          requestShutdown: () => {
            if (owner.connected) owner.send({ type: 'shutdown' });
            else owner.kill('SIGTERM');
          },
          cooperativeTimeoutMs: Math.min(phaseTimeoutMs * 2 + 250, 120_000),
          forcedTimeoutMs: phaseTimeoutMs,
        });
        controllerForcedFallback = termination.forced;
      } else {
        await waitForOwnedProcessExit(owner, phaseTimeoutMs);
      }
      ownerOutcome = await ownerExit;
    } catch {
      protocolIssues.add('direct-owner-exit-timeout');
      controllerForcedFallback = true;
      ownerOutcome = {
        code: owner.exitCode,
        signal: owner.signalCode,
      };
    }

    if (firstTerminalResult === null)
      protocolIssues.add('missing-terminal-result');
    if (
      firstTerminalResult !== null &&
      (ownerOutcome.code !== 0 || ownerOutcome.signal !== null)
    )
      protocolIssues.add('owner-exit-after-terminal-failure');

    if (internalVerificationMode === 'controller-transient-path') {
      await mkdir(configuration.runRoot, { recursive: false });
      await mkdir(configuration.outputPath, { recursive: false });
    }
    let persistentPortListener;
    let controllerVerification;
    try {
      if (internalVerificationMode === 'controller-persistent-port')
        persistentPortListener = await listenOnExactPort(configuration.appPort);
      const observedBeforeControllerCleanup =
        await observeResources('controller');
      controllerVerification = await convergeRunResources(
        configuration,
        phaseTimeoutMs,
        {
          initialObservation: observedBeforeControllerCleanup,
          observe: () => observeResources('controller'),
          remove: () => removeResources('controller'),
        },
      );
    } finally {
      if (persistentPortListener !== undefined)
        await closeReservation(persistentPortListener);
    }
    emitE2ePhase('controller-cleanup-verification-complete', {
      clean: controllerVerification.clean ? 1 : 0,
      'observation-count': controllerVerification.observationCount,
    });
    const observedBeforeControllerCleanup =
      controllerVerification.firstObservation;
    const observedAfterControllerCleanup =
      controllerVerification.lastObservation;
    const exactCleanupError = controllerVerification.clean
      ? null
      : (controllerVerification.cleanupErrors.at(-1) ??
        'Exact controller resources did not converge.');

    const primary =
      firstPrimaryResult ??
      Object.freeze({
        exitCode: requestedExitCode ?? 1,
        signal: ownerOutcome.signal,
      });
    const cleanupSucceeded =
      firstCleanupResult?.succeeded === true &&
      controllerVerification.clean &&
      !controllerForcedFallback &&
      !ownerForcedFallbackObserved;

    const protocol = {
      succeeded: protocolIssues.size === 0,
      issues: [...protocolIssues],
    };
    const forcedDirectChildFallback =
      controllerForcedFallback || ownerForcedFallbackObserved;
    const baseResult = {
      version: 2,
      configuration,
      primary,
      cleanup: {
        succeeded: cleanupSucceeded,
        owner: firstCleanupResult,
        observedBeforeControllerCleanup,
        observedAfterControllerCleanup,
        controllerCleanupObservationCount:
          controllerVerification.observationCount,
        controllerCleanupErrors: controllerVerification.cleanupErrors,
        exactCleanupError,
        controllerForcedFallback,
        ownerForcedFallbackObserved,
      },
      protocol,
      forcedDirectChildFallback,
      ownershipBoundary: 'playwright-descendants-and-containing-ci-job',
      reason,
    };

    let resultPathPersistenceError = null;
    try {
      await mkdir(configuration.runRoot, { recursive: false });
      await writeFile(
        configuration.resultPath,
        `${JSON.stringify(baseResult)}\n`,
        { flag: 'wx' },
      );
      if (internalVerificationMode === 'result-persistence-failure') {
        await writeFile(
          configuration.resultPath,
          '{"injected":"terminal-result-persistence-failure"}\n',
        );
        emitE2ePhase('result-persistence-failure-injected');
      }
      const persisted = JSON.parse(
        await readFile(configuration.resultPath, 'utf8'),
      );
      if (JSON.stringify(persisted) !== JSON.stringify(baseResult))
        throw new Error(
          internalVerificationMode === 'result-persistence-failure'
            ? 'Injected exact terminal result persistence verification failure.'
            : 'Persisted E2E terminal result changed.',
        );
    } catch (error) {
      resultPathPersistenceError = error;
    }

    const resultPathInitialObservation = await observeResources('result');
    const resultPathVerification = await convergeRunResources(
      configuration,
      phaseTimeoutMs,
      {
        initialObservation: resultPathInitialObservation,
        observe: () => observeResources('result'),
        remove: () => removeResources('result'),
      },
    );
    emitE2ePhase('result-path-verification-complete', {
      clean: resultPathVerification.clean ? 1 : 0,
      'observation-count': resultPathVerification.observationCount,
    });
    const resultPathError =
      resultPathPersistenceError === null && resultPathVerification.clean
        ? null
        : resultPathPersistenceError === null
          ? (resultPathVerification.cleanupErrors.at(-1) ??
            'Exact terminal result resources did not converge.')
          : cleanupErrorMessage(resultPathPersistenceError);
    if (resultPathError !== null)
      protocolIssues.add('terminal-result-path-failure');

    const finalAudit = resultPathVerification.lastObservation;
    const finalResult = {
      ...baseResult,
      cleanup: {
        ...baseResult.cleanup,
        succeeded:
          baseResult.cleanup.succeeded &&
          resultPathError === null &&
          finalAudit.clean,
        finalAudit,
        resultPathInitialObservation,
        resultPathObservationCount: resultPathVerification.observationCount,
        resultPathCleanupErrors: resultPathVerification.cleanupErrors,
        resultPathError,
      },
      protocol: {
        succeeded: protocolIssues.size === 0,
        issues: [...protocolIssues],
      },
    };
    emitE2eRecord('terminal-result', finalResult);
    emitE2ePhase('controller-watchdog-state', {
      expired: reason === 'outer-timeout' ? 1 : 0,
    });

    const terminalSuccess =
      requestedExitCode !== 1 &&
      finalResult.primary.exitCode === 0 &&
      finalResult.primary.signal === null &&
      finalResult.cleanup.succeeded &&
      finalResult.protocol.succeeded &&
      !finalResult.forcedDirectChildFallback;
    const exitCode = terminalSuccess
      ? 0
      : requestedExitCode === 1
        ? 1
        : finalResult.primary.exitCode === 0
          ? (requestedExitCode ?? 1)
          : finalResult.primary.exitCode;
    emitE2ePhase(reason, { 'exit-code': exitCode });
    resolveCompletion(exitCode);
    return completion;
  }

  return completion;
}

if (process.argv[1] && resolve(process.argv[1]) === controllerPath) {
  try {
    process.exitCode = await runController();
  } catch (error) {
    process.stderr.write(
      `E2E controller failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  } finally {
    if (process.connected) process.disconnect();
  }
}
