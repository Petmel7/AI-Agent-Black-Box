import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readlinkSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

import type { GitSnapshotPhase } from '@blackbox/contracts';

import { CollectorError } from './errors.js';

export const GIT_COMMAND_TIMEOUT_MS = 5_000;
export const GIT_CAPTURE_TIMEOUT_MS = 10_000;
export const GIT_MAX_OUTPUT_BYTES = 8_000_000;
export const GIT_MAX_ENTRIES = 10_000;
export const GIT_MAX_ENTRY_BYTES = 1_000_000;
export const GIT_MAX_PATH_BYTES = 32_768;
export const GIT_MAX_ARTIFACT_BYTES = 20_000_000;
export const GIT_MAX_CAPTURED_CONTENT_BYTES = 4_000_000;

export type GitAttribution =
  'pre-existing' | 'observed-during-run' | 'mixed-or-uncertain' | 'unavailable';

export interface GitEntry {
  readonly displayPath: string;
  readonly displayAmbiguous?: boolean;
  readonly displayReason?: 'redaction-collision';
  readonly entryId: string;
  readonly indexStatus: string;
  readonly kind: 'ordinary' | 'rename-or-copy' | 'unmerged' | 'untracked';
  readonly modeHead?: string;
  readonly modeIndex?: string;
  readonly modeWorktree?: string;
  readonly objectHead?: string;
  readonly objectIndex?: string;
  readonly objectBase?: string;
  readonly objectOurs?: string;
  readonly objectTheirs?: string;
  readonly originalDisplayPath?: string;
  readonly originalPath?: string;
  readonly path: string;
  readonly submodule: string;
  readonly worktreeStatus: string;
  readonly fingerprint: string;
  readonly unavailableReason?: string;
  readonly untrackedText?: string;
  readonly binary?: boolean;
  readonly capturedByteLength?: number;
}

interface GitHeadEntry {
  readonly displayAmbiguous?: boolean;
  readonly displayPath: string;
  readonly displayReason?: 'redaction-collision';
  readonly entryId: string;
  readonly mode: string;
  readonly objectId: string;
  readonly path: string;
  readonly type: 'blob' | 'commit';
}

interface GitHeadDeltaEntry {
  readonly originalPath?: string;
  readonly path: string;
  readonly status: 'A' | 'D' | 'M' | 'R' | 'T';
}

interface GitHeadDelta {
  readonly entries: readonly GitHeadDeltaEntry[];
  readonly patch: string;
}

export interface GitSnapshot {
  readonly snapshotId: string;
  readonly phase: GitSnapshotPhase;
  readonly headCommit?: string;
  readonly headState: 'attached' | 'detached' | 'unborn';
  readonly headEntries: readonly GitHeadEntry[];
  readonly branch?: string;
  readonly entries: readonly GitEntry[];
  readonly stagedPatch: string;
  readonly unstagedPatch: string;
  readonly root: string;
  readonly repositoryIdentity: string;
  readonly statusBytes: Uint8Array;
  readonly stagedFileCount: number;
  readonly unstagedFileCount: number;
  readonly untrackedFileCount: number;
}

export interface GitComparison {
  readonly comparisonBytes: Uint8Array;
  readonly diffId: string;
  readonly fileListBytes: Uint8Array;
  readonly filesChanged: number;
}

export interface GitCommandInvocation {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly maxBuffer: number;
  readonly shell: false;
  readonly timeout: number;
}

type GitExecutor = (
  invocation: GitCommandInvocation,
) => SpawnSyncReturns<Buffer>;
export interface GitReaderOptions {
  afterInitialState?(attempt: number): void;
  execute?: GitExecutor;
}
type HeadState = {
  branch?: string;
  commit?: string;
  state: 'attached' | 'detached' | 'unborn';
};
type ObservedState = {
  head: HeadState;
  repositoryIdentity: string;
  status: Buffer;
};
type CompleteObservation = ObservedState & {
  entries: readonly GitEntry[];
  headEntries: readonly Omit<GitHeadEntry, 'displayPath'>[];
  stagedPatch: string;
  unstagedPatch: string;
};

const decoder = new TextDecoder('utf-8', { fatal: true });

function fail(): never {
  throw new CollectorError('collection-failed', 'local Git observation failed');
}

function decode(bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes);
  } catch {
    return fail();
  }
}

function decodeLine(bytes: Uint8Array): string {
  const text = decode(bytes);
  const value = text.endsWith('\r\n')
    ? text.slice(0, -2)
    : text.endsWith('\n')
      ? text.slice(0, -1)
      : text;
  if (!value || /[\0\r\n]/u.test(value)) return fail();
  return value;
}

function safeRelativePath(value: string): string {
  if (
    value.length === 0 ||
    Buffer.byteLength(value) > GIT_MAX_PATH_BYTES ||
    value.includes('\0') ||
    isAbsolute(value) ||
    /^[A-Za-z]:[\\/]/u.test(value)
  )
    return fail();
  const normalized = value.replace(/\/$/u, '');
  if (normalized.split('/').some((part) => part === '..' || part === ''))
    return fail();
  return normalized;
}

function takeFields(record: string, count: number): [string[], string] {
  const fields: string[] = [];
  let offset = 0;
  for (let index = 0; index < count; index += 1) {
    const next = record.indexOf(' ', offset);
    if (next < 0) return fail();
    fields.push(record.slice(offset, next));
    offset = next + 1;
  }
  return [fields, record.slice(offset)];
}

function opaquePath(path: string): string {
  return createHash('sha256').update(path, 'utf8').digest('hex');
}

function validMode(value: string | undefined): value is string {
  return typeof value === 'string' && /^[0-7]{6}$/u.test(value);
}

