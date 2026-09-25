import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { validateCollectorConfig } from './config.js';
import {
  captureText,
  HOME_PLACEHOLDER,
  REDACTION_MARKER,
  Redactor,
  REPOSITORY_PLACEHOLDER,
} from './redaction.js';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), 'bbx-redaction-'));
  temporaryDirectories.push(path);
  return path;
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0))
    rmSync(path, { recursive: true, force: true });
});

describe('collector redaction', () => {
  it('defaults every capture class to metadata-only omission', () => {
    const config = validateCollectorConfig({ spoolRoot: temporaryDirectory() });
    expect(
      captureText(
        'stdout',
        Buffer.from('private content'),
        config,
        new Redactor({ environment: {} }),
      ),
    ).toEqual({ capture: { state: 'omitted' } });
  });

  it('merges overlapping literal matches and uses a constant marker', () => {
    const result = new Redactor({
      collectorCredentials: ['abcdefgh', 'abcdefghijk'],
      environment: {},
    }).redact('xabcdefghijky abcdefgh');

    expect(result.text).toBe(`x${REDACTION_MARKER}y ${REDACTION_MARKER}`);
    expect(result.matchCount).toBe(2);
    expect(result.text).not.toContain('abcdefgh');
  });

  it('applies built-in, environment, file, and path rules', () => {
    const directory = temporaryDirectory();
    const literalPath = join(directory, 'rules.txt');
    const fileSecret = `file-${randomUUID()}`;
    const environmentSecret = `env-${randomUUID()}`;
    writeFileSync(literalPath, `${fileSecret}\n`, { mode: 0o600 });
    const redactor = new Redactor({
      environment: { APP_SECRET: environmentSecret },
      homeDirectory: 'C:\\Users\\private',
      literalFilePath: literalPath,
      repositoryRoot: 'C:\\code\\private',
    });
    const result = redactor.redact(
      `Authorization: Bearer token-value ${fileSecret} ${environmentSecret} C:\\code\\private\\x C:\\Users\\private\\y https://name:password@example.test`,
    );

    expect(result.text).not.toContain(fileSecret);
    expect(result.text).not.toContain(environmentSecret);
    expect(result.text).not.toContain('token-value');
    expect(result.text).not.toContain('name:password');
    expect(result.text).toContain(REPOSITORY_PLACEHOLDER);
    expect(result.text).toContain(HOME_PLACEHOLDER);
  });

  it('normalizes private paths by complete components across host platforms', () => {
    const windows = new Redactor({
      environment: {},
      homeDirectory: 'C:\\Users\\Private\\',
      repositoryRoot: 'C:\\Repo\\',
    }).redact(
      'C:\\Repo c:/repo/file C:/RePo\\mixed C:\\Repository/file C:\\Users\\Private c:/users/private/file <repository-root>',
    ).text;
    expect(windows).toContain(
      `${REPOSITORY_PLACEHOLDER} ${REPOSITORY_PLACEHOLDER}/file`,
    );
    expect(windows).toContain(`${REPOSITORY_PLACEHOLDER}\\mixed`);
    expect(windows).toContain('C:\\Repository/file');
    expect(windows).toContain(`${HOME_PLACEHOLDER} ${HOME_PLACEHOLDER}/file`);
    expect(windows).toContain(REPOSITORY_PLACEHOLDER);

    const posix = new Redactor({
      environment: {},
      homeDirectory: '/home/private/',
      repositoryRoot: '/srv/repo/',
    }).redact(
      '/srv/repo /srv/repo/file /srv/repository /home/private/file',
    ).text;
    expect(posix).toBe(
      `${REPOSITORY_PLACEHOLDER} ${REPOSITORY_PLACEHOLDER}/file /srv/repository ${HOME_PLACEHOLDER}/file`,
    );
  });

  it('fails closed for invalid UTF-8, redactor failure, and input bounds', () => {
    const root = temporaryDirectory();
    const config = validateCollectorConfig({
      captureClasses: ['stdout'],
      inputLimitBytes: 4,
      spoolRoot: root,
    });
    expect(
      captureText('stdout', Uint8Array.from([0xff]), config, new Redactor()),
    ).toMatchObject({
      capture: { state: 'unavailable', reason: 'collection-failed' },
    });
    expect(
      captureText('stdout', Buffer.from('12345'), config, new Redactor()),
    ).toMatchObject({ diagnosticCode: 'capture-bound-reached' });
    const broken = {
      redact: () => {
        throw new Error('unsafe details');
      },
    } as unknown as Redactor;
    expect(captureText('stdout', Buffer.from('safe'), config, broken)).toEqual({
      capture: { state: 'unavailable', reason: 'collection-failed' },
      diagnosticCode: 'collection-failed',
    });
  });

  it('bounds excerpts after redaction', () => {
    const config = validateCollectorConfig({
      captureClasses: ['stdout'],
      inputLimitBytes: 10_000,
      spoolRoot: temporaryDirectory(),
    });
    const result = captureText(
      'stdout',
      Buffer.from('x'.repeat(5_000)),
      config,
      new Redactor({ environment: {} }),
    );
    expect(result.capture).toMatchObject({
      state: 'captured',
      truncated: true,
    });
    if (result.capture.state === 'captured')
      expect(result.capture.excerpt).toHaveLength(4_096);
  });
});
