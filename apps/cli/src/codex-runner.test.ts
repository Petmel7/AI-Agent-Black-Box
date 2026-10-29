import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PassThrough } from 'node:stream';

import { EvidenceEventSchema } from '@blackbox/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { composeCollectorFromEnvironment } from './collector/index.js';
import {
  MAX_FAILED_CODEX_CHECKPOINTS,
  runCodexProcess,
} from './process-runner.js';

const temporaryDirectories: string[] = [];
const CHILD_WRITE_REJECTION_EXIT_CODE = 86;

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { force: true, recursive: true });
});

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'bbx-codex-runner-'));
  temporaryDirectories.push(root);
  if (spawnSync('git', ['init', '--quiet'], { cwd: root }).status !== 0)
    throw new Error('Git repository initialization failed');
  return root;
}

function temporaryDirectory(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(root);
  return root;
}

function events(spoolRoot: string): Array<Record<string, unknown>> {
  using database = new DatabaseSync(join(spoolRoot, 'spool.sqlite3'), {
    readOnly: true,
  });
  return (
    database
      .prepare('SELECT canonical_json FROM events ORDER BY sequence')
      .all() as unknown as { canonical_json: string }[]
  ).map((row) => JSON.parse(row.canonical_json) as Record<string, unknown>);
}

