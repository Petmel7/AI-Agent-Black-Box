import { fork, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { mkdir, readFile, rm, rmdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

type RunConfiguration = Readonly<{
  runIdentity: string;
  runRoot: string;
  appPort: number;
  proxyPort: number;
  outputPath: string;
  reportPath: string;
  resultPath: string;
}>;

type RunAudit = Readonly<{
  clean: boolean;
  remainingPaths: readonly string[];
  remainingPorts: readonly number[];
}>;

type ControllerModule = {
  INTERNAL_CONTROLLER_MARKER: string;
  createRunAllocation(): Promise<{
    configuration: RunConfiguration;
    release(): Promise<void>;
  }>;
  environmentForRunConfiguration(
    base: NodeJS.ProcessEnv,
    configuration: RunConfiguration,
  ): NodeJS.ProcessEnv;
  runConfigurationFromEnvironment(
    environment: NodeJS.ProcessEnv,
  ): RunConfiguration;
  verifyRunResources(configuration: RunConfiguration): Promise<RunAudit>;
  convergeRunResources(
    configuration: RunConfiguration,
    timeoutMs: number,
    options?: {
      initialObservation?: RunAudit;
      observe?: (configuration: RunConfiguration) => Promise<RunAudit>;
      remove?: (configuration: RunConfiguration) => Promise<void>;
    },
  ): Promise<{
    clean: boolean;
    firstObservation: RunAudit;
    lastObservation: RunAudit;
    observationCount: number;
    cleanupErrors: readonly string[];
  }>;
};

type OwnerModule = {
  createFinalLaunchPlan(
    configuration: RunConfiguration,
    arguments_: readonly string[],
    environment: NodeJS.ProcessEnv,
  ): {
    kind: 'authenticated-no-browser-fixture' | 'playwright';
    configuration: RunConfiguration;
    environment: NodeJS.ProcessEnv;
    arguments: readonly string[];
  };
};

// Indirection keeps these production JavaScript entrypoints outside TypeScript's
// declaration-file contract without adding a task-prohibited helper file.
const controllerModuleSpecifier = './e2e-controller.mjs';
const ownerModuleSpecifier = './e2e-playwright-owner.mjs';
const controllerModule = (await import(
  controllerModuleSpecifier
)) as ControllerModule;
const ownerModule = (await import(ownerModuleSpecifier)) as OwnerModule;

const serverPath = fileURLToPath(new URL('./e2e-server.mjs', import.meta.url));
const productionControllerPath = fileURLToPath(
  new URL('./e2e-controller.mjs', import.meta.url),
);
const ownerSourcePath = fileURLToPath(
  new URL('./e2e-playwright-owner.mjs', import.meta.url),
);
const controllerSourcePath = fileURLToPath(
  new URL('./e2e-controller.mjs', import.meta.url),
);
const processControlSourcePath = fileURLToPath(
  new URL('./e2e-process-control.mjs', import.meta.url),
);
const serverSourcePath = fileURLToPath(
  new URL('./e2e-server.mjs', import.meta.url),
);
const workerSourcePath = fileURLToPath(
  new URL('./e2e-server-worker.mjs', import.meta.url),
);
const playwrightConfigPath = fileURLToPath(
  new URL('../playwright.config.mjs', import.meta.url),
);

type TerminalRecord = {
  name: 'terminal-result';
  configuration: RunConfiguration;
  primary: { exitCode: number; signal: string | null };
  cleanup: {
    succeeded: boolean;
    owner: {
      succeeded: boolean;
      errorCode: number;
      remainingPathCount: number;
    } | null;
    observedBeforeControllerCleanup: RunAudit;
    observedAfterControllerCleanup: RunAudit;
    controllerCleanupObservationCount: number;
    controllerCleanupErrors: readonly string[];
    exactCleanupError: string | null;
    controllerForcedFallback: boolean;
    ownerForcedFallbackObserved: boolean;
    finalAudit: RunAudit;
    resultPathInitialObservation: RunAudit;
    resultPathObservationCount: number;
    resultPathCleanupErrors: readonly string[];
    resultPathError: string | null;
  };
  protocol: { succeeded: boolean; issues: string[] };
  forcedDirectChildFallback: boolean;
  ownershipBoundary: string;
  reason: string;
};

type ConfigurationRecord = {
  name: 'run-configuration';
  configuration: RunConfiguration;
  configurationDigest: string;
};

type HarnessProcess = {
  child: ChildProcess;
  output(): string;
  waitForOutput(fragment: string, timeoutMs?: number): Promise<void>;
  waitForRecord<T>(name: string, timeoutMs?: number): Promise<T>;
};

const active = new Set<HarnessProcess>();

function createHarnessProcess(child: ChildProcess): HarnessProcess {
  let output = '';
  const listeners = new Set<() => void>();
  const append = (chunk: unknown) => {
    output += String(chunk);
    for (const listener of listeners) listener();
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);

  function waitForCondition(
    condition: () => boolean,
    message: string,
    timeoutMs: number,
  ) {
    if (condition()) return Promise.resolve();
    return new Promise<void>((resolvePromise, reject) => {
      const onOutput = () => {
        if (!condition()) return;
        clearTimeout(timer);
        listeners.delete(onOutput);
        resolvePromise();
      };
      const timer = setTimeout(() => {
        listeners.delete(onOutput);
        reject(new Error(`${message}\n${output}`));
      }, timeoutMs);
      listeners.add(onOutput);
    });
  }

  function records() {
    return output
      .split(/\r?\n/)
      .filter((line) => line.startsWith('BBX_E2E_RECORD '))
      .map(
        (line) =>
          JSON.parse(line.slice('BBX_E2E_RECORD '.length)) as {
            name: string;
          },
      );
  }

  const harness: HarnessProcess = {
    child,
    output: () => output,
    waitForOutput(fragment, timeoutMs = 10_000) {
      return waitForCondition(
        () => output.includes(fragment),
        `Timed out waiting for ${fragment}.`,
        timeoutMs,
      );
    },
    async waitForRecord<T>(name: string, timeoutMs = 10_000) {
      await waitForCondition(
        () => records().some((record) => record.name === name),
        `Timed out waiting for record ${name}.`,
        timeoutMs,
      );
      return records().find((record) => record.name === name) as T;
    },
  };
  active.add(harness);
  return harness;
}

function startProductionController(
  options: {
    mode?:
      | 'hang'
      | 'ignore-shutdown'
      | 'success'
      | 'failure'
      | 'signal'
      | 'already-absent';
    protocolMode?:
      | 'normal'
      | 'duplicate'
      | 'conflict'
      | 'malformed'
      | 'missing'
      | 'unacknowledged';
    cleanupResultMode?:
      | 'normal'
      | 'success-nonzero-error'
      | 'success-remaining-path'
      | 'failure-zero-error'
      | 'missing-remaining-path'
      | 'invalid-remaining-path-domain'
      | 'extra-cleanup-field';
    lifecycleMode?: 'normal' | 'owner-ipc-disconnect';
    verificationMode?:
      | 'controller-transient-path'
      | 'result-transient-remove'
      | 'result-persistence-failure'
      | 'final-transient-observation'
      | 'controller-persistent-port';
    cleanupFailure?: boolean;
    preservePath?: 'output' | 'report';
    phaseTimeoutMs?: number;
    outerTimeoutMs?: number;
  } = {},
) {
  return createHarnessProcess(
    fork(productionControllerPath, [], {
      detached: false,
      env: {
        ...process.env,
        BBX_E2E_INTERNAL_CONTROLLER_CONTEXT:
          controllerModule.INTERNAL_CONTROLLER_MARKER,
        BBX_E2E_INTERNAL_FIXTURE_MODE: options.mode ?? 'success',
        ...(options.protocolMode
          ? { BBX_E2E_INTERNAL_PROTOCOL_MODE: options.protocolMode }
          : {}),
        ...(options.cleanupFailure
          ? { BBX_E2E_INTERNAL_CLEANUP_FAILURE: 'injected' }
          : {}),
        ...(options.cleanupResultMode
          ? {
              BBX_E2E_INTERNAL_CLEANUP_RESULT_MODE: options.cleanupResultMode,
            }
          : {}),
        ...(options.lifecycleMode
          ? { BBX_E2E_INTERNAL_LIFECYCLE_MODE: options.lifecycleMode }
          : {}),
        ...(options.verificationMode
          ? {
              BBX_E2E_INTERNAL_VERIFICATION_MODE: options.verificationMode,
            }
          : {}),
        ...(options.preservePath
          ? { BBX_E2E_INTERNAL_PRESERVE_PATH: options.preservePath }
          : {}),
        ...(options.phaseTimeoutMs
          ? {
              BBX_E2E_INTERNAL_PHASE_TIMEOUT_MS: String(options.phaseTimeoutMs),
            }
          : {}),
        ...(options.outerTimeoutMs
          ? {
              BBX_E2E_INTERNAL_OUTER_TIMEOUT_MS: String(options.outerTimeoutMs),
            }
          : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    }),
  );
}

async function createServerFixture(
  mode: 'ready' | 'stall' | 'pre-spawn-failure',
) {
  const allocation = await controllerModule.createRunAllocation();
  const configuration = allocation.configuration;
  const environment = controllerModule.environmentForRunConfiguration(
    {
      ...process.env,
      BBX_E2E_TRUSTED_PROXY_TOKEN: 'fixture_proxy_token_012345678901',
      BBX_E2E_INTERNAL_TEST_CONTEXT: 'bbx-e2e-server-harness-v2',
      BBX_E2E_INTERNAL_FIXTURE_MODE: mode,
      BBX_E2E_INTERNAL_STARTUP_TIMEOUT_MS: '750',
    },
    configuration,
  );
  await allocation.release();
  const harness = createHarnessProcess(
    fork(serverPath, [], {
      detached: false,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    }),
  );
  return { harness, configuration };
}

function waitForExit(child: ChildProcess, timeoutMs = 15_000) {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve();
  return new Promise<void>((resolvePromise, reject) => {
    const onExit = () => {
      clearTimeout(timer);
      resolvePromise();
    };
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      reject(new Error('Retained direct child did not exit.'));
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

async function stopHarness(harness: HarnessProcess) {
  if (
    harness.child.exitCode === null &&
    harness.child.signalCode === null &&
    harness.child.connected
  )
    harness.child.send({ type: 'shutdown' });
  await waitForExit(harness.child);
  active.delete(harness);
}

async function pathExists(path: string) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function portIsFree(port: number) {
  const server = createServer();
  return new Promise<boolean>((resolvePromise) => {
    server.once('error', () => resolvePromise(false));
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () =>
      server.close(() => resolvePromise(true)),
    );
  });
}

function listen(port: number) {
  const server = createServer();
  return new Promise<Server>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () =>
      resolvePromise(server),
    );
  });
}

function close(server: Server) {
  return new Promise<void>((resolvePromise, reject) =>
    server.close((error) => (error ? reject(error) : resolvePromise())),
  );
}

async function assertConfigurationClean(configuration: RunConfiguration) {
  expect(await controllerModule.verifyRunResources(configuration)).toEqual({
    clean: true,
    remainingPaths: [],
    remainingPorts: [],
  });
}

async function assertExactTerminalResources(result: TerminalRecord) {
  expect(result.cleanup.finalAudit).toEqual({
    clean: true,
    remainingPaths: [],
    remainingPorts: [],
  });
  for (const path of [
    result.configuration.runRoot,
    result.configuration.outputPath,
    result.configuration.reportPath,
    result.configuration.resultPath,
  ])
    expect(await pathExists(path)).toBe(false);
  expect(await portIsFree(result.configuration.appPort)).toBe(true);
  expect(await portIsFree(result.configuration.proxyPort)).toBe(true);
  await assertConfigurationClean(result.configuration);
}

function assertDelegatedBoundary(result: TerminalRecord) {
  expect(result.ownershipBoundary).toBe(
    'playwright-descendants-and-containing-ci-job',
  );
  expect(result).not.toHaveProperty('descendantCleanupSucceeded');
  expect(result).not.toHaveProperty('descendantPids');
}

function phaseLine(output: string, phase: string) {
  return output
    .split(/\r?\n/)
    .find((line) => line.startsWith(`BBX_E2E_PHASE ${phase} `));
}

function cleanupDiagnostic(result: TerminalRecord, output: string) {
  return JSON.stringify({
    firstCleanupResult: result.cleanup.owner,
    observedBeforeControllerCleanup:
      result.cleanup.observedBeforeControllerCleanup,
    observedAfterControllerCleanup:
      result.cleanup.observedAfterControllerCleanup,
    controllerCleanupObservationCount:
      result.cleanup.controllerCleanupObservationCount,
    controllerCleanupErrors: result.cleanup.controllerCleanupErrors,
    exactCleanupError: result.cleanup.exactCleanupError,
    controllerForcedFallback: result.cleanup.controllerForcedFallback,
    ownerForcedFallbackObserved: result.cleanup.ownerForcedFallbackObserved,
    resultPathInitialObservation: result.cleanup.resultPathInitialObservation,
    resultPathObservationCount: result.cleanup.resultPathObservationCount,
    resultPathCleanupErrors: result.cleanup.resultPathCleanupErrors,
    resultPathError: result.cleanup.resultPathError,
    finalAudit: result.cleanup.finalAudit,
    protocol: result.protocol,
    fixtureChildExit: phaseLine(output, 'playwright-child-exit'),
    ownerExit: phaseLine(output, 'playwright-owner-exit-observed'),
  });
}

function assertProtocolOnlyFailure(
  result: TerminalRecord,
  output: string,
  issue: 'duplicate-terminal-result' | 'conflicting-terminal-result',
) {
  const diagnostic = cleanupDiagnostic(result, output);
  expect(result.primary, diagnostic).toEqual({ exitCode: 0, signal: null });
  expect(result.cleanup.owner, diagnostic).toEqual({
    succeeded: true,
    errorCode: 0,
    remainingPathCount: 0,
  });
  expect(result.cleanup.succeeded, diagnostic).toBe(true);
  expect(result.cleanup.exactCleanupError, diagnostic).toBeNull();
  expect(result.cleanup.resultPathError, diagnostic).toBeNull();
  expect(result.cleanup.finalAudit, diagnostic).toEqual({
    clean: true,
    remainingPaths: [],
    remainingPorts: [],
  });
  expect(result.protocol, diagnostic).toEqual({
    succeeded: false,
    issues: [issue],
  });
  expect(result.forcedDirectChildFallback, diagnostic).toBe(false);
  expect(result.cleanup.controllerForcedFallback, diagnostic).toBe(false);
  expect(result.cleanup.ownerForcedFallbackObserved, diagnostic).toBe(false);
}

async function withCrossRunSentinel<T>(operation: () => Promise<T>) {
  const allocation = await controllerModule.createRunAllocation();
  const configuration = allocation.configuration;
  await allocation.release();
  await mkdir(configuration.runRoot, { recursive: false });
  await mkdir(configuration.outputPath, { recursive: false });
  await mkdir(configuration.reportPath, { recursive: false });
  const appListener = await listen(configuration.appPort);
  const proxyListener = await listen(configuration.proxyPort);
  try {
    const value = await operation();
    expect(await pathExists(configuration.runRoot)).toBe(true);
    expect(await pathExists(configuration.outputPath)).toBe(true);
    expect(await pathExists(configuration.reportPath)).toBe(true);
    expect(await pathExists(configuration.resultPath)).toBe(false);
    expect(await portIsFree(configuration.appPort)).toBe(false);
    expect(await portIsFree(configuration.proxyPort)).toBe(false);
    return value;
  } finally {
    await close(appListener);
    await close(proxyListener);
    await rm(configuration.resultPath, { force: true });
    await rm(configuration.outputPath, { recursive: true, force: true });
    await rm(configuration.reportPath, { recursive: true, force: true });
    await rmdir(configuration.runRoot).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    await assertConfigurationClean(configuration);
  }
}

function exerciseInstalledSignalHandler(
  harness: HarnessProcess,
  signal: 'SIGINT' | 'SIGTERM',
) {
  if (process.platform === 'win32') {
    harness.child.send({ type: 'internal-signal', signal });
    return;
  }
  expect(harness.child.kill(signal)).toBe(true);
}

afterEach(async () => {
  for (const harness of active) {
    if (harness.child.exitCode === null && harness.child.signalCode === null) {
      if (harness.child.connected) harness.child.send({ type: 'shutdown' });
      try {
        await waitForExit(harness.child, 5_000);
      } catch {
        harness.child.kill('SIGKILL');
        await waitForExit(harness.child, 5_000).catch(() => undefined);
      }
    }
  }
  active.clear();
});

describe('production Option D configuration and final launch seam', () => {
  it('allocates, propagates, records, and cleans one immutable production run', async () => {
    const harness = startProductionController({ mode: 'success' });
    const allocation =
      await harness.waitForRecord<ConfigurationRecord>('run-configuration');
    await waitForExit(harness.child);
    active.delete(harness);
    const result =
      await harness.waitForRecord<TerminalRecord>('terminal-result');

    expect(harness.child.exitCode).toBe(0);
    expect(allocation.configuration.runIdentity).toMatch(/^[a-f0-9]{64}$/);
    expect(allocation.configuration.appPort).not.toBe(
      allocation.configuration.proxyPort,
    );
    expect(allocation.configuration.runRoot).toBe(
      resolve(tmpdir(), `bbx-e2e-${allocation.configuration.runIdentity}`),
    );
    expect(allocation.configuration.outputPath).toBe(
      join(allocation.configuration.runRoot, 'output'),
    );
    expect(allocation.configuration.reportPath).toBe(
      join(allocation.configuration.runRoot, 'report'),
    );
    expect(allocation.configuration.resultPath).toBe(
      join(allocation.configuration.runRoot, 'result.json'),
    );
    expect(allocation.configurationDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.configuration).toEqual(allocation.configuration);
    expect(result.primary).toEqual({ exitCode: 0, signal: null });
    expect(result.cleanup.succeeded).toBe(true);
    expect(result.protocol).toEqual({ succeeded: true, issues: [] });
    expect(result.forcedDirectChildFallback).toBe(false);
    expect(harness.output()).toContain('BBX_E2E_PHASE fixture-launch-seam');
    expect(harness.output()).not.toContain(
      'BBX_E2E_PHASE playwright-launch-seam',
    );
    await assertConfigurationClean(allocation.configuration);
  });

  it('runs two simultaneous production controllers without shared ports, paths, or cross-cleanup', async () => {
    const first = startProductionController({ mode: 'hang' });
    const second = startProductionController({ mode: 'hang' });
    const [firstRecord, secondRecord] = await Promise.all([
      first.waitForRecord<ConfigurationRecord>('run-configuration'),
      second.waitForRecord<ConfigurationRecord>('run-configuration'),
    ]);
    await Promise.all([
      first.waitForOutput('BBX_E2E_PHASE controller-fixture-ready'),
      second.waitForOutput('BBX_E2E_PHASE controller-fixture-ready'),
    ]);

    const a = firstRecord.configuration;
    const b = secondRecord.configuration;
    expect(a.runIdentity).not.toBe(b.runIdentity);
    expect(new Set([a.appPort, a.proxyPort, b.appPort, b.proxyPort]).size).toBe(
      4,
    );
    expect(a.runRoot).not.toBe(b.runRoot);
    expect(a.outputPath).not.toBe(b.outputPath);
    expect(a.reportPath).not.toBe(b.reportPath);
    expect(a.resultPath).not.toBe(b.resultPath);
    expect(await pathExists(a.outputPath)).toBe(true);
    expect(await pathExists(b.outputPath)).toBe(true);
    expect(await portIsFree(a.appPort)).toBe(false);
    expect(await portIsFree(b.appPort)).toBe(false);

    await stopHarness(first);
    await assertConfigurationClean(a);
    expect(await pathExists(b.outputPath)).toBe(true);
    expect(await pathExists(b.reportPath)).toBe(true);
    expect(await portIsFree(b.appPort)).toBe(false);
    expect(await portIsFree(b.proxyPort)).toBe(false);

    await stopHarness(second);
    await assertConfigurationClean(b);
  }, 30_000);

  it('allows the fixture only for the exact marker after configuration validation', async () => {
    const allocation = await controllerModule.createRunAllocation();
    const configuration = allocation.configuration;
    const base = controllerModule.environmentForRunConfiguration(
      process.env,
      configuration,
    );
    const realPlan = ownerModule.createFinalLaunchPlan(configuration, [], base);
    expect(realPlan.kind).toBe('playwright');
    expect(realPlan.arguments).toContain(
      `--output=${configuration.outputPath}`,
    );

    expect(() =>
      ownerModule.createFinalLaunchPlan(configuration, [], {
        ...base,
        BBX_E2E_INTERNAL_CONTROLLER_CONTEXT: 'not-the-marker',
        BBX_E2E_INTERNAL_FIXTURE_MODE: 'success',
      }),
    ).toThrow(/exact authenticated marker/);

    const fixturePlan = ownerModule.createFinalLaunchPlan(configuration, [], {
      ...base,
      BBX_E2E_INTERNAL_CONTROLLER_CONTEXT:
        controllerModule.INTERNAL_CONTROLLER_MARKER,
      BBX_E2E_INTERNAL_FIXTURE_MODE: 'success',
    });
    expect(fixturePlan.kind).toBe('authenticated-no-browser-fixture');
    expect(fixturePlan.configuration).toEqual(realPlan.configuration);
    expect(fixturePlan.environment.BBX_E2E_APP_PORT).toBe(
      realPlan.environment.BBX_E2E_APP_PORT,
    );
    expect(fixturePlan.environment.BBX_E2E_PROXY_PORT).toBe(
      realPlan.environment.BBX_E2E_PROXY_PORT,
    );
    expect(fixturePlan.environment.BBX_E2E_OUTPUT_DIR).toBe(
      realPlan.environment.BBX_E2E_OUTPUT_DIR,
    );
    await allocation.release();
  });

  it('rejects any child attempt to replace identity, ports, paths, or digest', async () => {
    const allocation = await controllerModule.createRunAllocation();
    const configuration = allocation.configuration;
    const environment = controllerModule.environmentForRunConfiguration(
      process.env,
      configuration,
    );
    expect(Object.isFrozen(configuration)).toBe(true);
    expect(() =>
      controllerModule.runConfigurationFromEnvironment({
        ...environment,
        BBX_E2E_APP_PORT: String(configuration.proxyPort),
      }),
    ).toThrow();
    expect(() =>
      controllerModule.runConfigurationFromEnvironment({
        ...environment,
        BBX_E2E_OUTPUT_DIR: join(configuration.runRoot, 'other-output'),
      }),
    ).toThrow();
    expect(() =>
      controllerModule.runConfigurationFromEnvironment({
        ...environment,
        BBX_E2E_CONFIG_DIGEST: '0'.repeat(64),
      }),
    ).toThrow(/digest mismatch/);
    await allocation.release();
  });

  it('rejects the result-persistence failure mode without the exact marker', async () => {
    const harness = createHarnessProcess(
      fork(productionControllerPath, [], {
        detached: false,
        env: {
          ...process.env,
          BBX_E2E_INTERNAL_CONTROLLER_CONTEXT: 'not-the-marker',
          BBX_E2E_INTERNAL_FIXTURE_MODE: 'success',
          BBX_E2E_INTERNAL_VERIFICATION_MODE: 'result-persistence-failure',
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
      }),
    );
    await waitForExit(harness.child);
    active.delete(harness);
    const record =
      await harness.waitForRecord<ConfigurationRecord>('run-configuration');
    const output = harness.output();

    expect(harness.child.exitCode).toBe(1);
    expect(output).toContain(
      'Internal verification mode requires exact marker.',
    );
    expect(output).not.toContain('BBX_E2E_PHASE playwright-owner-spawned');
    expect(output).not.toContain(
      'BBX_E2E_PHASE result-persistence-failure-injected',
    );
    await assertConfigurationClean(record.configuration);
  });

  it('statically proves the ordinary branch shares pre-launch allocation and propagation', async () => {
    const [controllerSource, ownerSource, configSource] = await Promise.all([
      readFile(controllerSourcePath, 'utf8'),
      readFile(ownerSourcePath, 'utf8'),
      readFile(playwrightConfigPath, 'utf8'),
    ]);
    expect(controllerSource.indexOf('createRunAllocation()')).toBeLessThan(
      controllerSource.indexOf('fork(ownerPath'),
    );
    expect(
      ownerSource.indexOf('runConfigurationFromEnvironment(process.env)'),
    ).toBeLessThan(
      ownerSource.indexOf('const launchPlan = createFinalLaunchPlan('),
    );
    expect(ownerSource.match(/createFinalLaunchPlan\(/g)).toHaveLength(2);
    expect(configSource).toContain(
      'runConfigurationFromEnvironment(process.env)',
    );
    expect(configSource).toContain('env: childEnvironment');
    expect(configSource).toContain('configuration.proxyPort');
    expect(configSource).toContain('configuration.outputPath');
    expect(configSource).toContain('configuration.reportPath');
    expect(ownerSource).toContain(
      "launchPlan.kind === 'authenticated-no-browser-fixture'",
    );
    expect(ownerSource).toContain("else child.kill('SIGTERM')");
  });
});

describe('terminal cleanup schema and invariants', () => {
  it.each([
    {
      label: 'success with a nonzero cleanup error preserves primary failure',
      fixtureMode: 'failure',
      cleanupResultMode: 'success-nonzero-error',
      expectedPrimary: 17,
    },
    {
      label: 'success with a remaining path',
      fixtureMode: 'success',
      cleanupResultMode: 'success-remaining-path',
      expectedPrimary: 0,
    },
    {
      label: 'failure with the success error code',
      fixtureMode: 'success',
      cleanupResultMode: 'failure-zero-error',
      expectedPrimary: 0,
    },
    {
      label: 'missing required remaining-path count',
      fixtureMode: 'success',
      cleanupResultMode: 'missing-remaining-path',
      expectedPrimary: 0,
    },
    {
      label: 'remaining-path count outside its exact domain',
      fixtureMode: 'success',
      cleanupResultMode: 'invalid-remaining-path-domain',
      expectedPrimary: 0,
    },
    {
      label: 'an undeclared cleanup field',
      fixtureMode: 'success',
      cleanupResultMode: 'extra-cleanup-field',
      expectedPrimary: 0,
    },
  ] as const)(
    'rejects contradictory cleanup: $label',
    async ({ fixtureMode, cleanupResultMode, expectedPrimary }) => {
      const harness = startProductionController({
        mode: fixtureMode,
        cleanupResultMode,
        phaseTimeoutMs: 250,
      });
      await waitForExit(harness.child);
      active.delete(harness);
      const result =
        await harness.waitForRecord<TerminalRecord>('terminal-result');

      expect(harness.child.exitCode).toBe(expectedPrimary === 0 ? 1 : 17);
      expect(result.primary).toEqual({
        exitCode: expectedPrimary,
        signal: null,
      });
      expect(result.cleanup.owner).toBeNull();
      expect(result.cleanup.succeeded).toBe(false);
      expect(result.protocol.succeeded).toBe(false);
      expect(result.protocol.issues).toEqual(
        expect.arrayContaining([
          'malformed-terminal-result',
          'missing-terminal-result',
        ]),
      );
      expect(result.forcedDirectChildFallback).toBe(false);
      assertDelegatedBoundary(result);
      await assertExactTerminalResources(result);
    },
  );

  it('accepts a valid clean cleanup control', async () => {
    const harness = startProductionController({ mode: 'success' });
    await waitForExit(harness.child);
    active.delete(harness);
    const result =
      await harness.waitForRecord<TerminalRecord>('terminal-result');

    expect(harness.child.exitCode).toBe(0);
    expect(result.cleanup.owner).toEqual({
      succeeded: true,
      errorCode: 0,
      remainingPathCount: 0,
    });
    expect(result.cleanup.succeeded).toBe(true);
    expect(result.protocol).toEqual({ succeeded: true, issues: [] });
    expect(result.forcedDirectChildFallback).toBe(false);
    assertDelegatedBoundary(result);
    await assertExactTerminalResources(result);
  });

  it('accepts a valid failed-cleanup control without terminal success', async () => {
    const harness = startProductionController({
      mode: 'success',
      cleanupFailure: true,
    });
    await waitForExit(harness.child);
    active.delete(harness);
    const result =
      await harness.waitForRecord<TerminalRecord>('terminal-result');

    expect(harness.child.exitCode).toBe(1);
    expect(result.primary).toEqual({ exitCode: 0, signal: null });
    expect(result.cleanup.owner).toEqual({
      succeeded: false,
      errorCode: 1,
      remainingPathCount: 0,
    });
    expect(result.cleanup.succeeded).toBe(false);
    expect(result.protocol).toEqual({ succeeded: true, issues: [] });
    expect(result.forcedDirectChildFallback).toBe(false);
    assertDelegatedBoundary(result);
    await assertExactTerminalResources(result);
  });
});

describe('production lifecycle negative cases', () => {
  it('handles already-absent direct-child resources as a clean success', async () => {
    await withCrossRunSentinel(async () => {
      const harness = startProductionController({ mode: 'already-absent' });
      await waitForExit(harness.child);
      active.delete(harness);
      const result =
        await harness.waitForRecord<TerminalRecord>('terminal-result');

      expect(harness.child.exitCode).toBe(0);
      expect(result.primary).toEqual({ exitCode: 0, signal: null });
      expect(result.cleanup.owner).toEqual({
        succeeded: true,
        errorCode: 0,
        remainingPathCount: 0,
      });
      expect(result.cleanup.succeeded).toBe(true);
      expect(result.protocol).toEqual({ succeeded: true, issues: [] });
      expect(result.forcedDirectChildFallback).toBe(false);
      expect(result.reason).toBe('playwright-owner-exit');
      expect(harness.output()).toContain(
        'BBX_E2E_PHASE playwright-child-exit exit-code=0 signaled=0',
      );
      expect(harness.output()).toContain(
        'BBX_E2E_PHASE playwright-owner-exit-observed exit-code=0 signaled=0',
      );
      assertDelegatedBoundary(result);
      await assertExactTerminalResources(result);
    });
  });

  it('preserves a signaled direct-child primary outcome', async () => {
    await withCrossRunSentinel(async () => {
      const harness = startProductionController({ mode: 'signal' });
      await waitForExit(harness.child);
      active.delete(harness);
      const result =
        await harness.waitForRecord<TerminalRecord>('terminal-result');

      const signaledPrimary =
        process.platform === 'win32'
          ? { exitCode: 1, signal: null }
          : { exitCode: 130, signal: 'SIGTERM' };
      expect(harness.child.exitCode).toBe(signaledPrimary.exitCode);
      expect(result.primary).toEqual(signaledPrimary);
      expect(result.cleanup.succeeded).toBe(true);
      expect(result.protocol).toEqual({ succeeded: true, issues: [] });
      expect(result.forcedDirectChildFallback).toBe(false);
      expect(result.reason).toBe('playwright-owner-exit');
      expect(harness.output()).toContain(
        process.platform === 'win32'
          ? 'BBX_E2E_PHASE playwright-child-exit exit-code=1 signaled=0'
          : 'BBX_E2E_PHASE playwright-child-exit exit-code=0 signaled=1',
      );
      expect(harness.output()).toContain(
        'BBX_E2E_PHASE playwright-owner-exit-observed exit-code=0 signaled=0',
      );
      assertDelegatedBoundary(result);
      await assertExactTerminalResources(result);
    });
  });

  it.each(['SIGINT', 'SIGTERM'] as const)(
    'routes catchable %s through the installed controller signal handler',
    async (signal) => {
      await withCrossRunSentinel(async () => {
        const harness = startProductionController({ mode: 'hang' });
        await harness.waitForOutput('BBX_E2E_PHASE controller-fixture-ready');
        exerciseInstalledSignalHandler(harness, signal);
        await waitForExit(harness.child);
        active.delete(harness);
        const result =
          await harness.waitForRecord<TerminalRecord>('terminal-result');

        expect(harness.child.exitCode).toBe(130);
        expect(result.primary).toEqual({ exitCode: 130, signal: null });
        expect(result.cleanup.succeeded).toBe(true);
        expect(result.protocol).toEqual({ succeeded: true, issues: [] });
        expect(result.forcedDirectChildFallback).toBe(false);
        expect(result.reason).toBe(`controller-${signal.toLowerCase()}`);
        expect(harness.output()).toContain(
          `BBX_E2E_PHASE controller-signal-handler-entered signal=${
            signal === 'SIGINT' ? 2 : 15
          }`,
        );
        expect(harness.output()).toContain(
          'BBX_E2E_PHASE playwright-child-exit exit-code=0 signaled=0',
        );
        expect(harness.output()).toContain(
          'BBX_E2E_PHASE playwright-owner-exit-observed exit-code=0 signaled=0',
        );
        assertDelegatedBoundary(result);
        await assertExactTerminalResources(result);
      });
    },
  );

  it('fails visibly on an unexpected owner IPC disconnect', async () => {
    await withCrossRunSentinel(async () => {
      const harness = startProductionController({
        mode: 'hang',
        lifecycleMode: 'owner-ipc-disconnect',
      });
      await waitForExit(harness.child);
      active.delete(harness);
      const result =
        await harness.waitForRecord<TerminalRecord>('terminal-result');

      expect(harness.child.exitCode).toBe(1);
      expect(result.primary).toEqual({ exitCode: 1, signal: null });
      expect(result.cleanup.owner).toBeNull();
      expect(result.cleanup.succeeded).toBe(false);
      expect(result.cleanup.finalAudit.clean).toBe(true);
      expect(result.protocol.succeeded).toBe(false);
      expect(result.protocol.issues).toEqual(
        expect.arrayContaining([
          'owner-ipc-disconnect-before-terminal-result',
          'missing-terminal-result',
        ]),
      );
      expect(result.forcedDirectChildFallback).toBe(false);
      expect(result.reason).toBe('owner-ipc-disconnect');
      expect(harness.output()).toContain(
        'BBX_E2E_PHASE controller-owner-ipc-disconnect terminal-result-received=0',
      );
      expect(harness.output()).toContain(
        'BBX_E2E_PHASE playwright-child-exit exit-code=0 signaled=0',
      );
      expect(harness.output()).toContain(
        'BBX_E2E_PHASE playwright-owner-exit-observed exit-code=1 signaled=0',
      );
      assertDelegatedBoundary(result);
      await assertExactTerminalResources(result);
    });
  });

  it('fails visibly on an unexpected controller-side IPC disconnect', async () => {
    await withCrossRunSentinel(async () => {
      const harness = startProductionController({ mode: 'hang' });
      await harness.waitForOutput('BBX_E2E_PHASE controller-fixture-ready');
      harness.child.disconnect();
      await waitForExit(harness.child);
      active.delete(harness);
      const result =
        await harness.waitForRecord<TerminalRecord>('terminal-result');

      expect(harness.child.exitCode).toBe(1);
      expect(result.primary).toEqual({ exitCode: 130, signal: null });
      expect(result.cleanup.succeeded).toBe(true);
      expect(result.protocol.succeeded).toBe(false);
      expect(result.protocol.issues).toContain(
        'controller-parent-ipc-disconnect',
      );
      expect(result.forcedDirectChildFallback).toBe(false);
      expect(result.reason).toBe('controller-parent-ipc-disconnect');
      expect(harness.output()).toContain(
        'BBX_E2E_PHASE controller-parent-ipc-disconnect',
      );
      expect(harness.output()).toContain(
        'BBX_E2E_PHASE playwright-child-exit exit-code=0 signaled=0',
      );
      expect(harness.output()).toContain(
        'BBX_E2E_PHASE playwright-owner-exit-observed exit-code=0 signaled=0',
      );
      assertDelegatedBoundary(result);
      await assertExactTerminalResources(result);
    });
  });
});

describe('immutable terminal facts and direct-child cleanup', () => {
  it.each([
    ['duplicate', 'duplicate-terminal-result'],
    ['conflict', 'conflicting-terminal-result'],
  ] as const)(
    'keeps the first success immutable after a %s terminal result',
    async (protocolMode, issue) => {
      const harness = startProductionController({
        mode: 'success',
        protocolMode,
      });
      await waitForExit(harness.child);
      active.delete(harness);
      const result =
        await harness.waitForRecord<TerminalRecord>('terminal-result');
      const output = harness.output();

      expect(harness.child.exitCode).toBe(1);
      assertProtocolOnlyFailure(result, output, issue);
      const firstResult = output.indexOf(
        'BBX_E2E_PHASE controller-terminal-result-received',
      );
      const acknowledged = output.indexOf(
        'BBX_E2E_PHASE owner-terminal-result-acknowledged',
      );
      const repeated = output.indexOf(
        `BBX_E2E_PHASE controller-terminal-result-repeated conflicting=${
          protocolMode === 'conflict' ? 1 : 0
        }`,
      );
      const ownerExit = output.indexOf(
        'BBX_E2E_PHASE playwright-owner-exit-observed',
      );
      expect(firstResult).toBeGreaterThanOrEqual(0);
      expect(acknowledged).toBeGreaterThan(firstResult);
      expect(repeated).toBeGreaterThan(acknowledged);
      expect(ownerExit).toBeGreaterThan(repeated);
      await assertExactTerminalResources(result);
    },
  );

  it('keeps a genuine result-persistence failure non-clean after exact resources converge', async () => {
    const harness = startProductionController({
      mode: 'success',
      verificationMode: 'result-persistence-failure',
    });
    await waitForExit(harness.child);
    active.delete(harness);
    const result =
      await harness.waitForRecord<TerminalRecord>('terminal-result');
    const output = harness.output();
    const diagnostic = cleanupDiagnostic(result, output);

    expect(harness.child.exitCode, diagnostic).toBe(1);
    expect(result.primary, diagnostic).toEqual({ exitCode: 0, signal: null });
    expect(result.cleanup.owner, diagnostic).toEqual({
      succeeded: true,
      errorCode: 0,
      remainingPathCount: 0,
    });
    expect(result.cleanup.succeeded, diagnostic).toBe(false);
    expect(result.cleanup.exactCleanupError, diagnostic).toBeNull();
    expect(result.cleanup.resultPathError, diagnostic).toBe(
      'Injected exact terminal result persistence verification failure.',
    );
    expect(result.protocol, diagnostic).toEqual({
      succeeded: false,
      issues: ['terminal-result-path-failure'],
    });
    expect(result.forcedDirectChildFallback, diagnostic).toBe(false);
    expect(result.cleanup.controllerForcedFallback, diagnostic).toBe(false);
    expect(result.cleanup.ownerForcedFallbackObserved, diagnostic).toBe(false);
    expect(result.cleanup.resultPathInitialObservation, diagnostic).toEqual({
      clean: false,
      remainingPaths: [
        result.configuration.resultPath,
        result.configuration.runRoot,
      ],
      remainingPorts: [],
    });
    expect(result.cleanup.resultPathCleanupErrors, diagnostic).toEqual([]);
    expect(result.cleanup.finalAudit, diagnostic).toEqual({
      clean: true,
      remainingPaths: [],
      remainingPorts: [],
    });
    expect(output, diagnostic).toContain(
      'BBX_E2E_PHASE result-persistence-failure-injected',
    );
    expect(output, diagnostic).toContain(
      'BBX_E2E_PHASE playwright-child-exit exit-code=0 signaled=0',
    );
    expect(output, diagnostic).toContain(
      'BBX_E2E_PHASE playwright-owner-exit-observed exit-code=0 signaled=0',
    );
    const injected = output.indexOf(
      'BBX_E2E_PHASE result-persistence-failure-injected',
    );
    const verified = output.indexOf(
      'BBX_E2E_PHASE result-path-verification-complete',
    );
    expect(injected, diagnostic).toBeGreaterThanOrEqual(0);
    expect(verified, diagnostic).toBeGreaterThan(injected);
    assertDelegatedBoundary(result);
    await assertExactTerminalResources(result);
  });

  it.each([
    ['controller-transient-path', 'controller-initial-observation'],
    ['result-transient-remove', 'result-path-removal'],
    ['final-transient-observation', 'final-resource-observation'],
  ] as const)(
    'converges a transient exact resource at the %s boundary',
    async (verificationMode, boundary) => {
      const harness = startProductionController({
        mode: 'success',
        protocolMode: 'duplicate',
        verificationMode,
        phaseTimeoutMs: 250,
      });
      await waitForExit(harness.child);
      active.delete(harness);
      const result =
        await harness.waitForRecord<TerminalRecord>('terminal-result');
      const output = harness.output();
      const diagnostic = cleanupDiagnostic(result, output);

      expect(harness.child.exitCode, diagnostic).toBe(1);
      assertProtocolOnlyFailure(result, output, 'duplicate-terminal-result');
      if (boundary === 'controller-initial-observation') {
        expect(
          result.cleanup.observedBeforeControllerCleanup.clean,
          diagnostic,
        ).toBe(false);
        expect(
          result.cleanup.observedBeforeControllerCleanup.remainingPaths,
          diagnostic,
        ).toContain(result.configuration.outputPath);
        expect(
          result.cleanup.observedAfterControllerCleanup.clean,
          diagnostic,
        ).toBe(true);
        expect(
          result.cleanup.controllerCleanupObservationCount,
          diagnostic,
        ).toBeGreaterThanOrEqual(2);
      } else if (boundary === 'result-path-removal') {
        expect(result.cleanup.resultPathCleanupErrors, diagnostic).toContain(
          'Injected transient exact result-path removal failure.',
        );
        expect(
          result.cleanup.resultPathObservationCount,
          diagnostic,
        ).toBeGreaterThanOrEqual(3);
      } else {
        expect(
          result.cleanup.resultPathObservationCount,
          diagnostic,
        ).toBeGreaterThanOrEqual(3);
      }
      await assertExactTerminalResources(result);
    },
  );

  it('keeps a persistent exact port observation non-clean and protocol-independent', async () => {
    const harness = startProductionController({
      mode: 'success',
      protocolMode: 'duplicate',
      verificationMode: 'controller-persistent-port',
      phaseTimeoutMs: 125,
    });
    await waitForExit(harness.child);
    active.delete(harness);
    const result =
      await harness.waitForRecord<TerminalRecord>('terminal-result');
    const output = harness.output();
    const diagnostic = cleanupDiagnostic(result, output);

    expect(harness.child.exitCode, diagnostic).toBe(1);
    expect(result.primary, diagnostic).toEqual({
      exitCode: 0,
      signal: null,
    });
    expect(result.cleanup.owner, diagnostic).toEqual({
      succeeded: true,
      errorCode: 0,
      remainingPathCount: 0,
    });
    expect(result.cleanup.succeeded, diagnostic).toBe(false);
    expect(
      result.cleanup.observedAfterControllerCleanup.remainingPorts,
      diagnostic,
    ).toEqual([result.configuration.appPort]);
    expect(result.cleanup.exactCleanupError, diagnostic).toBe(
      'Exact controller resources did not converge.',
    );
    expect(result.cleanup.finalAudit.clean, diagnostic).toBe(true);
    expect(result.protocol, diagnostic).toEqual({
      succeeded: false,
      issues: ['duplicate-terminal-result'],
    });
    expect(result.forcedDirectChildFallback, diagnostic).toBe(false);
    await assertExactTerminalResources(result);
  });

  it.each(['malformed', 'missing'] as const)(
    'reports %s terminal behavior independently',
    async (protocolMode) => {
      const harness = startProductionController({
        mode: 'success',
        protocolMode,
      });
      await waitForExit(harness.child);
      active.delete(harness);
      const result =
        await harness.waitForRecord<TerminalRecord>('terminal-result');

      expect(harness.child.exitCode).toBe(1);
      expect(result.cleanup.succeeded).toBe(false);
      expect(result.protocol.succeeded).toBe(false);
      expect(result.protocol.issues).toContain('missing-terminal-result');
      if (protocolMode === 'malformed')
        expect(result.protocol.issues).toContain('malformed-terminal-result');
      await assertConfigurationClean(result.configuration);
    },
  );

  it('preserves the first result when acknowledgement fails', async () => {
    const harness = startProductionController({
      mode: 'success',
      protocolMode: 'unacknowledged',
      phaseTimeoutMs: 250,
    });
    await waitForExit(harness.child);
    active.delete(harness);
    const result =
      await harness.waitForRecord<TerminalRecord>('terminal-result');

    expect(harness.child.exitCode).toBe(1);
    expect(result.primary).toEqual({ exitCode: 0, signal: null });
    expect(result.cleanup.owner?.succeeded).toBe(true);
    expect(result.protocol.issues).toContain(
      'owner-exit-after-terminal-failure',
    );
    await assertConfigurationClean(result.configuration);
  });

  it('preserves nonzero primary, cleanup failure, and protocol success as separate facts', async () => {
    const harness = startProductionController({
      mode: 'failure',
      cleanupFailure: true,
    });
    await waitForExit(harness.child);
    active.delete(harness);
    const result =
      await harness.waitForRecord<TerminalRecord>('terminal-result');

    expect(harness.child.exitCode).toBe(17);
    expect(result.primary).toEqual({ exitCode: 17, signal: null });
    expect(result.cleanup.owner).toMatchObject({
      succeeded: false,
      errorCode: 1,
    });
    expect(result.cleanup.succeeded).toBe(false);
    expect(result.protocol).toEqual({ succeeded: true, issues: [] });
    expect(result.forcedDirectChildFallback).toBe(false);
    await assertConfigurationClean(result.configuration);
  });

  it('marks an exact direct-child forced fallback as non-clean', async () => {
    const harness = startProductionController({
      mode: 'ignore-shutdown',
      phaseTimeoutMs: 250,
    });
    await harness.waitForOutput('BBX_E2E_PHASE controller-fixture-ready');
    harness.child.send({ type: 'shutdown' });
    await waitForExit(harness.child);
    active.delete(harness);
    const result =
      await harness.waitForRecord<TerminalRecord>('terminal-result');

    expect(result.primary.exitCode).toBe(130);
    expect(result.forcedDirectChildFallback).toBe(true);
    expect(result.cleanup.owner).toMatchObject({
      succeeded: false,
      errorCode: 1,
    });
    expect(result.cleanup.succeeded).toBe(false);
    expect(result.cleanup.finalAudit.clean).toBe(true);
    await assertConfigurationClean(result.configuration);
  });

  it('fails visibly on an exact remaining path without expanding ownership', async () => {
    const harness = startProductionController({
      mode: 'success',
      preservePath: 'output',
    });
    await waitForExit(harness.child);
    active.delete(harness);
    const result =
      await harness.waitForRecord<TerminalRecord>('terminal-result');

    expect(harness.child.exitCode).toBe(1);
    expect(result.cleanup.succeeded).toBe(false);
    expect(
      result.cleanup.observedBeforeControllerCleanup.remainingPaths,
    ).toContain(result.configuration.outputPath);
    expect(result.cleanup.finalAudit.clean).toBe(true);
    await assertConfigurationClean(result.configuration);
  });

  it('fails an allocated-port audit while the exact listener remains', async () => {
    const allocation = await controllerModule.createRunAllocation();
    const configuration = allocation.configuration;
    await allocation.release();
    const listener = await listen(configuration.appPort);
    try {
      const audit = await controllerModule.verifyRunResources(configuration);
      expect(audit.clean).toBe(false);
      expect(audit.remainingPorts).toEqual([configuration.appPort]);
      expect(audit.remainingPaths).toEqual([]);
    } finally {
      await close(listener);
    }
    await assertConfigurationClean(configuration);
  });

  it('expires the outer watchdog but still awaits cooperative exact cleanup', async () => {
    const harness = startProductionController({
      mode: 'hang',
      phaseTimeoutMs: 500,
      outerTimeoutMs: 300,
    });
    await waitForExit(harness.child);
    active.delete(harness);
    const result =
      await harness.waitForRecord<TerminalRecord>('terminal-result');

    expect(harness.child.exitCode).toBe(1);
    expect(result.reason).toBe('outer-timeout');
    expect(result.forcedDirectChildFallback).toBe(false);
    expect(result.cleanup.succeeded).toBe(true);
    expect(result.protocol.succeeded).toBe(true);
    expect(harness.output()).toContain(
      'BBX_E2E_PHASE controller-watchdog-state expired=1',
    );
    await assertConfigurationClean(result.configuration);
  });
});

describe('repository-created server direct-child ownership', () => {
  it('starts and cooperatively cleans its exact worker, application, and listeners', async () => {
    const { harness, configuration } = await createServerFixture('ready');
    await harness.waitForOutput('BBX_E2E_PHASE proxy-ready');
    expect(
      (await fetch(`http://127.0.0.1:${configuration.proxyPort}/health`))
        .status,
    ).toBe(200);
    await stopHarness(harness);

    expect(harness.child.exitCode).toBe(0);
    expect(harness.output()).toContain(
      'BBX_E2E_PHASE server-controller-cleanup-complete forced=0',
    );
    await assertConfigurationClean(configuration);
  });

  it('propagates a failure before application spawn', async () => {
    const { harness, configuration } =
      await createServerFixture('pre-spawn-failure');
    await waitForExit(harness.child);
    active.delete(harness);

    expect(harness.child.exitCode).toBe(1);
    expect(harness.output()).toContain(
      'BBX_E2E_PHASE application-pre-spawn-failure',
    );
    expect(harness.output()).not.toContain('BBX_E2E_PHASE application-spawned');
    await assertConfigurationClean(configuration);
  });

  it('fails the monotonic startup phase and cleans the retained direct child', async () => {
    const { harness, configuration } = await createServerFixture('stall');
    await waitForExit(harness.child);
    active.delete(harness);

    expect(harness.child.exitCode).toBe(1);
    expect(harness.output()).toMatch(
      /BBX_E2E_PHASE (server-startup-timeout|server-worker-failed)/,
    );
    await assertConfigurationClean(configuration);
  });
});

describe('delegated Playwright ownership boundary', () => {
  it('contains no descendant PID, PGID, process-tree, or fixed-port cleanup authority', async () => {
    const sources = (
      await Promise.all([
        readFile(controllerSourcePath, 'utf8'),
        readFile(ownerSourcePath, 'utf8'),
        readFile(processControlSourcePath, 'utf8'),
        readFile(serverSourcePath, 'utf8'),
        readFile(workerSourcePath, 'utf8'),
        readFile(playwrightConfigPath, 'utf8'),
      ])
    ).join('\n');

    expect(sources).not.toMatch(/detached:\s*true/);
    expect(sources).not.toMatch(/taskkill/i);
    expect(sources).not.toMatch(/process\.kill\s*\(\s*-/);
    expect(sources).not.toMatch(/\/proc\//);
    expect(sources).not.toMatch(/43121|43122/);
    expect(sources).not.toMatch(/guardian|job object|resource registry/i);
    expect(sources).toContain('playwright-descendants-and-containing-ci-job');
  });

  it('states that uncatchable final-owner destruction has no repository cleanup guarantee', async () => {
    const controllerSource = await readFile(controllerSourcePath, 'utf8');
    expect(controllerSource).toContain(
      'playwright-descendants-and-containing-ci-job',
    );
    const harness = startProductionController({ mode: 'success' });
    await waitForExit(harness.child);
    active.delete(harness);
    const result =
      await harness.waitForRecord<TerminalRecord>('terminal-result');
    expect(result.ownershipBoundary).toBe(
      'playwright-descendants-and-containing-ci-job',
    );
    expect(result).not.toHaveProperty('descendantCleanupSucceeded');
  });
});