function validObjectId(value: string | undefined): value is string {
  return (
    typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value)
  );
}

function validStatus(value: string | undefined): value is string {
  return typeof value === 'string' && /^[.MADRCUT]{2}$/u.test(value);
}

function validSubmodule(value: string | undefined): value is string {
  return (
    typeof value === 'string' && /^(?:N\.\.\.|S[.C][.M][.U])$/u.test(value)
  );
}

export function parsePorcelainV2(
  input: Uint8Array,
): Omit<GitEntry, 'fingerprint'>[] {
  if (input.byteLength > GIT_MAX_OUTPUT_BYTES) return fail();
  const records = decode(input).split('\0');
  if (records.at(-1) === '') records.pop();
  const entries: Omit<GitEntry, 'fingerprint'>[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.startsWith('# ')) continue;
    let path: string;
    let entry: Omit<GitEntry, 'fingerprint'>;
    if (record.startsWith('? ')) {
      path = safeRelativePath(record.slice(2));
      entry = {
        displayPath: path,
        entryId: opaquePath(path),
        indexStatus: '?',
        kind: 'untracked',
        path,
        submodule: 'N...',
        worktreeStatus: '?',
      };
    } else if (record.startsWith('1 ')) {
      const [fields, rest] = takeFields(record, 8);
      path = safeRelativePath(rest);
      const xy = fields[1]!;
      if (
        fields[0] !== '1' ||
        !validStatus(xy) ||
        !validSubmodule(fields[2]) ||
        !validMode(fields[3]) ||
        !validMode(fields[4]) ||
        !validMode(fields[5]) ||
        !validObjectId(fields[6]) ||
        !validObjectId(fields[7])
      )
        return fail();
      entry = {
        displayPath: path,
        entryId: opaquePath(path),
        indexStatus: xy[0]!,
        kind: 'ordinary',
        modeHead: fields[3]!,
        modeIndex: fields[4]!,
        modeWorktree: fields[5]!,
        objectHead: fields[6]!,
        objectIndex: fields[7]!,
        path,
        submodule: fields[2]!,
        worktreeStatus: xy[1]!,
      };
    } else if (record.startsWith('2 ')) {
      const [fields, rest] = takeFields(record, 9);
      path = safeRelativePath(rest);
      const original = records[++index];
      if (original === undefined) return fail();
      const originalPath = safeRelativePath(original);
      const xy = fields[1]!;
      if (
        fields[0] !== '2' ||
        !validStatus(xy) ||
        !validSubmodule(fields[2]) ||
        !validMode(fields[3]) ||
        !validMode(fields[4]) ||
        !validMode(fields[5]) ||
        !validObjectId(fields[6]) ||
        !validObjectId(fields[7]) ||
        !/^[RC][0-9]{1,3}$/u.test(fields[8] ?? '')
      )
        return fail();
      entry = {
        displayPath: path,
        entryId: opaquePath(path),
        indexStatus: xy[0]!,
        kind: 'rename-or-copy',
        modeHead: fields[3]!,
        modeIndex: fields[4]!,
        modeWorktree: fields[5]!,
        objectHead: fields[6]!,
        objectIndex: fields[7]!,
        originalDisplayPath: originalPath,
        originalPath,
        path,
        submodule: fields[2]!,
        worktreeStatus: xy[1]!,
      };
    } else if (record.startsWith('u ')) {
      const [fields, rest] = takeFields(record, 10);
      path = safeRelativePath(rest);
      const xy = fields[1]!;
      if (
        fields[0] !== 'u' ||
        !/^(?:DD|AU|UD|UA|DU|AA|UU)$/u.test(xy) ||
        !validSubmodule(fields[2]) ||
        !validMode(fields[3]) ||
        !validMode(fields[4]) ||
        !validMode(fields[5]) ||
        !validMode(fields[6]) ||
        !validObjectId(fields[7]) ||
        !validObjectId(fields[8]) ||
        !validObjectId(fields[9])
      )
        return fail();
      entry = {
        displayPath: path,
        entryId: opaquePath(path),
        indexStatus: xy[0]!,
        kind: 'unmerged',
        modeHead: fields[3]!,
        modeIndex: fields[4]!,
        modeWorktree: fields[6]!,
        objectBase: fields[7]!,
        objectOurs: fields[8]!,
        objectTheirs: fields[9]!,
        path,
        submodule: fields[2]!,
        worktreeStatus: xy[1]!,
      };
    } else return fail();
    entries.push(entry);
    if (entries.length > GIT_MAX_ENTRIES) return fail();
  }
  if (new Set(entries.map((entry) => entry.path)).size !== entries.length)
    return fail();
  return entries.sort((left, right) =>
    Buffer.from(left.path).compare(Buffer.from(right.path)),
  );
}

function parseHeadTree(input: Uint8Array): Omit<GitHeadEntry, 'displayPath'>[] {
  if (input.byteLength > GIT_MAX_OUTPUT_BYTES) return fail();
  const records = decode(input).split('\0');
  if (records.at(-1) === '') records.pop();
  const entries = records.map((record) => {
    const tab = record.indexOf('\t');
    if (tab < 0) return fail();
    const metadata = record.slice(0, tab).split(' ');
    const path = safeRelativePath(record.slice(tab + 1));
    if (
      metadata.length !== 3 ||
      !validMode(metadata[0]) ||
      !['blob', 'commit'].includes(metadata[1] ?? '') ||
      !validObjectId(metadata[2])
    )
      return fail();
    return {
      entryId: opaquePath(path),
      mode: metadata[0],
      objectId: metadata[2],
      path,
      type: metadata[1] as 'blob' | 'commit',
    };
  });
  if (
    entries.length > GIT_MAX_ENTRIES ||
    new Set(entries.map((entry) => entry.path)).size !== entries.length
  )
    return fail();
  return entries.sort((left, right) =>
    Buffer.from(left.path).compare(Buffer.from(right.path)),
  );
}