function files(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

class BackpressureOutput extends EventEmitter {
  readonly chunks: Buffer[] = [];
  #blocked = false;

  write(chunk: Uint8Array): boolean {
    this.chunks.push(Buffer.from(chunk));
    this.emit('write');
    if (this.#blocked) return true;
    this.#blocked = true;
    setImmediate(() => this.emit('drain'));
    return false;
  }
}

function waitForOutput(
  output: BackpressureOutput,
  predicate: () => boolean,
): Promise<void> {
  if (predicate()) return Promise.resolve();
  return new Promise((resolve) => {
    const listener = () => {
      if (!predicate()) return;
      output.removeListener('write', listener);
      resolve();
    };
    output.on('write', listener);
  });
}

function controlledRunEvidence(spoolRoot: string): {
  diagnosticCodes: string[];
  runId: string;
} {
  const recorded = events(spoolRoot).map((event) =>
    EvidenceEventSchema.parse(event),
  );
  const runId = recorded[0]?.runId;
  if (!runId) throw new Error('Controlled run has no canonical events');
  if (recorded.some((event) => event.runId !== runId))
    throw new Error('Controlled spool contains multiple run identities');
  return {
    diagnosticCodes: recorded
      .filter((event) => event.kind === 'error.observed')
      .map((event) => event.payload.code),
    runId,
  };
}

async function waitForCheckpointDiagnostics(
  spoolRoot: string,
  failed: number,
  abandoned: number,
): Promise<string[]> {
  const expectedCodes = [
    ...Array.from({ length: failed }, () => 'codex-checkpoint-failed'),
    ...Array.from({ length: abandoned }, () => 'codex-checkpoint-abandoned'),
  ];
  for (let turn = 0; turn < 1_000; turn += 1) {
    const codes = controlledRunEvidence(spoolRoot).diagnosticCodes;
    for (const [index, code] of codes.entries())
      if (code !== expectedCodes[index])
        throw new Error(
          `Unexpected controlled diagnostic at ${index}: ${code}`,
        );
    if (codes.length > expectedCodes.length)
      throw new Error(
        `Controlled diagnostic stream exceeded ${expectedCodes.length} events`,
      );
    if (codes.length === expectedCodes.length) return codes;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(
    `Checkpoint diagnostics did not settle at ${failed} failed and ${abandoned} abandoned`,
  );
}

async function congestEventLoop(): Promise<void> {
  await Promise.all(
    Array.from(
      { length: 64 },
      () => new Promise<void>((resolve) => setImmediate(resolve)),
    ),
  );
}

async function waitForPromise<T>(
  promise: Promise<T>,
  label: string,
): Promise<T> {
  let outcome:
    | { status: 'fulfilled'; value: T }
    | { reason: unknown; status: 'rejected' }
    | undefined;
  void promise.then(
    (value) => {
      outcome = { status: 'fulfilled', value };
    },
    (reason: unknown) => {
      outcome = { reason, status: 'rejected' };
    },
  );
  for (let turn = 0; turn < 1_000 && !outcome; turn += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
  if (!outcome) throw new Error(`${label} did not settle`);
  if (outcome.status === 'rejected') throw outcome.reason;
  return outcome.value;
}

function flushChildScript(
  thread: string,
  changes: readonly string[],
  rejectedWriteIndex?: number,
): string {
  const emissions = changes
    .map(
      (line, index) =>
        `new Promise((resolve) => setTimeout(resolve, ${20 + index * 35})).then(() => write(${JSON.stringify(line)}, ${index}))`,
    )
    .join(',');
  return `const write = (value, index) => new Promise((resolve, reject) => { if (index === ${rejectedWriteIndex ?? -2}) { reject(new Error('controlled-write-rejection')); return; } process.stdout.write(value, (error) => error ? reject(error) : resolve()); }); void (async () => { await write(${JSON.stringify(thread)}, -1); await Promise.all([${emissions}]); process.exitCode = 17; })().catch(() => { process.exitCode = ${CHILD_WRITE_REJECTION_EXIT_CODE}; });`;
}

interface ControlledRunAudit {
  childTerminations: number;
  listenersRemoved: boolean;
  resultSettled: boolean;
  sourceEnded: boolean;
  spoolRemoved: boolean;
  spoolRoot?: string;
}

interface ControlledRunResult {
  attempts: number;
  audit: ControlledRunAudit;
  diagnosticCodes: string[];
  expectedOutput: Buffer;
  output: Buffer;
  releasedAfterFailureCounts: number[];
  result: { code: number; kind: 'exit' };
  runId: string;
  spoolRoot: string;
}

function controlledRunAudit(): ControlledRunAudit {
  return {
    childTerminations: 0,
    listenersRemoved: false,
    resultSettled: false,
    sourceEnded: false,
    spoolRemoved: false,
  };
}

async function runControlledAbandonment(
  repositoryRoot: string,
  options: {
    audit?: ControlledRunAudit;
    failAfterDiagnostic?: number;
  } = {},
): Promise<ControlledRunResult> {
  const audit = options.audit ?? controlledRunAudit();
  const spoolRoot = temporaryDirectory('bbx-spool-abandon-');
  audit.spoolRoot = spoolRoot;
  const output = new BackpressureOutput();
  const source = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdout: source,
    kill: () => true,
  });
  const thread = `${JSON.stringify({ type: 'thread.started', thread_id: 'abandon-thread' })}\n${JSON.stringify({ type: 'turn.started' })}\n`;
  const changes = Array.from(
    { length: MAX_FAILED_CODEX_CHECKPOINTS },
    (_, index) =>
      `${JSON.stringify({ type: 'item.completed', item: { id: `abandon-file-${index}`, type: 'file_change' } })}\n`,
  );
  let childSpawned!: () => void;
  const spawned = new Promise<void>((resolve) => {
    childSpawned = resolve;
  });
  const sourceEnded = new Promise<void>((resolve) =>
    source.once('end', resolve),
  );
  let attempts = 0;
  let childTerminated = false;
  let diagnosticCodes: string[] = [];
  type WrappedResult = Awaited<ReturnType<typeof runCodexProcess>>;
  let observedResult:
    | Promise<
        | { status: 'fulfilled'; value: WrappedResult }
        | { reason: unknown; status: 'rejected' }
      >
    | undefined;
  let primaryError: unknown;
  let result: WrappedResult | undefined;
  let runId: string | undefined;
  const releasedAfterFailureCounts: number[] = [];
  const teardownErrors: unknown[] = [];
  const terminateChild = () => {
    if (childTerminated) return;
    childTerminated = true;
    audit.childTerminations += 1;
    child.emit('close', 17, null);
  };
  try {
    const env = {
      ...process.env,
      BLACKBOX_REPOSITORY_ROOT: repositoryRoot,
      BLACKBOX_SPOOL_DIR: spoolRoot,
    };
    observedResult = runCodexProcess(
      [],
      env,
      composeCollectorFromEnvironment(env),
      { state: 'offline' },
      { warning: () => undefined },
      {
        captureCodexCheckpoint: async () => {
          attempts += 1;
          throw new Error('bounded checkpoint failure');
        },
        stdout: output,
        spawn: () => {
          setImmediate(() => {
            child.emit('spawn');
            source.write(thread);
            childSpawned();
          });
          return child as unknown as ChildProcess;
        },
      },
    ).then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason: unknown) => ({ reason, status: 'rejected' as const }),
    );

    await spawned;
    for (const [index, change] of changes.entries()) {
      const evidenceBeforeRelease = controlledRunEvidence(spoolRoot);
      runId ??= evidenceBeforeRelease.runId;
      releasedAfterFailureCounts.push(
        evidenceBeforeRelease.diagnosticCodes.length,
      );
      expect(evidenceBeforeRelease.diagnosticCodes).toEqual(
        Array.from({ length: index }, () => 'codex-checkpoint-failed'),
      );

      source.write(change);
      diagnosticCodes = await waitForCheckpointDiagnostics(
        spoolRoot,
        index + 1,
        index === changes.length - 1 ? 1 : 0,
      );
      expect(attempts).toBe(index + 1);
      if (options.failAfterDiagnostic === index + 1)
        throw new Error('injected-controlled-polling-failure');
      if (index < changes.length - 1) await congestEventLoop();
    }
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      if (!source.writableEnded) source.end();
      await waitForPromise(sourceEnded, 'controlled stdout end');
      audit.sourceEnded = true;
    } catch (error) {
      teardownErrors.push(error);
      source.destroy();
    }
    try {
      terminateChild();
    } catch (error) {
      teardownErrors.push(error);
    }
    try {
      if (!observedResult) {
        teardownErrors.push(
          new Error('Controlled wrapped result was not created'),
        );
      } else {
        const observed = await waitForPromise(
          observedResult,
          'controlled wrapped result',
        );
        audit.resultSettled = true;
        if (observed.status === 'rejected')
          teardownErrors.push(observed.reason);
        else result = observed.value;
      }
    } catch (error) {
      teardownErrors.push(error);
    }
    source.destroy();
    try {
      const listenerCounts = [
        source.listenerCount('data'),
        source.listenerCount('end'),
        source.listenerCount('error'),
        source.listenerCount('close'),
        child.listenerCount('spawn'),
        child.listenerCount('error'),
        child.listenerCount('close'),
      ];
      if (listenerCounts.some((count) => count !== 0)) {
        teardownErrors.push(
          new Error(`Controlled listeners remain: ${listenerCounts.join(',')}`),
        );
      } else {
        audit.listenersRemoved = true;
      }
    } catch (error) {
      teardownErrors.push(error);
    }
    try {
      if (existsSync(spoolRoot))
        rmSync(spoolRoot, { force: true, recursive: true });
      if (existsSync(spoolRoot)) {
        teardownErrors.push(
          new Error('Controlled spool removal did not converge'),
        );
      } else {
        audit.spoolRemoved = true;
      }
    } catch (error) {
      teardownErrors.push(error);
    }
  }

  if (primaryError) {
    if (teardownErrors.length > 0)
      throw new AggregateError(
        [primaryError, ...teardownErrors],
        'Controlled run and teardown failed',
      );
    throw primaryError;
  }
  if (teardownErrors.length > 0)
    throw new AggregateError(teardownErrors, 'Controlled teardown failed');
  if (!result || result.kind !== 'exit' || !runId)
    throw new Error(
      'Controlled run completed without a result or run identity',
    );
  return {
    attempts,
    audit,
    diagnosticCodes,
    expectedOutput: Buffer.from(thread + changes.join('')),
    output: Buffer.concat(output.chunks),
    releasedAfterFailureCounts,
    result,
    runId,
    spoolRoot,
  };
}

