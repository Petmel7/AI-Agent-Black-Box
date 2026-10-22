import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  resolveWebTestDistDir,
  webTestContextMarker,
} from './next-test-output';
// @ts-expect-error -- The controller is a Node-executed test-only ES module.
import { createIsolatedNextController as createUntypedIsolatedNextController } from './test/isolated-next-controller.mjs';
import { createHarnessTestOutputOwnership } from './test/next-test-output-ownership';

interface IsolatedNextExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface IsolatedNextLaunch {
  readonly id: string;
  readonly pid: number;
  output(): string;
  wait(): Promise<IsolatedNextExit>;
  stop(): Promise<IsolatedNextExit>;
}

interface IsolatedNextController {
  readonly ownerRoot: string;
  readonly webRoot: string;
  readonly workerPid: number;
  launch(options: {
    command: 'build' | 'server';
    environment: NodeJS.ProcessEnv;
    mode?: 'dev' | 'start';
    nextArguments?: string[];
    port?: number;
  }): Promise<IsolatedNextLaunch>;
  shutdown(): Promise<void>;
}

const createIsolatedNextController = createUntypedIsolatedNextController as (
  sourceWebRoot: string,
) => Promise<IsolatedNextController>;

const sourceWebRoot = fileURLToPath(new URL('.', import.meta.url));
const sourcePackageJsonPath = fileURLToPath(
  new URL('./package.json', import.meta.url),
);
const externalControllerPath = fileURLToPath(
  new URL('./test/isolated-next-external-controller.mjs', import.meta.url),
);
const testOutputOwnership = createHarnessTestOutputOwnership(process.pid);
const ownedTestDistDirNames = testOutputOwnership.cleanupDistDirs.map(
  (distDir) => {
    const resolved = resolveWebTestDistDir({
      NODE_ENV: 'test',
      BBX_WEB_INTERNAL_TEST_CONTEXT: webTestContextMarker,
      BBX_WEB_TEST_DIST_DIR: distDir,
    });
    if (resolved === undefined)
      throw new Error('An internal Next test output was not selected.');
    return resolved;
  },
) as [string, string];
const [testDistDirName, productionProbeDistDirName] = ownedTestDistDirNames;
let testDistDirPath: string;
let productionProbeDistDirPath: string;
let isolatedController: IsolatedNextController;
const accessToken = 'actual-next-dashboard-secret';
const proxyToken = Buffer.alloc(32, 6).toString('base64url');
const accessDigest = createHash('sha256').update(accessToken).digest('hex');
const proxyDigest = createHash('sha256').update(proxyToken).digest('hex');
const cursorKey = Buffer.alloc(32, 7).toString('base64url');
const children = new Set<IsolatedNextLaunch>();
const endpoints = new Map<IsolatedNextLaunch, { host: string; port: number }>();
const sourceGeneratedFiles = ['AGENTS.md', 'CLAUDE.md'].map((name) => {
  const path = fileURLToPath(new URL(name, import.meta.url));
  return { path, source: existsSync(path) ? readFileSync(path) : undefined };
});
const nextEnvironmentPath = fileURLToPath(
  new URL('./next-env.d.ts', import.meta.url),
);
const nextEnvironmentSource = readFileSync(nextEnvironmentPath);

interface LaunchContext {
  baseUrl: string;
  child: IsolatedNextLaunch;
  output(): string;
}

async function freePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Unable to allocate a loopback port.'));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

function urlHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}

function environment(
  values: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NEXT_TELEMETRY_DISABLED: '1',
    BBX_WEB_INTERNAL_TEST_CONTEXT: webTestContextMarker,
    BBX_WEB_TEST_DIST_DIR: testDistDirName,
    DATABASE_URL: 'postgresql://dashboard:secret@127.0.0.1:9/unused',
    DASHBOARD_ORGANIZATION_ID: '11111111-1111-4111-8111-111111111111',
    DASHBOARD_ACCESS_TOKEN_SHA256: accessDigest,
    DASHBOARD_CURSOR_SIGNING_KEY: cursorKey,
    DASHBOARD_TRUSTED_PROXY_TOKEN_SHA256: proxyDigest,
    DASHBOARD_ALLOW_INSECURE_LOOPBACK: 'false',
    DASHBOARD_SERVER_BIND_HOST: '127.0.0.1',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'actual-next-storage-secret',
    ARTIFACT_STORAGE_BUCKET: 'private-evidence',
    ...values,
  };
}