function parseHeadDelta(input: Uint8Array): GitHeadDeltaEntry[] {
  if (input.byteLength > GIT_MAX_OUTPUT_BYTES) return fail();
  const fields = decode(input).split('\0');
  if (fields.at(-1) === '') fields.pop();
  const entries: GitHeadDeltaEntry[] = [];
  for (let index = 0; index < fields.length;) {
    const rawStatus = fields[index++];
    if (!rawStatus) return fail();
    if (/^R[0-9]{1,3}$/u.test(rawStatus)) {
      const originalPath = fields[index++];
      const path = fields[index++];
      if (originalPath === undefined || path === undefined) return fail();
      entries.push({
        originalPath: safeRelativePath(originalPath),
        path: safeRelativePath(path),
        status: 'R',
      });
    } else {
      if (!/^[ADMT]$/u.test(rawStatus)) return fail();
      const path = fields[index++];
      if (path === undefined) return fail();
      entries.push({
        path: safeRelativePath(path),
        status: rawStatus as 'A' | 'D' | 'M' | 'T',
      });
    }
    if (entries.length > GIT_MAX_ENTRIES) return fail();
  }
  const identities = entries.map((entry) =>
    entry.originalPath ? `${entry.originalPath}\0${entry.path}` : entry.path,
  );
  if (new Set(identities).size !== identities.length) return fail();
  return entries.sort((left, right) =>
    Buffer.from(`${left.path}\0${left.originalPath ?? ''}`).compare(
      Buffer.from(`${right.path}\0${right.originalPath ?? ''}`),
    ),
  );
}

function defaultExecutor(
  invocation: GitCommandInvocation,
): SpawnSyncReturns<Buffer> {
  return spawnSync('git', [...invocation.args], {
    cwd: invocation.cwd,
    encoding: 'buffer',
    env: invocation.env,
    maxBuffer: invocation.maxBuffer,
    shell: invocation.shell,
    timeout: invocation.timeout,
    windowsHide: true,
  });
}

const HARDENING_ARGS = [
  '--no-pager',
  '--no-optional-locks',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.quotePath=false',
  '-c',
  'color.ui=false',
  '-c',
  'diff.external=',
] as const;
const MAX_DISABLED_FILTER_SETTINGS = 256;

function canonicalPath(path: string): string {
  const value = realpathSync.native(resolve(path)).replace(/[\\/]+$/u, '');
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function stableJson(value: unknown): Uint8Array {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  if (bytes.byteLength > GIT_MAX_ARTIFACT_BYTES) return fail();
  return bytes;
}

function observationDigest(observation: CompleteObservation): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        head: observation.head,
        repositoryIdentity: observation.repositoryIdentity,
        status: observation.status.toString('base64'),
        stagedPatch: observation.stagedPatch,
        unstagedPatch: observation.unstagedPatch,
        entries: observation.entries,
        headEntries: observation.headEntries,
      }),
    )
    .digest('hex');
}

