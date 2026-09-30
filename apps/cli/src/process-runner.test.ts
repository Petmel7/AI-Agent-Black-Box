import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { composeCollectorFromEnvironment } from './collector/environment.js';
import { LocalSpool } from './collector/spool.js';
import { CollectorWorkSpool } from './collector/delivery.js';
import {
  buildChildEnvironment,
  runWrappedProcess,
  type ProcessRunnerDependencies,
  type SupportedProcessSignal,
} from './process-runner.js';

const roots: string[] = [];
const originalWorkingDirectory = process.cwd();
const wrappedRepository = mkdtempSync(join(tmpdir(), 'bbx-process-repo-'));

beforeAll(() => {
  execFileSync('git', ['init', '--quiet'], {
    cwd: wrappedRepository,
    stdio: 'ignore',
  });
  process.chdir(wrappedRepository);
});

afterAll(() => {
  process.chdir(originalWorkingDirectory);
  rmSync(wrappedRepository, { force: true, recursive: true });
});

function temporaryRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), 'bbx-process-'));
  roots.push(directory);
  return directory;
}

afterEach(() => {
  for (const path of roots.splice(0))
    rmSync(path, { force: true, recursive: true });
});

function environment(spoolRoot: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    BLACKBOX_SPOOL_DIR: spoolRoot,
  };
}

function configuredDelivery() {
  return {
    state: 'configured' as const,
    config: {
      apiBaseUrl: 'http://127.0.0.1:1',
      apiToken: 'token',
      connectTimeoutMs: 1,
      drainMaxAttempts: 1,
      drainMaxElapsedMs: 1,
      drainMaxItems: 1,
      overallTimeoutMs: 1,
      repositoryId: randomUUID(),
      requestTimeoutMs: 1,
      retryBaseMs: 1,
      retryMaxMs: 1,
    },
  };
}

async function runNode(
  spoolRoot: string,
  script: string,
  childArgs: readonly string[] = [],
  extraEnvironment: NodeJS.ProcessEnv = {},
  dependencies: ProcessRunnerDependencies = {},
) {
  const env = { ...environment(spoolRoot), ...extraEnvironment };
  const warnings: string[] = [];
  const result = await runWrappedProcess(
    process.execPath,
    ['-e', script, ...(childArgs.length > 0 ? ['--', ...childArgs] : [])],
    env,
    composeCollectorFromEnvironment(env),
    { state: 'offline' },
    { warning: (message) => warnings.push(message) },
    dependencies,
  );
  return { result, warnings };
}

function canonicalEvents(spoolRoot: string): Array<Record<string, unknown>> {
  using database = new DatabaseSync(join(spoolRoot, 'spool.sqlite3'), {
    readOnly: true,
  });
  return (
    database
      .prepare('SELECT canonical_json FROM events ORDER BY sequence')
      .all() as unknown as { canonical_json: string }[]
  ).map((row) => JSON.parse(row.canonical_json) as Record<string, unknown>);
}

class FakeChild extends EventEmitter {
  readonly kills: NodeJS.Signals[] = [];

  kill(signal?: NodeJS.Signals | number): boolean {
    if (typeof signal === 'string') this.kills.push(signal);
    return true;
  }
}

function fakeSession(
  overrides: Partial<{
    capture(phase: 'after' | 'before' | 'checkpoint'): void;
    close(): void;
    compare(): void;
    dispose(): void;
    finish(): void;
    renew(): void;
    start(): void;
  }> = {},
) {
  return {
    runId: randomUUID(),
    captureGitSnapshot: overrides.capture ?? (() => undefined),
    close: overrides.close ?? (() => undefined),
    compareGitSnapshots: overrides.compare ?? (() => undefined),
    observeRunFinished: overrides.finish ?? (() => undefined),
    observeRunStarted: overrides.start ?? (() => undefined),
    renewLease: overrides.renew ?? (() => undefined),
    [Symbol.dispose]: overrides.dispose ?? (() => undefined),
  };
}