async function spawnNextCommand(
  command: 'build',
  values: Record<string, string | undefined>,
): Promise<LaunchContext> {
  const child = await isolatedController.launch({
    command,
    environment: environment(values),
  });
  children.add(child);
  return {
    baseUrl: '',
    child,
    output: child.output,
  };
}

async function spawnNext(
  options: {
    mode?: 'dev' | 'start';
    host?: string;
    values?: Record<string, string | undefined>;
    nextArguments?: string[];
    port?: number;
  } = {},
): Promise<LaunchContext> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? (await freePort(host));
  const child = await isolatedController.launch({
    command: 'server',
    environment: environment({
      DASHBOARD_SERVER_BIND_HOST: host,
      ...options.values,
    }),
    mode: options.mode ?? 'dev',
    ...(options.nextArguments === undefined
      ? {}
      : { nextArguments: options.nextArguments }),
    port,
  });
  children.add(child);
  endpoints.set(child, { host, port });
  return {
    baseUrl: `http://${urlHost(host)}:${port}`,
    child,
    output: child.output,
  };
}

async function startNext(
  options: Parameters<typeof spawnNext>[0] = {},
): Promise<LaunchContext> {
  const context = await spawnNext(options);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${context.baseUrl}/health`);
      if (response.ok) return context;
    } catch {
      // The listener is not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Next server did not become ready.\n${context.output()}`);
}

async function waitForExit(
  context: LaunchContext,
  timeoutMs = 30_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return Promise.race([
    context.child.wait(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Launcher did not exit.')), timeoutMs),
    ),
  ]);
}

async function stopNext(child: IsolatedNextLaunch): Promise<void> {
  await Promise.race([
    child.stop(),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error('Owned Next process did not stop.')),
        10_000,
      ),
    ),
  ]);
  children.delete(child);
}

async function listenerIsAbsent(host: string, port: number): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const server = createServer();
        server.once('error', reject);
        server.listen(port, host, () =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      });
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  return false;
}

async function waitForCondition(
  condition: () => boolean,
  description: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

function processIsAbsent(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

async function waitForChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Controller did not exit.')), 10_000),
    ),
  ]);
}

function authorization(): string {
  return `Basic ${Buffer.from(`blackbox:${accessToken}`).toString('base64')}`;
}

beforeAll(async () => {
  isolatedController = await createIsolatedNextController(sourceWebRoot);
  testDistDirPath = join(
    isolatedController.webRoot,
    ...testDistDirName.split('/'),
  );
  productionProbeDistDirPath = join(
    isolatedController.webRoot,
    ...productionProbeDistDirName.split('/'),
  );
  expect(readFileSync(nextEnvironmentPath)).toEqual(nextEnvironmentSource);
});

afterEach(async () => {
  const observedEndpoints = [...endpoints.values()];
  await Promise.all([...children].map(stopNext));
  children.clear();
  endpoints.clear();
  for (const endpoint of observedEndpoints)
    expect(await listenerIsAbsent(endpoint.host, endpoint.port)).toBe(true);
});

afterAll(async () => {
  if (isolatedController === undefined) {
    expect(readFileSync(nextEnvironmentPath)).toEqual(nextEnvironmentSource);
    return;
  }
  const ownerRoot = isolatedController.ownerRoot;
  await isolatedController.shutdown();
  expect(children.size).toBe(0);
  expect(readFileSync(nextEnvironmentPath)).toEqual(nextEnvironmentSource);
  expect(existsSync(ownerRoot)).toBe(false);
  expect(existsSync(testDistDirPath)).toBe(false);
  expect(existsSync(productionProbeDistDirPath)).toBe(false);
  for (const { path, source } of sourceGeneratedFiles) {
    expect(existsSync(path)).toBe(source !== undefined);
    if (source !== undefined) expect(readFileSync(path)).toEqual(source);
  }
});