function fingerprintEntry(
  root: string,
  entry: Omit<GitEntry, 'fingerprint'>,
  remainingContentBytes: number,
  deadline: number,
): GitEntry {
  if (performance.now() >= deadline) return fail();
  const hash = createHash('sha256');
  hash.update(
    JSON.stringify({
      indexStatus: entry.indexStatus,
      worktreeStatus: entry.worktreeStatus,
      submodule: entry.submodule,
      modeHead: entry.modeHead,
      modeIndex: entry.modeIndex,
      modeWorktree: entry.modeWorktree,
      objectHead: entry.objectHead,
      objectIndex: entry.objectIndex,
      objectBase: entry.objectBase,
      objectOurs: entry.objectOurs,
      objectTheirs: entry.objectTheirs,
      originalPath: entry.originalPath,
    }),
  );
  if (entry.worktreeStatus === 'D')
    return { ...entry, fingerprint: hash.update('deleted').digest('hex') };
  const absolute = resolve(root, ...entry.path.split('/'));
  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (absolute !== root && !absolute.startsWith(rootPrefix)) return fail();
  try {
    const stat = lstatSync(absolute, { throwIfNoEntry: false });
    if (!stat)
      return { ...entry, fingerprint: hash.update('absent').digest('hex') };
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(absolute, 'utf8');
      const verified = lstatSync(absolute);
      if (
        !verified.isSymbolicLink() ||
        verified.dev !== stat.dev ||
        verified.ino !== stat.ino ||
        verified.mtimeMs !== stat.mtimeMs ||
        verified.ctimeMs !== stat.ctimeMs
      )
        return {
          ...entry,
          fingerprint: hash.update('changed-link').digest('hex'),
          unavailableReason: 'read-race',
        };
      if (
        Buffer.byteLength(target) > GIT_MAX_ENTRY_BYTES ||
        Buffer.byteLength(target) > remainingContentBytes
      )
        return {
          ...entry,
          fingerprint: hash.update('oversized-link').digest('hex'),
          unavailableReason: 'entry-size-limit',
        };
      hash.update('symlink').update(target);
      return {
        ...entry,
        capturedByteLength: Buffer.byteLength(target),
        fingerprint: hash.digest('hex'),
      };
    }
    if (!stat.isFile())
      return {
        ...entry,
        fingerprint: hash.update('metadata-only').digest('hex'),
        unavailableReason: 'unsupported-file-type',
      };
    if (stat.size > GIT_MAX_ENTRY_BYTES || stat.size > remainingContentBytes)
      return {
        ...entry,
        fingerprint: hash.update(`oversized:${stat.size}`).digest('hex'),
        unavailableReason: 'entry-size-limit',
      };
    const descriptor = openSync(
      absolute,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    let bytes: Buffer;
    try {
      const opened = fstatSync(descriptor);
      if (
        !opened.isFile() ||
        opened.dev !== stat.dev ||
        opened.ino !== stat.ino ||
        opened.size > GIT_MAX_ENTRY_BYTES ||
        opened.size > remainingContentBytes
      )
        return {
          ...entry,
          fingerprint: hash.update(`unsafe:${opened.size}`).digest('hex'),
          unavailableReason: 'entry-size-limit',
        };
      bytes = Buffer.alloc(opened.size);
      let offset = 0;
      while (offset < bytes.byteLength) {
        if (performance.now() >= deadline) return fail();
        const count = readSync(
          descriptor,
          bytes,
          offset,
          Math.min(64 * 1024, bytes.byteLength - offset),
          offset,
        );
        if (count === 0)
          return {
            ...entry,
            fingerprint: hash.update('short-read').digest('hex'),
            unavailableReason: 'read-failed',
          };
        offset += count;
      }
      const verified = fstatSync(descriptor);
      if (
        verified.size !== opened.size ||
        verified.mtimeMs !== opened.mtimeMs ||
        verified.ctimeMs !== opened.ctimeMs ||
        verified.dev !== opened.dev ||
        verified.ino !== opened.ino
      )
        return {
          ...entry,
          fingerprint: hash.update('changed-during-read').digest('hex'),
          unavailableReason: 'read-race',
        };
    } finally {
      closeSync(descriptor);
    }
    hash.update(bytes);
    if (bytes.includes(0))
      return {
        ...entry,
        binary: true,
        capturedByteLength: bytes.byteLength,
        fingerprint: hash.digest('hex'),
      };
    try {
      const text = decoder.decode(bytes);
      return {
        ...entry,
        capturedByteLength: bytes.byteLength,
        fingerprint: hash.digest('hex'),
        ...(entry.kind === 'untracked' ? { untrackedText: text } : {}),
      };
    } catch {
      return {
        ...entry,
        binary: true,
        capturedByteLength: bytes.byteLength,
        fingerprint: hash.digest('hex'),
      };
    }
  } catch {
    return {
      ...entry,
      fingerprint: hash.update('unavailable').digest('hex'),
      unavailableReason: 'read-failed',
    };
  }
}

function publicEntry(entry: GitEntry) {
  return {
    entryId: entry.entryId,
    path: entry.displayPath,
    ...(entry.originalDisplayPath
      ? { originalPath: entry.originalDisplayPath }
      : {}),
    kind: entry.kind,
    indexStatus: entry.indexStatus,
    worktreeStatus: entry.worktreeStatus,
    submodule: entry.submodule,
    ...(entry.modeHead ? { modeHead: entry.modeHead } : {}),
    ...(entry.modeIndex ? { modeIndex: entry.modeIndex } : {}),
    ...(entry.modeWorktree ? { modeWorktree: entry.modeWorktree } : {}),
    ...(entry.binary ? { binary: true } : {}),
    ...(entry.unavailableReason
      ? { unavailableReason: entry.unavailableReason }
      : {}),
    ...(entry.displayAmbiguous ? { displayAmbiguous: true } : {}),
    ...(entry.displayReason ? { displayReason: entry.displayReason } : {}),
  };
}

export class GitReader {
  readonly root: string;
  readonly #execute: GitExecutor;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #hooks: Pick<GitReaderOptions, 'afterInitialState'>;
  #filterOverrides: string[] = [];
  #gitCommonDirectory = '';

