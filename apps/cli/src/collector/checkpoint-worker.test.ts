import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createGitCheckpointWorkerMessage,
  GIT_MAX_ENTRIES,
  GitReader,
  type GitCheckpointWorkerMessage,
} from './git.js';
import {
  captureCodexCheckpoint,
  CollectorSession,
  type CheckpointWorkerFactory,
} from './session.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { force: true, recursive: true });
});

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'bbx-checkpoint-worker-'));
  temporaryDirectories.push(root);
  if (spawnSync('git', ['init', '--quiet'], { cwd: root }).status !== 0)
    throw new Error('Git repository initialization failed');
  return root;
}

function spoolRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'bbx-checkpoint-spool-'));
  temporaryDirectories.push(root);
  return root;
}

function artifactJson(root: string): Record<string, unknown>[] {
  const directory = join(root, 'artifacts');
  return readdirSync(directory)
    .filter((name) => name.endsWith('.artifact'))
    .map(
      (name) =>
        JSON.parse(readFileSync(join(directory, name), 'utf8')) as Record<
          string,
          unknown
        >,
    );
}

function eventKinds(root: string): string[] {
  using database = new DatabaseSync(join(root, 'spool.sqlite3'), {
    readOnly: true,
  });
  return (
    database
      .prepare('SELECT canonical_json FROM events ORDER BY sequence')
      .all() as unknown as { canonical_json: string }[]
  ).map((row) => JSON.parse(row.canonical_json).kind as string);
}

class FakeCheckpointWorker extends EventEmitter {
  terminateCalls = 0;
  readonly #termination: Promise<number>;

  constructor(termination: Promise<number> = Promise.resolve(0)) {
    super();
    this.#termination = termination;
  }

  terminate(): Promise<number> {
    this.terminateCalls += 1;
    return this.#termination;
  }
}

function fakeFactory(
  createMessage: (
    nonce: string,
  ) => GitCheckpointWorkerMessage | Record<string, unknown>,
  inspect?: (worker: FakeCheckpointWorker) => void,
): CheckpointWorkerFactory {
  return (_url, options) => {
    const worker = new FakeCheckpointWorker();
    inspect?.(worker);
    setImmediate(() =>
      worker.emit('message', createMessage(options.workerData.nonce)),
    );
    return worker;
  };
}

