import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

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
