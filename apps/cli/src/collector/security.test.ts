import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runCli } from '../cli.js';
import { validateCollectorConfig } from './config.js';
import { CollectorSession } from './session.js';
import { LocalSpool } from './spool.js';
import * as collectorApi from './index.js';

const roots: string[] = [];
function temporaryRoot(): string {
  const path = mkdtempSync(join(tmpdir(), 'bbx-security-'));
  roots.push(path);
  return join(path, 'spool');
}

afterEach(() => {
  for (const path of roots.splice(0))
    rmSync(path, { recursive: true, force: true });
});

function allFiles(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? allFiles(child) : [child];
  });
}

describe('complete durable-surface sentinel scan', () => {
  it('keeps secrets and private absolute paths out of SQLite, WAL/SHM, files, batches, diagnostics, status, stdout, and stderr', () => {
    const spoolRoot = temporaryRoot();
    const sentinel = ['bbx', randomUUID(), 'sentinel'].join('-');
    const repositoryRoot = join(tmpdir(), `private-repository-${randomUUID()}`);
    const homeDirectory = join(tmpdir(), `private-home-${randomUUID()}`);
    const privatePaths = [
      repositoryRoot,
      `${repositoryRoot}\\file.txt`,
      repositoryRoot.replaceAll('\\', '/').toLowerCase(),
      `${repositoryRoot.replaceAll('\\', '/').toLowerCase()}/nested/file.txt`,
      homeDirectory,
      `${homeDirectory}\\file.txt`,
      homeDirectory.replaceAll('\\', '/').toLowerCase(),
    ];
    const configInput = {
      captureClasses: ['task-description', 'stdout', 'stderr', 'file-content'],
      repositoryRoot,
      spoolRoot,
    } as const;
    const internalConfig = validateCollectorConfig(configInput);
    const temporarySpool = new LocalSpool(
      internalConfig,
      {
        afterArtifactWrite: () => {
          throw new Error('retain redacted temporary file');
        },
      },
      {
        collectorCredentials: [sentinel],
        environment: {},
        homeDirectory,
        repositoryRoot,
      },
    ).open();
    const temporaryHandle = temporarySpool.createRun();
    temporarySpool.captureText(
      temporaryHandle,
      'stdout',
      Buffer.from(`${sentinel} ${repositoryRoot}`),
      { kind: 'command-output' },
    );
    temporarySpool.close();
    const session = CollectorSession.open(configInput, {
      collectorCredentials: [sentinel],
      environment: {},
      homeDirectory,
      repositoryRoot,
    });
    expect(Reflect.ownKeys(session)).toEqual([]);
    session.observeRunStarted({
      taskDescription: Buffer.from(`${sentinel} ${repositoryRoot}`),
    });
    const returnedEvent = session.observeCommandFinished({
      commandId: randomUUID(),
      outcome: 'succeeded',
      stdout: Buffer.from(`${sentinel} ${privatePaths.join(' ')}`),
      stderr: Buffer.from(`${sentinel} ${repositoryRoot}`),
    });
    if (
      returnedEvent.kind === 'command.finished' &&
      returnedEvent.payload.stdout.state === 'captured'
    )
      Object.assign(returnedEvent.payload.stdout, { excerpt: sentinel });
    session.observeGitDiffCaptured({
      diff: Buffer.from(`${sentinel} ${repositoryRoot}`),
      diffId: randomUUID(),
      fileList: Buffer.from(`${sentinel} ${homeDirectory}`),
      fromSnapshotId: randomUUID(),
      toSnapshotId: randomUUID(),
    });
    session.observeRunFinished({ outcome: 'succeeded' });
    const runId = session.runId;
    session.close();
    using spool = new LocalSpool(validateCollectorConfig(configInput)).open();
    spool.createBatch(runId);
    spool.recordDiagnostic('collection-failed');

    const output: string[] = [];
    const errors: string[] = [];
    expect(
      runCli(
        ['status', '--json', '--run', runId],
        {
          output: (value) => output.push(value),
          error: (value) => errors.push(value),
        },
        { env: { BLACKBOX_SPOOL_DIR: spoolRoot } },
      ),
    ).toBe(2);
    const forbidden = [sentinel, ...privatePaths];
    const rendered = [
      ...output,
      ...errors,
      JSON.stringify(spool.status()),
    ].join('\n');
    for (const value of forbidden) expect(rendered).not.toContain(value);
    for (const path of allFiles(spoolRoot)) {
      const bytes = readFileSync(path);
      for (const value of forbidden)
        expect(bytes.includes(Buffer.from(value))).toBe(false);
    }
    expect(existsSync(repositoryRoot)).toBe(false);
    expect('ArtifactStore' in collectorApi).toBe(false);
    expect('captureText' in collectorApi).toBe(false);
    expect('LocalSpool' in collectorApi).toBe(false);
    expect('Redactor' in collectorApi).toBe(false);
    expect(Object.keys(collectorApi).sort()).toEqual([
      'CAPTURE_CLASSES',
      'CollectorError',
      'CollectorSession',
      'CollectorWorkSpool',
      'DEFAULT_CAPTURE_INPUT_BYTES',
      'DEFAULT_SPOOL_QUOTA_BYTES',
      'MAX_CAPTURE_INPUT_BYTES',
      'MAX_LITERAL_BYTES',
      'MAX_LITERAL_RULES',
      'collectorConfigFromEnvironment',
      'composeCollectorFromEnvironment',
      'defaultSpoolRoot',
      'validateCollectorConfig',
    ]);
    expect(
      Object.getOwnPropertyNames(CollectorSession.prototype).sort(),
    ).toEqual([
      'captureText',
      'close',
      'constructor',
      'observeCommandFinished',
      'observeGitDiffCaptured',
      'observeRunFinished',
      'observeRunStarted',
      'runId',
    ]);
    expect(
      Object.getOwnPropertyNames(
        collectorApi.CollectorWorkSpool.prototype,
      ).sort(),
    ).toEqual([
      'acknowledgeArtifactVerification',
      'acknowledgeBatchDelivery',
      'auditArtifacts',
      'bindArtifactUpload',
      'blockArtifact',
      'blockBatch',
      'claimArtifact',
      'claimBatch',
      'close',
      'constructor',
      'prepareBatches',
      'recoverExpired',
      'releaseArtifact',
      'releaseBatch',
      'status',
      'supersedeOversizedBatch',
    ]);
    using workSpool = collectorApi.CollectorWorkSpool.open({ spoolRoot });
    expect(Reflect.ownKeys(workSpool)).toEqual([]);
  });

  it('rejects fake redactors, forged captures, accessors, and prototype-bearing observations', () => {
    const spoolRoot = temporaryRoot();
    const secret = `secret-${randomUUID()}`;
    expect(() =>
      CollectorSession.open(
        { captureClasses: ['stdout'], spoolRoot },
        Object.assign(Object.create({ redact: () => ({ text: secret }) }), {
          environment: {},
        }),
      ),
    ).toThrow();
    using session = CollectorSession.open(
      { captureClasses: ['stdout'], spoolRoot },
      { collectorCredentials: [secret], environment: {} },
    );
    const mutable = Buffer.from('safe mutable bytes');
    const prepared = session.captureText('stdout', mutable);
    expect(Object.isFrozen(prepared)).toBe(true);
    if (prepared.state === 'captured') {
      expect(Object.isFrozen(prepared.redaction)).toBe(true);
      expect(() => Object.assign(prepared, { excerpt: secret })).toThrow();
    }
    mutable.fill(120);
    const forged = {
      state: 'captured',
      excerpt: secret,
      redaction: { applied: true, rulesetVersion: 'collector-redaction-v1' },
    };
    expect(() =>
      session.observeCommandFinished({
        commandId: randomUUID(),
        outcome: 'succeeded',
        stdout: forged as unknown as Uint8Array,
      }),
    ).toThrow();
    const accessor = Object.defineProperty({}, 'stdout', {
      enumerable: true,
      get: () => Buffer.from(secret),
    });
    expect(() => session.observeCommandFinished(accessor as never)).toThrow();
    expect(() =>
      session.observeRunFinished(
        Object.assign(Object.create({ secret }), { outcome: 'succeeded' }),
      ),
    ).toThrow();
    for (const path of allFiles(spoolRoot))
      expect(readFileSync(path).includes(Buffer.from(secret))).toBe(false);
  });
});