describe('wrapped process boundary', () => {
  it('prevents launch on before-capture failure and closes with failed terminal evidence', async () => {
    const actions: string[] = [];
    let spawned = false;
    const result = await runWrappedProcess(
      'fixture',
      [],
      {},
      composeCollectorFromEnvironment({
        BLACKBOX_SPOOL_DIR: join(temporaryRoot(), 'spool'),
      }),
      { state: 'offline' },
      { warning: () => undefined },
      {
        openSession: () =>
          fakeSession({
            capture: (phase) => {
              actions.push(phase);
              throw new Error('safe failure');
            },
            close: () => actions.push('close'),
            finish: () => actions.push('finish'),
            start: () => actions.push('start'),
          }),
        spawn: () => {
          spawned = true;
          return new FakeChild() as unknown as ChildProcess;
        },
      },
    );
    expect(result).toEqual({ code: 1, kind: 'exit' });
    expect(spawned).toBe(false);
    expect(actions).toEqual(['start', 'before', 'finish', 'close']);
  });

  it('keeps final Git degradation secondary and preserves finalization order', async () => {
    const child = new FakeChild();
    const actions: string[] = [];
    const warnings: string[] = [];
    const resultPromise = runWrappedProcess(
      'fixture',
      [],
      {},
      composeCollectorFromEnvironment({
        BLACKBOX_SPOOL_DIR: join(temporaryRoot(), 'spool'),
      }),
      { state: 'offline' },
      { warning: (message) => warnings.push(message) },
      {
        openSession: () =>
          fakeSession({
            capture: (phase) => {
              actions.push(phase);
              if (phase === 'after') throw new Error('safe failure');
            },
            close: () => actions.push('close'),
            compare: () => actions.push('compare'),
            finish: () => actions.push('finish'),
            start: () => actions.push('start'),
          }),
        spawn: () => child as unknown as ChildProcess,
      },
    );
    child.emit('spawn');
    child.emit('close', 37, null);
    expect(await resultPromise).toEqual({ code: 37, kind: 'exit' });
    expect(actions).toEqual(['start', 'before', 'after', 'finish', 'close']);
    expect(warnings).toEqual(['Collector degraded: collection-failed']);
  });

  it('filters collector variables case-insensitively and rejects ambiguous keys', () => {
    const runId = randomUUID();
    expect(
      buildChildEnvironment(
        {
          PATH: 'preserved',
          BLACKBOX_API_TOKEN: 'secret',
          blackbox_spool_dir: 'private',
        },
        runId,
      ),
    ).toEqual({ PATH: 'preserved', BLACKBOX_RUN_ID: runId });
    expect(() =>
      buildChildEnvironment({ Path: 'one', PATH: 'two' }, runId),
    ).toThrow(/ambiguous/u);
  });

  it.each(['open', 'run-start'] as const)(
    'does not spawn when %s initialization fails',
    async (failure) => {
      const directory = temporaryRoot();
      let spawned = false;
      const composition = composeCollectorFromEnvironment({
        BLACKBOX_SPOOL_DIR: join(directory, 'spool'),
      });
      await expect(
        runWrappedProcess(
          'fixture',
          [],
          {},
          composition,
          { state: 'offline' },
          { warning: () => undefined },
          {
            openSession: () => {
              if (failure === 'open') throw new Error('open failed');
              return fakeSession({
                start: () => {
                  throw new Error('run start failed');
                },
              });
            },
            spawn: () => {
              spawned = true;
              return new FakeChild() as unknown as ChildProcess;
            },
          },
        ),
      ).rejects.toThrow();
      expect(spawned).toBe(false);
    },
  );

  it.each([0, 37])(
    'preserves exit %s, exact arguments, cwd, environment, and durable lifecycle',
    async (exitCode) => {
      const directory = temporaryRoot();
      const spoolRoot = join(directory, 'spool');
      const marker = join(directory, 'marker.json');
      const childArguments = [
        '--help',
        '--version',
        '',
        'space value',
        '"quoted"',
        'Unicode-Привіт',
        '*',
        '|',
        '>',
        '$(not-executed)',
      ];
      const script = `
        const { writeFileSync } = require('node:fs');
        const { DatabaseSync } = require('node:sqlite');
        const database = new DatabaseSync(process.env.SPOOL_DB, { readOnly: true });
        const row = database.prepare("SELECT capture_state FROM runs WHERE run_id=? AND EXISTS (SELECT 1 FROM events WHERE run_id=? AND json_extract(canonical_json,'$.kind')='run.started')").get(process.env.BLACKBOX_RUN_ID, process.env.BLACKBOX_RUN_ID);
        database.close();
        writeFileSync(process.env.MARKER, JSON.stringify({ argv: process.argv.slice(1), cwd: process.cwd(), runId: process.env.BLACKBOX_RUN_ID, started: Boolean(row), safe: process.env.SAFE_VALUE, leaked: Object.keys(process.env).filter((key) => key.toUpperCase().startsWith('BLACKBOX_') && key !== 'BLACKBOX_RUN_ID') }));
        process.exit(Number(process.env.CHILD_EXIT));
      `;
      const execution = await runNode(spoolRoot, script, childArguments, {
        BLACKBOX_API_TOKEN: 'credential-sentinel',
        CHILD_EXIT: String(exitCode),
        MARKER: marker,
        SAFE_VALUE: 'preserved',
        SPOOL_DB: join(spoolRoot, 'spool.sqlite3'),
      });
      expect(execution.result).toEqual({ code: exitCode, kind: 'exit' });
      expect(execution.warnings).toEqual([]);
      const observed = JSON.parse(readFileSync(marker, 'utf8')) as {
        argv: string[];
        cwd: string;
        leaked: string[];
        runId: string;
        safe: string;
        started: boolean;
      };
      expect(observed).toMatchObject({
        argv: childArguments,
        cwd: process.cwd(),
        leaked: [],
        safe: 'preserved',
        started: true,
      });
      const events = canonicalEvents(spoolRoot);
      expect(events.map((event) => event.kind)).toEqual([
        'run.started',
        'git.snapshot.captured',
        'git.snapshot.captured',
        'git.diff.captured',
        'run.finished',
      ]);
      expect(events[0]?.runId).toBe(observed.runId);
      expect(events[4]?.payload).toMatchObject({
        outcome: exitCode === 0 ? 'succeeded' : 'failed',
      });
      expect(
        (events[4]?.payload as { durationMs: number }).durationMs,
      ).toBeGreaterThanOrEqual(0);
    },
    15_000,
  );

  it('renews ownership for a child that outlives the initial lease', async () => {
    const directory = temporaryRoot();
    const spoolRoot = join(directory, 'spool');
    const execution = await runNode(
      spoolRoot,
      'setTimeout(() => process.exit(0), 3300)',
      [],
      {},
      { heartbeatIntervalMs: 100, runLeaseMs: 3_200 },
    );
    expect(execution).toMatchObject({
      result: { code: 0, kind: 'exit' },
      warnings: [],
    });
    using spool = new LocalSpool(
      composeCollectorFromEnvironment(environment(spoolRoot)).config,
    ).open();
    expect(spool.status().runs).toMatchObject({ closed: 1, interrupted: 0 });
  }, 10_000);

  it('preserves the child result and emits one safe warning after renewal failure', async () => {
    const directory = temporaryRoot();
    let renewals = 0;
    const execution = await runNode(
      join(directory, 'spool'),
      'setTimeout(() => process.exit(23), 250)',
      [],
      {},
      {
        heartbeatIntervalMs: 100,
        openSession: () =>
          fakeSession({
            renew: () => {
              renewals += 1;
              if (renewals > 1) throw new Error('raw renewal secret');
            },
          }),
        runLeaseMs: 4_000,
      },
    );
    expect(execution.result).toEqual({ code: 23, kind: 'exit' });
    expect(execution.warnings).toEqual([
      'Collector degraded: collection-failed',
    ]);
    expect(renewals).toBe(2);
  });

  it('waits for close after repeated post-spawn errors and finalizes normal-exit work once', async () => {
    const child = new FakeChild();
    const outcomes: Array<{ durationMs?: number; outcome: string }> = [];
    const installed = new Map<SupportedProcessSignal, () => void>();
    const removed: SupportedProcessSignal[] = [];
    const warnings: string[] = [];
    let closes = 0;
    let disposals = 0;
    let heartbeatClears = 0;
    let deliveryDisposals = 0;
    let drains = 0;
    const heartbeat = { unref: () => undefined } as unknown as NodeJS.Timeout;
    const resultPromise = runWrappedProcess(
      'fixture',
      [],
      {},
      {
        config: composeCollectorFromEnvironment({
          BLACKBOX_SPOOL_DIR: join(temporaryRoot(), 'spool'),
        }).config,
        redactorOptions: { environment: {} },
      },
      configuredDelivery(),
      { warning: (message) => warnings.push(message) },
      {
        clearInterval: () => {
          heartbeatClears += 1;
        },
        createCoordinator: () => ({
          drain: async () => {
            drains += 1;
            return {
              remaining: { blocked: 0, readyOrDelayed: 0 },
            } as never;
          },
        }),
        monotonicNow: () => 100,
        openDeliverySpool: () =>
          ({
            [Symbol.dispose]: () => {
              deliveryDisposals += 1;
            },
          }) as never,
        openSession: () => ({
          runId: randomUUID(),
          captureGitSnapshot: () => undefined,
          close: () => {
            closes += 1;
          },
          compareGitSnapshots: () => undefined,
          observeRunFinished: (input) => outcomes.push(input),
          observeRunStarted: () => undefined,
          renewLease: () => undefined,
          [Symbol.dispose]: () => {
            disposals += 1;
          },
        }),
        setInterval: () => heartbeat,
        signalHost: {
          on: (signal, listener) => installed.set(signal, listener),
          removeListener: (signal) => {
            removed.push(signal);
            installed.delete(signal);
          },
        },
        spawn: () => child as unknown as ChildProcess,
      },
    );
    child.emit('spawn');
    child.emit('error', new Error('post-spawn one'));
    child.emit('error', new Error('post-spawn two'));
    child.emit('close', 37, null);
    child.emit('close', 0, null);

    expect(await resultPromise).toEqual({ code: 37, kind: 'exit' });
    expect(outcomes).toEqual([{ durationMs: 0, outcome: 'failed' }]);
    expect(warnings).toEqual(['Collector degraded: collection-failed']);
    expect(closes).toBe(1);
    expect(disposals).toBe(0);
    expect(heartbeatClears).toBe(1);
    expect(new Set(removed).size).toBe(3);
    expect(drains).toBe(1);
    expect(deliveryDisposals).toBe(1);
  });

  it('keeps waiting after failed signal forwarding and preserves a normal child exit', async () => {
    const child = new FakeChild();
    const installed = new Map<SupportedProcessSignal, () => void>();
    const outcomes: string[] = [];
    const warnings: string[] = [];
    child.kill = () => false;
    const resultPromise = runWrappedProcess(
      'fixture',
      [],
      {},
      {
        config: composeCollectorFromEnvironment({
          BLACKBOX_SPOOL_DIR: join(temporaryRoot(), 'spool'),
        }).config,
        redactorOptions: { environment: {} },
      },
      { state: 'offline' },
      { warning: (message) => warnings.push(message) },
      {
        openSession: () => ({
          runId: randomUUID(),
          captureGitSnapshot: () => undefined,
          close: () => undefined,
          compareGitSnapshots: () => undefined,
          observeRunFinished: (input) => outcomes.push(input.outcome),
          observeRunStarted: () => undefined,
          renewLease: () => undefined,
          [Symbol.dispose]: () => undefined,
        }),
        signalHost: {
          on: (signal, listener) => installed.set(signal, listener),
          removeListener: (signal) => installed.delete(signal),
        },
        spawn: () => child as unknown as ChildProcess,
      },
    );
    child.emit('spawn');
    installed.get('SIGINT')?.();
    child.emit('close', 0, null);

    expect(await resultPromise).toEqual({ code: 0, kind: 'exit' });
    expect(outcomes).toEqual(['succeeded']);
    expect(warnings).toEqual(['Collector degraded: collection-failed']);
  });

  it('preserves supported signal termination after a post-spawn error', async () => {
    const child = new FakeChild();
    const outcomes: string[] = [];
    const warnings: string[] = [];
    const resultPromise = runWrappedProcess(
      'fixture',
      [],
      {},
      {
        config: composeCollectorFromEnvironment({
          BLACKBOX_SPOOL_DIR: join(temporaryRoot(), 'spool'),
        }).config,
        redactorOptions: { environment: {} },
      },
      { state: 'offline' },
      { warning: (message) => warnings.push(message) },
      {
        openSession: () => ({
          runId: randomUUID(),
          captureGitSnapshot: () => undefined,
          close: () => undefined,
          compareGitSnapshots: () => undefined,
          observeRunFinished: (input) => outcomes.push(input.outcome),
          observeRunStarted: () => undefined,
          renewLease: () => undefined,
          [Symbol.dispose]: () => undefined,
        }),
        signalHost: {
          on: () => undefined,
          removeListener: () => undefined,
        },
        spawn: () => child as unknown as ChildProcess,
      },
    );
    child.emit('spawn');
    child.emit('error', new Error('post-spawn'));
    child.emit('close', null, 'SIGTERM');

    expect(await resultPromise).toEqual({
      fallbackCode: 143,
      kind: 'signal',
      signal: 'SIGTERM',
    });
    expect(outcomes).toEqual(['cancelled']);
    expect(warnings).toEqual(['Collector degraded: collection-failed']);
  });

  it('keeps pre-spawn emitted errors as launch failures even when close races', async () => {
    const child = new FakeChild();
    const outcomes: string[] = [];
    const warnings: string[] = [];
    let closes = 0;
    let disposals = 0;
    const resultPromise = runWrappedProcess(
      'fixture',
      [],
      {},
      {
        config: composeCollectorFromEnvironment({
          BLACKBOX_SPOOL_DIR: join(temporaryRoot(), 'spool'),
        }).config,
        redactorOptions: { environment: {} },
      },
      { state: 'offline' },
      { warning: (message) => warnings.push(message) },
      {
        openSession: () => ({
          runId: randomUUID(),
          captureGitSnapshot: () => undefined,
          close: () => {
            closes += 1;
          },
          compareGitSnapshots: () => undefined,
          observeRunFinished: (input) => outcomes.push(input.outcome),
          observeRunStarted: () => undefined,
          renewLease: () => undefined,
          [Symbol.dispose]: () => {
            disposals += 1;
          },
        }),
        spawn: () => child as unknown as ChildProcess,
      },
    );
    child.emit('error', new Error('launch failed'));
    child.emit('close', 37, null);

    expect(await resultPromise).toEqual({ code: 1, kind: 'exit' });
    expect(outcomes).toEqual(['failed']);
    expect(warnings).toEqual([]);
    expect(closes).toBe(1);
    expect(disposals).toBe(0);
  });

  it('serializes heartbeat cleanup, terminal failure, and listener removal', async () => {
    const child = new FakeChild();
    const installed = new Map<SupportedProcessSignal, () => void>();
    const removed: SupportedProcessSignal[] = [];
    const warnings: string[] = [];
    const resultPromise = runWrappedProcess(
      'fixture',
      [],
      {},
      {
        config: composeCollectorFromEnvironment({
          BLACKBOX_SPOOL_DIR: join(temporaryRoot(), 'spool'),
        }).config,
        redactorOptions: { environment: {} },
      },
      { state: 'offline' },
      {
        warning: (message) => {
          warnings.push(message);
          throw new Error('warning sink failed');
        },
      },
      {
        heartbeatIntervalMs: 100,
        openSession: () =>
          fakeSession({
            finish: () => {
              throw new Error('terminal');
            },
          }),
        runLeaseMs: 4_000,
        signalHost: {
          on: (signal, listener) => installed.set(signal, listener),
          removeListener: (signal) => {
            removed.push(signal);
            installed.delete(signal);
          },
        },
        spawn: () => child as unknown as ChildProcess,
      },
    );
    child.emit('spawn');
    installed.get('SIGINT')?.();
    installed.get('SIGINT')?.();
    child.emit('close', 7, null);
    expect(await resultPromise).toEqual({ code: 7, kind: 'exit' });
    expect(child.kills).toEqual(['SIGINT', 'SIGINT']);
    expect(warnings).toEqual(['Collector degraded: collection-failed']);
    expect(installed.size).toBe(0);
    expect(new Set(removed).size).toBe(3);
  });

  it('skips configured delivery after actual signal termination', async () => {
    const child = new FakeChild();
    let coordinators = 0;
    const resultPromise = runWrappedProcess(
      'fixture',
      [],
      {},
      {
        config: composeCollectorFromEnvironment({
          BLACKBOX_SPOOL_DIR: join(temporaryRoot(), 'spool'),
        }).config,
        redactorOptions: { environment: {} },
      },
      {
        state: 'configured',
        config: {
          apiBaseUrl: 'http://127.0.0.1:1',
          apiToken: 'token',
          connectTimeoutMs: 1,
          drainMaxAttempts: 1,
          drainMaxElapsedMs: 1,
          drainMaxItems: 1,
          overallTimeoutMs: 1,
          repositoryId: randomUUID(),
          requestTimeoutMs: 1,
          retryBaseMs: 1,
          retryMaxMs: 1,
        },
      },
      { warning: () => undefined },
      {
        createCoordinator: () => {
          coordinators += 1;
          throw new Error('must not create coordinator');
        },
        openSession: () => fakeSession(),
        spawn: () => child as unknown as ChildProcess,
      },
    );
    child.emit('spawn');
    child.emit('close', null, 'SIGTERM');
    expect(await resultPromise).toEqual({
      fallbackCode: 143,
      kind: 'signal',
      signal: 'SIGTERM',
    });
    expect(coordinators).toBe(0);
  });

  it('does not duplicate terminal evidence when close fails after append', async () => {
    const child = new FakeChild();
    let disposals = 0;
    let terminalWrites = 0;
    const warnings: string[] = [];
    const resultPromise = runWrappedProcess(
      'fixture',
      [],
      {},
      {
        config: composeCollectorFromEnvironment({
          BLACKBOX_SPOOL_DIR: join(temporaryRoot(), 'spool'),
        }).config,
        redactorOptions: { environment: {} },
      },
      { state: 'offline' },
      { warning: (message) => warnings.push(message) },
      {
        openSession: () =>
          fakeSession({
            close: () => {
              throw new Error('close failed');
            },
            dispose: () => {
              disposals += 1;
              throw new Error('dispose failed');
            },
            finish: () => {
              terminalWrites += 1;
            },
          }),
        spawn: () => child as unknown as ChildProcess,
      },
    );
    child.emit('spawn');
    child.emit('close', 5, null);
    expect(await resultPromise).toEqual({ code: 5, kind: 'exit' });
    expect(terminalWrites).toBe(1);
    expect(disposals).toBe(1);
    expect(warnings).toEqual(['Collector degraded: collection-failed']);
  });

  it('drains one completed run only and keeps delivery degradation secondary', async () => {
    const child = new FakeChild();
    const session = fakeSession();
    const drained: string[] = [];
    const warnings: string[] = [];
    const resultPromise = runWrappedProcess(
      'fixture',
      [],
      {},
      {
        config: composeCollectorFromEnvironment({
          BLACKBOX_SPOOL_DIR: join(temporaryRoot(), 'spool'),
        }).config,
        redactorOptions: { environment: {} },
      },
      {
        state: 'configured',
        config: {
          apiBaseUrl: 'http://127.0.0.1:1',
          apiToken: 'token',
          connectTimeoutMs: 1,
          drainMaxAttempts: 1,
          drainMaxElapsedMs: 1,
          drainMaxItems: 1,
          overallTimeoutMs: 1,
          repositoryId: randomUUID(),
          requestTimeoutMs: 1,
          retryBaseMs: 1,
          retryMaxMs: 1,
        },
      },
      { warning: (message) => warnings.push(message) },
      {
        createCoordinator: () => ({
          drain: async (runId?: string) => {
            drained.push(runId ?? 'missing');
            return {
              remaining: { blocked: 0, readyOrDelayed: 1 },
            } as never;
          },
        }),
        openDeliverySpool: () =>
          ({
            close: () => undefined,
            [Symbol.dispose]: () => undefined,
          }) as never,
        openSession: () => session,
        spawn: () => child as unknown as ChildProcess,
      },
    );
    child.emit('spawn');
    child.emit('close', 41, null);
    expect(await resultPromise).toEqual({ code: 41, kind: 'exit' });
    expect(drained).toEqual([session.runId]);
    expect(warnings).toEqual(['Collector degraded: collection-failed']);
  });

  it('returns launch failure without exposing the raw spawn error', async () => {
    const directory = temporaryRoot();
    const spoolRoot = join(directory, 'spool');
    const execution = await runNode(
      spoolRoot,
      '',
      [],
      {},
      {
        spawn: () => {
          throw new Error('raw spawn credential');
        },
      },
    );
    expect(execution).toEqual({
      result: { code: 1, kind: 'exit' },
      warnings: [],
    });
    expect(canonicalEvents(spoolRoot).map((event) => event.kind)).toEqual([
      'run.started',
      'git.snapshot.captured',
      'run.finished',
    ]);
    expect(canonicalEvents(spoolRoot)[2]?.payload).toMatchObject({
      outcome: 'failed',
    });
  });

  it('recovers a hard-killed collector as interrupted without fabricating a terminal event', async () => {
    const directory = temporaryRoot();
    const spoolRoot = join(directory, 'spool');
    const marker = join(directory, 'child-started');
    const runnerModule = pathToFileURL(
      join(originalWorkingDirectory, 'dist', 'process-runner.js'),
    ).href;
    const environmentModule = pathToFileURL(
      join(originalWorkingDirectory, 'dist', 'collector', 'environment.js'),
    ).href;
    const fixture = `
      import { runWrappedProcess } from ${JSON.stringify(runnerModule)};
      import { composeCollectorFromEnvironment } from ${JSON.stringify(environmentModule)};
      await runWrappedProcess(process.execPath, ['-e', ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started'); setTimeout(() => process.exit(0), 500)`)}], process.env, composeCollectorFromEnvironment(process.env), { state: 'offline' }, { warning() {} }, { runLeaseMs: 10000, heartbeatIntervalMs: 1000 });
    `;
    const collector = spawn(
      process.execPath,
      ['--input-type=module', '-e', fixture],
      {
        env: { ...process.env, BLACKBOX_SPOOL_DIR: spoolRoot },
        stdio: 'ignore',
      },
    );
    await waitForPath(marker);
    const exited = new Promise<void>((resolve) =>
      collector.once('exit', () => resolve()),
    );
    collector.kill('SIGKILL');
    await exited;
    await new Promise((resolve) => setTimeout(resolve, 10_100));
    using work = CollectorWorkSpool.open({ spoolRoot });
    expect(work.recoverExpired().runs).toBe(1);
    expect(work.status().runs).toMatchObject({ active: 0, interrupted: 1 });
    expect(work.prepareBatches()).toEqual({
      batchesCreated: 1,
      eventsBatched: 2,
    });
    const claim = work.claimBatch();
    expect(claim?.body).toContain('run.started');
  }, 25_000);
});

function exists(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 12_000;
  while (!exists(path)) {
    if (Date.now() >= deadline)
      throw new Error('collector fixture did not launch child');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
