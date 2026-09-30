import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { CLI_VERSION, runCli } from './cli.js';
import { CollectorSession } from './collector/index.js';

async function captureRun(args: readonly string[]) {
  const errors: string[] = [];
  const output: string[] = [];
  const exitCode = await runCli(args, {
    error: (message) => errors.push(message),
    output: (message) => output.push(message),
  });

  return { errors, exitCode, output };
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error('child marker timeout');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const temporaryDirectories: string[] = [];
const originalWorkingDirectory = process.cwd();
const commandRepository = mkdtempSync(join(tmpdir(), 'bbx-cli-repository-'));

beforeAll(() => {
  const initialized = spawnSync('git', ['init', '--quiet'], {
    cwd: commandRepository,
    stdio: 'ignore',
  });
  if (initialized.status !== 0)
    throw new Error('temporary Git repository initialization failed');
  process.chdir(commandRepository);
});

afterAll(() => {
  process.chdir(originalWorkingDirectory);
  rmSync(commandRepository, { force: true, recursive: true });
});

afterEach(() => {
  for (const path of temporaryDirectories.splice(0))
    rmSync(path, { recursive: true, force: true });
});

describe('blackbox command', () => {
  it('prints help successfully', async () => {
    const result = await captureRun(['--help']);

    expect(result.exitCode).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.output.join('\n')).toContain('Usage: blackbox');
  });

  it('prints the version successfully', async () => {
    const result = await captureRun(['--version']);

    expect(result.exitCode).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.output).toEqual([CLI_VERSION]);
  });

  it('prints stable content-free JSON status', async () => {
    const spoolRoot = join(mkdtempSync(join(tmpdir(), 'bbx-cli-')), 'spool');
    temporaryDirectories.push(join(spoolRoot, '..'));
    const errors: string[] = [];
    const output: string[] = [];
    const exitCode = await runCli(
      ['status', '--json'],
      {
        error: (value) => errors.push(value),
        output: (value) => output.push(value),
      },
      { env: { BLACKBOX_SPOOL_DIR: spoolRoot } },
    );
    expect(exitCode).toBe(0);
    expect(errors).toEqual([]);
    expect(JSON.parse(output[0] ?? '')).toMatchObject({
      schemaVersion: 1,
      runs: { active: 0, closed: 0, interrupted: 0 },
      filesystem: { corrupt: 0, missing: 0 },
    });
  });

  it('validates retry arguments and reports explicit offline state', async () => {
    expect(await captureRun(['retry', '--run', 'invalid'])).toMatchObject({
      exitCode: 1,
      errors: ['Invalid retry arguments'],
    });
    expect(await captureRun(['retry', '--json'])).toMatchObject({
      exitCode: 2,
      errors: [],
      output: [JSON.stringify({ schemaVersion: 1, state: 'offline' })],
    });
  });

  it('runs one bounded retry drain and emits content-free aggregate JSON', async () => {
    const spoolRoot = join(mkdtempSync(join(tmpdir(), 'bbx-cli-')), 'spool');
    temporaryDirectories.push(join(spoolRoot, '..'));
    const session = CollectorSession.open({ spoolRoot });
    session.observeRunFinished({ outcome: 'succeeded' });
    session.close();
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          error: { code: 'internal_error', message: 'temporarily unavailable' },
        }),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('address');
    try {
      const output: string[] = [];
      const errors: string[] = [];
      const exitCode = await runCli(
        ['retry', '--json'],
        {
          error: (value) => errors.push(value),
          output: (value) => output.push(value),
        },
        {
          env: {
            BLACKBOX_API_BASE_URL: `http://127.0.0.1:${address.port}`,
            BLACKBOX_API_TOKEN: 'cli-token-sentinel',
            BLACKBOX_DRAIN_MAX_ATTEMPTS: '1',
            BLACKBOX_REPOSITORY_ID: randomUUID(),
            BLACKBOX_SPOOL_DIR: spoolRoot,
          },
        },
      );
      expect(exitCode).toBe(2);
      expect(errors).toEqual([]);
      expect(JSON.parse(output[0] ?? '')).toMatchObject({
        schemaVersion: 1,
        attempts: 1,
        batches: { retried: 1 },
        remaining: { readyOrDelayed: 1 },
      });
      expect(output.join('')).not.toContain('cli-token-sentinel');
      expect(requests).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('requires the run delimiter and command without consuming child options', async () => {
    expect(await captureRun(['run'])).toMatchObject({
      exitCode: 1,
      errors: ['Invalid run arguments'],
    });
    expect(await captureRun(['run', process.execPath])).toMatchObject({
      exitCode: 1,
      errors: ['Invalid run arguments'],
    });
    expect(await captureRun(['run', '--', ''])).toMatchObject({
      exitCode: 1,
      errors: ['Invalid run arguments'],
    });
    const spoolRoot = join(
      mkdtempSync(join(tmpdir(), 'bbx-cli-run-')),
      'spool',
    );
    temporaryDirectories.push(join(spoolRoot, '..'));
    const result = await runCli(
      [
        'run',
        '--',
        process.execPath,
        '-e',
        "process.exit(process.argv.slice(1).join(',') === '--help,--version' ? 0 : 9)",
        '--',
        '--help',
        '--version',
      ],
      { error: () => undefined, output: () => undefined },
      { env: { ...process.env, BLACKBOX_SPOOL_DIR: spoolRoot } },
    );
    expect(result).toEqual({ code: 0, kind: 'exit' });
  }, 15_000);

  it('fails invalid initialization before creating the child marker', async () => {
    const repositoryRoot = mkdtempSync(join(tmpdir(), 'bbx-cli-repository-'));
    temporaryDirectories.push(repositoryRoot);
    const marker = join(repositoryRoot, 'child-marker');
    const result = await runCli(
      [
        'run',
        '--',
        process.execPath,
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'launched')`,
      ],
      { error: () => undefined, output: () => undefined },
      {
        env: {
          ...process.env,
          BLACKBOX_REPOSITORY_ROOT: repositoryRoot,
          BLACKBOX_SPOOL_DIR: join(repositoryRoot, 'spool'),
        },
      },
    );
    expect(result).toBe(1);
    expect(existsSync(marker)).toBe(false);
  });

  it('performs one run-scoped lifecycle drain without replacing the child exit', async () => {
    const spoolRoot = join(
      mkdtempSync(join(tmpdir(), 'bbx-cli-run-')),
      'spool',
    );
    temporaryDirectories.push(join(spoolRoot, '..'));
    const repositoryId = randomUUID();
    const received: Array<{ batchId: string; runId: string }> = [];
    const server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const batch = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          batchId: string;
          runId: string;
        };
        received.push(batch);
        response.writeHead(202, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            outcome: 'accepted',
            batchId: batch.batchId,
            runId: batch.runId,
            receivedAt: '2026-09-29T10:00:00.000Z',
          }),
        );
      })();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('address');
    try {
      const result = await runCli(
        ['run', '--', process.execPath, '-e', 'process.exit(17)'],
        { error: () => undefined, output: () => undefined },
        {
          env: {
            ...process.env,
            BLACKBOX_API_BASE_URL: `http://127.0.0.1:${address.port}`,
            BLACKBOX_API_TOKEN: 'run-delivery-token',
            BLACKBOX_DRAIN_MAX_ATTEMPTS: '2',
            BLACKBOX_REPOSITORY_ID: repositoryId,
            BLACKBOX_SPOOL_DIR: spoolRoot,
          },
        },
      );
      expect(result).toEqual({ code: 17, kind: 'exit' });
      const deliveredBatches = received.filter((item) => item.runId);
      expect(deliveredBatches).toHaveLength(1);
      expect(deliveredBatches[0]?.runId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15_000);
});