class FailingOutput extends BackpressureOutput {
  override write(chunk: Uint8Array): boolean {
    super.write(chunk);
    this.emit('error', new Error('private output failure'));
    return true;
  }
}

describe('Codex wrapped process', () => {
  it('owns same-prefix temporary directories independently', () => {
    const fixtureRoot = temporaryDirectory('bbx-spool-ownership-fixture-');
    const preservedDirectory = join(fixtureRoot, 'pre-existing');
    mkdirSync(preservedDirectory);
    writeFileSync(join(preservedDirectory, 'marker'), 'preserved');
    const first = temporaryDirectory('bbx-spool-ownership-');
    const second = temporaryDirectory('bbx-spool-ownership-');
    writeFileSync(join(first, 'marker'), 'first');
    writeFileSync(join(second, 'marker'), 'second');

    expect(first).not.toBe(second);
    expect(existsSync(join(first, 'marker'))).toBe(true);
    expect(existsSync(join(second, 'marker'))).toBe(true);
    rmSync(first, { force: true, recursive: true });
    expect(existsSync(first)).toBe(false);
    expect(existsSync(join(second, 'marker'))).toBe(true);
    expect(existsSync(join(preservedDirectory, 'marker'))).toBe(true);
    rmSync(second, { force: true, recursive: true });
    expect(existsSync(second)).toBe(false);
    expect(existsSync(join(preservedDirectory, 'marker'))).toBe(true);
  });

  it('launches exact arguments, preserves stdout under backpressure, and records mapped evidence', async () => {
    const root = repository();
    const spoolRoot = temporaryDirectory('bbx-spool-mapped-evidence-');
    const priorCwd = process.cwd();
    process.chdir(root);
    const lines = [
      { type: 'thread.started', thread_id: 'native-thread' },
      { type: 'turn.started' },
      {
        type: 'item.started',
        item: {
          id: 'native-command',
          type: 'command_execution',
          command: 'echo TOP_SECRET_SENTINEL',
          cwd: root,
        },
      },
      {
        type: 'item.completed',
        item: {
          id: 'native-command',
          type: 'command_execution',
          aggregated_output: 'TOP_SECRET_SENTINEL',
          exit_code: 0,
          status: 'completed',
        },
      },
      {
        type: 'item.completed',
        item: {
          id: 'native-file',
          type: 'file_change',
          changes: ['TOP_SECRET_SENTINEL'],
        },
      },
      {
        type: 'item.completed',
        item: {
          id: 'native-reasoning',
          type: 'reasoning',
          text: 'TOP_SECRET_SENTINEL',
        },
      },
      {
        type: 'turn.completed',
        usage: { input_tokens: 7, output_tokens: 4 },
      },
    ];
    const jsonl = Buffer.from(
      `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
    );
    const output = new BackpressureOutput();
    let launch:
      { args: readonly string[]; command: string; stdio: unknown } | undefined;
    try {
      const env = {
        ...process.env,
        BLACKBOX_CAPTURE_CLASSES: 'command,working-directory,stdout',
        BLACKBOX_REPOSITORY_ROOT: root,
        BLACKBOX_SPOOL_DIR: spoolRoot,
        TOP_SECRET_TOKEN: 'TOP_SECRET_SENTINEL',
      };
      const result = await runCodexProcess(
        ['--model', 'gpt-test', '-'],
        env,
        composeCollectorFromEnvironment(env),
        { state: 'offline' },
        { warning: () => undefined },
        {
          stdout: output,
          spawn: (command, args, options) => {
            launch = { command, args, stdio: options.stdio };
            return spawn(
              process.execPath,
              [
                '-e',
                `process.stdout.write(Buffer.from(${JSON.stringify(jsonl.toString('base64'))},'base64')); process.exit(23)`,
              ],
              options,
            );
          },
        },
      );

      expect(result).toEqual({ code: 23, kind: 'exit' });
      expect(launch).toEqual({
        command: 'codex',
        args: ['exec', '--json', '--model', 'gpt-test', '-'],
        stdio: ['inherit', 'pipe', 'inherit'],
      });
      expect(Buffer.concat(output.chunks)).toEqual(jsonl);
      const recorded = events(spoolRoot);
      expect(recorded.map((event) => event.kind)).toEqual([
        'run.started',
        'git.snapshot.captured',
        'command.started',
        'command.finished',
        'tool.call.finished',
        'usage.observed',
        'git.snapshot.captured',
        'git.snapshot.captured',
        'git.diff.captured',
        'run.finished',
      ]);
      expect(recorded[2]?.source).toMatchObject({
        component: 'agent-adapter',
        provider: 'codex',
        nativeSessionId: 'native-thread',
        nativeEventId: 'native-command',
      });
      expect(recorded[2]?.payload).toMatchObject({
        command: { state: 'captured', excerpt: 'echo [REDACTED]' },
        workingDirectory: {
          state: 'captured',
          excerpt: '<repository-root>',
        },
      });
      expect(recorded[3]?.payload).toMatchObject({
        exitCode: 0,
        outcome: 'succeeded',
        stdout: { state: 'captured', excerpt: '[REDACTED]' },
        stderr: { state: 'unavailable', reason: 'not-exposed' },
      });
      expect(recorded[5]?.payload).toMatchObject({
        inputTokens: { state: 'reported', value: 7 },
        outputTokens: { state: 'reported', value: 4 },
        cachedInputTokens: { state: 'unavailable', reason: 'not-reported' },
        reasoningTokens: { state: 'unavailable', reason: 'not-reported' },
        totalTokens: { state: 'unavailable', reason: 'not-reported' },
      });
      for (const path of files(spoolRoot))
        expect(readFileSync(path)).not.toContain(
          Buffer.from('TOP_SECRET_SENTINEL'),
        );
    } finally {
      process.chdir(priorCwd);
    }
  }, 20_000);

  it('preserves the real child exit when JSONL parsing degrades', async () => {
    const root = repository();
    const spoolRoot = temporaryDirectory('bbx-spool-malformed-jsonl-');
    const priorCwd = process.cwd();
    process.chdir(root);
    const output = new BackpressureOutput();
    try {
      const env = { ...process.env, BLACKBOX_SPOOL_DIR: spoolRoot };
      const result = await runCodexProcess(
        [],
        env,
        composeCollectorFromEnvironment(env),
        { state: 'offline' },
        { warning: () => undefined },
        {
          stdout: output,
          spawn: (_command, _args, options): ChildProcess =>
            spawn(
              process.execPath,
              [
                '-e',
                "process.stdout.write('{malformed private sentinel}\\n'); process.exit(37)",
              ],
              options,
            ),
        },
      );

      expect(result).toEqual({ code: 37, kind: 'exit' });
      const recorded = events(spoolRoot);
      expect(recorded.map((event) => event.kind)).toContain('error.observed');
      expect(recorded.at(-1)?.payload).toMatchObject({ outcome: 'failed' });
      expect(readFileSync(join(spoolRoot, 'spool.sqlite3'))).not.toContain(
        Buffer.from('private sentinel'),
      );
    } finally {
      process.chdir(priorCwd);
    }
  }, 20_000);

  it('preserves the real child exit when stdout forwarding fails', async () => {
    const root = repository();
    const spoolRoot = temporaryDirectory('bbx-spool-stdout-failure-');
    const priorCwd = process.cwd();
    process.chdir(root);
    const warnings: string[] = [];
    try {
      const env = { ...process.env, BLACKBOX_SPOOL_DIR: spoolRoot };
      const result = await runCodexProcess(
        [],
        env,
        composeCollectorFromEnvironment(env),
        { state: 'offline' },
        { warning: (message) => warnings.push(message) },
        {
          stdout: new FailingOutput(),
          spawn: (_command, _args, options): ChildProcess =>
            spawn(
              process.execPath,
              [
                '-e',
                `process.stdout.write(${JSON.stringify(`${JSON.stringify({ type: 'thread.started', thread_id: 'stdout-failure' })}\n`)}); process.exit(19)`,
              ],
              options,
            ),
        },
      );

      expect(result).toEqual({ code: 19, kind: 'exit' });
      expect(warnings).toEqual(['Collector degraded: collection-failed']);
      expect(events(spoolRoot).at(-1)?.payload).toMatchObject({
        outcome: 'failed',
      });
      expect(warnings.join('')).not.toContain('private output failure');
    } finally {
      process.chdir(priorCwd);
    }
  }, 20_000);

  it('waits for child close after a stdout source error/close race and removes listeners', async () => {
    const root = repository();
    const spoolRoot = temporaryDirectory('bbx-spool-source-race-');
    const priorCwd = process.cwd();
    process.chdir(root);
    const output = new BackpressureOutput();
    const source = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdout: source,
      kill: () => true,
    });
    let sourceClosed!: () => void;
    const sourceCloseObserved = new Promise<void>((resolve) => {
      sourceClosed = resolve;
    });
    let resultSettled = false;
    try {
      const env = { ...process.env, BLACKBOX_SPOOL_DIR: spoolRoot };
      const resultPromise = runCodexProcess(
        [],
        env,
        composeCollectorFromEnvironment(env),
        { state: 'offline' },
        { warning: () => undefined },
        {
          stdout: output,
          spawn: () => {
            setImmediate(() => {
              child.emit('spawn');
              source.write(
                `${JSON.stringify({ type: 'thread.started', thread_id: 'source-race' })}\n`,
              );
              source.emit('error', new Error('private source failure'));
              source.emit('close');
              sourceClosed();
            });
            return child as unknown as ChildProcess;
          },
        },
      ).finally(() => {
        resultSettled = true;
      });

      await sourceCloseObserved;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(resultSettled).toBe(false);
      child.emit('close', 43, null);

      await expect(resultPromise).resolves.toEqual({ code: 43, kind: 'exit' });
      expect(source.listenerCount('data')).toBe(0);
      expect(source.listenerCount('end')).toBe(0);
      expect(source.listenerCount('error')).toBe(0);
      expect(source.listenerCount('close')).toBe(0);
      expect(events(spoolRoot).at(-1)?.payload).toMatchObject({
        outcome: 'failed',
      });
    } finally {
      process.chdir(priorCwd);
    }
  }, 20_000);

  it('continues draining JSONL while checkpoint Git work is blocked', async () => {
    const root = repository();
    const spoolRoot = temporaryDirectory('bbx-spool-checkpoint-drain-');
    const priorCwd = process.cwd();
    process.chdir(root);
    const output = new BackpressureOutput();
    let checkpointStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      checkpointStarted = resolve;
    });
    let releaseCheckpoint!: () => void;
    const blockedCheckpoint = new Promise<void>((resolve) => {
      releaseCheckpoint = resolve;
    });
    let resultSettled = false;
    let checkpointAttempts = 0;
    const first = `${JSON.stringify({ type: 'thread.started', thread_id: 'drain-thread' })}\n${JSON.stringify({ type: 'turn.started' })}\n${JSON.stringify({ type: 'item.completed', item: { id: 'drain-file', type: 'file_change' } })}\n`;
    const second = `${[2, 3, 4]
      .map((id) =>
        JSON.stringify({
          type: 'item.completed',
          item: { id: `drain-file-${id}`, type: 'file_change' },
        }),
      )
      .join(
        '\n',
      )}\n${JSON.stringify({ type: 'turn.completed', turn_id: 'drain-turn', usage: { output_tokens: 3 } })}\n`;
    try {
      const env = { ...process.env, BLACKBOX_SPOOL_DIR: spoolRoot };
      const resultPromise = runCodexProcess(
        [],
        env,
        composeCollectorFromEnvironment(env),
        { state: 'offline' },
        { warning: () => undefined },
        {
          captureCodexCheckpoint: async () => {
            checkpointAttempts += 1;
            if (checkpointAttempts === 1) {
              checkpointStarted();
              await blockedCheckpoint;
            }
          },
          stdout: output,
          spawn: (_command, _args, options) =>
            spawn(
              process.execPath,
              [
                '-e',
                `process.stdout.write(${JSON.stringify(first)}); setTimeout(() => { process.stdout.write(${JSON.stringify(second)}); process.exit(31); }, 30);`,
              ],
              options,
            ),
        },
      ).finally(() => {
        resultSettled = true;
      });

      await started;
      await waitForOutput(output, () =>
        Buffer.concat(output.chunks).includes(Buffer.from(second)),
      );
      expect(Buffer.concat(output.chunks)).toEqual(Buffer.from(first + second));
      expect(resultSettled).toBe(false);
      expect(checkpointAttempts).toBe(1);
      releaseCheckpoint();
      await expect(resultPromise).resolves.toEqual({ code: 31, kind: 'exit' });
      expect(checkpointAttempts).toBe(2);
    } finally {
      releaseCheckpoint?.();
      process.chdir(priorCwd);
    }
  }, 20_000);

  it('allows a later checkpoint to succeed after bounded transient failures', async () => {
    const root = repository();
    const spoolRoot = temporaryDirectory('bbx-spool-checkpoint-retry-');
    const priorCwd = process.cwd();
    process.chdir(root);
    const warnings: string[] = [];
    const thread = `${JSON.stringify({ type: 'thread.started', thread_id: 'retry-thread' })}\n${JSON.stringify({ type: 'turn.started' })}\n`;
    const changes = [1, 2, 3].map(
      (id) =>
        `${JSON.stringify({ type: 'item.completed', item: { id: `retry-file-${id}`, type: 'file_change' } })}\n`,
    );
    let attempts = 0;
    try {
      const env = { ...process.env, BLACKBOX_SPOOL_DIR: spoolRoot };
      const result = await runCodexProcess(
        [],
        env,
        composeCollectorFromEnvironment(env),
        { state: 'offline' },
        { warning: (message) => warnings.push(message) },
        {
          captureCodexCheckpoint: async (session) => {
            attempts += 1;
            if (attempts < 3) throw new Error('transient checkpoint failure');
            session.captureGitSnapshot('checkpoint');
          },
          spawn: (_command, _args, options) =>
            spawn(
              process.execPath,
              [
                '-e',
                `process.stdout.write(${JSON.stringify(thread + changes[0])}); setTimeout(() => process.stdout.write(${JSON.stringify(changes[1])}), 40); setTimeout(() => { process.stdout.write(${JSON.stringify(changes[2])}); process.exit(0); }, 80);`,
              ],
              options,
            ),
        },
      );

      expect(result).toEqual({ code: 0, kind: 'exit' });
      expect(attempts).toBe(3);
      const recorded = events(spoolRoot);
      expect(
        recorded.filter((event) => event.kind === 'git.snapshot.captured'),
      ).toHaveLength(3);
      expect(
        recorded.filter(
          (event) =>
            (event.payload as { code?: string }).code ===
            'codex-checkpoint-failed',
        ),
      ).toHaveLength(2);
      expect(
        recorded.some(
          (event) =>
            (event.payload as { code?: string }).code ===
            'codex-checkpoint-abandoned',
        ),
      ).toBe(false);
      expect(warnings).toEqual(['Collector degraded: collection-failed']);
    } finally {
      process.chdir(priorCwd);
    }
  }, 20_000);

  it('flushes all checkpoint JSONL before a real child exits', async () => {
    const root = repository();
    const spoolRoot = temporaryDirectory('bbx-spool-flush-');
    const priorCwd = process.cwd();
    process.chdir(root);
    const output = new BackpressureOutput();
    const thread = `${JSON.stringify({ type: 'thread.started', thread_id: 'flush-thread' })}\n${JSON.stringify({ type: 'turn.started' })}\n`;
    const changes = Array.from(
      { length: MAX_FAILED_CODEX_CHECKPOINTS },
      (_, index) =>
        `${JSON.stringify({ type: 'item.completed', item: { id: `flush-file-${index}`, type: 'file_change' } })}\n`,
    );
    try {
      const env = { ...process.env, BLACKBOX_SPOOL_DIR: spoolRoot };
      const result = await runCodexProcess(
        [],
        env,
        composeCollectorFromEnvironment(env),
        { state: 'offline' },
        { warning: () => undefined },
        {
          captureCodexCheckpoint: async () => undefined,
          stdout: output,
          spawn: (_command, _args, options) =>
            spawn(
              process.execPath,
              [
                '--unhandled-rejections=strict',
                '-e',
                flushChildScript(thread, changes),
              ],
              options,
            ),
        },
      );

      expect(result).toEqual({ code: 17, kind: 'exit' });
      expect(changes).toHaveLength(MAX_FAILED_CODEX_CHECKPOINTS);
      expect(Buffer.concat(output.chunks)).toEqual(
        Buffer.from(thread + changes.join('')),
      );
    } finally {
      process.chdir(priorCwd);
    }
  }, 20_000);

  it('handles a rejected real-child write with a distinct exit', async () => {
    const root = repository();
    const spoolRoot = temporaryDirectory('bbx-spool-flush-rejected-');
    const priorCwd = process.cwd();
    process.chdir(root);
    const output = new BackpressureOutput();
    const thread = `${JSON.stringify({ type: 'thread.started', thread_id: 'flush-rejected-thread' })}\n${JSON.stringify({ type: 'turn.started' })}\n`;
    const changes = Array.from(
      { length: MAX_FAILED_CODEX_CHECKPOINTS },
      (_, index) =>
        `${JSON.stringify({ type: 'item.completed', item: { id: `flush-rejected-file-${index}`, type: 'file_change' } })}\n`,
    );
    try {
      const env = { ...process.env, BLACKBOX_SPOOL_DIR: spoolRoot };
      const result = await runCodexProcess(
        [],
        env,
        composeCollectorFromEnvironment(env),
        { state: 'offline' },
        { warning: () => undefined },
        {
          captureCodexCheckpoint: async () => undefined,
          stdout: output,
          spawn: (_command, _args, options) =>
            spawn(
              process.execPath,
              [
                '--unhandled-rejections=strict',
                '-e',
                flushChildScript(thread, changes, 3),
              ],
              options,
            ),
        },
      );

      expect(result).toEqual({
        code: CHILD_WRITE_REJECTION_EXIT_CODE,
        kind: 'exit',
      });
      expect(result).not.toEqual({ code: 17, kind: 'exit' });
    } finally {
      process.chdir(priorCwd);
    }
  }, 20_000);

  it('bounds failed checkpoint attempts and records final abandonment', async () => {
    const root = repository();
    const priorCwd = process.cwd();
    process.chdir(root);
    try {
      const controlled = await runControlledAbandonment(root);
      expect(controlled.result).toEqual({ code: 17, kind: 'exit' });
      expect(controlled.releasedAfterFailureCounts).toEqual(
        Array.from(
          { length: MAX_FAILED_CODEX_CHECKPOINTS },
          (_, index) => index,
        ),
      );
      expect(controlled.output).toEqual(controlled.expectedOutput);
      expect(controlled.attempts).toBe(MAX_FAILED_CODEX_CHECKPOINTS);
      expect(controlled.diagnosticCodes).toEqual([
        ...Array.from(
          { length: MAX_FAILED_CODEX_CHECKPOINTS },
          () => 'codex-checkpoint-failed',
        ),
        'codex-checkpoint-abandoned',
      ]);
      expect(controlled.audit).toMatchObject({
        childTerminations: 1,
        listenersRemoved: true,
        resultSettled: true,
        sourceEnded: true,
        spoolRemoved: true,
      });
      expect(existsSync(controlled.spoolRoot)).toBe(false);
    } finally {
      process.chdir(priorCwd);
    }
  }, 20_000);

  it('settles and removes controlled resources after an injected failure', async () => {
    const root = repository();
    const priorCwd = process.cwd();
    process.chdir(root);
    const audit = controlledRunAudit();
    try {
      await expect(
        runControlledAbandonment(root, {
          audit,
          failAfterDiagnostic: 3,
        }),
      ).rejects.toThrow('injected-controlled-polling-failure');
      expect(audit).toMatchObject({
        childTerminations: 1,
        listenersRemoved: true,
        resultSettled: true,
        sourceEnded: true,
        spoolRemoved: true,
      });
      expect(audit.spoolRoot).toBeDefined();
      expect(existsSync(audit.spoolRoot!)).toBe(false);
    } finally {
      process.chdir(priorCwd);
    }
  }, 20_000);

  it('isolates concurrent controlled-run spools and identities', async () => {
    const root = repository();
    const priorCwd = process.cwd();
    process.chdir(root);
    try {
      const [first, second] = await Promise.all([
        runControlledAbandonment(root),
        runControlledAbandonment(root),
      ]);
      const expectedCodes = [
        ...Array.from(
          { length: MAX_FAILED_CODEX_CHECKPOINTS },
          () => 'codex-checkpoint-failed',
        ),
        'codex-checkpoint-abandoned',
      ];
      expect(first.spoolRoot).not.toBe(second.spoolRoot);
      expect(first.runId).not.toBe(second.runId);
      expect(first.diagnosticCodes).toEqual(expectedCodes);
      expect(second.diagnosticCodes).toEqual(expectedCodes);
      expect(first.audit.spoolRemoved).toBe(true);
      expect(second.audit.spoolRemoved).toBe(true);
      expect(existsSync(first.spoolRoot)).toBe(false);
      expect(existsSync(second.spoolRoot)).toBe(false);
    } finally {
      process.chdir(priorCwd);
    }
  }, 20_000);
});