describe('checkpoint worker boundary', () => {
  it('preserves redaction collisions in a real worker checkpoint', async () => {
    const root = repository();
    const storage = spoolRoot();
    const first = 'alpha-secret-value';
    const second = 'bravo-secret-value';
    writeFileSync(join(root, `${first}.txt`), 'first\n');
    writeFileSync(join(root, `${second}.txt`), 'second\n');
    const previous = process.cwd();
    process.chdir(root);
    try {
      const session = CollectorSession.open(
        { repositoryRoot: root, spoolRoot: storage },
        { collectorCredentials: [first, second], environment: {} },
      );
      session.observeRunStarted({});
      session.captureGitSnapshot('before');
      await captureCodexCheckpoint(session);
      session.observeRunFinished({ outcome: 'succeeded' });
      session.close();

      const checkpoint = artifactJson(storage).find(
        (artifact) => artifact.phase === 'checkpoint',
      ) as { entries: Array<Record<string, unknown>> } | undefined;
      expect(checkpoint).toBeDefined();
      const collided = checkpoint!.entries.filter(
        (entry) => entry.path === '[REDACTED].txt',
      );
      expect(collided).toHaveLength(2);
      expect(
        collided.every(
          (entry) =>
            entry.displayAmbiguous === true &&
            entry.displayReason === 'redaction-collision',
        ),
      ).toBe(true);
      expect(new Set(collided.map((entry) => entry.entryId)).size).toBe(2);
    } finally {
      process.chdir(previous);
    }
  }, 30_000);

  it('rejects malformed messages and collision metadata inconsistencies before persistence', async () => {
    const root = repository();
    const storage = spoolRoot();
    writeFileSync(join(root, 'one-secret-value.txt'), 'one\n');
    writeFileSync(join(root, 'two-secret-value.txt'), 'two\n');
    const redact = (value: string) =>
      value.replace(/(?:one|two)-secret-value/gu, '[REDACTED]');
    const snapshot = GitReader.open(root).capture('checkpoint', redact);
    const originalMessage = createGitCheckpointWorkerMessage(
      snapshot,
      'replaced',
    );
    const manifest = JSON.parse(
      Buffer.from(originalMessage.statusBytes).toString('utf8'),
    ) as {
      entries: Array<Record<string, unknown>>;
    };
    delete manifest.entries[0]!.displayReason;
    const inconsistent = {
      ...originalMessage,
      statusBytes: Buffer.from(`${JSON.stringify(manifest)}\n`),
    };
    const previous = process.cwd();
    process.chdir(root);
    try {
      const session = CollectorSession.open(
        { repositoryRoot: root, spoolRoot: storage },
        {
          collectorCredentials: ['one-secret-value', 'two-secret-value'],
          environment: {},
        },
      );
      session.observeRunStarted({});
      session.captureGitSnapshot('before');
      await expect(
        captureCodexCheckpoint(
          session,
          fakeFactory((nonce) => ({ ...inconsistent, nonce })),
        ),
      ).rejects.toMatchObject({ code: 'collection-failed' });
      await expect(
        captureCodexCheckpoint(
          session,
          fakeFactory((nonce) => ({
            ...createGitCheckpointWorkerMessage(snapshot, nonce),
            forged: true,
          })),
        ),
      ).rejects.toMatchObject({ code: 'collection-failed' });
      await expect(
        captureCodexCheckpoint(
          session,
          fakeFactory(() => originalMessage),
        ),
      ).rejects.toMatchObject({ code: 'collection-failed' });
      await expect(
        captureCodexCheckpoint(
          session,
          fakeFactory((nonce) => ({
            ...createGitCheckpointWorkerMessage(snapshot, nonce),
            stagedFileCount: GIT_MAX_ENTRIES + 1,
          })),
        ),
      ).rejects.toMatchObject({ code: 'collection-failed' });
      const unredactedManifest = structuredClone(manifest);
      unredactedManifest.entries[0]!.path = 'one-secret-value.txt';
      await expect(
        captureCodexCheckpoint(
          session,
          fakeFactory((nonce) => ({
            ...createGitCheckpointWorkerMessage(snapshot, nonce),
            statusBytes: Buffer.from(`${JSON.stringify(unredactedManifest)}\n`),
          })),
        ),
      ).rejects.toMatchObject({ code: 'collection-failed' });
      session.observeRunFinished({ outcome: 'failed' });
      session.close();

      expect(eventKinds(storage)).toEqual([
        'run.started',
        'git.snapshot.captured',
        'run.finished',
      ]);
    } finally {
      process.chdir(previous);
    }
  }, 30_000);

  it('settles only after termination and cleans listeners across message/error/exit races', async () => {
    const root = repository();
    const storage = spoolRoot();
    const snapshot = GitReader.open(root).capture('checkpoint');
    let releaseTermination!: (code: number) => void;
    const termination = new Promise<number>((resolve) => {
      releaseTermination = resolve;
    });
    let fake!: FakeCheckpointWorker;
    const factory: CheckpointWorkerFactory = (_url, options) => {
      fake = new FakeCheckpointWorker(termination);
      setImmediate(() => {
        fake.emit(
          'message',
          createGitCheckpointWorkerMessage(snapshot, options.workerData.nonce),
        );
        fake.emit('error', new Error('late private worker error'));
        fake.emit('exit', 1);
      });
      return fake;
    };
    const previous = process.cwd();
    process.chdir(root);
    try {
      const session = CollectorSession.open({
        repositoryRoot: root,
        spoolRoot: storage,
      });
      session.observeRunStarted({});
      session.captureGitSnapshot('before');
      let settled = false;
      const capture = captureCodexCheckpoint(session, factory).finally(() => {
        settled = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(fake.terminateCalls).toBe(1);
      expect(fake.listenerCount('message')).toBe(0);
      expect(fake.listenerCount('error')).toBe(1);
      expect(fake.listenerCount('exit')).toBe(0);
      releaseTermination(0);
      await expect(capture).resolves.toBeUndefined();
      expect(fake.listenerCount('message')).toBe(0);
      expect(fake.listenerCount('error')).toBe(0);
      expect(fake.listenerCount('exit')).toBe(0);
      session.observeRunFinished({ outcome: 'succeeded' });
      session.close();
      expect(eventKinds(storage)).toEqual([
        'run.started',
        'git.snapshot.captured',
        'git.snapshot.captured',
        'run.finished',
      ]);
    } finally {
      releaseTermination?.(0);
      process.chdir(previous);
    }
  }, 30_000);

  it('rejects error-before-message races once and removes every worker listener', async () => {
    const root = repository();
    const storage = spoolRoot();
    let fake!: FakeCheckpointWorker;
    const factory: CheckpointWorkerFactory = () => {
      fake = new FakeCheckpointWorker();
      setImmediate(() => {
        fake.emit('error', new Error('private worker failure'));
        fake.emit('message', {});
        fake.emit('exit', 0);
      });
      return fake;
    };
    const previous = process.cwd();
    process.chdir(root);
    try {
      const session = CollectorSession.open({
        repositoryRoot: root,
        spoolRoot: storage,
      });
      session.observeRunStarted({});
      session.captureGitSnapshot('before');
      await expect(
        captureCodexCheckpoint(session, factory),
      ).rejects.toMatchObject({ code: 'collection-failed' });
      expect(fake.terminateCalls).toBe(1);
      expect(fake.listenerCount('message')).toBe(0);
      expect(fake.listenerCount('error')).toBe(0);
      expect(fake.listenerCount('exit')).toBe(0);
      session.observeRunFinished({ outcome: 'failed' });
      session.close();
      expect(eventKinds(storage)).toEqual([
        'run.started',
        'git.snapshot.captured',
        'run.finished',
      ]);
    } finally {
      process.chdir(previous);
    }
  }, 30_000);
});