describe('blackbox executable', () => {
  const binaryPath = fileURLToPath(new URL('../dist/bin.js', import.meta.url));

  it.each([
    ['--help', 'Usage: blackbox'],
    ['--version', CLI_VERSION],
  ])('runs %s successfully', (argument, expectedOutput) => {
    const result = spawnSync(process.execPath, [binaryPath, argument], {
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain(expectedOutput);
  });

  it('preserves child stdout, stderr, and a representative non-zero exit', () => {
    const spoolRoot = join(
      mkdtempSync(join(tmpdir(), 'bbx-bin-run-')),
      'spool',
    );
    temporaryDirectories.push(join(spoolRoot, '..'));
    const result = spawnSync(
      process.execPath,
      [
        binaryPath,
        'run',
        '--',
        process.execPath,
        '-e',
        "process.stdout.write('child-out'); process.stderr.write('child-err'); process.exit(42)",
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, BLACKBOX_SPOOL_DIR: spoolRoot },
      },
    );
    expect(result.status).toBe(42);
    expect(result.stdout).toBe('child-out');
    expect(result.stderr).toBe('child-err');
  }, 15_000);

  it('keeps every collector-created file outside the child working directory', () => {
    const repository = mkdtempSync(join(tmpdir(), 'bbx-noop-repository-'));
    const spoolRoot = join(
      mkdtempSync(join(tmpdir(), 'bbx-noop-spool-')),
      'spool',
    );
    temporaryDirectories.push(repository, join(spoolRoot, '..'));
    expect(
      spawnSync('git', ['init', '--quiet'], {
        cwd: repository,
        encoding: 'utf8',
      }).status,
    ).toBe(0);
    const result = spawnSync(
      process.execPath,
      [binaryPath, 'run', '--', process.execPath, '-e', 'process.exit(0)'],
      {
        cwd: repository,
        encoding: 'utf8',
        env: { ...process.env, BLACKBOX_SPOOL_DIR: spoolRoot },
      },
    );
    expect(result.status).toBe(0);
    expect(readdirSync(repository)).toEqual(['.git']);
  }, 15_000);

  it.skipIf(process.platform === 'win32')(
    'forwards a supported signal and reproduces actual child signal termination',
    async () => {
      const directory = mkdtempSync(join(tmpdir(), 'bbx-bin-signal-'));
      temporaryDirectories.push(directory);
      const marker = join(directory, 'ready');
      const collector = spawn(
        process.execPath,
        [
          binaryPath,
          'run',
          '--',
          process.execPath,
          '-e',
          `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ready'); setInterval(() => {}, 1000)`,
        ],
        {
          env: {
            ...process.env,
            BLACKBOX_SPOOL_DIR: join(directory, 'spool'),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      await waitForFile(marker);
      const exited = new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolve) =>
        collector.once('exit', (code, signal) => resolve({ code, signal })),
      );
      collector.kill('SIGTERM');
      const result = await exited;
      expect(result).toEqual({ code: null, signal: 'SIGTERM' });
      const events = (() => {
        using database = new DatabaseSync(
          join(directory, 'spool', 'spool.sqlite3'),
          { readOnly: true },
        );
        return (
          database
            .prepare('SELECT canonical_json FROM events ORDER BY sequence')
            .all() as unknown as { canonical_json: string }[]
        ).map((row) => JSON.parse(row.canonical_json) as unknown);
      })();
      expect(events).toHaveLength(2);
      expect(events[1]).toMatchObject({
        kind: 'run.finished',
        payload: { outcome: 'cancelled' },
      });
    },
    10_000,
  );
});
