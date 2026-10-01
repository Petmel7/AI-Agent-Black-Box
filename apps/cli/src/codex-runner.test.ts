import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { composeCollectorFromEnvironment } from './collector/index.js';
import {
  MAX_FAILED_CODEX_CHECKPOINTS,
  runCodexProcess,
} from './process-runner.js';

const temporaryDirectories: string[] = [];

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

class FailingOutput extends BackpressureOutput {
  override write(chunk: Uint8Array): boolean {
    super.write(chunk);
    this.emit('error', new Error('private output failure'));
    return true;
  }
}

describe('Codex wrapped process', () => {
  it('launches exact arguments, preserves stdout under backpressure, and records mapped evidence', async () => {
    const root = repository();
    const spoolRoot = join(root, '..', `bbx-spool-${Date.now()}`);
    temporaryDirectories.push(spoolRoot);
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
    const spoolRoot = join(root, '..', `bbx-spool-malformed-${Date.now()}`);
    temporaryDirectories.push(spoolRoot);
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
    const spoolRoot = join(root, '..', `bbx-spool-stdout-${Date.now()}`);
    temporaryDirectories.push(spoolRoot);
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
    const spoolRoot = join(root, '..', `bbx-spool-source-${Date.now()}`);
    temporaryDirectories.push(spoolRoot);
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
    const spoolRoot = join(root, '..', `bbx-spool-drain-${Date.now()}`);
    temporaryDirectories.push(spoolRoot);
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
    const first = `${JSON.stringify({ type: 'thread.started', thread_id: 'drain-thread' })}\n${JSON.stringify({ type: 'turn.started' })}\n${JSON.stringify({ type: 'item.completed', item: { id: 'drain-file', type: 'file_change' } })}\n`;
    const second = `${JSON.stringify({ type: 'turn.completed', turn_id: 'drain-turn', usage: { output_tokens: 3 } })}\n`;
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
            checkpointStarted();
            await blockedCheckpoint;
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
      releaseCheckpoint();
      await expect(resultPromise).resolves.toEqual({ code: 31, kind: 'exit' });
    } finally {
      releaseCheckpoint?.();
      process.chdir(priorCwd);
    }
  }, 20_000);

  it('allows a later checkpoint to succeed after bounded transient failures', async () => {
    const root = repository();
    const spoolRoot = join(root, '..', `bbx-spool-retry-${Date.now()}`);
    temporaryDirectories.push(spoolRoot);
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

  it('bounds failed checkpoint attempts and records final abandonment', async () => {
    const root = repository();
    const spoolRoot = join(root, '..', `bbx-spool-abandon-${Date.now()}`);
    temporaryDirectories.push(spoolRoot);
    const priorCwd = process.cwd();
    process.chdir(root);
    const output = new BackpressureOutput();
    const thread = `${JSON.stringify({ type: 'thread.started', thread_id: 'abandon-thread' })}\n${JSON.stringify({ type: 'turn.started' })}\n`;
    const changes = Array.from(
      { length: MAX_FAILED_CODEX_CHECKPOINTS },
      (_, index) =>
        `${JSON.stringify({ type: 'item.completed', item: { id: `abandon-file-${index}`, type: 'file_change' } })}\n`,
    );
    const emissions = changes
      .map(
        (line, index) =>
          `setTimeout(() => process.stdout.write(${JSON.stringify(line)}), ${20 + index * 35})`,
      )
      .join(';');
    let attempts = 0;
    try {
      const env = { ...process.env, BLACKBOX_SPOOL_DIR: spoolRoot };
      const result = await runCodexProcess(
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
          spawn: (_command, _args, options) =>
            spawn(
              process.execPath,
              [
                '-e',
                `process.stdout.write(${JSON.stringify(thread)}); ${emissions}; setTimeout(() => process.exit(17), ${80 + changes.length * 35});`,
              ],
              options,
            ),
        },
      );

      expect(result).toEqual({ code: 17, kind: 'exit' });
      expect(attempts).toBe(MAX_FAILED_CODEX_CHECKPOINTS);
      const codes = events(spoolRoot)
        .map((event) => (event.payload as { code?: string }).code)
        .filter(Boolean);
      expect(
        codes.filter((code) => code === 'codex-checkpoint-failed'),
      ).toHaveLength(MAX_FAILED_CODEX_CHECKPOINTS);
      expect(
        codes.filter((code) => code === 'codex-checkpoint-abandoned'),
      ).toHaveLength(1);
    } finally {
      process.chdir(priorCwd);
    }
  }, 20_000);
});
