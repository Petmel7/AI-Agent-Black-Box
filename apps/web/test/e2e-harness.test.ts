import { fork, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { readFile, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it as vitestIt } from 'vitest';

// @ts-expect-error -- this Node-owned test helper intentionally executes as ESM.
import * as processControlModule from './e2e-process-control.mjs';
// @ts-expect-error -- this Node-owned test helper intentionally executes as ESM.
import * as ownedProcessModule from './e2e-owned-process.mjs';
// @ts-expect-error -- this Node-owned test helper intentionally executes as ESM.
import * as resourceRegistryModule from './e2e-resource-registry.mjs';

interface LinuxProcessIdentity {
  parentProcessId: number;
  processGroupId: number;
  sessionId: number;
  zombie: boolean;
}

interface ActiveController {
  authorities: Array<{
    actualProcessId: number;
    metadataDirectory: string;
    supervisorProcessId: number;
  }>;
  child: ChildProcess;
  directAuthority: unknown;
  kind: 'server' | 'playwright';
  output: () => string;
  ports: number[];
  resources: Set<string>;
  layerProcessIds: Set<number>;
  ownedPaths: Set<string>;
  authorityAckDelayMs: number;
  resourcePaths: Map<string, string>;
  resourceRegistry: {
    accept: (candidate: unknown, expectedRole: string) => unknown;
    complete: (resource: string) => void;
    entry: (resource: string) => {
      metadataDirectory: string;
      resourceId: string;
    };
  };
}

const {
  captureDirectChildAuthority,
  probeProcessState,
  readLinuxProcessIdentity,
  terminateDirectChild,
} = processControlModule as unknown as {
  captureDirectChildAuthority: (child: ChildProcess) => unknown;
  probeProcessState: (processId: number) => 'live' | 'absent' | 'unverifiable';
  readLinuxProcessIdentity: (
    processId: number,
  ) => LinuxProcessIdentity | undefined;
  terminateDirectChild: (authority: unknown) => Promise<unknown>;
};
const {
  createParentResourcePlan,
  createParentResourceRegistry,
  parentResourceEnvironment,
} = resourceRegistryModule as unknown as {
  createParentResourcePlan: (
    resources: string[],
  ) => Map<string, { metadataDirectory: string; resourceId: string }>;
  createParentResourceRegistry: (
    plan: Map<string, { metadataDirectory: string; resourceId: string }>,
    importer: typeof importOwnedProcessAuthority,
  ) => ActiveController['resourceRegistry'];
  parentResourceEnvironment: (
    plan: Map<string, { metadataDirectory: string; resourceId: string }>,
    environment?: NodeJS.ProcessEnv,
  ) => NodeJS.ProcessEnv;
};
const {
  cleanupOwnedProcessAuthority,
  exactOwnedTempDirectory,
  importOwnedProcessAuthority,
  removeExactOwnedTempDirectory,
} = ownedProcessModule as unknown as {
  cleanupOwnedProcessAuthority: (authority: unknown) => Promise<unknown>;
  importOwnedProcessAuthority: (
    authority: unknown,
    expected: { role: string; metadataDirectory: string },
  ) => ActiveController['authorities'][number];
  exactOwnedTempDirectory: (path: string) => string;
  removeExactOwnedTempDirectory: (path: string) => Promise<unknown>;
};

const serverPath = fileURLToPath(new URL('./e2e-server.mjs', import.meta.url));
const playwrightControllerPath = fileURLToPath(
  new URL('./e2e-controller.mjs', import.meta.url),
);
const nextEnvironmentPath = fileURLToPath(
  new URL('../next-env.d.ts', import.meta.url),
);
const active = new Set<ActiveController>();

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

async function linuxOwnershipToken(processId: number): Promise<string> {
  const entries = String(await readFile(`/proc/${processId}/environ`)).split(
    '\0',
  );
  const value = entries.find((entry) =>
    entry.startsWith('BBX_E2E_OWNERSHIP_TOKEN='),
  );
  if (!value) throw new Error('Linux E2E process lacks its ownership token.');
  return value.slice('BBX_E2E_OWNERSHIP_TOKEN='.length);
}

async function linuxGroupProcessIds(processGroupId: number): Promise<number[]> {
  const processIds = (await readdir('/proc'))
    .filter((entry) => /^[1-9][0-9]*$/.test(entry))
    .map(Number);
  return processIds.filter((processId) => {
    const identity = readLinuxProcessIdentity(processId);
    return identity?.processGroupId === processGroupId;
  });
}

async function linuxCommandLine(processId: number): Promise<string> {
  try {
    return String(await readFile(`/proc/${processId}/cmdline`)).replaceAll(
      '\0',
      ' ',
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

function startController(
  mode: string,
  appPort: number,
  proxyPort: number,
  options: {
    cleanupFailure?: boolean;
    launchDelayMs?: number;
    startupTimeoutMs?: number;
    authorityAckDelayMs?: number;
  } = {},
) {
  const resources =
    process.platform === 'win32'
      ? ['server-application', 'server-worker']
      : ['server-application'];
  const resourcePlan = createParentResourcePlan(resources);
  const child = fork(serverPath, [], {
    detached: true,
    env: parentResourceEnvironment(resourcePlan, {
      ...process.env,
      BBX_E2E_APP_PORT: String(appPort),
      BBX_E2E_PROXY_PORT: String(proxyPort),
      BBX_E2E_TRUSTED_PROXY_TOKEN: 'fixture_proxy_token_012345678901',
      BBX_E2E_INTERNAL_TEST_CONTEXT: 'bbx-e2e-harness-v1',
      BBX_E2E_INTERNAL_FIXTURE_MODE: mode,
      ...(options.startupTimeoutMs === undefined
        ? {}
        : {
            BBX_E2E_INTERNAL_STARTUP_TIMEOUT_MS: String(
              options.startupTimeoutMs,
            ),
          }),
      ...(options.launchDelayMs === undefined
        ? {}
        : {
            BBX_E2E_INTERNAL_LAUNCH_DELAY_MS: String(options.launchDelayMs),
          }),
      ...(options.cleanupFailure
        ? { BBX_E2E_INTERNAL_WORKER_CLEANUP_FAILURE: 'injected' }
        : {}),
    }),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  const pendingMessages: unknown[] = [];
  const bufferMessage = (message: unknown) => pendingMessages.push(message);
  child.on('message', bufferMessage);
  let output = '';
  child.stdout?.on('data', (chunk) => (output += String(chunk)));
  child.stderr?.on('data', (chunk) => (output += String(chunk)));
  const controller = {
    authorities: [],
    child,
    directAuthority: captureDirectChildAuthority(child),
    kind: 'server' as const,
    output: () => output,
    ports: [appPort, proxyPort],
    resources: new Set<string>(),
    layerProcessIds: new Set<number>(),
    ownedPaths: new Set<string>(),
    authorityAckDelayMs: options.authorityAckDelayMs ?? 0,
    resourcePaths: new Map(
      [...resourcePlan].map(([resource, entry]) => [
        resource,
        entry.metadataDirectory,
      ]),
    ),
    resourceRegistry: createParentResourceRegistry(
      resourcePlan,
      importOwnedProcessAuthority,
    ),
  };
  active.add(controller);
  child.off('message', bufferMessage);
  retainControllerResources(controller, pendingMessages);
  return controller;
}

function startPlaywrightController(
  port: number,
  options: {
    mode?:
      | 'hang'
      | 'success'
      | 'failure'
      | 'signal'
      | 'already-absent'
      | 'root-exit'
      | 'uninstrumented-root-exit'
      | 'stubborn-hang'
      | 'stubborn-root-exit';
    cleanupFailure?: boolean;
    spawnFailure?: boolean;
    operationTimeoutMs?: number;
    protocolFault?:
      | 'duplicate-launch-authority'
      | 'unknown-after-launch-settlement'
      | 'unknown-pending-spawn'
      | 'unknown-pending-handoff'
      | 'unknown-before-ownership-ready'
      | 'unknown-running'
      | 'unknown-cleaning'
      | 'unknown-after-terminal-result';
    registered?: boolean;
    authorityAckDelayMs?: number;
  } = {},
) {
  const resources =
    process.platform === 'win32'
      ? ['playwright', 'playwright-owner']
      : ['playwright'];
  const resourcePlan = createParentResourcePlan(resources);
  const child = fork(playwrightControllerPath, [], {
    detached: true,
    env: parentResourceEnvironment(resourcePlan, {
      ...process.env,
      BBX_E2E_INTERNAL_CONTROLLER_CONTEXT: 'bbx-e2e-controller-harness-v1',
      BBX_E2E_INTERNAL_CONTROLLER_PORT: String(port),
      BBX_E2E_INTERNAL_CONTROLLER_MODE: options.mode ?? 'hang',
      ...(options.cleanupFailure
        ? { BBX_E2E_INTERNAL_CLEANUP_FAILURE: 'injected' }
        : {}),
      ...(options.spawnFailure
        ? { BBX_E2E_INTERNAL_OWNER_SPAWN_FAILURE: 'injected' }
        : {}),
      ...(options.operationTimeoutMs === undefined
        ? {}
        : {
            BBX_E2E_INTERNAL_OPERATION_TIMEOUT_MS: String(
              options.operationTimeoutMs,
            ),
          }),
      ...(options.protocolFault === undefined
        ? {}
        : { BBX_E2E_INTERNAL_PROTOCOL_FAULT: options.protocolFault }),
    }),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  const pendingMessages: unknown[] = [];
  const bufferMessage = (message: unknown) => pendingMessages.push(message);
  child.on('message', bufferMessage);
  let output = '';
  child.stdout?.on('data', (chunk) => (output += String(chunk)));
  child.stderr?.on('data', (chunk) => (output += String(chunk)));
  const controller = {
    authorities: [],
    child,
    directAuthority: captureDirectChildAuthority(child),
    kind: 'playwright' as const,
    output: () => output,
    ports: [port],
    resources: new Set<string>(),
    layerProcessIds: new Set<number>(),
    ownedPaths: new Set<string>(),
    authorityAckDelayMs: options.authorityAckDelayMs ?? 0,
    resourcePaths: new Map(
      [...resourcePlan].map(([resource, entry]) => [
        resource,
        entry.metadataDirectory,
      ]),
    ),
    resourceRegistry: createParentResourceRegistry(
      resourcePlan,
      importOwnedProcessAuthority,
    ),
  };
  if (options.registered !== false) active.add(controller);
  child.off('message', bufferMessage);
  retainControllerResources(controller, pendingMessages);
  return controller;
}

function startLinuxStandardPlaywrightController(
  port: number,
  options: {
    mode?: 'hang' | 'stubborn-hang' | 'uninstrumented-root-exit';
    operationTimeoutMs?: number;
    bootstrapPause?:
      | 'before-configuration'
      | 'during-controller-creation'
      | 'before-armed-ack'
      | 'after-terminal-result';
  } = {},
) {
  const resourcePlan = createParentResourcePlan(['playwright']);
  const child = spawn(process.execPath, [playwrightControllerPath], {
    detached: true,
    env: parentResourceEnvironment(resourcePlan, {
      ...process.env,
      BBX_E2E_INTERNAL_CONTROLLER_CONTEXT: 'bbx-e2e-controller-harness-v1',
      BBX_E2E_INTERNAL_CONTROLLER_PORT: String(port),
      BBX_E2E_INTERNAL_CONTROLLER_MODE: options.mode ?? 'stubborn-hang',
      BBX_E2E_INTERNAL_OPERATION_TIMEOUT_MS: String(
        options.operationTimeoutMs ?? 5_000,
      ),
      ...(options.bootstrapPause === undefined
        ? {}
        : {
            BBX_E2E_INTERNAL_GUARDIAN_BOOTSTRAP_PAUSE: options.bootstrapPause,
          }),
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  child.stdout?.on('data', (chunk) => (output += String(chunk)));
  child.stderr?.on('data', (chunk) => (output += String(chunk)));
  return {
    child,
    output: () => output,
    outputPath: resourcePlan.get('playwright')!.metadataDirectory,
    ports: [port],
  };
}

function startLinuxActualTopologyController(
  proxyPort: number,
  appPort: number,
) {
  const resourcePlan = createParentResourcePlan(['playwright']);
  const child = spawn(process.execPath, [playwrightControllerPath], {
    detached: true,
    env: parentResourceEnvironment(resourcePlan, {
      ...process.env,
      BBX_E2E_INTERNAL_CONTROLLER_CONTEXT: 'bbx-e2e-controller-harness-v1',
      BBX_E2E_INTERNAL_CONTROLLER_MODE: 'actual-topology',
      BBX_E2E_INTERNAL_CONTROLLER_PORT: String(proxyPort),
      BBX_E2E_INTERNAL_OPERATION_TIMEOUT_MS: '10000',
      BBX_E2E_INTERNAL_TEST_CONTEXT: 'bbx-e2e-harness-v1',
      BBX_E2E_INTERNAL_FIXTURE_MODE: 'stubborn-ready',
      BBX_E2E_APP_PORT: String(appPort),
      BBX_E2E_PROXY_PORT: String(proxyPort),
      BBX_E2E_TRUSTED_PROXY_TOKEN: 'bbx-e2e-topology-token-000000000',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  child.stdout?.on('data', (chunk) => (output += String(chunk)));
  child.stderr?.on('data', (chunk) => (output += String(chunk)));
  return {
    child,
    output: () => output,
    outputPath: resourcePlan.get('playwright')!.metadataDirectory,
    ports: [proxyPort, appPort],
  };
}

function retainControllerResources(
  controller: ActiveController,
  pendingMessages: unknown[],
) {
  const retain = (message: unknown) => {
    const candidate = message as {
      authority?: unknown;
      resource?: string;
      layerProcessId?: number;
      resourceId?: string;
      ownedPaths?: unknown;
      type?: string;
      version?: number;
    };
    if (candidate.type !== 'owned-resource-authority') return;
    try {
      const allowedResources =
        controller.kind === 'server'
          ? new Map([
              ['server-worker', 'server-worker'],
              ['server-application', 'application'],
            ])
          : new Map([
              ['playwright-owner', 'playwright-owner'],
              ['playwright', 'playwright'],
            ]);
      const resource = candidate.resource;
      const expectedRole =
        typeof resource === 'string'
          ? allowedResources.get(resource)
          : undefined;
      if (
        candidate.version !== 1 ||
        typeof resource !== 'string' ||
        expectedRole === undefined ||
        !Number.isSafeInteger(candidate.layerProcessId) ||
        candidate.layerProcessId! < 1 ||
        controller.resources.has(resource)
      )
        throw new Error('Invalid registered E2E resource authority.');
      const authority = controller.resourceRegistry.accept(
        candidate,
        expectedRole,
      ) as ActiveController['authorities'][number];
      if (
        !Array.isArray(candidate.ownedPaths) ||
        candidate.ownedPaths.length > 2
      )
        throw new Error('Invalid registered E2E owned paths.');
      for (const path of candidate.ownedPaths) {
        const expectedPath = controller.resourcePaths.get('playwright');
        if (
          controller.kind !== 'playwright' ||
          typeof path !== 'string' ||
          path !== expectedPath ||
          exactOwnedTempDirectory(path) !== expectedPath
        )
          throw new Error('Invalid registered E2E owned path.');
        controller.ownedPaths.add(expectedPath);
      }
      controller.authorities.push(authority);
      controller.resources.add(resource);
      controller.layerProcessIds.add(authority.supervisorProcessId);
      const acknowledge = () => {
        if (controller.child.connected)
          controller.child.send({
            type: 'owned-resource-authority-ack',
            resource,
            resourceId: controller.resourceRegistry.entry(resource).resourceId,
            version: 1,
          });
      };
      if (controller.authorityAckDelayMs === 0) acknowledge();
      else setTimeout(acknowledge, controller.authorityAckDelayMs).unref();
    } catch {
      if (
        controller.child.exitCode === null &&
        controller.child.signalCode === null
      )
        controller.child.kill('SIGKILL');
    }
  };
  controller.child.on('message', retain);
  for (const message of pendingMessages) retain(message);
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
  message: string | (() => string),
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(typeof message === 'function' ? message() : message);
}

async function waitForAsync(
  condition: () => Promise<boolean>,
  message: string,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
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

function processState(processId: number) {
  const linuxIdentity = readLinuxProcessIdentity(processId);
  if (linuxIdentity !== undefined)
    return linuxIdentity.zombie
      ? `zombie(ppid=${linuxIdentity.parentProcessId},pgid=${linuxIdentity.processGroupId},sid=${linuxIdentity.sessionId})`
      : `live(ppid=${linuxIdentity.parentProcessId},pgid=${linuxIdentity.processGroupId},sid=${linuxIdentity.sessionId})`;
  if (process.platform === 'linux') return 'absent';
  return probeProcessState(processId);
}

function processAbsent(processId: number) {
  return processState(processId) === 'absent';
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

function phasePids(output: string, phase: string) {
  return Array.from(
    output.matchAll(new RegExp(`BBX_E2E_PHASE ${phase} pid=([0-9]+)`, 'g')),
    (match) => Number(match[1]),
  );
}

function phaseDetails(output: string, phase: string) {
  const match = new RegExp(`BBX_E2E_PHASE ${phase} ([^\\r\\n]+)`).exec(output);
  const fields = match?.[1];
  if (!fields) return undefined;
  return Object.fromEntries(
    fields.split(' ').map((field) => {
      const [key, value] = field.split('=');
      return [key, Number(value)];
    }),
  );
}

function expectLinuxFixtureOwnership(output: string, ownerPid: number) {
  if (process.platform !== 'linux') return;
  const identity = phaseDetails(output, 'controller-fixture-ready');
  expect(identity).toBeDefined();
  expect(identity!['root-ppid']).toBe(ownerPid);
  expect(identity!.ppid).toBe(identity!['root-pid']);
  expect(identity!.pgid).toBe(identity!['root-pgid']);
  expect(identity!.sid).toBe(identity!['root-sid']);
  expect(identity!['root-pgid']).toBe(identity!['root-pid']);
  expect(identity!['root-sid']).toBe(identity!['root-pid']);
}

async function stopController(child: ChildProcess) {
  if (child.exitCode === null && child.signalCode === null && child.connected)
    child.send({ type: 'shutdown', version: 1 });
  await waitForExit(child);
}

async function runWithExactCleanup<T>(
  action: () => Promise<T>,
  cleanup: () => Promise<void>,
) {
  let actionFailure: unknown;
  let cleanupFailure: unknown;
  let result: T | undefined;
  try {
    result = await action();
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
      'E2E assertion and exact cleanup both failed.',
    );
  if (cleanupFailure !== undefined) throw cleanupFailure;
  if (actionFailure !== undefined) throw actionFailure;
  return result as T;
}

async function cleanupActiveControllers() {
  const failures: unknown[] = [];
  for (const controller of active) {
    const resourceFailures: unknown[] = [];
    const { child } = controller;
    try {
      if (child.exitCode === null && child.signalCode === null) {
        if (child.connected) child.send({ type: 'shutdown', version: 1 });
        try {
          await waitForExit(child, 10_000);
        } catch (error) {
          resourceFailures.push(error);
          try {
            await terminateDirectChild(controller.directAuthority);
          } catch (terminationError) {
            resourceFailures.push(terminationError);
          }
        }
      }
      if (child.pid !== undefined && !processAbsent(child.pid))
        resourceFailures.push(
          new Error('Controller remained after exact teardown.'),
        );

      for (const authority of controller.authorities)
        try {
          await cleanupOwnedProcessAuthority(authority);
        } catch (error) {
          resourceFailures.push(error);
        }
      for (const resource of controller.resources)
        try {
          controller.resourceRegistry.complete(resource);
        } catch (error) {
          resourceFailures.push(error);
        }
      try {
        await waitFor(
          () => [...controller.layerProcessIds].every(processAbsent),
          'Registered owner or worker did not converge to absence.',
          10_000,
        );
      } catch (error) {
        resourceFailures.push(error);
      }
      const ownedPids = new Set(
        controller.authorities.flatMap((authority) => [
          authority.supervisorProcessId,
          authority.actualProcessId,
        ]),
      );
      if (![...ownedPids].every(processAbsent))
        resourceFailures.push(
          new Error('Registered ownership did not converge to absence.'),
        );
      for (const port of controller.ports)
        if (!(await portIsFree(port)))
          resourceFailures.push(
            new Error('Registered listener remained after teardown.'),
          );
      for (const path of controller.ownedPaths)
        try {
          await removeExactOwnedTempDirectory(path);
        } catch (error) {
          resourceFailures.push(error);
        }
      const paths = controller.authorities.map(
        (authority) => authority.metadataDirectory,
      );
      paths.push(...controller.ownedPaths);
      for (const path of paths)
        if (await pathExists(path))
          resourceFailures.push(
            new Error('Registered metadata or output remained after teardown.'),
          );
      if (resourceFailures.length === 0) active.delete(controller);
    } catch (error) {
      resourceFailures.push(error);
    }
    failures.push(...resourceFailures);
  }
  if (failures.length > 0)
    throw new AggregateError(failures, 'E2E ownership teardown failed.');
}

function it(name: string, body: () => Promise<void>, timeout?: number) {
  return vitestIt(
    name,
    () => runWithExactCleanup(body, cleanupActiveControllers),
    timeout,
  );
}

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
        () => `Controller did not become ready.\n${controller.output()}`,
        10_000,
      );
      const workerPid = phasePid(controller.output(), 'server-worker-spawned');
      const appPid = phasePid(controller.output(), 'application-spawned');
      expect(workerPid).toBeTypeOf('number');
      expect(appPid).toBeTypeOf('number');
      expect((await fetch(`http://127.0.0.1:${proxyPort}/health`)).status).toBe(
        200,
      );
      await stopController(controller.child);
      expect(controller.child.exitCode).toBe(0);
      await waitFor(
        () => processAbsent(workerPid!) && processAbsent(appPid!),
        () =>
          `Owned E2E processes remained after shutdown: worker=${processState(workerPid!)} app=${processState(appPid!)}.`,
      );
      expect(await portIsFree(appPort)).toBe(true);
      expect(await portIsFree(proxyPort)).toBe(true);
      expect(await portIsFree(sentinelPort)).toBe(false);
      expect(controller.output()).toContain(
        'BBX_E2E_PHASE server-controller-cleanup-complete',
      );
      expect(
        controller.output().match(/server-terminal-result-received/g),
      ).toHaveLength(1);
      expect(
        controller.output().indexOf('worker-cleanup-complete'),
      ).toBeLessThan(
        controller.output().indexOf('server-terminal-result-received'),
      );
      expect(
        controller.output().indexOf('server-terminal-result-acknowledged'),
      ).toBeLessThan(
        controller.output().indexOf('server-controller-cleanup-complete'),
      );
      if (process.platform === 'win32') {
        expect(
          controller.output().indexOf('windows-job-child-assigned'),
        ).toBeLessThan(
          controller.output().indexOf('windows-job-child-resumed'),
        );
      }
    } finally {
      sentinel.close();
    }
  }, 15_000);

  it('propagates a failure before application spawn', async () => {
    const appPort = await freePort();
    const proxyPort = await freePort();
    const controller = startController('pre-spawn-failure', appPort, proxyPort);
    await waitForExit(controller.child);
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
    const controller = startController('stall', appPort, proxyPort, {
      startupTimeoutMs: 2000,
    });
    await waitForExit(controller.child);
    const applicationPids = [
      ...phasePids(controller.output(), 'application-supervisor-spawned'),
      ...phasePids(controller.output(), 'application-spawned'),
    ];
    expect(controller.child.exitCode).toBe(1);
    expect(controller.output()).toMatch(
      /BBX_E2E_PHASE (application-startup-timeout|server-startup-timeout|server-worker-failed)/,
    );
    await waitFor(
      () => applicationPids.every(processAbsent),
      () =>
        `Stalled fixture processes remained after startup timeout: ${applicationPids
          .map((pid) => `${pid}:${processState(pid)}`)
          .join(',')}.`,
    );
    await waitForAsync(
      async () => (await portIsFree(appPort)) && (await portIsFree(proxyPort)),
      'Startup-timeout listeners did not converge to absence.',
      10_000,
    );
  }, 15_000);

  it('allows the complete cleanup budget for a SIGKILL-required child', async () => {
    if (process.platform !== 'linux') return;
    const appPort = await freePort();
    const proxyPort = await freePort();
    const controller = startController('stubborn-stall', appPort, proxyPort, {
      startupTimeoutMs: 5_000,
    });
    await waitForExit(controller.child, 15_000);
    const output = controller.output();
    const workerPid = phasePid(output, 'server-worker-spawned')!;
    const applicationPid = phasePid(output, 'application-spawned')!;

    expect(controller.child.exitCode).not.toBe(0);
    expect(output).toContain('forced-process-cleanup=1');
    expect(output.match(/server-terminal-result-received/g)).toHaveLength(1);
    expect(output).toContain('server-terminal-result-acknowledged');
    expect(output).not.toContain('BBX_E2E_PHASE server-startup-timeout');
    await waitFor(
      () => processAbsent(workerPid) && processAbsent(applicationPid),
      'SIGKILL-required cleanup did not converge.',
      10_000,
    );
    await waitForAsync(
      async () => (await portIsFree(appPort)) && (await portIsFree(proxyPort)),
      'SIGKILL-required listeners did not converge to absence.',
      10_000,
    );
    expect(
      await pathExists(controller.resourcePaths.get('server-application')!),
    ).toBe(false);
  }, 20_000);

  it('charges application launch delay to the worker startup deadline', async () => {
    const appPort = await freePort();
    const proxyPort = await freePort();
    const controller = startController('ready', appPort, proxyPort, {
      startupTimeoutMs: 500,
      launchDelayMs: 600,
    });
    await waitForExit(controller.child, 10_000);
    const output = controller.output();
    expect(controller.child.exitCode).toBe(1);
    expect(output).toContain('application-startup-timeout');
    expect(output).not.toContain('BBX_E2E_PHASE application-spawned');
    expect(output).not.toContain('BBX_E2E_PHASE server-startup-timeout');
    expect(await portIsFree(appPort)).toBe(true);
    expect(await portIsFree(proxyPort)).toBe(true);
  }, 15_000);

  for (const [signal, exitCode] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const) {
    it(`preserves ${signal} as a nonzero server result after cleanup`, async () => {
      const appPort = await freePort();
      const proxyPort = await freePort();
      const controller = startController('ready', appPort, proxyPort);
      await waitFor(
        () => controller.output().includes('BBX_E2E_PHASE proxy-ready'),
        () => `Controller did not become ready.\n${controller.output()}`,
        10_000,
      );
      if (process.platform === 'win32')
        controller.child.send({ type: 'simulate-signal', signal, version: 1 });
      else process.kill(controller.child.pid!, signal);
      await waitForExit(controller.child, 15_000);
      expect(controller.child.exitCode).toBe(exitCode);
      expect(controller.output()).toContain('BBX_E2E_PHASE server-signal');
      expect(controller.output()).toContain(
        'BBX_E2E_PHASE server-controller-cleanup-complete',
      );
      expect(await portIsFree(appPort)).toBe(true);
      expect(await portIsFree(proxyPort)).toBe(true);
    }, 20_000);
  }

  it('delivers one valid terminal result when worker cleanup fails', async () => {
    const appPort = await freePort();
    const proxyPort = await freePort();
    const controller = startController('ready', appPort, proxyPort, {
      cleanupFailure: true,
    });
    await waitFor(
      () => controller.output().includes('BBX_E2E_PHASE proxy-ready'),
      () => `Controller did not become ready.\n${controller.output()}`,
      10_000,
    );
    controller.child.send({ type: 'shutdown', version: 1 });
    await waitForExit(controller.child, 15_000);
    const output = controller.output();
    expect(controller.child.exitCode).toBe(1);
    expect(output).toContain(
      'BBX_E2E_PHASE worker-cleanup-failed error-code=1 failure-count=1',
    );
    expect(output.match(/server-terminal-result-received/g)).toHaveLength(1);
    expect(output).toContain('cleanup-error-code=1');
    expect(output).toContain('BBX_E2E_PHASE server-controller-cleanup-failed');
    expect(await portIsFree(appPort)).toBe(true);
    expect(await portIsFree(proxyPort)).toBe(true);
  }, 20_000);

  it('cleans worker, application, and listeners when the controller is externally terminated', async () => {
    const appPort = await freePort();
    const proxyPort = await freePort();
    const controller = startController('ready', appPort, proxyPort);
    await waitFor(
      () => controller.output().includes('BBX_E2E_PHASE proxy-ready'),
      () => `Controller did not become ready.\n${controller.output()}`,
      10_000,
    );
    const workerPid = phasePid(controller.output(), 'server-worker-spawned')!;
    const appPid = phasePid(controller.output(), 'application-spawned')!;
    expect(controller.child.kill('SIGKILL')).toBe(true);
    await waitForExit(controller.child);
    await waitFor(
      () => processAbsent(workerPid) && processAbsent(appPid),
      'Owned processes remained after external controller termination.',
    );
    await waitForAsync(
      async () => (await portIsFree(appPort)) && (await portIsFree(proxyPort)),
      'Externally terminated server listeners did not converge to absence.',
      10_000,
    );
  }, 15_000);

  it('removes a surviving descendant after the application root exits', async () => {
    const appPort = await freePort();
    const proxyPort = await freePort();
    const controller = startController('root-exit', appPort, proxyPort);
    await waitForExit(controller.child, 15_000);
    const applicationPids = phasePids(
      controller.output(),
      'application-spawned',
    );
    const descendantPid = phasePid(
      controller.output(),
      'controller-fixture-ready',
    );
    expect(controller.child.exitCode).toBe(1);
    expect(applicationPids.length).toBeGreaterThanOrEqual(1);
    expect(descendantPid).toBeTypeOf('number');
    await waitFor(
      () =>
        applicationPids.every(processAbsent) && processAbsent(descendantPid!),
      'Application root or surviving descendant remained after natural exit.',
      10_000,
    );
    expect(await portIsFree(appPort)).toBe(true);
    expect(await portIsFree(proxyPort)).toBe(true);
  }, 20_000);

  it('fails closed and removes the application tree after worker termination', async () => {
    const appPort = await freePort();
    const proxyPort = await freePort();
    const controller = startController('ready', appPort, proxyPort);
    await waitFor(
      () => controller.output().includes('BBX_E2E_PHASE proxy-ready'),
      () => `Controller did not become ready.\n${controller.output()}`,
      10_000,
    );
    expect(
      controller.output().indexOf('application-ownership-authority-retained'),
    ).toBeLessThan(controller.output().indexOf('proxy-ready'));
    const workerPid = phasePid(controller.output(), 'server-worker-spawned')!;
    const applicationPids = phasePids(
      controller.output(),
      'application-spawned',
    );
    expect(process.kill(workerPid, 'SIGKILL')).toBe(true);
    await waitForExit(controller.child, 15_000);
    expect(controller.child.exitCode).toBe(1);
    await waitFor(
      () => processAbsent(workerPid) && applicationPids.every(processAbsent),
      'Worker-owned application tree remained after worker termination.',
      10_000,
    );
    expect(
      await pathExists(controller.resourcePaths.get('server-application')!),
    ).toBe(false);
    expect(await portIsFree(appPort)).toBe(true);
    expect(await portIsFree(proxyPort)).toBe(true);
  }, 30_000);

  it('isolates concurrent server-controller ownership', async () => {
    const firstApp = await freePort();
    const firstProxy = await freePort();
    const secondApp = await freePort();
    const secondProxy = await freePort();
    const first = startController('ready', firstApp, firstProxy);
    const second = startController('ready', secondApp, secondProxy);
    await waitFor(
      () =>
        first.output().includes('BBX_E2E_PHASE proxy-ready') &&
        second.output().includes('BBX_E2E_PHASE proxy-ready'),
      () =>
        `Concurrent controllers did not become ready.\n${first.output()}\n${second.output()}`,
      15_000,
    );
    const secondWorker = phasePid(second.output(), 'server-worker-spawned')!;
    const secondApplications = phasePids(
      second.output(),
      'application-spawned',
    );
    await stopController(first.child);
    expect(processAbsent(secondWorker)).toBe(false);
    expect(secondApplications.every((pid) => !processAbsent(pid))).toBe(true);
    expect(await portIsFree(firstApp)).toBe(true);
    expect(await portIsFree(firstProxy)).toBe(true);
    expect(await portIsFree(secondApp)).toBe(false);
    expect(await portIsFree(secondProxy)).toBe(false);
    await stopController(second.child);
    await waitFor(
      () =>
        processAbsent(secondWorker) && secondApplications.every(processAbsent),
      'Concurrent survivor did not clean its exact owned tree.',
      10_000,
    );
  }, 30_000);
});

describe('top-level Playwright ownership', () => {
  it('returns success only after a successful child and exact cleanup', async () => {
    const port = await freePort();
    const controller = startPlaywrightController(port, { mode: 'success' });
    await waitForExit(controller.child, 10_000).catch((error) => {
      throw new Error(
        `Successful controller did not exit.\n${controller.output()}`,
        { cause: error },
      );
    });
    const outputPath = controller.resourcePaths.get('playwright')!;

    expect(controller.child.exitCode, controller.output()).toBe(0);
    expect(controller.output()).toContain(
      'BBX_E2E_PHASE playwright-child-exit exit-code=0 signaled=0',
    );
    expect(controller.output()).toContain(
      'BBX_E2E_PHASE playwright-owner-cleanup-complete',
    );
    if (process.platform === 'win32') {
      const output = controller.output();
      expect(output.indexOf('windows-job-child-assigned')).toBeLessThan(
        output.indexOf('windows-job-child-resumed'),
      );
      expect(output).toContain('BBX_E2E_PHASE windows-job-cleanup-complete');
    }
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
    const outputPath = controller.resourcePaths.get('playwright')!;

    expect(controller.child.exitCode).toBe(0);
    expect(controller.output()).toContain('process-already-absent=1');
    expect(controller.output()).toContain('cleanup-error-code=0');
    expect(await pathExists(outputPath)).toBe(false);
  }, 15_000);

  it('cleans the owned tree after its actual root leader exits', async () => {
    const port = await freePort();
    const controller = startPlaywrightController(port, { mode: 'root-exit' });
    await waitForExit(controller.child, 10_000);
    const ownerPid = phasePid(controller.output(), 'playwright-owner-spawned')!;
    const fixturePid = phasePid(controller.output(), 'playwright-spawned')!;
    const descendantPid = phasePid(
      controller.output(),
      'controller-fixture-ready',
    )!;
    const outputPath = controller.resourcePaths.get('playwright')!;

    expectLinuxFixtureOwnership(controller.output(), ownerPid);
    expect(controller.child.exitCode).toBe(0);
    expect(controller.output()).toContain(
      'BBX_E2E_PHASE playwright-child-exit exit-code=0 signaled=0',
    );
    expect(controller.output()).toContain('cleanup-error-code=0');
    await waitFor(
      () => processAbsent(fixturePid) && processAbsent(descendantPid),
      'The exited Linux leader group remained present after cleanup.',
      10_000,
    );
    expect(await pathExists(outputPath)).toBe(false);
    expect(await portIsFree(port)).toBe(true);
  }, 15_000);

  vitestIt.skipIf(process.platform !== 'linux')(
    'cleans a real uninstrumented Linux descendant after its leaders exit',
    async () => {
      await runWithExactCleanup(async () => {
        const port = await freePort();
        const controller = startPlaywrightController(port, {
          mode: 'uninstrumented-root-exit',
        });
        await waitForExit(controller.child, 15_000);
        const fixturePid = phasePid(controller.output(), 'playwright-spawned')!;
        const descendantPid = phasePid(
          controller.output(),
          'controller-fixture-ready',
        )!;
        const outputPath = controller.resourcePaths.get('playwright')!;

        expect(controller.child.exitCode).toBe(0);
        expect(controller.output()).toContain('cleanup-error-code=0');
        await waitFor(
          () => processAbsent(fixturePid) && processAbsent(descendantPid),
          'The uninstrumented Linux descendant remained after cleanup.',
          10_000,
        );
        expect(await pathExists(outputPath)).toBe(false);
        expect(await portIsFree(port)).toBe(true);
      }, cleanupActiveControllers);
    },
    20_000,
  );

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
    controller.child.send({ type: 'shutdown', version: 1 });
    await waitForExit(controller.child, 10_000);
    const outputPath = controller.resourcePaths.get('playwright')!;

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

  it('fails closed and cleans exact ownership on duplicate protocol launch authority', async () => {
    const port = await freePort();
    const controller = startPlaywrightController(port, {
      mode: 'hang',
      protocolFault: 'duplicate-launch-authority',
    });
    await waitForExit(controller.child, 10_000);
    expect(controller.child.exitCode).toBe(1);
    expect(controller.output()).toContain(
      'BBX_E2E_PHASE owner-protocol-failed error-code=1',
    );
    expect(controller.output()).toContain(
      'BBX_E2E_PHASE controller-watchdog-state expired=0',
    );
    expect(await pathExists(controller.resourcePaths.get('playwright')!)).toBe(
      false,
    );
    expect(await portIsFree(port)).toBe(true);
  }, 15_000);

  for (const testCase of [
    {
      label: 'after launch authority Promise settlement',
      protocolFault: 'unknown-after-launch-settlement' as const,
      mode: 'hang' as const,
    },
    {
      label: 'while owned-process spawn is pending',
      protocolFault: 'unknown-pending-spawn' as const,
      mode: 'hang' as const,
    },
    ...(process.platform === 'win32'
      ? [
          {
            label: 'while the Windows ownership handoff is pending',
            protocolFault: 'unknown-pending-handoff' as const,
            mode: 'hang' as const,
          },
        ]
      : []),
    {
      label: 'after the handle exists but before ownership readiness',
      protocolFault: 'unknown-before-ownership-ready' as const,
      mode: 'hang' as const,
    },
    {
      label: 'after running begins',
      protocolFault: 'unknown-running' as const,
      mode: 'hang' as const,
    },
    {
      label: 'during cleanup',
      protocolFault: 'unknown-cleaning' as const,
      mode: 'success' as const,
    },
    {
      label: 'after the terminal result',
      protocolFault: 'unknown-after-terminal-result' as const,
      mode: 'success' as const,
    },
  ])
    it(`fails once and converges immediately on an invalid message ${testCase.label}`, async () => {
      const port = await freePort();
      const startedAt = Date.now();
      const controller = startPlaywrightController(port, {
        mode: testCase.mode,
        operationTimeoutMs: 5_000,
        protocolFault: testCase.protocolFault,
      });
      await waitForExit(controller.child, 12_000);
      const ownerPid = phasePid(
        controller.output(),
        'playwright-owner-spawned',
      )!;
      const rootPid = phasePid(controller.output(), 'playwright-spawned');
      const descendantPid = phasePid(
        controller.output(),
        'controller-fixture-ready',
      );

      expect(controller.child.exitCode).toBe(1);
      expect(controller.output()).toContain(
        'BBX_E2E_PHASE controller-protocol-fault-injected',
      );
      expect(controller.output().match(/owner-protocol-failed/g)).toHaveLength(
        1,
      );
      expect(controller.output()).toContain(
        'BBX_E2E_PHASE controller-watchdog-state expired=0',
      );
      expect(Date.now() - startedAt).toBeLessThan(12_000);
      await waitFor(
        () =>
          processAbsent(ownerPid) &&
          (rootPid === undefined || processAbsent(rootPid)) &&
          (descendantPid === undefined || processAbsent(descendantPid)),
        'Invalid owner protocol left an owned process running.',
        10_000,
      );
      expect(
        await pathExists(controller.resourcePaths.get('playwright')!),
      ).toBe(false);
      expect(await portIsFree(port)).toBe(true);
    }, 20_000);

  it('preserves protocol and pending-spawn failures in one terminal result', async () => {
    const port = await freePort();
    const controller = startPlaywrightController(port, {
      mode: 'hang',
      operationTimeoutMs: 5_000,
      protocolFault: 'unknown-pending-spawn',
      spawnFailure: true,
    });
    await waitForExit(controller.child, 12_000);
    const output = controller.output();
    expect(controller.child.exitCode).toBe(1);
    expect(output.match(/playwright-owner-cleanup-start/g)).toHaveLength(1);
    expect(output.match(/owner-terminal-result-sent/g)).toHaveLength(1);
    expect(output).toContain(
      'BBX_E2E_PHASE controller-terminal-result-received exit-code=1 cleanup-error-code=0 failure-count=2',
    );
    expect(output.match(/owner-protocol-failed/g)).toHaveLength(1);
    expect(await pathExists(controller.resourcePaths.get('playwright')!)).toBe(
      false,
    );
    expect(await portIsFree(port)).toBe(true);
  }, 20_000);

  it('starts stubborn-descendant cleanup at the operation deadline and finishes before the outer watchdog', async () => {
    const port = await freePort();
    const controller = startPlaywrightController(port, {
      mode: 'stubborn-hang',
      // The shortened operation window still includes real Windows Job setup.
      operationTimeoutMs: 5_000,
    });
    await waitForExit(controller.child, 15_000);
    const ownerPid = phasePid(controller.output(), 'playwright-owner-spawned')!;
    const fixturePid = phasePid(controller.output(), 'playwright-spawned')!;
    const descendantPid = phasePid(
      controller.output(),
      'controller-fixture-ready',
    );
    const supervisorPid = phasePid(
      controller.output(),
      'playwright-supervisor-spawned',
    );
    expectLinuxFixtureOwnership(controller.output(), ownerPid);
    const outputPath = controller.resourcePaths.get('playwright')!;

    expect(controller.child.exitCode).toBe(1);
    expect(controller.output()).toContain(
      'BBX_E2E_PHASE controller-ownership-authority-retained',
    );
    expect(controller.output()).toContain(
      'BBX_E2E_PHASE controller-watchdog-state expired=0',
    );
    expect(controller.output()).toContain(
      'BBX_E2E_PHASE controller-operation-deadline',
    );
    expect(controller.output()).toContain(
      process.platform === 'linux'
        ? 'BBX_E2E_PHASE controller-forced-group-cleanup'
        : 'BBX_E2E_PHASE playwright-owner-forced-cleanup',
    );
    expect(controller.output()).toContain(
      'BBX_E2E_PHASE operation-timeout exit-code=1',
    );
    expect(controller.output()).not.toContain('BBX_E2E_PHASE outer-timeout');
    expect(
      controller.output().indexOf('controller-operation-deadline'),
    ).toBeLessThan(
      controller.output().indexOf('playwright-owner-cleanup-start'),
    );
    expect(
      controller.output().indexOf('owner-terminal-result-acknowledged'),
    ).toBeLessThan(
      controller.output().indexOf('operation-timeout exit-code=1'),
    );
    await waitFor(
      () =>
        processAbsent(ownerPid) &&
        (supervisorPid === undefined || processAbsent(supervisorPid)) &&
        (fixturePid === undefined || processAbsent(fixturePid)) &&
        (descendantPid === undefined || processAbsent(descendantPid)),
      () =>
        `Watchdog cleanup did not remove every owned PID: owner=${processState(ownerPid)} supervisor=${supervisorPid === undefined ? 'not-started' : processState(supervisorPid)} root=${fixturePid === undefined ? 'not-started' : processState(fixturePid)} descendant=${descendantPid === undefined ? 'not-started' : processState(descendantPid)}.`,
      10_000,
    );
    expect(await pathExists(outputPath)).toBe(false);
    expect(await portIsFree(port)).toBe(true);
  }, 20_000);

  it('uses retained authority for top-level signal cleanup', async () => {
    const port = await freePort();
    const controller = startPlaywrightController(port);
    await waitFor(
      () => controller.output().includes('controller-fixture-ready'),
      () => `Controller fixture did not become ready.\n${controller.output()}`,
      10_000,
    );
    const ownerPid = phasePid(controller.output(), 'playwright-owner-spawned')!;
    const rootPid = phasePid(controller.output(), 'playwright-spawned')!;
    const descendantPid = phasePid(
      controller.output(),
      'controller-fixture-ready',
    )!;
    const outputPath = controller.resourcePaths.get('playwright')!;
    if (process.platform === 'win32')
      controller.child.send({
        type: 'simulate-signal',
        signal: 'SIGTERM',
        version: 1,
      });
    else process.kill(controller.child.pid!, 'SIGTERM');
    await waitForExit(controller.child, 15_000);
    expect(controller.child.exitCode).toBe(143);
    expect(controller.output()).toContain(
      'BBX_E2E_PHASE controller-ownership-authority-retained',
    );
    await waitFor(
      () =>
        processAbsent(ownerPid) &&
        processAbsent(rootPid) &&
        processAbsent(descendantPid),
      'Signal cleanup left an owned Playwright process.',
      10_000,
    );
    expect(await pathExists(outputPath)).toBe(false);
    expect(await portIsFree(port)).toBe(true);
  }, 25_000);

  it('cleans an externally terminated controller without touching a concurrent owner', async () => {
    const originalNextEnvironment = await readFile(nextEnvironmentPath);
    const firstPort = await freePort();
    let secondPort = await freePort();
    while (secondPort === firstPort) secondPort = await freePort();
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
    const firstGuardian = phasePid(
      first.output(),
      'windows-layer-job-guardian-ready',
    );
    const secondOwner = phasePid(second.output(), 'playwright-owner-spawned')!;
    const secondOutputPath = second.resourcePaths.get('playwright')!;
    const firstOutputPath = first.resourcePaths.get('playwright')!;
    expectLinuxFixtureOwnership(first.output(), firstOwner);
    expectLinuxFixtureOwnership(second.output(), secondOwner);
    expect(await pathExists(firstOutputPath)).toBe(true);
    expect(await pathExists(secondOutputPath)).toBe(true);

    expect(first.child.kill('SIGKILL')).toBe(true);
    await waitForExit(first.child);
    await waitFor(
      () =>
        processAbsent(firstOwner) &&
        processAbsent(firstPlaywright) &&
        processAbsent(firstDescendant),
      () =>
        `The surviving owner did not clean the terminated controller tree: owner=${processState(firstOwner)} root=${processState(firstPlaywright)} descendant=${processState(firstDescendant)}.`,
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
    if (firstGuardian !== undefined)
      await waitFor(
        () => processAbsent(firstGuardian),
        'The surviving owner guardian did not converge.',
        10_000,
      );
    expect(await pathExists(secondOutputPath)).toBe(true);
    await waitForAsync(
      () => portIsFree(firstPort),
      'Externally terminated controller listener did not converge to absence.',
      10_000,
    );
    expect(await portIsFree(secondPort)).toBe(false);
    expect(await readFile(nextEnvironmentPath)).toEqual(
      originalNextEnvironment,
    );

    second.child.send({ type: 'shutdown', version: 1 });
    await waitForExit(second.child, 15_000);
    expect(await pathExists(secondOutputPath)).toBe(false);
    expect(await portIsFree(secondPort)).toBe(true);
    expect(await readFile(nextEnvironmentPath)).toEqual(
      originalNextEnvironment,
    );
  }, 30_000);

  it('converges exact ownership when the controller dies during cleanup', async () => {
    const port = await freePort();
    const controller = startPlaywrightController(port, {
      mode: 'stubborn-hang',
      operationTimeoutMs: 5_000,
    });
    await waitFor(
      () =>
        controller
          .output()
          .includes('BBX_E2E_PHASE playwright-owner-cleanup-start'),
      () => `Controller cleanup did not begin.\n${controller.output()}`,
      10_000,
    );
    const owner = phasePid(controller.output(), 'playwright-owner-spawned')!;
    const root = phasePid(controller.output(), 'playwright-spawned')!;
    const descendant = phasePid(
      controller.output(),
      'controller-fixture-ready',
    )!;
    expect(controller.child.kill('SIGKILL')).toBe(true);
    await waitForExit(controller.child, 10_000);
    await waitFor(
      () => [owner, root, descendant].every(processAbsent),
      'Controller death during cleanup left an owned process.',
      12_000,
    );
    expect(await portIsFree(port)).toBe(true);
    await cleanupActiveControllers();
    expect(await pathExists(controller.resourcePaths.get('playwright')!)).toBe(
      false,
    );
  }, 30_000);

  it('reclaims an exact failed-assertion tree without touching its concurrent tree', async () => {
    const failedPort = await freePort();
    let survivingPort = await freePort();
    while (survivingPort === failedPort) survivingPort = await freePort();
    const failed = startPlaywrightController(failedPort);
    const surviving = startPlaywrightController(survivingPort, {
      registered: false,
    });
    try {
      await waitFor(
        () =>
          failed.output().includes('controller-fixture-ready') &&
          surviving.output().includes('controller-fixture-ready'),
        'Assertion-failure fixtures did not become ready.',
        10_000,
      );
      const failedOwner = phasePid(
        failed.output(),
        'playwright-owner-spawned',
      )!;
      const failedRoot = phasePid(failed.output(), 'playwright-spawned')!;
      const failedDescendant = phasePid(
        failed.output(),
        'controller-fixture-ready',
      )!;
      const failedGuardians = phasePids(
        failed.output(),
        'windows-layer-job-guardian-ready',
      );
      const survivingRoot = phasePid(surviving.output(), 'playwright-spawned')!;
      const failedOutput = failed.resourcePaths.get('playwright')!;

      await expect(
        runWithExactCleanup(async () => {
          expect(failed.child.kill('SIGKILL')).toBe(true);
          await waitForExit(failed.child);
          expect('early assertion').toBe('deliberate failure');
        }, cleanupActiveControllers),
      ).rejects.toThrow();
      expect(processAbsent(failed.child.pid!)).toBe(true);
      expect(processAbsent(failedOwner)).toBe(true);
      expect(processAbsent(failedRoot)).toBe(true);
      expect(processAbsent(failedDescendant)).toBe(true);
      expect(failedGuardians.every(processAbsent)).toBe(true);
      expect(await pathExists(failedOutput)).toBe(false);
      expect(await portIsFree(failedPort)).toBe(true);
      expect(processAbsent(survivingRoot)).toBe(false);
      expect(await portIsFree(survivingPort)).toBe(false);
    } finally {
      await stopController(surviving.child);
    }
  }, 30_000);
});

describe.skipIf(process.platform !== 'linux')(
  'Linux upper-layer launch authority',
  () => {
    for (const testCase of [
      {
        label: 'before ownership acknowledgement',
        phase: 'server-upper-authority-requested',
        authorityAckDelayMs: 1_500,
        childExpected: false,
      },
      {
        label: 'immediately after child spawn',
        phase: 'application-spawned',
        authorityAckDelayMs: 0,
        childExpected: true,
      },
      {
        label: 'immediately after authority retention',
        phase: 'application-ownership-authority-retained',
        authorityAckDelayMs: 0,
        childExpected: false,
      },
      {
        label: 'after readiness',
        phase: 'proxy-ready',
        authorityAckDelayMs: 0,
        childExpected: true,
      },
    ]) {
      it(`converges the exact group when the worker dies ${testCase.label}`, async () => {
        const appPort = await freePort();
        const proxyPort = await freePort();
        const controller = startController('ready', appPort, proxyPort, {
          authorityAckDelayMs: testCase.authorityAckDelayMs,
        });
        await waitFor(
          () => controller.output().includes(`BBX_E2E_PHASE ${testCase.phase}`),
          () =>
            `Worker did not reach ${testCase.phase}.\n${controller.output()}`,
          10_000,
        );
        const workerPid = phasePid(
          controller.output(),
          'server-worker-spawned',
        )!;
        expect(process.kill(workerPid, 'SIGKILL')).toBe(true);
        await waitForExit(controller.child, 15_000);
        const applicationPids = phasePids(
          controller.output(),
          'application-spawned',
        );
        if (testCase.childExpected)
          expect(applicationPids.length).toBeGreaterThan(0);
        if (testCase.authorityAckDelayMs > 0)
          expect(applicationPids).toHaveLength(0);
        const descendantPids = phasePids(
          controller.output(),
          'controller-fixture-ready',
        );
        await waitFor(
          () =>
            processAbsent(workerPid) &&
            [...applicationPids, ...descendantPids].every(processAbsent),
          'Upper-layer authority did not converge the exact server group.',
          10_000,
        );
        expect(await portIsFree(appPort)).toBe(true);
        expect(await portIsFree(proxyPort)).toBe(true);
        expect(
          await pathExists(controller.resourcePaths.get('server-application')!),
        ).toBe(false);
      }, 25_000);
    }

    for (const testCase of [
      {
        label: 'before ownership acknowledgement',
        phase: 'controller-upper-authority-requested',
        authorityAckDelayMs: 1_500,
        childExpected: false,
      },
      {
        label: 'immediately after child spawn',
        phase: 'playwright-spawned',
        authorityAckDelayMs: 0,
        childExpected: true,
      },
      {
        label: 'immediately after authority retention',
        phase: 'controller-ownership-authority-retained',
        authorityAckDelayMs: 0,
        childExpected: false,
      },
      {
        label: 'after readiness',
        phase: 'controller-fixture-ready',
        authorityAckDelayMs: 0,
        childExpected: true,
      },
    ]) {
      it(`converges the exact group when the owner dies ${testCase.label}`, async () => {
        const { phase, authorityAckDelayMs, childExpected } = testCase;
        const port = await freePort();
        const controller = startPlaywrightController(port, {
          authorityAckDelayMs,
        });
        await waitFor(
          () => controller.output().includes(`BBX_E2E_PHASE ${phase}`),
          () => `Owner did not reach ${phase}.\n${controller.output()}`,
          10_000,
        );
        const ownerPid = phasePid(
          controller.output(),
          'playwright-owner-spawned',
        )!;
        expect(process.kill(ownerPid, 'SIGKILL')).toBe(true);
        await waitForExit(controller.child, 15_000);
        const childPids = phasePids(controller.output(), 'playwright-spawned');
        if (childExpected) expect(childPids.length).toBeGreaterThan(0);
        if (authorityAckDelayMs > 0) expect(childPids).toHaveLength(0);
        const descendantPids = phasePids(
          controller.output(),
          'controller-fixture-ready',
        );
        await waitFor(
          () =>
            processAbsent(ownerPid) &&
            [...childPids, ...descendantPids].every(processAbsent),
          'Upper-layer authority did not converge the exact Linux group.',
          10_000,
        );
        expect(await portIsFree(port)).toBe(true);
        expect(
          await pathExists(controller.resourcePaths.get('playwright')!),
        ).toBe(false);
      }, 25_000);
    }
  },
);

describe.skipIf(process.platform !== 'linux')(
  'Linux standard-command guardian convergence',
  () => {
    async function stopStandardController(
      controller: ReturnType<typeof startLinuxStandardPlaywrightController>,
    ) {
      if (
        controller.child.exitCode === null &&
        controller.child.signalCode === null
      )
        controller.child.kill('SIGTERM');
      await waitForExit(controller.child, 15_000);
    }

    async function assertGuardianFailover(
      controller:
        | ReturnType<typeof startLinuxStandardPlaywrightController>
        | ReturnType<typeof startLinuxActualTopologyController>,
      phase: string,
      timeoutMs = 10_000,
    ) {
      const survivorPort = await freePort();
      const survivor = startLinuxStandardPlaywrightController(survivorPort, {
        mode: 'stubborn-hang',
        operationTimeoutMs: 10_000,
      });
      try {
        await waitFor(
          () => survivor.output().includes('controller-fixture-ready'),
          () =>
            `Concurrent Linux controller was not ready.\n${survivor.output()}`,
          4_000,
        );
        await waitFor(
          () => controller.output().includes(`BBX_E2E_PHASE ${phase}`),
          () =>
            `Guardian-loss boundary ${phase} was not reached.\n${controller.output()}`,
          timeoutMs,
        );
        const guardianProcessId = phasePid(
          controller.output(),
          'linux-group-guardian-ready',
        )!;
        const survivorRoot = phasePid(survivor.output(), 'playwright-spawned')!;
        expect(process.kill(guardianProcessId, 'SIGKILL')).toBe(true);
        await waitForExit(controller.child, 12_000);
        expect(controller.child.exitCode).not.toBe(0);
        const output = controller.output();
        const absence = output.indexOf(
          'BBX_E2E_PHASE linux-controller-guardian-absence-confirmed',
        );
        const fallback = output.indexOf(
          'BBX_E2E_PHASE linux-controller-supervisor-fallback-cleanup-start',
        );
        expect(absence).toBeGreaterThanOrEqual(0);
        expect(fallback).toBeGreaterThan(absence);
        expect(
          output.match(/linux-controller-supervisor-fallback-cleanup-start/g),
        ).toHaveLength(1);
        expect(
          output.match(
            /linux-controller-supervisor-fallback-cleanup-complete/g,
          ),
        ).toHaveLength(1);
        const ownedProcessIds = [
          guardianProcessId,
          phasePid(output, 'controller-start'),
          phasePid(output, 'playwright-owner-spawned'),
          phasePid(output, 'playwright-spawned'),
          phasePid(output, 'server-controller-start'),
          phasePid(output, 'server-worker-spawned'),
          phasePid(output, 'application-spawned'),
          phasePid(output, 'controller-fixture-ready'),
        ].filter((value): value is number => value !== undefined);
        await waitFor(
          () => ownedProcessIds.every(processAbsent),
          () => `Guardian failover left an owned process.\n${output}`,
          8_000,
        );
        for (const port of controller.ports)
          expect(await portIsFree(port)).toBe(true);
        expect(await pathExists(controller.outputPath)).toBe(false);
        expect(processAbsent(survivorRoot)).toBe(false);
        expect(await portIsFree(survivorPort)).toBe(false);
      } finally {
        await stopStandardController(controller);
        await stopStandardController(survivor);
      }
    }

    vitestIt(
      'does not start guardian cleanup before a shortened operation deadline',
      async () => {
        const port = await freePort();
        const startedAt = Date.now();
        const controller = startLinuxStandardPlaywrightController(port, {
          mode: 'stubborn-hang',
          operationTimeoutMs: 5_000,
        });
        try {
          await waitFor(
            () => controller.output().includes('controller-fixture-ready'),
            () => `Linux fixture did not become ready.\n${controller.output()}`,
            2_000,
          );
          await new Promise((resolveBoundary) =>
            setTimeout(
              resolveBoundary,
              Math.max(0, startedAt + 4_000 - Date.now()),
            ),
          );
          expect(controller.output()).not.toContain(
            'linux-controller-guardian-cleanup-start',
          );
          await waitForExit(controller.child, 12_000);
          expect(Date.now() - startedAt).toBeGreaterThanOrEqual(4_900);
          expect(controller.child.exitCode).toBe(1);
        } finally {
          await stopStandardController(controller);
        }
      },
      20_000,
    );

    vitestIt(
      'owns the actual Playwright and web-server process chain in one Linux group',
      async () => {
        const proxyPort = await freePort();
        const appPort = await freePort();
        const controller = startLinuxActualTopologyController(
          proxyPort,
          appPort,
        );
        try {
          await waitFor(
            () =>
              controller.output().includes('BBX_E2E_PHASE proxy-ready') &&
              controller
                .output()
                .includes('BBX_E2E_PHASE server-controller-start'),
            () =>
              `Actual Playwright topology did not become ready.\n${controller.output()}`,
            9_000,
          );
          const output = controller.output();
          const phaseProcessIds = [
            phasePid(output, 'controller-start'),
            phasePid(output, 'playwright-owner-spawned'),
            phasePid(output, 'playwright-spawned'),
            phasePid(output, 'server-controller-start'),
            phasePid(output, 'server-worker-spawned'),
            phasePid(output, 'application-spawned'),
          ].filter((value): value is number => value !== undefined);
          expect(phaseProcessIds).toHaveLength(6);
          const innerController = phaseProcessIds[0];
          if (innerController === undefined)
            throw new Error('Inner controller identity was not captured.');
          const controllerIdentity = readLinuxProcessIdentity(innerController)!;
          expect(controllerIdentity.processGroupId).toBe(innerController);
          expect(controllerIdentity.sessionId).toBe(innerController);
          const ownershipToken = await linuxOwnershipToken(innerController);
          const serverController = phasePid(output, 'server-controller-start')!;
          const serverIdentity = readLinuxProcessIdentity(serverController)!;
          const webServerShell = serverIdentity.parentProcessId;
          expect(webServerShell).not.toBe(
            phasePid(output, 'playwright-spawned'),
          );
          const knownProcessIds = [...phaseProcessIds, webServerShell];
          expect(new Set(knownProcessIds).size).toBe(7);
          for (const processId of knownProcessIds) {
            const identity = readLinuxProcessIdentity(processId)!;
            expect(identity.processGroupId).toBe(
              controllerIdentity.processGroupId,
            );
            expect(identity.sessionId).toBe(controllerIdentity.sessionId);
            expect(await linuxOwnershipToken(processId)).toBe(ownershipToken);
          }
          let browserProcessIds: number[] = [];
          await waitForAsync(
            async () => {
              const candidates = await linuxGroupProcessIds(
                controllerIdentity.processGroupId,
              );
              browserProcessIds = [];
              for (const processId of candidates)
                if (
                  /(?:chrome|chromium)/i.test(await linuxCommandLine(processId))
                )
                  browserProcessIds.push(processId);
              return (
                browserProcessIds.length > 1 &&
                browserProcessIds.some((processId) =>
                  browserProcessIds.includes(
                    readLinuxProcessIdentity(processId)?.parentProcessId ?? -1,
                  ),
                )
              );
            },
            'Chromium and a descendant did not join the guardian-owned Linux group.',
            8_000,
          );
          const groupMembers = await linuxGroupProcessIds(
            controllerIdentity.processGroupId,
          );
          expect(groupMembers.length).toBeGreaterThan(knownProcessIds.length);
          for (const browserProcessId of browserProcessIds) {
            const browserIdentity = readLinuxProcessIdentity(browserProcessId)!;
            expect(browserIdentity.processGroupId).toBe(
              controllerIdentity.processGroupId,
            );
            expect(browserIdentity.sessionId).toBe(
              controllerIdentity.sessionId,
            );
            expect(await linuxOwnershipToken(browserProcessId)).toBe(
              ownershipToken,
            );
          }

          await waitForExit(controller.child, 20_000);
          expect(controller.child.exitCode).toBe(1);
          const guardianProcessId = phasePid(
            controller.output(),
            'linux-group-guardian-ready',
          )!;
          expect(
            controller.output().match(/linux-group-guardian-cleanup-start/g),
          ).toHaveLength(1);
          expect(
            controller.output().match(/linux-group-guardian-forced-cleanup/g),
          ).toHaveLength(1);
          await waitFor(
            () =>
              processAbsent(guardianProcessId) &&
              groupMembers.every(processAbsent),
            'Actual Playwright topology left a Linux group member.',
            10_000,
          );
          expect(await portIsFree(proxyPort)).toBe(true);
          expect(await portIsFree(appPort)).toBe(true);
          expect(await pathExists(controller.outputPath)).toBe(false);
        } finally {
          await stopStandardController(controller);
        }
      },
      30_000,
    );

    for (const guardianLoss of [
      {
        label: 'immediately after guardian arming',
        phase: 'linux-supervisor-before-armed-ack',
        bootstrapPause: 'before-armed-ack' as const,
      },
      {
        label: 'after inner controller authorization',
        phase: 'linux-group-guardian-controller-authorized',
      },
      {
        label: 'after Playwright launch',
        phase: 'playwright-spawned',
      },
      {
        label: 'while guardian cleanup is active',
        phase: 'linux-group-guardian-cleanup-start',
        operationTimeoutMs: 5_000,
      },
      {
        label: 'after terminal result and before acknowledgement',
        phase: 'linux-supervisor-after-terminal-result',
        operationTimeoutMs: 5_000,
        bootstrapPause: 'after-terminal-result' as const,
      },
    ])
      vitestIt(
        `transfers exclusive cleanup authority ${guardianLoss.label}`,
        async () => {
          const port = await freePort();
          const controller = startLinuxStandardPlaywrightController(port, {
            mode: 'stubborn-hang',
            operationTimeoutMs: guardianLoss.operationTimeoutMs ?? 10_000,
            ...(guardianLoss.bootstrapPause === undefined
              ? {}
              : { bootstrapPause: guardianLoss.bootstrapPause }),
          });
          await assertGuardianFailover(controller, guardianLoss.phase);
        },
        30_000,
      );

    vitestIt(
      'transfers cleanup authority after real web server and Chromium launch',
      async () => {
        const proxyPort = await freePort();
        const appPort = await freePort();
        const controller = startLinuxActualTopologyController(
          proxyPort,
          appPort,
        );
        await waitForAsync(
          async () => {
            const innerController = phasePid(
              controller.output(),
              'controller-start',
            );
            if (innerController === undefined) return false;
            const identity = readLinuxProcessIdentity(innerController);
            if (identity === undefined) return false;
            for (const processId of await linuxGroupProcessIds(
              identity.processGroupId,
            ))
              if (
                /(?:chrome|chromium)/i.test(await linuxCommandLine(processId))
              )
                return controller
                  .output()
                  .includes('BBX_E2E_PHASE proxy-ready');
            return false;
          },
          'Real server and Chromium did not reach the guardian-loss boundary.',
          9_000,
        );
        await assertGuardianFailover(controller, 'proxy-ready');
      },
      35_000,
    );

    for (const boundary of [
      {
        label: 'before guardian configuration',
        pause: 'before-configuration' as const,
        phase: 'linux-supervisor-before-configuration',
      },
      {
        label: 'during controller creation',
        pause: 'during-controller-creation' as const,
        phase: 'linux-group-guardian-controller-creation-start',
      },
      {
        label: 'after controller creation but before armed acknowledgement',
        pause: 'before-armed-ack' as const,
        phase: 'linux-supervisor-before-armed-ack',
      },
      {
        label: 'immediately after armed',
        phase: 'linux-group-guardian-controller-authorized',
      },
      {
        label: 'after descendant launch',
        phase: 'controller-fixture-ready',
      },
    ])
      vitestIt(
        `converges when the supervisor dies ${boundary.label}`,
        async () => {
          const port = await freePort();
          const controller = startLinuxStandardPlaywrightController(port, {
            mode: 'stubborn-hang',
            operationTimeoutMs: 10_000,
            ...('pause' in boundary ? { bootstrapPause: boundary.pause } : {}),
          });
          await waitFor(
            () => controller.output().includes(boundary.phase),
            () =>
              `Linux bootstrap boundary was not reached.\n${controller.output()}`,
            8_000,
          );
          if ('pause' in boundary)
            expect(controller.output()).not.toContain(
              'BBX_E2E_PHASE playwright-owner-spawned',
            );
          expect(controller.child.kill('SIGKILL')).toBe(true);
          await waitForExit(controller.child, 5_000);
          await waitFor(
            () => {
              const output = controller.output();
              const processIds = [
                phasePid(output, 'linux-group-guardian-ready'),
                phasePid(output, 'controller-start'),
                phasePid(output, 'playwright-owner-spawned'),
                phasePid(output, 'playwright-spawned'),
                phasePid(output, 'controller-fixture-ready'),
              ].filter((value): value is number => value !== undefined);
              return processIds.every(processAbsent);
            },
            `Supervisor death left a Linux guardian resource.\n${controller.output()}`,
            12_000,
          );
          expect(await portIsFree(port)).toBe(true);
          expect(await pathExists(controller.outputPath)).toBe(false);
        },
        25_000,
      );

    vitestIt(
      'uses one upper TERM/KILL sequence for a hung owner and resistant descendant',
      async () => {
        const port = await freePort();
        const controller = startLinuxStandardPlaywrightController(port);
        try {
          await waitForExit(controller.child, 15_000);
          const output = controller.output();
          const groupGuardian = phasePid(output, 'linux-group-guardian-ready')!;
          const innerController = phasePid(output, 'controller-start')!;
          const owner = phasePid(output, 'playwright-owner-spawned')!;
          const root = phasePid(output, 'playwright-spawned')!;
          const descendant = phasePid(output, 'controller-fixture-ready')!;
          expect(controller.child.exitCode).toBe(1);
          expect(output).toContain(
            'BBX_E2E_PHASE linux-controller-guardian-authority-retained',
          );
          expect(output).toContain(
            'BBX_E2E_PHASE linux-controller-guardian-operation-deadline',
          );
          expect(output).toContain(
            'BBX_E2E_PHASE linux-controller-guardian-cleanup-complete failure-count=0 exit-code=1',
          );
          expect(
            output.match(/linux-controller-guardian-cleanup-start/g),
          ).toHaveLength(1);
          await waitFor(
            () =>
              [groupGuardian, innerController, owner, root, descendant].every(
                processAbsent,
              ),
            'The standard Linux command left an owned process group.',
            10_000,
          );
          expect(await portIsFree(port)).toBe(true);
          expect(await pathExists(controller.outputPath)).toBe(false);
        } finally {
          await stopStandardController(controller);
        }
      },
      25_000,
    );

    vitestIt(
      'retains cleanup authority when the inner controller dies during cleanup',
      async () => {
        const port = await freePort();
        const controller = startLinuxStandardPlaywrightController(port);
        try {
          await waitFor(
            () =>
              controller
                .output()
                .includes('linux-controller-guardian-cleanup-start'),
            () =>
              `Linux guardian did not begin cleanup.\n${controller.output()}`,
            10_000,
          );
          const innerController = phasePid(
            controller.output(),
            'controller-start',
          )!;
          const groupGuardian = phasePid(
            controller.output(),
            'linux-group-guardian-ready',
          )!;
          const owner = phasePid(
            controller.output(),
            'playwright-owner-spawned',
          )!;
          const root = phasePid(controller.output(), 'playwright-spawned')!;
          const descendant = phasePid(
            controller.output(),
            'controller-fixture-ready',
          )!;
          try {
            process.kill(innerController, 'SIGKILL');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          }
          await waitForExit(controller.child, 15_000);
          expect(controller.child.exitCode).toBe(1);
          expect(controller.output()).toContain(
            'BBX_E2E_PHASE linux-controller-guardian-cleanup-complete failure-count=0 exit-code=1',
          );
          await waitFor(
            () =>
              [groupGuardian, innerController, owner, root, descendant].every(
                processAbsent,
              ),
            'The guardian did not converge after inner controller death.',
            10_000,
          );
          expect(await portIsFree(port)).toBe(true);
          expect(await pathExists(controller.outputPath)).toBe(false);
        } finally {
          await stopStandardController(controller);
        }
      },
      25_000,
    );

    vitestIt(
      'recognizes and cleans an uninstrumented descendant after its root exits',
      async () => {
        const port = await freePort();
        const controller = startLinuxStandardPlaywrightController(port, {
          mode: 'uninstrumented-root-exit',
        });
        try {
          await waitForExit(controller.child, 15_000);
          const root = phasePid(controller.output(), 'playwright-spawned')!;
          const descendant = phasePid(
            controller.output(),
            'controller-fixture-ready',
          )!;
          expect(controller.child.exitCode).toBe(0);
          await waitFor(
            () => processAbsent(root) && processAbsent(descendant),
            'The standard guardian left an uninstrumented descendant.',
            10_000,
          );
          expect(await portIsFree(port)).toBe(true);
          expect(await pathExists(controller.outputPath)).toBe(false);
        } finally {
          await stopStandardController(controller);
        }
      },
      25_000,
    );
  },
);
