import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { EvidenceBatchSchema } from '@blackbox/contracts';

import {
  compareSnapshots,
  GIT_MAX_OUTPUT_BYTES,
  GitReader,
  parsePorcelainV2,
} from './git.js';
import { CollectorWorkSpool } from './delivery.js';
import { CollectorSession } from './session.js';

const roots: string[] = [];

vi.setConfig({ testTimeout: 30_000 });

function allFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? allFiles(path) : [path];
  });
}

function repositoryDigest(root: string): string {
  const hash = createHash('sha256');
  for (const path of allFiles(root).sort())
    hash.update(relative(root, path)).update('\0').update(readFileSync(path));
  return hash.digest('hex');
}

function temporaryRepository(commit = true): string {
  const root = mkdtempSync(join(tmpdir(), 'bbx-git-'));
  roots.push(root);
  git(root, 'init', '--quiet');
  git(root, 'config', 'user.email', 'collector@example.invalid');
  git(root, 'config', 'user.name', 'Collector Test');
  if (commit) {
    writeFileSync(join(root, 'tracked.txt'), 'initial\n');
    git(root, 'add', '--', 'tracked.txt');
    git(root, 'commit', '--quiet', '-m', 'initial');
  }
  return root;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { force: true, recursive: true });
});

describe('collector-owned Git reader', () => {
  it('parses, sorts, and preserves porcelain status dimensions', () => {
    const parsed = parsePorcelainV2(
      Buffer.from(
        '? z.txt\0' +
          '1 M. N... 100644 100755 100755 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb a file.txt\0' +
          '2 R. N... 100644 100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb R100 renamed.txt\0old.txt\0',
      ),
    );
    expect(parsed.map((entry) => entry.path)).toEqual([
      'a file.txt',
      'renamed.txt',
      'z.txt',
    ]);
    expect(parsed[0]).toMatchObject({
      indexStatus: 'M',
      modeHead: '100644',
      modeIndex: '100755',
      worktreeStatus: '.',
    });
    expect(parsed[1]).toMatchObject({
      kind: 'rename-or-copy',
      originalPath: 'old.txt',
    });
    expect(() => parsePorcelainV2(Buffer.from('? ../escape\0'))).toThrow(
      /Git observation failed/,
    );
    expect(() =>
      parsePorcelainV2(Buffer.alloc(GIT_MAX_OUTPUT_BYTES + 1)),
    ).toThrow(/Git observation failed/);
    expect(() => parsePorcelainV2(Buffer.from([63, 32, 255, 0]))).toThrow(
      /Git observation failed/,
    );
  });

  it('supports unborn, attached, and detached heads without repository mutation', () => {
    const unborn = temporaryRepository(false);
    const unbornSnapshot = GitReader.open(unborn).capture('checkpoint');
    expect(unbornSnapshot.headState).toBe('unborn');
    expect(unbornSnapshot.headCommit).toBeUndefined();

    const attached = temporaryRepository();
    const firstHead = git(attached, 'rev-parse', 'HEAD').trim();
    const beforeCapture = repositoryDigest(attached);
    const attachedSnapshot = GitReader.open(attached).capture('before');
    expect(attachedSnapshot).toMatchObject({
      headCommit: firstHead,
      headState: 'attached',
    });
    const repeatedSnapshot = GitReader.open(attached).capture('before');
    const firstManifest = JSON.parse(
      Buffer.from(attachedSnapshot.statusBytes).toString('utf8'),
    ) as Record<string, unknown>;
    const repeatedManifest = JSON.parse(
      Buffer.from(repeatedSnapshot.statusBytes).toString('utf8'),
    ) as Record<string, unknown>;
    delete firstManifest.snapshotId;
    delete repeatedManifest.snapshotId;
    expect(repeatedManifest).toEqual(firstManifest);
    expect(repositoryDigest(attached)).toBe(beforeCapture);
    git(attached, 'checkout', '--quiet', '--detach');
    const detachedSnapshot = GitReader.open(attached).capture('after');
    expect(detachedSnapshot.headState).toBe('detached');
    expect(git(attached, 'rev-parse', 'HEAD').trim()).toBe(firstHead);
  }, 25_000);

  it('classifies pre-existing, observed, and mixed changes conservatively', () => {
    const root = temporaryRepository();
    writeFileSync(join(root, 'tracked.txt'), 'dirty before\n');
    writeFileSync(join(root, 'pre-existing.txt'), 'same\n');
    const reader = GitReader.open(root);
    const before = reader.capture('before');
    writeFileSync(join(root, 'tracked.txt'), 'changed again\n');
    writeFileSync(join(root, 'during.txt'), 'new\n');
    const after = reader.capture('after');
    const comparison = compareSnapshots(before, after);
    const fileList = JSON.parse(
      Buffer.from(comparison.fileListBytes).toString('utf8'),
    ) as {
      files: { attribution: string; path: string }[];
    };
    expect(fileList.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attribution: 'pre-existing',
          path: 'pre-existing.txt',
        }),
        expect.objectContaining({
          attribution: 'mixed-or-uncertain',
          path: 'tracked.txt',
        }),
        expect.objectContaining({
          attribution: 'observed-during-run',
          path: 'during.txt',
        }),
      ]),
    );
    expect(comparison.filesChanged).toBe(3);
  });

  it('records clean-to-clean HEAD changes as bounded conservative evidence', () => {
    const root = temporaryRepository();
    const reader = GitReader.open(root);
    const before = reader.capture('before');
    writeFileSync(join(root, 'tracked.txt'), 'committed during run\n');
    writeFileSync(join(root, 'committed.txt'), 'new committed file\n');
    git(root, 'add', '--', 'tracked.txt', 'committed.txt');
    git(root, 'commit', '--quiet', '-m', 'observed commit');
    const after = reader.capture('after');
    expect(after.entries).toEqual([]);

    const comparison = reader.compare(before, after);
    const fileList = JSON.parse(
      Buffer.from(comparison.fileListBytes).toString('utf8'),
    ) as {
      files: { attribution: string; path: string; reason?: string }[];
    };
    const evidence = JSON.parse(
      Buffer.from(comparison.comparisonBytes).toString('utf8'),
    ) as { headDelta: { files: unknown[]; patch: string } };
    expect(comparison.filesChanged).toBe(2);
    expect(fileList.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attribution: 'mixed-or-uncertain',
          path: 'committed.txt',
          reason: 'repository-head-changed',
        }),
        expect.objectContaining({
          attribution: 'mixed-or-uncertain',
          path: 'tracked.txt',
          reason: 'repository-head-changed',
        }),
      ]),
    );
    expect(evidence.headDelta.files).toHaveLength(2);
    expect(evidence.headDelta.patch).toContain('committed during run');
  });

  it('compares the empty tree with the complete final history for unborn-to-HEAD', () => {
    const root = temporaryRepository(false);
    const reader = GitReader.open(root);
    const before = reader.capture('before');
    writeFileSync(join(root, 'first.txt'), 'first version\n');
    git(root, 'add', '--', 'first.txt');
    git(root, 'commit', '--quiet', '-m', 'first commit');
    writeFileSync(join(root, 'first.txt'), 'final version\n');
    writeFileSync(join(root, 'second.txt'), 'second file\n');
    git(root, 'add', '--', 'first.txt', 'second.txt');
    git(root, 'commit', '--quiet', '-m', 'second commit');
    const after = reader.capture('after');
    const beforeComparison = repositoryDigest(root);
    const comparison = reader.compare(before, after);
    expect(repositoryDigest(root)).toBe(beforeComparison);
    const evidence = JSON.parse(
      Buffer.from(comparison.comparisonBytes).toString('utf8'),
    ) as {
      headDelta: {
        files: { path: string; status: string }[];
        patch: string;
      };
    };
    expect(comparison.filesChanged).toBe(2);
    expect(evidence.headDelta.files).toEqual([
      expect.objectContaining({ path: 'first.txt', status: 'A' }),
      expect.objectContaining({ path: 'second.txt', status: 'A' }),
    ]);
    expect(evidence.headDelta.patch).toContain('+final version');
    expect(evidence.headDelta.patch).toContain('+second file');
    expect(evidence.headDelta.patch).not.toContain('+first version');
  });

  it('derives the non-writing empty tree for SHA-256 repositories', () => {
    const root = mkdtempSync(join(tmpdir(), 'bbx-git-sha256-'));
    roots.push(root);
    git(root, 'init', '--quiet', '--object-format=sha256');
    git(root, 'config', 'user.email', 'collector@example.invalid');
    git(root, 'config', 'user.name', 'Collector Test');
    const reader = GitReader.open(root);
    const before = reader.capture('before');
    writeFileSync(join(root, 'sha256.txt'), 'sha256 content\n');
    git(root, 'add', '--', 'sha256.txt');
    git(root, 'commit', '--quiet', '-m', 'sha256 commit');
    const after = reader.capture('after');
    const beforeComparison = repositoryDigest(root);
    const comparison = reader.compare(before, after);
    expect(repositoryDigest(root)).toBe(beforeComparison);
    expect(after.headCommit).toMatch(/^[a-f0-9]{64}$/u);
    expect(comparison.filesChanged).toBe(1);
    expect(Buffer.from(comparison.comparisonBytes).toString('utf8')).toContain(
      '+sha256 content',
    );
  });

  it('compares HEAD to the empty tree without a misleading empty patch', () => {
    const root = temporaryRepository();
    const reader = GitReader.open(root);
    const before = reader.capture('before');
    git(root, 'update-ref', '-d', 'HEAD');
    const after = reader.capture('after');
    expect(after.headState).toBe('unborn');
    const comparison = reader.compare(before, after);
    const evidence = JSON.parse(
      Buffer.from(comparison.comparisonBytes).toString('utf8'),
    ) as {
      headDelta: {
        files: { path: string; status: string }[];
        patch: string;
      };
    };
    expect(comparison.filesChanged).toBe(1);
    expect(evidence.headDelta.files).toEqual([
      expect.objectContaining({ path: 'tracked.txt', status: 'D' }),
    ]);
    expect(evidence.headDelta.patch).toContain('-initial');
  });

  it('propagates committed HEAD-path redaction collisions with stable identities', () => {
    const root = temporaryRepository();
    writeFileSync(join(root, 'secret-one.txt'), 'one\n');
    writeFileSync(join(root, 'secret-two.txt'), 'two\n');
    git(root, 'add', '--', 'secret-one.txt', 'secret-two.txt');
    git(root, 'commit', '--quiet', '-m', 'colliding paths');
    const redact = (value: string) =>
      value.startsWith('secret-') ? '[REDACTED]' : value;
    const reader = GitReader.open(root);
    const before = reader.capture('before', redact);
    writeFileSync(join(root, 'secret-one.txt'), 'one changed\n');
    writeFileSync(join(root, 'secret-two.txt'), 'two changed\n');
    git(root, 'add', '--', 'secret-one.txt', 'secret-two.txt');
    git(root, 'commit', '--quiet', '-m', 'change colliding paths');
    const after = reader.capture('after', redact);
    const status = JSON.parse(
      Buffer.from(after.statusBytes).toString('utf8'),
    ) as {
      headTree: {
        displayAmbiguous?: boolean;
        displayReason?: string;
        entryId: string;
        path: string;
      }[];
    };
    const comparison = reader.compare(before, after);
    const evidence = JSON.parse(
      Buffer.from(comparison.comparisonBytes).toString('utf8'),
    ) as {
      headDelta: {
        files: {
          displayAmbiguous?: boolean;
          displayReason?: string;
          entryId: string;
          path: string;
        }[];
      };
    };
    const fileList = JSON.parse(
      Buffer.from(comparison.fileListBytes).toString('utf8'),
    ) as {
      files: {
        after: { displayAmbiguous?: boolean; displayReason?: string };
        entryId: string;
        path: string;
      }[];
    };
    const statusCollisions = status.headTree.filter(
      (entry) => entry.path === '[REDACTED]',
    );
    expect(statusCollisions).toHaveLength(2);
    expect(statusCollisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          displayAmbiguous: true,
          displayReason: 'redaction-collision',
        }),
      ]),
    );
    expect(new Set(statusCollisions.map((entry) => entry.entryId)).size).toBe(
      2,
    );
    expect(evidence.headDelta.files).toHaveLength(2);
    expect(
      evidence.headDelta.files.every(
        (entry) =>
          entry.path === '[REDACTED]' &&
          entry.displayAmbiguous === true &&
          entry.displayReason === 'redaction-collision',
      ),
    ).toBe(true);
    expect(fileList.files).toHaveLength(2);
    expect(
      fileList.files.every(
        (entry) =>
          entry.path === '[REDACTED]' &&
          entry.after.displayAmbiguous === true &&
          entry.after.displayReason === 'redaction-collision',
      ),
    ).toBe(true);
    expect(new Set(fileList.files.map((entry) => entry.entryId)).size).toBe(2);
  });

  it('detects cross-snapshot rename collisions without marking same-identity modifications', () => {
    const root = temporaryRepository();
    for (const [path, content] of [
      ['alpha-before.secret', 'alpha\n'],
      ['beta-before.secret', 'beta\n'],
      ['same.secret', 'same\n'],
    ] as const)
      writeFileSync(join(root, path), content);
    git(
      root,
      'add',
      '--',
      'alpha-before.secret',
      'beta-before.secret',
      'same.secret',
    );
    git(root, 'commit', '--quiet', '-m', 'secret paths');
    const redact = (value: string) => {
      if (value.startsWith('alpha-')) return '[ALPHA]';
      if (value.startsWith('beta-')) return '[BETA]';
      if (value === 'same.secret') return '[SAME]';
      return value;
    };
    const reader = GitReader.open(root);
    const before = reader.capture('before', redact);
    git(root, 'mv', '--', 'alpha-before.secret', 'alpha-after.secret');
    git(root, 'mv', '--', 'beta-before.secret', 'beta-after.secret');
    writeFileSync(join(root, 'same.secret'), 'same changed\n');
    git(root, 'add', '--', 'same.secret');
    git(root, 'commit', '--quiet', '-m', 'rename and modify secret paths');
    const after = reader.capture('after', redact);
    const beforeStatus = Buffer.from(before.statusBytes);
    const afterStatus = Buffer.from(after.statusBytes);
    expect(
      [...before.headEntries, ...after.headEntries]
        .filter((entry) =>
          ['[ALPHA]', '[BETA]', '[SAME]'].includes(entry.displayPath),
        )
        .some((entry) => entry.displayAmbiguous),
    ).toBe(false);

    const comparison = reader.compare(before, after);
    expect(Buffer.from(before.statusBytes)).toEqual(beforeStatus);
    expect(Buffer.from(after.statusBytes)).toEqual(afterStatus);
    const evidence = JSON.parse(
      Buffer.from(comparison.comparisonBytes).toString('utf8'),
    ) as {
      headDelta: {
        files: {
          after: { displayAmbiguous?: boolean; entryId: string };
          before: { displayAmbiguous?: boolean; entryId: string };
          displayAmbiguous?: boolean;
          displayReason?: string;
          path: string;
        }[];
      };
    };
    const fileList = JSON.parse(
      Buffer.from(comparison.fileListBytes).toString('utf8'),
    ) as {
      files: {
        after: { displayAmbiguous?: boolean; entryId: string };
        before: { displayAmbiguous?: boolean; entryId: string };
        displayAmbiguous?: boolean;
        displayReason?: string;
        path: string;
      }[];
    };
    expect(evidence.headDelta.files.map((entry) => entry.path)).toEqual([
      '[ALPHA]',
      '[BETA]',
      '[SAME]',
    ]);
    expect(fileList.files.map((entry) => entry.path)).toEqual([
      '[ALPHA]',
      '[BETA]',
      '[SAME]',
    ]);
    for (const entries of [evidence.headDelta.files, fileList.files]) {
      for (const entry of entries.slice(0, 2)) {
        expect(entry).toMatchObject({
          displayAmbiguous: true,
          displayReason: 'redaction-collision',
          before: { displayAmbiguous: true },
          after: { displayAmbiguous: true },
        });
        expect(entry.before.entryId).not.toBe(entry.after.entryId);
      }
      expect(entries[2]).not.toHaveProperty('displayAmbiguous');
      expect(entries[2]?.before).not.toHaveProperty('displayAmbiguous');
      expect(entries[2]?.after).not.toHaveProperty('displayAmbiguous');
      expect(entries[2]?.before.entryId).toBe(entries[2]?.after.entryId);
    }
    const pathMetadata = JSON.stringify({
      headDelta: evidence.headDelta.files,
      files: fileList.files,
    });
    for (const rawPath of [
      'alpha-before.secret',
      'alpha-after.secret',
      'beta-before.secret',
      'beta-after.secret',
      'same.secret',
    ])
      expect(pathMetadata).not.toContain(rawPath);
  });

  it('represents a clean committed rename as one identity-linked transition', () => {
    const root = temporaryRepository();
    const reader = GitReader.open(root);
    const before = reader.capture('before');
    git(root, 'mv', '--', 'tracked.txt', 'renamed.txt');
    git(root, 'commit', '--quiet', '-m', 'rename tracked file');
    const after = reader.capture('after');
    const comparison = reader.compare(before, after);
    const evidence = JSON.parse(
      Buffer.from(comparison.comparisonBytes).toString('utf8'),
    ) as {
      headDelta: {
        files: {
          entryId: string;
          originalEntryId: string;
          originalPath: string;
          path: string;
          status: string;
        }[];
      };
    };
    const fileList = JSON.parse(
      Buffer.from(comparison.fileListBytes).toString('utf8'),
    ) as {
      files: {
        after: { originalPath?: string; path: string };
        before: { path: string };
        path: string;
      }[];
    };
    expect(comparison.filesChanged).toBe(1);
    expect(evidence.headDelta.files).toEqual([
      expect.objectContaining({
        originalPath: 'tracked.txt',
        path: 'renamed.txt',
        status: 'R',
      }),
    ]);
    expect(evidence.headDelta.files[0]?.entryId).not.toBe(
      evidence.headDelta.files[0]?.originalEntryId,
    );
    expect(fileList.files).toEqual([
      expect.objectContaining({
        path: 'renamed.txt',
        before: expect.objectContaining({ path: 'tracked.txt' }),
        after: expect.objectContaining({
          originalPath: 'tracked.txt',
          path: 'renamed.txt',
        }),
      }),
    ]);
  });

  it('merges a committed rename with final dirty state without duplicates', () => {
    const root = temporaryRepository();
    writeFileSync(join(root, 'pre-existing.txt'), 'dirty before\n');
    const reader = GitReader.open(root);
    const before = reader.capture('before');
    git(root, 'mv', '--', 'tracked.txt', 'renamed.txt');
    git(root, 'commit', '--quiet', '-am', 'rename tracked file');
    writeFileSync(join(root, 'renamed.txt'), 'dirty after rename\n');
    const after = reader.capture('after');
    const comparison = reader.compare(before, after);
    const fileList = JSON.parse(
      Buffer.from(comparison.fileListBytes).toString('utf8'),
    ) as {
      files: {
        attribution: string;
        before: { path: string } | null;
        path: string;
      }[];
    };
    expect(comparison.filesChanged).toBe(2);
    expect(fileList.files.map((entry) => entry.path)).toEqual([
      'pre-existing.txt',
      'renamed.txt',
    ]);
    expect(fileList.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attribution: 'mixed-or-uncertain',
          path: 'pre-existing.txt',
        }),
        expect.objectContaining({
          attribution: 'mixed-or-uncertain',
          before: expect.objectContaining({ path: 'tracked.txt' }),
          path: 'renamed.txt',
        }),
      ]),
    );
  });

  it('detects dirty content changes even when porcelain status is unchanged', () => {
    const root = temporaryRepository();
    writeFileSync(join(root, 'tracked.txt'), 'dirty initial\n');
    const reader = GitReader.open(root, undefined, {
      afterInitialState: (attempt) => {
        writeFileSync(
          join(root, 'tracked.txt'),
          attempt === 0 ? 'dirty second\n' : 'dirty third\n',
        );
      },
    });
    expect(() => reader.capture('checkpoint')).toThrow(
      /Git observation failed/,
    );
  });

  it('keeps NUL-containing untracked files as binary metadata only', () => {
    const root = temporaryRepository();
    writeFileSync(
      join(root, 'nul-untracked.bin'),
      Buffer.from([0x61, 0x00, 0x62, 0x0a]),
    );
    const reader = GitReader.open(root);
    const before = reader.capture('before');
    const after = reader.capture('after');
    const entry = after.entries.find(
      (candidate) => candidate.path === 'nul-untracked.bin',
    );
    expect(entry).toMatchObject({ binary: true, capturedByteLength: 4 });
    expect(entry?.untrackedText).toBeUndefined();
    const evidence = JSON.parse(
      Buffer.from(reader.compare(before, after).comparisonBytes).toString(
        'utf8',
      ),
    ) as {
      after: { untracked: Record<string, unknown>[] };
    };
    expect(evidence.after.untracked).toContainEqual(
      expect.objectContaining({
        binary: true,
        metadataOnly: true,
        path: 'nul-untracked.bin',
      }),
    );
  });

  it('preserves staged, unstaged, rename, delete, binary, mode, and leading-dash metadata', () => {
    const root = temporaryRepository();
    writeFileSync(join(root, 'delete.txt'), 'delete me\n');
    writeFileSync(join(root, 'rename.txt'), 'rename me\n');
    writeFileSync(join(root, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
    git(root, 'add', '--', 'delete.txt', 'rename.txt', 'binary.bin');
    git(root, 'commit', '--quiet', '-m', 'fixtures');
    writeFileSync(join(root, 'tracked.txt'), 'staged\n');
    git(root, 'add', '--', 'tracked.txt');
    writeFileSync(join(root, 'tracked.txt'), 'staged and unstaged\n');
    git(root, 'mv', '--', 'rename.txt', 'renamed.txt');
    rmSync(join(root, 'delete.txt'));
    writeFileSync(join(root, 'binary.bin'), Buffer.from([0, 9, 8, 7]));
    writeFileSync(join(root, '--leading-dash.txt'), 'safe\n');
    const snapshot = GitReader.open(root).capture('checkpoint');
    expect(snapshot.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '--leading-dash.txt',
          kind: 'untracked',
        }),
        expect.objectContaining({ path: 'delete.txt', worktreeStatus: 'D' }),
        expect.objectContaining({
          path: 'renamed.txt',
          kind: 'rename-or-copy',
          originalPath: 'rename.txt',
        }),
        expect.objectContaining({
          path: 'tracked.txt',
          indexStatus: 'M',
          worktreeStatus: 'M',
        }),
      ]),
    );
    expect(snapshot.stagedPatch).toContain('renamed.txt');
    expect(snapshot.unstagedPatch).toContain('delete.txt');
    expect(snapshot.unstagedPatch).toContain('GIT binary patch');
  }, 15_000);

  it('rejects non-repositories, bare repositories, root mismatches, and failed Git execution', () => {
    const outside = mkdtempSync(join(tmpdir(), 'bbx-not-git-'));
    roots.push(outside);
    expect(() => GitReader.open(outside)).toThrow(/Git observation failed/);
    const root = temporaryRepository();
    expect(() => GitReader.open(root, outside)).toThrow(
      /Git observation failed/,
    );
    const bare = mkdtempSync(join(tmpdir(), 'bbx-bare-'));
    roots.push(bare);
    git(bare, 'init', '--quiet', '--bare');
    expect(() => GitReader.open(bare)).toThrow(/Git observation failed/);
    const invocations: Array<{
      args: readonly string[];
      shell: false;
      timeout: number;
    }> = [];
    expect(() =>
      GitReader.open(root, undefined, {
        execute: (invocation) => {
          invocations.push(invocation);
          return {
            error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
            output: [],
            pid: 0,
            signal: null,
            status: null,
            stderr: Buffer.alloc(0),
            stdout: Buffer.alloc(0),
          };
        },
      }),
    ).toThrow(/Git observation failed/);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toMatchObject({ shell: false });
    expect(invocations[0]!.timeout).toBeGreaterThan(0);
    expect(invocations[0]!.timeout).toBeLessThanOrEqual(5_000);
    expect(invocations[0]!.args).toEqual(
      expect.arrayContaining(['--no-pager', '--no-optional-locks']),
    );
  });

  it('supports repository and file paths containing spaces', () => {
    const parent = mkdtempSync(join(tmpdir(), 'bbx-git-spaces-'));
    roots.push(parent);
    const root = join(parent, 'repository with spaces');
    mkdirSync(root);
    git(root, 'init', '--quiet');
    writeFileSync(join(root, 'file with spaces.txt'), 'spaces\n');
    expect(GitReader.open(root).capture('checkpoint').entries).toEqual([
      expect.objectContaining({ path: 'file with spaces.txt' }),
    ]);
  });

  it('records a symlink as link metadata without following its target when supported', () => {
    const root = temporaryRepository();
    const outside = join(root, '..', `outside-${Date.now()}.txt`);
    writeFileSync(outside, 'must not be captured\n');
    try {
      symlinkSync(outside, join(root, 'link.txt'), 'file');
    } catch {
      rmSync(outside, { force: true });
      return;
    }
    try {
      const entry = GitReader.open(root)
        .capture('checkpoint')
        .entries.find((item) => item.path === 'link.txt');
      expect(entry).toMatchObject({ kind: 'untracked' });
      expect(entry?.untrackedText).toBeUndefined();
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it('discovers and captures a linked worktree as its own canonical root', () => {
    const root = temporaryRepository();
    const linked = mkdtempSync(join(tmpdir(), 'bbx-linked-parent-'));
    roots.push(linked);
    rmSync(linked, { recursive: true, force: true });
    git(root, 'worktree', 'add', '--quiet', '--detach', linked);
    writeFileSync(join(linked, 'linked.txt'), 'linked\n');
    const reader = GitReader.open(join(linked, '.'));
    expect(reader.capture('checkpoint').entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'linked.txt', kind: 'untracked' }),
      ]),
    );
    git(root, 'worktree', 'remove', '--force', linked);
  }, 15_000);

  it('represents nested repositories and submodule gitlinks without recursion', () => {
    const parent = temporaryRepository();
    const nested = join(parent, 'nested');
    git(parent, 'init', '--quiet', nested);
    writeFileSync(join(nested, 'private.txt'), 'nested\n');
    const nestedSnapshot = GitReader.open(parent).capture('checkpoint');
    expect(nestedSnapshot.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'nested',
          unavailableReason: 'unsupported-file-type',
        }),
      ]),
    );
    expect(
      nestedSnapshot.entries.some((entry) =>
        entry.path.includes('private.txt'),
      ),
    ).toBe(false);

    rmSync(nested, { recursive: true, force: true });
    const source = temporaryRepository();
    git(
      parent,
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      '--quiet',
      source,
      'module',
    );
    git(parent, 'commit', '--quiet', '-am', 'submodule');
    writeFileSync(join(parent, 'module', 'tracked.txt'), 'submodule dirty\n');
    const submoduleSnapshot = GitReader.open(parent).capture('checkpoint');
    expect(submoduleSnapshot.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'module',
          unavailableReason: 'unsupported-file-type',
        }),
      ]),
    );
  }, 20_000);

  it('does not execute configured external diff, textconv, pager, or fsmonitor helpers', () => {
    const root = temporaryRepository();
    const marker = join(root, 'helper-ran');
    git(
      root,
      'config',
      'diff.external',
      `node -e "require('fs').writeFileSync('${marker.replaceAll('\\', '\\\\')}','x')"`,
    );
    git(
      root,
      'config',
      'filter.hostile.clean',
      `node -e "require('fs').writeFileSync('${marker.replaceAll('\\', '\\\\')}','x')"`,
    );
    git(
      root,
      'config',
      'diff.hostile.textconv',
      `node -e "require('fs').writeFileSync('${marker.replaceAll('\\', '\\\\')}','x')"`,
    );
    git(root, 'config', 'filter.hostile.required', 'true');
    git(root, 'config', 'core.pager', 'false');
    git(root, 'config', 'core.fsmonitor', 'false-command-that-must-not-run');
    writeFileSync(
      join(root, '.gitattributes'),
      '*.txt filter=hostile diff=hostile\n',
    );
    writeFileSync(join(root, 'tracked.txt'), 'dirty\n');
    expect(() => GitReader.open(root).capture('before')).not.toThrow();
    expect(existsSync(marker)).toBe(false);
  });

  it('retries one bracket race and fails closed when state changes twice', () => {
    const once = temporaryRepository();
    const onceReader = GitReader.open(once, undefined, {
      afterInitialState: (attempt) => {
        if (attempt === 0)
          writeFileSync(join(once, 'tracked.txt'), 'changed\n');
      },
    });
    expect(onceReader.capture('checkpoint').entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'tracked.txt' }),
      ]),
    );

    const continuous = temporaryRepository();
    const continuousReader = GitReader.open(continuous, undefined, {
      afterInitialState: (attempt) => {
        writeFileSync(
          join(continuous, 'tracked.txt'),
          attempt === 0 ? 'changed\n' : 'initial\n',
        );
      },
    });
    expect(() => continuousReader.capture('checkpoint')).toThrow(
      /Git observation failed/,
    );
  }, 15_000);

  it('keeps redacted display collisions distinct and explicitly ambiguous', () => {
    const root = temporaryRepository();
    writeFileSync(join(root, 'secret-one.txt'), 'one\n');
    writeFileSync(join(root, 'secret-two.txt'), 'two\n');
    const snapshot = GitReader.open(root).capture('checkpoint', (value) =>
      value.startsWith('secret-') ? '[REDACTED]' : value,
    );
    const collided = snapshot.entries.filter(
      (entry) => entry.displayPath === '[REDACTED]',
    );
    expect(collided).toHaveLength(2);
    expect(collided.every((entry) => entry.displayAmbiguous)).toBe(true);
    expect(new Set(collided.map((entry) => entry.entryId)).size).toBe(2);
  });

  it('persists linked redacted snapshot and comparison evidence through only the session API', () => {
    const root = temporaryRepository();
    const storage = mkdtempSync(join(tmpdir(), 'bbx-git-spool-'));
    roots.push(storage);
    const spoolRoot = join(storage, 'spool');
    const sentinel = 'bbx-git-secret-sentinel-value';
    const previous = process.cwd();
    process.chdir(root);
    try {
      const session = CollectorSession.open(
        { repositoryRoot: root, spoolRoot },
        {
          collectorCredentials: [sentinel],
          environment: {},
          repositoryRoot: root,
        },
      );
      const runId = session.runId;
      session.observeRunStarted({});
      const checkpoint = session.captureGitSnapshot('checkpoint');
      const before = session.captureGitSnapshot('before');
      writeFileSync(
        join(root, `${sentinel}.txt`),
        `${sentinel}\n${spoolRoot}\n`,
      );
      const after = session.captureGitSnapshot('after');
      const comparison = session.compareGitSnapshots();
      expect(() => session.compareGitSnapshots()).toThrow(
        /comparison is already recorded/,
      );
      session.observeRunFinished({ outcome: 'succeeded' });
      session.close();
      expect([
        checkpoint.kind,
        before.kind,
        after.kind,
        comparison.kind,
      ]).toEqual([
        'git.snapshot.captured',
        'git.snapshot.captured',
        'git.snapshot.captured',
        'git.diff.captured',
      ]);
      const database = new DatabaseSync(join(spoolRoot, 'spool.sqlite3'));
      const events = database
        .prepare('SELECT canonical_json FROM events ORDER BY sequence')
        .all() as { canonical_json: string }[];
      const parsedEvents = events.map(({ canonical_json }) =>
        JSON.parse(canonical_json),
      ) as Array<{
        kind: string;
        payload: Record<string, unknown>;
        source: { component: string };
      }>;
      expect(parsedEvents.map((event) => event.kind)).toEqual([
        'run.started',
        'git.snapshot.captured',
        'git.snapshot.captured',
        'git.snapshot.captured',
        'git.diff.captured',
        'run.finished',
      ]);
      for (const event of parsedEvents.slice(1, 5))
        expect(event.source).toEqual({ component: 'git' });
      for (const event of parsedEvents.slice(1, 4))
        expect(event.payload).toMatchObject({
          isDirty: expect.any(Boolean),
          stagedFileCount: expect.any(Number),
          statusArtifact: expect.objectContaining({ kind: 'git-status' }),
          unstagedFileCount: expect.any(Number),
          untrackedFileCount: expect.any(Number),
        });
      expect(parsedEvents[4]).toMatchObject({
        source: { component: 'git' },
        payload: {
          fromSnapshotId: parsedEvents[2]?.payload.snapshotId,
          toSnapshotId: parsedEvents[3]?.payload.snapshotId,
        },
      });
      expect(
        database.prepare('SELECT COUNT(*) AS count FROM event_artifacts').get(),
      ).toMatchObject({ count: 5 });
      database.close();
      using work = CollectorWorkSpool.open({ spoolRoot });
      expect(work.prepareBatches({ runId })).toEqual({
        batchesCreated: 1,
        eventsBatched: 6,
      });
      const batch = work.claimBatch();
      expect(
        EvidenceBatchSchema.parse(JSON.parse(batch?.body ?? '')).events.map(
          (event) => event.kind,
        ),
      ).toEqual(parsedEvents.map((event) => event.kind));
      expect(batch?.body).not.toContain(sentinel);
      expect(batch?.body).not.toContain(root);
      expect(batch?.body).not.toContain(spoolRoot);
      expect(JSON.stringify(work.status(runId))).not.toContain(sentinel);
      expect(JSON.stringify(work.status(runId))).not.toContain(root);
      expect(JSON.stringify(work.status(runId))).not.toContain(spoolRoot);
      for (const path of allFiles(spoolRoot)) {
        const bytes = readFileSync(path);
        expect(bytes.includes(Buffer.from(sentinel))).toBe(false);
        expect(bytes.includes(Buffer.from(root))).toBe(false);
        expect(bytes.includes(Buffer.from(spoolRoot))).toBe(false);
      }
    } finally {
      process.chdir(previous);
    }
  }, 30_000);

  it('fails Git artifact quota exhaustion without a partial Git event and records a safe diagnostic', () => {
    const root = temporaryRepository();
    for (let index = 0; index < 100; index += 1)
      writeFileSync(join(root, `untracked-${index}.txt`), 'bounded\n');
    const storage = mkdtempSync(join(tmpdir(), 'bbx-git-quota-'));
    roots.push(storage);
    const spoolRoot = join(storage, 'spool');
    const previous = process.cwd();
    process.chdir(root);
    try {
      const session = CollectorSession.open({
        repositoryRoot: root,
        spoolQuotaBytes: 5_000,
        spoolRoot,
      });
      session.observeRunStarted({});
      expect(() => session.captureGitSnapshot('before')).toThrow(
        expect.objectContaining({ code: 'quota-exceeded' }),
      );
      session.observeRunFinished({ outcome: 'failed' });
      session.close();
      const database = new DatabaseSync(join(spoolRoot, 'spool.sqlite3'));
      expect(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM events WHERE json_extract(canonical_json,'$.kind') LIKE 'git.%'",
          )
          .get(),
      ).toMatchObject({ count: 0 });
      expect(
        database
          .prepare("SELECT count FROM diagnostics WHERE code='quota-exceeded'")
          .get(),
      ).toMatchObject({ count: 1 });
      database.close();
    } finally {
      process.chdir(previous);
    }
  }, 20_000);
});
