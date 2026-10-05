import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { GitFileListV1Schema } from './git-file-list.js';

const fixture = JSON.parse(
  readFileSync(
    new URL('./fixtures/git-file-list-v1.json', import.meta.url),
    'utf8',
  ),
);

describe('GitFileListV1Schema', () => {
  it('accepts the collector-compatible rename, binary, and collision fixture', () => {
    expect(GitFileListV1Schema.parse(fixture)).toEqual(fixture);
  });

  it.each([
    ['pre-existing'],
    ['observed-during-run'],
    ['mixed-or-uncertain'],
    ['unavailable'],
  ])('accepts the %s attribution', (attribution) => {
    const value = structuredClone(fixture);
    value.files[1].attribution = attribution;
    if (attribution === 'unavailable') {
      value.files[1].reason = 'read-failed';
      value.files[1].after.unavailableReason = 'read-failed';
    }
    expect(GitFileListV1Schema.safeParse(value).success).toBe(true);
  });

  it('rejects unknown fields, duplicate identities, invalid ordering, and unsupported versions', () => {
    const unknown = structuredClone(fixture);
    unknown.extra = true;
    expect(GitFileListV1Schema.safeParse(unknown).success).toBe(false);
    const duplicate = structuredClone(fixture);
    duplicate.files[1].entryId = duplicate.files[0].entryId;
    duplicate.files[1].after.entryId = duplicate.files[0].entryId;
    expect(GitFileListV1Schema.safeParse(duplicate).success).toBe(false);
    const unordered = structuredClone(fixture);
    unordered.files.reverse();
    expect(GitFileListV1Schema.safeParse(unordered).success).toBe(false);
    expect(
      GitFileListV1Schema.safeParse({ ...fixture, schemaVersion: 2 }).success,
    ).toBe(false);
  });

  it('uses the collector UTF-8 byte order at Unicode surrogate boundaries', () => {
    const value = structuredClone(fixture);
    const first = structuredClone(value.files[1]);
    const second = structuredClone(value.files[1]);
    first.entryId = 'd'.repeat(64);
    first.path = '\uE000';
    first.after.entryId = first.entryId;
    first.after.path = first.path;
    second.entryId = 'e'.repeat(64);
    second.path = '\u{10000}';
    second.after.entryId = second.entryId;
    second.after.path = second.path;
    value.files = [first, second];
    expect(GitFileListV1Schema.safeParse(value).success).toBe(true);
    value.files.reverse();
    expect(GitFileListV1Schema.safeParse(value).success).toBe(false);
  });

  it('enforces the collector status, submodule, rename, and untracked invariants', () => {
    for (const mutate of [
      (value: typeof fixture) => (value.files[1].after.indexStatus = 'X'),
      (value: typeof fixture) => (value.files[1].after.submodule = 'SXYZ'),
      (value: typeof fixture) => (value.files[1].after.indexStatus = '.'),
      (value: typeof fixture) =>
        (value.files[1].after.originalPath = 'not-a-rename.txt'),
    ]) {
      const value = structuredClone(fixture);
      mutate(value);
      expect(GitFileListV1Schema.safeParse(value).success).toBe(false);
    }
  });

  it.each(['.', 'M', 'A', 'D', 'R', 'C', 'U', 'T'])(
    'accepts collector tracked status %s',
    (status) => {
      const value = structuredClone(fixture);
      value.files[0].before.indexStatus = status;
      expect(GitFileListV1Schema.safeParse(value).success).toBe(true);
    },
  );

  it.each(['N...', 'S...', 'SC..', 'S.M.', 'S..U', 'SCMU'])(
    'accepts collector submodule state %s',
    (submodule) => {
      const value = structuredClone(fixture);
      value.files[0].before.submodule = submodule;
      expect(GitFileListV1Schema.safeParse(value).success).toBe(true);
    },
  );

  it('rejects invalid IDs, endpoint fields, unavailable reasons, and path bounds', () => {
    for (const mutate of [
      (value: typeof fixture) => (value.diffId = 'not-a-uuid'),
      (value: typeof fixture) => (value.files[0].entryId = 'opaque'),
      (value: typeof fixture) => (value.files[0].before.extra = true),
      (value: typeof fixture) => (value.files[1].attribution = 'unavailable'),
      (value: typeof fixture) =>
        (value.files[1].after.unavailableReason = 'secret-path'),
      (value: typeof fixture) => (value.files[1].path = 'x'.repeat(32_769)),
    ]) {
      const value = structuredClone(fixture);
      mutate(value);
      expect(GitFileListV1Schema.safeParse(value).success).toBe(false);
    }
  });
});