describe('actual Next dashboard transport boundary', () => {
  it('routes both supported package scripts through the enforcing launcher', () => {
    const packageJson = JSON.parse(
      readFileSync(sourcePackageJsonPath, 'utf8'),
    ) as { scripts: Record<string, string> };
    expect(packageJson.scripts.dev).toBe(
      'node ./scripts/dashboard-next.mjs dev',
    );
    expect(packageJson.scripts.start).toBe(
      'node ./scripts/dashboard-next.mjs start',
    );
  });

  it('keeps the authoritative Next environment immutable and cleans exact ownership after external controller termination', async () => {
    const host = '127.0.0.1';
    const port = await freePort(host);
    const otherController = await createIsolatedNextController(sourceWebRoot);
    let externalController: ChildProcess | undefined;
    let owned:
      | {
          ownerRoot: string;
          port: number;
          serverPid: number;
          workerPid: number;
        }
      | undefined;
    try {
      externalController = spawn(
        process.execPath,
        [externalControllerPath, sourceWebRoot, host, String(port)],
        {
          cwd: sourceWebRoot,
          env: environment({
            DASHBOARD_ALLOW_INSECURE_LOOPBACK: 'true',
            DASHBOARD_TRUSTED_PROXY_TOKEN_SHA256: undefined,
            NODE_ENV: 'development',
          }),
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        },
      );
      let output = '';
      let diagnostics = '';
      externalController.stderr?.on('data', (chunk) => {
        diagnostics = `${diagnostics}${String(chunk)}`.slice(-12_000);
      });
      owned = await Promise.race([
        new Promise<NonNullable<typeof owned>>((resolve, reject) => {
          externalController?.stdout?.on('data', (chunk) => {
            output += String(chunk);
            const newline = output.indexOf('\n');
            if (newline === -1) return;
            try {
              resolve(
                JSON.parse(output.slice(0, newline)) as NonNullable<
                  typeof owned
                >,
              );
            } catch (error) {
              reject(error);
            }
          });
          externalController?.once('exit', (code, signal) =>
            reject(
              new Error(
                `External controller exited before readiness (${String(
                  code ?? signal,
                )}).\n${diagnostics}`,
              ),
            ),
          );
        }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `External controller readiness timed out.\n${diagnostics}`,
                ),
              ),
            45_000,
          ),
        ),
      ]);

      expect(existsSync(owned.ownerRoot)).toBe(true);
      expect(existsSync(otherController.ownerRoot)).toBe(true);
      expect(readFileSync(nextEnvironmentPath)).toEqual(nextEnvironmentSource);
      externalController.kill('SIGKILL');
      await waitForChildExit(externalController);

      await waitForCondition(
        () => !existsSync(owned?.ownerRoot ?? ''),
        'the terminated controller workspace to be removed',
      );
      await waitForCondition(
        () => processIsAbsent(owned?.serverPid ?? 0),
        'the terminated controller server to exit',
      );
      await waitForCondition(
        () => processIsAbsent(owned?.workerPid ?? 0),
        'the terminated controller worker to exit',
      );
      expect(await listenerIsAbsent(host, port)).toBe(true);
      expect(existsSync(otherController.ownerRoot)).toBe(true);
      expect(readFileSync(nextEnvironmentPath)).toEqual(nextEnvironmentSource);
    } finally {
      if (
        externalController !== undefined &&
        externalController.exitCode === null &&
        externalController.signalCode === null
      ) {
        externalController.kill('SIGKILL');
        await waitForChildExit(externalController).catch(() => undefined);
      }
      if (owned !== undefined)
        await waitForCondition(
          () => !existsSync(owned?.ownerRoot ?? ''),
          'external controller cleanup',
        ).catch(() => undefined);
      await otherController.shutdown();
    }
    expect(existsSync(otherController.ownerRoot)).toBe(false);
  }, 90_000);

  it.each(['build', 'start'] as const)(
    'rejects retained test controls before Next %s can select a custom output',
    async (command) => {
      expect(existsSync(productionProbeDistDirPath)).toBe(false);
      const values = {
        NODE_ENV: 'production',
        BBX_WEB_INTERNAL_TEST_CONTEXT: webTestContextMarker,
        BBX_WEB_TEST_DIST_DIR: productionProbeDistDirName,
      };
      const context =
        command === 'build'
          ? await spawnNextCommand(command, values)
          : await spawnNext({ mode: command, values });
      const result = await waitForExit(context);
      expect(result.code).toBe(1);
      expect(context.output()).toContain(
        'Invalid internal Web test output configuration.',
      );
      expect(existsSync(productionProbeDistDirPath)).toBe(false);
    },
    60_000,
  );

  it('rejects direct/spoofed HTTP and accepts only valid trusted termination with stripped headers', async () => {
    const { baseUrl, child } = await startNext();
    try {
      const direct = await fetch(baseUrl, {
        headers: {
          authorization: authorization(),
          host: 'dashboard.example',
        },
      });
      expect(direct.status).toBe(401);

      const spoofed = await fetch(baseUrl, {
        headers: {
          authorization: authorization(),
          'x-forwarded-proto': 'https',
        },
      });
      expect(spoofed.status).toBe(401);

      for (const proof of [
        undefined,
        'invalid-proxy-proof-token-000000000000',
      ]) {
        const response = await fetch(baseUrl, {
          headers: {
            authorization: authorization(),
            'x-forwarded-proto': 'https',
            ...(proof ? { 'x-blackbox-proxy-token': proof } : {}),
          },
        });
        expect(response.status).toBe(401);
      }

      const trustedHeaders = {
        authorization: authorization(),
        'x-forwarded-proto': 'https',
        'x-blackbox-proxy-token': proxyToken,
        'x-forwarded-for': '198.51.100.1',
        'x-forwarded-host': 'dashboard.example',
      };
      expect((await fetch(baseUrl, { headers: trustedHeaders })).status).toBe(
        200,
      );
      const transport = await fetch(`${baseUrl}/api/dashboard/transport`, {
        headers: trustedHeaders,
      });
      expect(transport.status).toBe(200);
      await expect(transport.json()).resolves.toEqual({ sanitized: true });
    } finally {
      await stopNext(child);
    }
  }, 60_000);

  it('uses the supported launcher to bind both available loopback forms', async () => {
    const hosts = ['127.0.0.1'];
    try {
      await freePort('::1');
      hosts.push('::1');
    } catch {
      // IPv6 loopback is optional on the executing host.
    }

    for (const host of hosts) {
      const { baseUrl, child } = await startNext({
        host,
        values: {
          NODE_ENV: 'development',
          DASHBOARD_ALLOW_INSECURE_LOOPBACK: 'true',
          DASHBOARD_TRUSTED_PROXY_TOKEN_SHA256: undefined,
        },
      });
      try {
        const response = await fetch(baseUrl, {
          headers: { authorization: authorization() },
        });
        expect(response.status).toBe(200);
      } finally {
        await stopNext(child);
      }
    }
  }, 90_000);

  it.each([
    ['separate hostname argument', ['--hostname', '0.0.0.0']],
    ['equals hostname argument', ['--hostname=0.0.0.0']],
    ['short hostname argument', ['-H', '0.0.0.0']],
  ])(
    'rejects declared loopback with an attempted non-loopback bind through %s',
    async (_name, nextArguments) => {
      const context = await spawnNext({
        host: '127.0.0.1',
        values: {
          NODE_ENV: 'development',
          DASHBOARD_ALLOW_INSECURE_LOOPBACK: 'true',
          DASHBOARD_TRUSTED_PROXY_TOKEN_SHA256: undefined,
        },
        nextArguments,
      });
      const result = await waitForExit(context);
      expect(result.code).toBe(1);
      expect(context.output()).toContain(
        'Dashboard Web server configuration is invalid.',
      );
      await expect(
        fetch(context.baseUrl, {
          headers: { authorization: authorization() },
          signal: AbortSignal.timeout(500),
        }),
      ).rejects.toThrow();
    },
  );

  it('rejects insecure-loopback mode in production before creating a listener', async () => {
    const context = await spawnNext({
      mode: 'start',
      host: '127.0.0.1',
      values: {
        NODE_ENV: undefined,
        DASHBOARD_ALLOW_INSECURE_LOOPBACK: 'true',
        DASHBOARD_TRUSTED_PROXY_TOKEN_SHA256: undefined,
      },
    });
    const result = await waitForExit(context);
    expect(result.code).toBe(1);
    expect(context.output()).toContain(
      'Dashboard Web server configuration is invalid.',
    );
  });

  it('propagates a real Next startup failure and leaves no listener', async () => {
    const context = await spawnNext({ nextArguments: ['--port', 'invalid'] });
    const result = await waitForExit(context);
    expect(result.code).toBe(1);
    expect(context.output()).toMatch(/invalid|port/i);
  });
});