  private constructor(
    root: string,
    execute: GitExecutor,
    hooks: Pick<GitReaderOptions, 'afterInitialState'> = {},
  ) {
    this.root = root;
    this.#execute = execute;
    this.#hooks = hooks;
    const environment = { ...process.env };
    for (const name of Object.keys(environment))
      if (name.toUpperCase().startsWith('GIT_')) delete environment[name];
    this.#environment = {
      ...environment,
      GIT_ASKPASS: '',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_EXTERNAL_DIFF: '',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_PAGER: 'cat',
      GIT_TERMINAL_PROMPT: '0',
      LANG: 'C',
      LC_ALL: 'C',
      PAGER: 'cat',
    };
  }

  static open(
    initialCwd: string,
    configuredRoot?: string,
    options: GitReaderOptions = {},
  ): GitReader {
    try {
      const deadline = performance.now() + GIT_CAPTURE_TIMEOUT_MS;
      const execute = options.execute ?? defaultExecutor;
      const probe = new GitReader(resolve(initialCwd), execute);
      const bare = decodeLine(
        probe.#run(['rev-parse', '--is-bare-repository'], deadline),
      );
      if (bare !== 'false') return fail();
      const discovered = decodeLine(
        probe.#run(['rev-parse', '--show-toplevel'], deadline),
      );
      const root = canonicalPath(discovered);
      if (configuredRoot && root !== canonicalPath(configuredRoot))
        return fail();
      const reader = new GitReader(
        realpathSync.native(discovered),
        execute,
        options,
      );
      const commonDirectory = decodeLine(
        reader.#run(['rev-parse', '--git-common-dir'], deadline),
      );
      reader.#gitCommonDirectory = realpathSync.native(
        resolve(reader.root, commonDirectory),
      );
      reader.#disableConfiguredFilters(deadline);
      return reader;
    } catch (cause) {
      if (cause instanceof CollectorError) throw cause;
      return fail();
    }
  }

  #run(args: readonly string[], deadline = Number.POSITIVE_INFINITY): Buffer {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) return fail();
    const result = this.#execute({
      args: [...HARDENING_ARGS, ...this.#filterOverrides, ...args],
      cwd: this.root,
      env: this.#environment,
      maxBuffer: GIT_MAX_OUTPUT_BYTES,
      shell: false,
      timeout: Math.min(GIT_COMMAND_TIMEOUT_MS, remaining),
    });
    if (
      result.error ||
      result.signal ||
      result.status !== 0 ||
      !Buffer.isBuffer(result.stdout)
    )
      return fail();
    if (result.stdout.byteLength > GIT_MAX_OUTPUT_BYTES) return fail();
    return result.stdout;
  }

  #disableConfiguredFilters(deadline: number): void {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) return fail();
    const result = this.#execute({
      args: [
        ...HARDENING_ARGS,
        'config',
        '-z',
        '--name-only',
        '--get-regexp',
        '^filter\\..*\\.(clean|smudge|process)$',
      ],
      cwd: this.root,
      env: this.#environment,
      maxBuffer: 64_000,
      shell: false,
      timeout: Math.min(GIT_COMMAND_TIMEOUT_MS, remaining),
    });
    if (
      result.error ||
      result.signal ||
      (result.status !== 0 && result.status !== 1) ||
      !Buffer.isBuffer(result.stdout)
    )
      return fail();
    if (result.status === 1) return;
    const names = decode(result.stdout).split('\0').filter(Boolean);
    if (names.length > MAX_DISABLED_FILTER_SETTINGS) return fail();
    const drivers = new Set<string>();
    for (const name of names) {
      const normalizedName = name.toLowerCase();
      if (
        name.length > 1024 ||
        !normalizedName.startsWith('filter.') ||
        !/\.(?:clean|process|smudge)$/u.test(normalizedName) ||
        /[=\s\0]/u.test(name)
      )
        return fail();
      this.#filterOverrides.push('-c', `${name}=`);
      drivers.add(name.slice(0, name.lastIndexOf('.')));
    }
    for (const driver of drivers)
      this.#filterOverrides.push('-c', `${driver}.required=false`);
  }

  #text(args: readonly string[], deadline?: number): string {
    return decode(this.#run(args, deadline));
  }

  #head(deadline = Number.POSITIVE_INFINITY): HeadState {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) return fail();
    const commitResult = this.#execute({
      args: [
        ...HARDENING_ARGS,
        ...this.#filterOverrides,
        'rev-parse',
        '--verify',
        'HEAD',
      ],
      cwd: this.root,
      env: this.#environment,
      maxBuffer: 256,
      shell: false,
      timeout: Math.min(GIT_COMMAND_TIMEOUT_MS, remaining),
    });
    if (
      commitResult.error ||
      commitResult.signal ||
      commitResult.status === null
    )
      return fail();
    if (commitResult.status === 0 && Buffer.isBuffer(commitResult.stdout)) {
      const commit = decodeLine(commitResult.stdout);
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commit)) return fail();
      const branchRemaining = Math.floor(deadline - performance.now());
      if (branchRemaining <= 0) return fail();
      const branchResult = this.#execute({
        args: [
          ...HARDENING_ARGS,
          ...this.#filterOverrides,
          'symbolic-ref',
          '--quiet',
          '--short',
          'HEAD',
        ],
        cwd: this.root,
        env: this.#environment,
        maxBuffer: 4096,
        shell: false,
        timeout: Math.min(GIT_COMMAND_TIMEOUT_MS, branchRemaining),
      });
      if (
        branchResult.error ||
        branchResult.signal ||
        branchResult.status === null
      )
        return fail();
      if (
        !branchResult.error &&
        !branchResult.signal &&
        branchResult.status === 0 &&
        Buffer.isBuffer(branchResult.stdout)
      )
        return {
          branch: decodeLine(branchResult.stdout),
          commit,
          state: 'attached',
        };
      if (branchResult.status === 1) return { commit, state: 'detached' };
      return fail();
    }
    if (commitResult.status !== 128) return fail();
    const symbolicRemaining = Math.floor(deadline - performance.now());
    if (symbolicRemaining <= 0) return fail();
    const symbolic = this.#execute({
      args: [
        ...HARDENING_ARGS,
        ...this.#filterOverrides,
        'symbolic-ref',
        '--quiet',
        '--short',
        'HEAD',
      ],
      cwd: this.root,
      env: this.#environment,
      maxBuffer: 4096,
      shell: false,
      timeout: Math.min(GIT_COMMAND_TIMEOUT_MS, symbolicRemaining),
    });
    if (symbolic.error || symbolic.signal || symbolic.status === null)
      return fail();
    if (
      !symbolic.error &&
      !symbolic.signal &&
      symbolic.status === 0 &&
      Buffer.isBuffer(symbolic.stdout)
    )
      return { branch: decodeLine(symbolic.stdout), state: 'unborn' };
    return fail();
  }

  #repositoryIdentity(): string {
    try {
      const stat = statSync(this.#gitCommonDirectory);
      if (!stat.isDirectory()) return fail();
      return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
    } catch {
      return fail();
    }
  }

  #state(deadline: number): ObservedState {
    const head = this.#head(deadline);
    const status = this.#run(
      [
        'status',
        '--porcelain=v2',
        '-z',
        '--untracked-files=all',
        '--ignore-submodules=none',
        '--',
      ],
      deadline,
    );
    return { head, repositoryIdentity: this.#repositoryIdentity(), status };
  }

  #headTree(head: HeadState, deadline: number) {
    if (!head.commit) return [];
    return parseHeadTree(
      this.#run(
        ['ls-tree', '-r', '-z', '--full-tree', head.commit, '--'],
        deadline,
      ),
    );
  }

  #completeObservation(deadline: number): CompleteObservation {
    const state = this.#state(deadline);
    const headEntries = this.#headTree(state.head, deadline);
    const stagedPatch = this.#text(
      [
        'diff',
        '--cached',
        '--binary',
        '--full-index',
        '--no-color',
        '--no-ext-diff',
        '--no-textconv',
        '--',
      ],
      deadline,
    );
    const unstagedPatch = this.#text(
      [
        'diff',
        '--binary',
        '--full-index',
        '--no-color',
        '--no-ext-diff',
        '--no-textconv',
        '--',
      ],
      deadline,
    );
    let remainingContentBytes = GIT_MAX_CAPTURED_CONTENT_BYTES;
    const entries = parsePorcelainV2(state.status).map((entry) => {
      const result = fingerprintEntry(
        this.root,
        entry,
        remainingContentBytes,
        deadline,
      );
      remainingContentBytes -= result.capturedByteLength ?? 0;
      return result;
    });
    return { ...state, entries, headEntries, stagedPatch, unstagedPatch };
  }

  capture(
    phase: GitSnapshotPhase,
    redactDisplay: (value: string) => string = (value) => value,
  ): GitSnapshot {
    const deadline = performance.now() + GIT_CAPTURE_TIMEOUT_MS;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const first = this.#completeObservation(deadline);
      try {
        this.#hooks.afterInitialState?.(attempt);
      } catch {
        return fail();
      }
      if (performance.now() >= deadline) return fail();
      const second = this.#completeObservation(deadline);
      if (observationDigest(first) !== observationDigest(second)) continue;
      const redactedEntries = second.entries.map((entry) => ({
        ...entry,
        displayPath: redactDisplay(entry.path),
        ...(entry.originalPath
          ? { originalDisplayPath: redactDisplay(entry.originalPath) }
          : {}),
      }));
      const snapshotId = randomUUID();
      const collisions = new Map<string, number>();
      for (const entry of redactedEntries)
        collisions.set(
          entry.displayPath,
          (collisions.get(entry.displayPath) ?? 0) + 1,
        );
      const publicEntries = redactedEntries.map((entry) => ({
        ...entry,
        ...(collisions.get(entry.displayPath)! > 1
          ? {
              displayAmbiguous: true,
              displayReason: 'redaction-collision' as const,
            }
          : {}),
      }));
      const redactedHeadEntries = second.headEntries.map((entry) => ({
        ...entry,
        displayPath: redactDisplay(entry.path),
      }));
      const headCollisions = new Map<string, number>();
      for (const entry of redactedHeadEntries)
        headCollisions.set(
          entry.displayPath,
          (headCollisions.get(entry.displayPath) ?? 0) + 1,
        );
      const publicHeadEntries = redactedHeadEntries.map((entry) => ({
        ...entry,
        ...(headCollisions.get(entry.displayPath)! > 1
          ? {
              displayAmbiguous: true,
              displayReason: 'redaction-collision' as const,
            }
          : {}),
      }));
      const statusBytes = stableJson({
        schemaVersion: 1,
        snapshotId,
        phase,
        repository: {
          headState: second.head.state,
          ...(second.head.commit ? { headCommit: second.head.commit } : {}),
          ...(second.head.branch ? { branch: second.head.branch } : {}),
        },
        entries: publicEntries.map(publicEntry),
        headTree: publicHeadEntries.map(
          ({
            displayAmbiguous,
            displayPath,
            displayReason,
            entryId,
            mode,
            objectId,
            type,
          }) => ({
            entryId,
            path: displayPath,
            mode,
            objectId,
            type,
            ...(displayAmbiguous ? { displayAmbiguous: true } : {}),
            ...(displayReason ? { displayReason } : {}),
          }),
        ),
      });
      return {
        snapshotId,
        phase,
        ...(second.head.commit ? { headCommit: second.head.commit } : {}),
        headState: second.head.state,
        headEntries: publicHeadEntries,
        repositoryIdentity: second.repositoryIdentity,
        ...(second.head.branch ? { branch: second.head.branch } : {}),
        entries: publicEntries,
        stagedPatch: second.stagedPatch,
        unstagedPatch: second.unstagedPatch,
        root: this.root,
        statusBytes,
        stagedFileCount: publicEntries.filter(
          (entry) => !['.', '?'].includes(entry.indexStatus),
        ).length,
        unstagedFileCount: publicEntries.filter(
          (entry) => !['.', '?'].includes(entry.worktreeStatus),
        ).length,
        untrackedFileCount: publicEntries.filter(
          (entry) => entry.kind === 'untracked',
        ).length,
      };
    }
    return fail();
  }

  compare(before: GitSnapshot, after: GitSnapshot): GitComparison {
    if (before.root !== this.root || after.root !== this.root) return fail();
    const deadline = performance.now() + GIT_CAPTURE_TIMEOUT_MS;
    if (before.headCommit === after.headCommit)
      return compareSnapshots(before, after, { entries: [], patch: '' });
    const emptyTree = decodeLine(
      this.#run(['hash-object', '-t', 'tree', '--stdin'], deadline),
    );
    if (!validObjectId(emptyTree)) return fail();
    const fromTree = before.headCommit ?? emptyTree;
    const toTree = after.headCommit ?? emptyTree;
    const entries = parseHeadDelta(
      this.#run(
        [
          'diff',
          '--name-status',
          '-z',
          '--find-renames',
          '--no-ext-diff',
          '--no-textconv',
          fromTree,
          toTree,
          '--',
        ],
        deadline,
      ),
    );
    const patch = this.#text(
      [
        'diff',
        '--binary',
        '--full-index',
        '--no-color',
        '--no-ext-diff',
        '--no-textconv',
        fromTree,
        toTree,
        '--',
      ],
      deadline,
    );
    if ((entries.length === 0) !== (patch.length === 0)) return fail();
    return compareSnapshots(before, after, { entries, patch });
  }
}

