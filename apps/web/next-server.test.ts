import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { rm, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import {
  resolveWebTestDistDir,
  webTestContextMarker,
} from './next-test-output';
import { createHarnessTestOutputOwnership } from './test/next-test-output-ownership';

const webRoot = fileURLToPath(new URL('.', import.meta.url));
const launcher = fileURLToPath(
  new URL('./scripts/dashboard-next.mjs', import.meta.url),
);
const nextBin = fileURLToPath(
  new URL('./node_modules/next/dist/bin/next', import.meta.url),
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
const testDistDirPath = fileURLToPath(
  new URL(`./${ownedTestDistDirNames[0]}`, import.meta.url),
);
const productionProbeDistDirPath = fileURLToPath(
  new URL(`./${ownedTestDistDirNames[1]}`, import.meta.url),
);
const accessToken = 'actual-next-dashboard-secret';
const proxyToken = Buffer.alloc(32, 6).toString('base64url');
const accessDigest = createHash('sha256').update(accessToken).digest('hex');
const proxyDigest = createHash('sha256').update(proxyToken).digest('hex');
const cursorKey = Buffer.alloc(32, 7).toString('base64url');
const children = new Set<ChildProcess>();
const endpoints = new Map<ChildProcess, { host: string; port: number }>();
const generatedAgentFiles = ['AGENTS.md', 'CLAUDE.md']
  .map((name) => fileURLToPath(new URL(name, import.meta.url)))
  .filter((path) => !existsSync(path));
const nextEnvironmentPath = fileURLToPath(
  new URL('./next-env.d.ts', import.meta.url),
);
const nextEnvironmentSource = readFileSync(nextEnvironmentPath);

interface LaunchContext {
  baseUrl: string;
  child: ChildProcess;
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

function spawnNextCommand(
  command: 'build',
  values: Record<string, string | undefined>,
): LaunchContext {
  const child = spawn(process.execPath, [nextBin, command], {
    cwd: webRoot,
    env: environment(values),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  let capturedOutput = '';
  const capture = (chunk: unknown) => {
    capturedOutput = `${capturedOutput}${String(chunk)}`.slice(-12_000);
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  return {
    baseUrl: '',
    child,
    output: () => capturedOutput,
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
  const child = spawn(
    process.execPath,
    [
      launcher,
      options.mode ?? 'dev',
      '--port',
      String(port),
      ...(options.nextArguments ?? []),
    ],
    {
      cwd: webRoot,
      env: environment({
        DASHBOARD_SERVER_BIND_HOST: host,
        ...options.values,
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  children.add(child);
  endpoints.set(child, { host, port });
  let capturedOutput = '';
  const capture = (chunk: unknown) => {
    capturedOutput = `${capturedOutput}${String(chunk)}`.slice(-12_000);
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  return {
    baseUrl: `http://${urlHost(host)}:${port}`,
    child,
    output: () => capturedOutput,
  };
}

async function startNext(
  options: Parameters<typeof spawnNext>[0] = {},
): Promise<LaunchContext> {
  const context = await spawnNext(options);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (context.child.exitCode !== null)
      throw new Error(
        `Next server exited before readiness.\n${context.output()}`,
      );
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
  if (context.child.exitCode !== null || context.child.signalCode !== null)
    return {
      code: context.child.exitCode,
      signal: context.child.signalCode,
    };
  return Promise.race([
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) =>
        context.child.once('exit', (code, signal) => resolve({ code, signal })),
    ),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Launcher did not exit.')), timeoutMs),
    ),
  ]);
}

async function stopNext(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    try {
      await waitForExit(
        {
          baseUrl: '',
          child,
          output: () => '',
        },
        5_000,
      );
    } catch (error) {
      child.kill('SIGKILL');
      throw error;
    }
  }
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

function authorization(): string {
  return `Basic ${Buffer.from(`blackbox:${accessToken}`).toString('base64')}`;
}

afterEach(async () => {
  const observedEndpoints = [...endpoints.values()];
  await Promise.all([...children].map(stopNext));
  children.clear();
  endpoints.clear();
  for (const endpoint of observedEndpoints)
    expect(await listenerIsAbsent(endpoint.host, endpoint.port)).toBe(true);
});

afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 250));
  await Promise.all([
    writeFile(nextEnvironmentPath, nextEnvironmentSource),
    ...[testDistDirPath, productionProbeDistDirPath].map((path) =>
      rm(path, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 100,
      }),
    ),
    ...generatedAgentFiles.map((path) => unlink(path).catch(() => undefined)),
  ]);
  expect(children.size).toBe(0);
  expect(readFileSync(nextEnvironmentPath)).toEqual(nextEnvironmentSource);
  expect(existsSync(testDistDirPath)).toBe(false);
  expect(existsSync(productionProbeDistDirPath)).toBe(false);
  for (const path of generatedAgentFiles) expect(existsSync(path)).toBe(false);
});

describe('actual Next dashboard transport boundary', () => {
  it('routes both supported package scripts through the enforcing launcher', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
    ) as { scripts: Record<string, string> };
    expect(packageJson.scripts.dev).toBe(
      'node ./scripts/dashboard-next.mjs dev',
    );
    expect(packageJson.scripts.start).toBe(
      'node ./scripts/dashboard-next.mjs start',
    );
  });

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
          ? spawnNextCommand(command, values)
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
