import { EventEmitter, once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { lstat, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

type ExpectedContext = {
  authority: string;
  nodeOptions: string;
  token: string;
};
type GuardedRegistry = {
  activeCount: () => number;
  kill: (processId: number, signal?: NodeJS.Signals | number) => boolean;
  track: (child: FakeChild) => { generation: number };
};

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kill = vi.fn(() => true);

  constructor(public pid: number) {
    super();
  }

  override prependOnceListener(
    eventName: string | symbol,
    listener: (...arguments_: unknown[]) => void,
  ): this {
    return super.prependOnceListener(eventName, listener);
  }
}

const require = createRequire(import.meta.url);
const guard = require('./e2e-playwright-spawn-guard.cjs') as {
  MARKER_NAME: string;
  MARKER_VALUE: string;
  MAX_LINUX_PID: number;
  PRELOAD_PATH: string;
  assertCanonicalLaunch: (
    nodeOptions: string | undefined,
    execArguments?: string[],
  ) => boolean;
  assertInheritedContext: (
    environment: NodeJS.ProcessEnv,
    expected: ExpectedContext,
  ) => void;
  canonicalNodeOptions: () => string;
  createGuardedChildRegistry: (options?: {
    readProcessIdentity?: (processId: number) => {
      processGroupId: number;
      sessionId: number;
      startTime: string;
    };
  }) => GuardedRegistry;
  createGuardedKill: (
    registry: GuardedRegistry,
    originalKill: (
      processId: number,
      signal?: NodeJS.Signals | number,
    ) => boolean,
  ) => (processId: number, signal?: NodeJS.Signals | number) => boolean;
  guardedSpawnArguments: (
    value: unknown[],
    expected: ExpectedContext,
  ) => unknown[];
  validateOwnershipContext: (
    environment: NodeJS.ProcessEnv,
    identityText: string,
    execArguments: string[],
  ) => ExpectedContext;
};

function createRegistry(
  readProcessIdentity = (processId: number) => ({
    processGroupId: 91,
    sessionId: 91,
    startTime: String(processId),
  }),
) {
  return guard.createGuardedChildRegistry({ readProcessIdentity });
}

function spawnedChild(registry: GuardedRegistry, pid: number) {
  const child = new FakeChild(pid);
  const tracking = registry.track(child);
  child.emit('spawn');
  return { child, tracking };
}

type PreloadProbeResult = {
  errorCode: string | null;
  signal: NodeJS.Signals | null;
  status: number | null;
  stderrLength: number;
  stdout: string;
  sentinelCreated: boolean;
  sentinelMarkerValid: boolean;
};

type TamperOracle = {
  type: 'bbx-e2e-tamper-oracle';
  version: 1;
  mode: string;
  outcome: 'blocked' | 'tamper-succeeded' | 'fixture-failed';
  code: string;
};

type LaunchOracle = {
  type: 'bbx-e2e-launch-oracle';
  version: 1;
  mode: string;
  outcome: 'blocked' | 'tamper-succeeded' | 'fixture-failed';
  code: string;
};

const SENTINEL_MARKER = 'bbx-e2e-hostile-executed-v1';

function parseTamperOracle(value: string): TamperOracle {
  const parsed = JSON.parse(value) as Record<string, unknown>;
  expect(Object.keys(parsed).sort()).toEqual(
    ['code', 'mode', 'outcome', 'type', 'version'].sort(),
  );
  expect(parsed.type).toBe('bbx-e2e-tamper-oracle');
  expect(parsed.version).toBe(1);
  expect(typeof parsed.mode).toBe('string');
  expect(['blocked', 'tamper-succeeded', 'fixture-failed']).toContain(
    parsed.outcome,
  );
  expect(typeof parsed.code).toBe('string');
  return parsed as TamperOracle;
}

function parseLaunchOracle(value: string): LaunchOracle {
  const parsed = JSON.parse(value) as Record<string, unknown>;
  expect(Object.keys(parsed).sort()).toEqual(
    ['code', 'mode', 'outcome', 'type', 'version'].sort(),
  );
  expect(parsed.type).toBe('bbx-e2e-launch-oracle');
  expect(parsed.version).toBe(1);
  expect(typeof parsed.mode).toBe('string');
  expect(['blocked', 'tamper-succeeded', 'fixture-failed']).toContain(
    parsed.outcome,
  );
  expect(typeof parsed.code).toBe('string');
  return parsed as LaunchOracle;
}

async function sentinelContents(sentinelPath: string) {
  try {
    return await readFile(sentinelPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function withExactSentinel<T>(run: (sentinelPath: string) => Promise<T>) {
  const temporaryRoot = await realpath(tmpdir());
  const ownedDirectory = await mkdtemp(
    join(temporaryRoot, 'bbx-e2e-tamper-oracle-'),
  );
  const ownedRealPath = await realpath(ownedDirectory);
  try {
    expect(dirname(ownedRealPath).toLowerCase()).toBe(
      temporaryRoot.toLowerCase(),
    );
    expect(basename(ownedRealPath)).toMatch(
      /^bbx-e2e-tamper-oracle-[a-zA-Z0-9_-]{6}$/,
    );
    return await run(join(ownedRealPath, 'execution.marker'));
  } finally {
    await rm(ownedRealPath, { force: true, recursive: true });
    await expect(lstat(ownedRealPath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  }
}

async function runPreloadProbe(mode: string, sentinelPath?: string) {
  const launcher = fileURLToPath(
    new URL('./e2e-playwright-preload-launcher.cjs', import.meta.url),
  );
  const child = spawn(process.execPath, [launcher, mode], {
    detached: true,
    env: {
      ...process.env,
      ...(sentinelPath === undefined
        ? {}
        : { BBX_E2E_TAMPER_SENTINEL: sentinelPath }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (data) => (stdout += data));
  child.stderr.on('data', (data) => (stderr += data));
  const result = await new Promise<{
    status: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Preload probe exceeded its deadline.'));
    }, 40_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal });
    });
  });
  expect(result.status, `launcher emitted ${stderr.length} stderr bytes`).toBe(
    0,
  );
  expect(result.signal).toBeNull();
  const parsed = JSON.parse(stdout) as PreloadProbeResult;
  expect(Object.keys(parsed).sort()).toEqual(
    [
      'errorCode',
      'signal',
      'status',
      'stderrLength',
      'stdout',
      'sentinelCreated',
      'sentinelMarkerValid',
    ].sort(),
  );
  expect(
    parsed.errorCode === null || typeof parsed.errorCode === 'string',
  ).toBe(true);
  expect(parsed.signal === null || typeof parsed.signal === 'string').toBe(
    true,
  );
  expect(parsed.status === null || Number.isInteger(parsed.status)).toBe(true);
  expect(typeof parsed.stderrLength).toBe('number');
  expect(typeof parsed.stdout).toBe('string');
  expect(typeof parsed.sentinelCreated).toBe('boolean');
  expect(typeof parsed.sentinelMarkerValid).toBe('boolean');
  return parsed;
}

describe('guarded Playwright child-process launch boundary', () => {
  const expected = {
    authority: '{"version":1}',
    nodeOptions: guard.canonicalNodeOptions(),
    token: 'a'.repeat(43),
  };
  const environment = {
    ...process.env,
    [guard.MARKER_NAME]: guard.MARKER_VALUE,
    BBX_E2E_LINUX_GROUP_AUTHORITY: expected.authority,
    BBX_E2E_OWNERSHIP_TOKEN: expected.token,
    NODE_OPTIONS: expected.nodeOptions,
  };

  it('clones options and changes only a detached request', () => {
    const arguments_ = ['--version'];
    const options = {
      cwd: '/tmp',
      detached: true,
      env: environment,
      shell: true,
      stdio: 'pipe',
      windowsHide: true,
    };
    const rewritten = guard.guardedSpawnArguments(
      ['node', arguments_, options],
      expected,
    ) as [string, string[], typeof options];
    expect(rewritten[0]).toBe('node');
    expect(rewritten[1]).toBe(arguments_);
    expect(rewritten[2]).toEqual({ ...options, detached: false });
    expect(rewritten[2]).not.toBe(options);
    expect(options.detached).toBe(true);
  });

  it('rejects removed, replaced, or conflicting inherited authority', () => {
    for (const changed of [
      { ...environment, BBX_E2E_OWNERSHIP_TOKEN: undefined },
      { ...environment, BBX_E2E_LINUX_GROUP_AUTHORITY: '{}' },
      { ...environment, NODE_OPTIONS: '--trace-warnings' },
      { ...environment, [guard.MARKER_NAME]: 'other' },
    ])
      expect(() => guard.assertInheritedContext(changed, expected)).toThrow(
        'contradicted ownership',
      );
  });

  it('targets a valid tracked negative PID through only its exact child', () => {
    const registry = createRegistry();
    const originalKill = vi.fn(() => true);
    const guardedKill = guard.createGuardedKill(registry, originalKill);
    const { child } = spawnedChild(registry, 1234);

    expect(guardedKill(-1234, 'SIGKILL')).toBe(true);
    expect(child.kill).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(originalKill).not.toHaveBeenCalled();
  });

  it('rejects every untracked, malformed, zero, special, or out-of-range non-positive PID without touching the OS', () => {
    const registry = createRegistry();
    const originalKill = vi.fn(() => true);
    const guardedKill = guard.createGuardedKill(registry, originalKill);

    for (const processId of [
      -5678,
      -1,
      0,
      -0,
      -1.5,
      Number.NaN,
      Number.NEGATIVE_INFINITY,
      -(guard.MAX_LINUX_PID + 1),
    ])
      expect(() => guardedKill(processId, 'SIGTERM')).toThrow(
        expect.objectContaining({ code: 'ESRCH' }),
      );
    expect(originalKill).not.toHaveBeenCalled();
  });

  it('invalidates authority at exit even when close is delayed', () => {
    const registry = createRegistry();
    const { child } = spawnedChild(registry, 2234);
    expect(registry.activeCount()).toBe(1);
    let externalListenerObservedRevocation = false;
    child.once('exit', () => {
      externalListenerObservedRevocation = registry.activeCount() === 0;
    });

    child.exitCode = 0;
    child.emit('exit', 0, null);
    expect(registry.activeCount()).toBe(0);
    expect(externalListenerObservedRevocation).toBe(true);
    expect(() => registry.kill(-2234, 'SIGTERM')).toThrow(
      expect.objectContaining({ code: 'ESRCH' }),
    );

    child.emit('close', 0, null);
    expect(registry.activeCount()).toBe(0);
  });

  it('does not authorize a later child that reuses a retired PID generation', () => {
    const registry = createRegistry();
    const first = spawnedChild(registry, 3234);
    first.child.exitCode = 0;
    first.child.emit('exit', 0, null);

    const second = spawnedChild(registry, 3234);
    expect(second.tracking.generation).not.toBe(first.tracking.generation);
    expect(registry.activeCount()).toBe(0);
    expect(() => registry.kill(-3234, 'SIGKILL')).toThrow(
      expect.objectContaining({ code: 'ESRCH' }),
    );
    expect(first.child.kill).not.toHaveBeenCalled();
    expect(second.child.kill).not.toHaveBeenCalled();
  });

  it('rejects a reused live PID when its Linux start-time identity changes', () => {
    let startTime = '100';
    const registry = createRegistry(() => ({
      processGroupId: 91,
      sessionId: 91,
      startTime,
    }));
    const { child } = spawnedChild(registry, 3734);
    startTime = '101';

    expect(() => registry.kill(-3734, 'SIGKILL')).toThrow(
      expect.objectContaining({ code: 'ESRCH' }),
    );
    expect(child.kill).not.toHaveBeenCalled();
    expect(registry.activeCount()).toBe(0);
  });

  it('leaves an unrelated process group alive after rejecting its negative PID', async () => {
    const registry = createRegistry();
    const originalKill = vi.fn(() => true);
    const guardedKill = guard.createGuardedKill(registry, originalKill);
    const unrelated = spawn(
      process.execPath,
      ['-e', 'setInterval(() => undefined, 1000)'],
      { detached: true, env: process.env, stdio: 'ignore' },
    );
    try {
      await once(unrelated, 'spawn');
      expect(() => guardedKill(-unrelated.pid!, 'SIGKILL')).toThrow(
        expect.objectContaining({ code: 'ESRCH' }),
      );
      expect(originalKill).not.toHaveBeenCalled();
      expect(() => process.kill(unrelated.pid!, 0)).not.toThrow();
    } finally {
      unrelated.kill('SIGTERM');
      if (unrelated.exitCode === null && unrelated.signalCode === null)
        await once(unrelated, 'exit');
    }
  });

  it('preserves positive PID behavior outside the guard authority', () => {
    const registry = createRegistry();
    const originalKill = vi.fn(() => true);
    const guardedKill = guard.createGuardedKill(registry, originalKill);

    expect(guardedKill(5234, 'SIGINT')).toBe(true);
    expect(originalKill).toHaveBeenCalledWith(5234, 'SIGINT');
  });

  it('requires the one exact canonical preload representation', () => {
    const canonical = guard.canonicalNodeOptions();
    expect(canonical).toBe(`--require=${JSON.stringify(guard.PRELOAD_PATH)}`);
    expect(guard.assertCanonicalLaunch(canonical, [])).toBe(true);
    for (const value of [
      undefined,
      '',
      '--trace-warnings',
      `${canonical} ${canonical}`,
      `${canonical} --import=other.mjs`,
      `--import=other.mjs ${canonical}`,
      `${canonical} --loader=other.mjs`,
      `${canonical} --experimental-loader=other.mjs`,
      '--require=other.cjs',
      `-r ${guard.PRELOAD_PATH}`,
      `--require=${guard.PRELOAD_PATH}`,
      '--require=./e2e-playwright-spawn-guard.cjs',
      `--require="$PRELOAD"`,
      `${canonical} `,
      ` ${canonical}`,
      `${canonical}\n`,
    ])
      expect(() => guard.assertCanonicalLaunch(value, [])).toThrow(
        'not canonical',
      );
    for (const execArguments of [
      ['--require', guard.PRELOAD_PATH],
      ['--import=other.mjs'],
      ['--loader=other.mjs'],
      ['--experimental-loader=other.mjs'],
      ['-e', 'void 0'],
    ])
      expect(() =>
        guard.assertCanonicalLaunch(canonical, execArguments),
      ).toThrow('arguments are not canonical');
  });

  it('validates the argument-free child launch independently of owner exec arguments', () => {
    const token = 'b'.repeat(43);
    const authority = JSON.stringify({
      version: 1,
      platform: 'linux',
      role: 'playwright',
      ownershipIdentity: {
        processGroupId: 91,
        sessionId: 91,
        ownershipToken: token,
      },
    });
    const childEnvironment = {
      ...environment,
      BBX_E2E_LINUX_GROUP_AUTHORITY: authority,
      BBX_E2E_OWNERSHIP_TOKEN: token,
    };

    expect(
      guard.validateOwnershipContext(
        childEnvironment,
        '123 (node) S 1 91 91',
        [],
      ).authority,
    ).toBe(authority);
    expect(() =>
      guard.validateOwnershipContext(childEnvironment, '123 (node) S 1 91 91', [
        '--import=other.mjs',
      ]),
    ).toThrow('arguments are not canonical');
  });

  it('leaves an ordinary unguarded Node subprocess unchanged', () => {
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        "const cp=require('node:child_process'); const d=Object.getOwnPropertyDescriptor(cp,'spawn'); if (!d.writable || !d.configurable) process.exit(1)",
      ],
      { encoding: 'utf8', env: process.env },
    );
    expect(result.status, result.stderr).toBe(0);
  });

  it('rejects malformed, incomplete, or unknown tamper-oracle results', () => {
    for (const value of [
      '',
      '{}',
      '{"type":"bbx-e2e-tamper-oracle"}',
      JSON.stringify({
        type: 'bbx-e2e-tamper-oracle',
        version: 1,
        mode: 'tamper-commonjs-spawn',
        outcome: 'unknown',
        code: 'unexpected',
      }),
      JSON.stringify({
        type: 'bbx-e2e-tamper-oracle',
        version: 1,
        mode: 'tamper-commonjs-spawn',
        outcome: 'blocked',
        code: 'immutable-guard-preserved',
        extra: true,
      }),
    ])
      expect(() => parseTamperOracle(value)).toThrow();
  });

  it.each([
    ['vulnerable-tamper-commonjs-spawn', 'tamper-commonjs-spawn'],
    ['vulnerable-tamper-esm-spawn', 'tamper-esm-spawn'],
    ['vulnerable-tamper-process-kill', 'tamper-process-kill'],
  ])(
    'proves the %s negative control really replaces the unguarded boundary',
    async (mode, targetMode) => {
      await withExactSentinel(async (sentinelPath) => {
        const result = await runPreloadProbe(mode, sentinelPath);
        expect(result).toMatchObject({
          errorCode: null,
          signal: null,
          status: 3,
          stderrLength: 0,
          sentinelCreated: false,
          sentinelMarkerValid: false,
        });
        expect(parseTamperOracle(result.stdout)).toEqual({
          type: 'bbx-e2e-tamper-oracle',
          version: 1,
          mode: targetMode,
          outcome: 'tamper-succeeded',
          code: 'mutable-boundary-replaced',
        });
        expect(await sentinelContents(sentinelPath)).toBeNull();
      });
    },
  );

  it.each(['vulnerable-loader', 'vulnerable-preload'])(
    'proves the %s negative control executes the hostile fixture',
    async (mode) => {
      await withExactSentinel(async (sentinelPath) => {
        const result = await runPreloadProbe(mode, sentinelPath);
        expect(result).toMatchObject({
          errorCode: null,
          signal: null,
          status: 0,
          stdout: 'vulnerable-child-complete',
          stderrLength: 0,
          sentinelCreated: true,
          sentinelMarkerValid: true,
        });
        expect(await sentinelContents(sentinelPath)).toBe(SENTINEL_MARKER);
      });
    },
  );

  describe.skipIf(process.platform !== 'linux')(
    'fresh canonical preload subprocesses',
    () => {
      it.each([
        ['canonical', 'attested'],
        ['wrapper', 'Version 1.51.1'],
        ['worker', 'worker-propagated'],
        ['pinned-launcher', 'pinned-launcher-guarded'],
      ])('accepts %s and observes %s', async (mode, expectedOutput) => {
        const result = await runPreloadProbe(mode);
        expect(result.errorCode).toBeNull();
        expect(result.status).toBe(0);
        expect(result.signal).toBeNull();
        expect(result.stderrLength).toBe(0);
        expect(result.stdout).toBe(expectedOutput);
        expect(result.sentinelCreated).toBe(false);
        expect(result.sentinelMarkerValid).toBe(false);
      });

      it.each([
        'missing',
        'marker-only',
        'duplicate',
        'relative',
        'marker-forgery',
      ])('fails closed for %s', async (mode) => {
        const result = await runPreloadProbe(mode);
        expect(result.errorCode).toBeNull();
        expect(result.status).not.toBe(0);
        expect(result.signal).toBeNull();
        expect(result.stdout).not.toContain('Version 1.51.1');
        expect(result.sentinelCreated).toBe(false);
        expect(result.sentinelMarkerValid).toBe(false);
      });

      it.each([
        'alternate-require',
        'alternate-before',
        'alternate-after',
        'import-before',
        'import-after',
        'loader',
        'experimental-loader',
      ])('rejects %s before hostile fixture execution', async (mode) => {
        await withExactSentinel(async (sentinelPath) => {
          const result = await runPreloadProbe(mode, sentinelPath);
          expect(result.errorCode).toBeNull();
          expect(result.status).toBe(0);
          expect(result.signal).toBeNull();
          expect(result.stderrLength).toBe(0);
          expect(result.stdout).not.toContain('Version 1.51.1');
          expect(parseLaunchOracle(result.stdout)).toEqual({
            type: 'bbx-e2e-launch-oracle',
            version: 1,
            mode,
            outcome: 'blocked',
            code: 'guarded-spawn-rejected',
          });
          expect(result.sentinelCreated).toBe(false);
          expect(result.sentinelMarkerValid).toBe(false);
          expect(await sentinelContents(sentinelPath)).toBeNull();
        });
      });

      it.each([
        'tamper-commonjs-spawn',
        'tamper-esm-spawn',
        'tamper-process-kill',
      ])('proves the canonical guard blocks %s', async (mode) => {
        await withExactSentinel(async (sentinelPath) => {
          const result = await runPreloadProbe(mode, sentinelPath);
          expect(result).toMatchObject({
            errorCode: null,
            signal: null,
            status: 0,
            stderrLength: 0,
            sentinelCreated: false,
            sentinelMarkerValid: false,
          });
          expect(parseTamperOracle(result.stdout)).toEqual({
            type: 'bbx-e2e-tamper-oracle',
            version: 1,
            mode,
            outcome: 'blocked',
            code: 'immutable-guard-preserved',
          });
          expect(await sentinelContents(sentinelPath)).toBeNull();
        });
      });
    },
  );

  it.skipIf(process.platform !== 'linux')(
    'keeps real CommonJS and ESM detached requests in the authorized group',
    () => {
      const probe = fileURLToPath(
        new URL('./e2e-playwright-spawn-probe.cjs', import.meta.url),
      );
      const result = spawnSync(process.execPath, [probe], {
        encoding: 'utf8',
        env: process.env,
      });
      expect(result.status, result.stderr).toBe(0);
      const parsed = JSON.parse(result.stdout) as {
        commonJsChild: { processGroupId: number; sessionId: number };
        esmChild: { processGroupId: number; sessionId: number };
        parent: { processGroupId: number; sessionId: number };
      };
      expect(parsed.commonJsChild).toEqual(parsed.parent);
      expect(parsed.esmChild).toEqual(parsed.parent);
    },
  );
});