function headEntryAsGitEntry(entry: GitHeadEntry): GitEntry {
  return {
    displayPath: entry.displayPath,
    ...(entry.displayAmbiguous ? { displayAmbiguous: true } : {}),
    ...(entry.displayReason ? { displayReason: entry.displayReason } : {}),
    entryId: entry.entryId,
    fingerprint: createHash('sha256')
      .update(`${entry.mode}\0${entry.type}\0${entry.objectId}`)
      .digest('hex'),
    indexStatus: '.',
    kind: 'ordinary',
    modeHead: entry.mode,
    modeIndex: entry.mode,
    modeWorktree: entry.mode,
    objectHead: entry.objectId,
    objectIndex: entry.objectId,
    path: entry.path,
    submodule: entry.type === 'commit' ? 'S...' : 'N...',
    worktreeStatus: '.',
  };
}

export function compareSnapshots(
  before: GitSnapshot,
  after: GitSnapshot,
  headDelta?: GitHeadDelta,
): GitComparison {
  if (before.root !== after.root) return fail();
  if (before.headCommit !== after.headCommit && !headDelta) return fail();
  const observedHeadDelta = headDelta ?? { entries: [], patch: '' };
  const beforeByPath = new Map(
    before.entries.map((entry) => [entry.path, entry]),
  );
  const afterByPath = new Map(
    after.entries.map((entry) => [entry.path, entry]),
  );
  const consumedBeforePaths = new Set<string>();
  const transitions: Array<{
    displayPath: string;
    final: GitEntry | undefined;
    initial: GitEntry | undefined;
  }> = [...afterByPath.values()].map((final) => {
    const direct = beforeByPath.get(final.path);
    const renamed = final.originalPath
      ? beforeByPath.get(final.originalPath)
      : undefined;
    const initial = direct ?? renamed;
    if (initial) consumedBeforePaths.add(initial.path);
    return { displayPath: final.path, final, initial };
  });
  for (const initial of beforeByPath.values())
    if (
      !consumedBeforePaths.has(initial.path) &&
      !afterByPath.has(initial.path)
    )
      transitions.push({
        displayPath: initial.path,
        final: undefined,
        initial,
      });
  const beforeHeadByPath = new Map(
    before.headEntries.map((entry) => [entry.path, entry]),
  );
  const afterHeadByPath = new Map(
    after.headEntries.map((entry) => [entry.path, entry]),
  );
  const changedTreePaths = [
    ...new Set([...beforeHeadByPath.keys(), ...afterHeadByPath.keys()]),
  ]
    .filter((path) => {
      const initial = beforeHeadByPath.get(path);
      const final = afterHeadByPath.get(path);
      return (
        initial?.mode !== final?.mode ||
        initial?.objectId !== final?.objectId ||
        initial?.type !== final?.type
      );
    })
    .sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  const describedTreePaths = new Set<string>();
  for (const delta of observedHeadDelta.entries) {
    const initialHead = beforeHeadByPath.get(delta.originalPath ?? delta.path);
    const finalHead = afterHeadByPath.get(delta.path);
    if (
      (delta.status === 'A' && (initialHead || !finalHead)) ||
      (delta.status === 'D' && (!initialHead || finalHead)) ||
      (['M', 'T'].includes(delta.status) && (!initialHead || !finalHead)) ||
      (delta.status === 'R' &&
        (!delta.originalPath ||
          delta.originalPath === delta.path ||
          !initialHead ||
          !finalHead))
    )
      return fail();
    describedTreePaths.add(delta.path);
    if (delta.originalPath) describedTreePaths.add(delta.originalPath);
  }
  if (
    describedTreePaths.size !== changedTreePaths.length ||
    changedTreePaths.some((path) => !describedTreePaths.has(path))
  )
    return fail();
  for (const delta of observedHeadDelta.entries) {
    const involvedPaths = new Set(
      [delta.path, delta.originalPath].filter(Boolean),
    );
    const involved = transitions.filter(({ final, initial }) =>
      [final?.path, initial?.path].some(
        (path) => path !== undefined && involvedPaths.has(path),
      ),
    );
    for (const transition of involved)
      transitions.splice(transitions.indexOf(transition), 1);
    const initialHead = beforeHeadByPath.get(delta.originalPath ?? delta.path);
    const finalHead = afterHeadByPath.get(delta.path);
    const dirtyInitial = involved
      .map((transition) => transition.initial)
      .find((entry) => entry?.path === (delta.originalPath ?? delta.path));
    const dirtyFinal = involved
      .map((transition) => transition.final)
      .find((entry) => entry?.path === delta.path);
    const initial =
      dirtyInitial ??
      (initialHead ? headEntryAsGitEntry(initialHead) : undefined);
    let final =
      dirtyFinal ?? (finalHead ? headEntryAsGitEntry(finalHead) : undefined);
    if (delta.status === 'R' && final && initial) {
      final = {
        ...final,
        kind: 'rename-or-copy',
        originalDisplayPath: initial.displayPath,
        originalPath: initial.path,
      };
    }
    transitions.push({
      displayPath: delta.path,
      initial,
      final,
    });
  }
  transitions.sort((left, right) =>
    Buffer.from(left.displayPath).compare(Buffer.from(right.displayPath)),
  );
  const comparisonDisplayIdentities = new Map<string, Set<string>>();
  for (const transition of transitions)
    for (const endpoint of [transition.initial, transition.final]) {
      if (!endpoint) continue;
      const identities =
        comparisonDisplayIdentities.get(endpoint.displayPath) ?? new Set();
      identities.add(endpoint.entryId);
      comparisonDisplayIdentities.set(endpoint.displayPath, identities);
    }
  const annotateComparisonCollision = <
    Entry extends { readonly displayPath: string; readonly entryId: string },
  >(
    entry: Entry | undefined,
  ) => {
    if (!entry || comparisonDisplayIdentities.get(entry.displayPath)!.size <= 1)
      return entry;
    return {
      ...entry,
      displayAmbiguous: true as const,
      displayReason: 'redaction-collision' as const,
    };
  };
  const comparisonTransitions = transitions.map((transition) => ({
    ...transition,
    initial: annotateComparisonCollision(transition.initial),
    final: annotateComparisonCollision(transition.final),
  }));
  const repositoryIdentityChanged =
    before.repositoryIdentity !== after.repositoryIdentity;
  const repositoryChanged =
    repositoryIdentityChanged ||
    before.headCommit !== after.headCommit ||
    before.headState !== after.headState;
  const files = comparisonTransitions.map(({ final, initial }) => {
    let attribution: GitAttribution;
    let reason: string | undefined;
    if (initial?.unavailableReason || final?.unavailableReason) {
      attribution = 'unavailable';
      reason = initial?.unavailableReason ?? final?.unavailableReason;
    } else if (repositoryChanged) {
      attribution = 'mixed-or-uncertain';
      reason = repositoryIdentityChanged
        ? 'repository-identity-changed'
        : 'repository-head-changed';
    } else if (initial && final && initial.fingerprint === final.fingerprint)
      attribution = 'pre-existing';
    else if (!initial && final) attribution = 'observed-during-run';
    else {
      attribution = 'mixed-or-uncertain';
      reason = 'pre-existing-state-changed';
    }
    const entry = final ?? initial!;
    return {
      entryId: entry.entryId,
      path: entry.displayPath,
      ...(entry.displayAmbiguous ? { displayAmbiguous: true } : {}),
      ...(entry.displayReason ? { displayReason: entry.displayReason } : {}),
      attribution,
      ...(reason ? { reason } : {}),
      before: initial ? publicEntry(initial) : null,
      after: final ? publicEntry(final) : null,
    };
  });
  const diffId = randomUUID();
  const comparisonBytes = stableJson({
    schemaVersion: 1,
    diffId,
    fromSnapshotId: before.snapshotId,
    toSnapshotId: after.snapshotId,
    before: {
      headCommit: before.headCommit ?? null,
      stagedPatch: before.stagedPatch,
      unstagedPatch: before.unstagedPatch,
      untracked: before.entries
        .filter((entry) => entry.kind === 'untracked')
        .map((entry) => ({
          path: entry.displayPath,
          ...(entry.untrackedText === undefined
            ? { metadataOnly: true }
            : { text: entry.untrackedText }),
          ...(entry.binary ? { binary: true } : {}),
        })),
    },
    after: {
      headCommit: after.headCommit ?? null,
      stagedPatch: after.stagedPatch,
      unstagedPatch: after.unstagedPatch,
      untracked: after.entries
        .filter((entry) => entry.kind === 'untracked')
        .map((entry) => ({
          path: entry.displayPath,
          ...(entry.untrackedText === undefined
            ? { metadataOnly: true }
            : { text: entry.untrackedText }),
          ...(entry.binary ? { binary: true } : {}),
        })),
    },
    headDelta: {
      patch: observedHeadDelta.patch,
      files: observedHeadDelta.entries.map((delta) => {
        const initial = annotateComparisonCollision(
          beforeHeadByPath.get(delta.originalPath ?? delta.path),
        );
        const final = annotateComparisonCollision(
          afterHeadByPath.get(delta.path),
        );
        return {
          status: delta.status,
          entryId: (final ?? initial)!.entryId,
          path: final?.displayPath ?? initial!.displayPath,
          ...(delta.originalPath && initial
            ? {
                originalEntryId: initial.entryId,
                originalPath: initial.displayPath,
              }
            : {}),
          ...(final?.displayAmbiguous || initial?.displayAmbiguous
            ? { displayAmbiguous: true }
            : {}),
          ...(final?.displayReason || initial?.displayReason
            ? {
                displayReason: (final?.displayReason ??
                  initial?.displayReason)!,
              }
            : {}),
          before: initial
            ? {
                entryId: initial.entryId,
                mode: initial.mode,
                objectId: initial.objectId,
                path: initial.displayPath,
                type: initial.type,
                ...(initial.displayAmbiguous ? { displayAmbiguous: true } : {}),
                ...(initial.displayReason
                  ? { displayReason: initial.displayReason }
                  : {}),
              }
            : null,
          after: final
            ? {
                entryId: final.entryId,
                mode: final.mode,
                objectId: final.objectId,
                path: final.displayPath,
                type: final.type,
                ...(final.displayAmbiguous ? { displayAmbiguous: true } : {}),
                ...(final.displayReason
                  ? { displayReason: final.displayReason }
                  : {}),
              }
            : null,
        };
      }),
    },
  });
  const fileListBytes = stableJson({
    schemaVersion: 1,
    diffId,
    fromSnapshotId: before.snapshotId,
    toSnapshotId: after.snapshotId,
    attributionIsTemporalNotCausal: true,
    files,
  });
  return { comparisonBytes, diffId, fileListBytes, filesChanged: files.length };
}
