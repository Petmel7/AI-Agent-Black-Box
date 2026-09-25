import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { CLI_VERSION, runCli } from './cli.js';

function captureRun(args: readonly string[]) {
  const errors: string[] = [];
  const output: string[] = [];
  const exitCode = runCli(args, {
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
  it('prints help successfully', () => {
    const result = captureRun(['--help']);

    expect(result.exitCode).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.output.join('\n')).toContain('Usage: blackbox');
  });

  it('prints the version successfully', () => {
    const result = captureRun(['--version']);

    expect(result.exitCode).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.output).toEqual([CLI_VERSION]);
  });

  it('prints stable content-free JSON status', () => {
    const spoolRoot = join(mkdtempSync(join(tmpdir(), 'bbx-cli-')), 'spool');
    temporaryDirectories.push(join(spoolRoot, '..'));
    const errors: string[] = [];
    const output: string[] = [];
    const exitCode = runCli(
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
