import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

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

const temporaryDirectories: string[] = [];
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
});
