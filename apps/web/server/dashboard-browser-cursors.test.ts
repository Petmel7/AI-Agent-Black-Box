import { describe, expect, it } from 'vitest';

import {
  assertDashboardBrowserSnapshot,
  DashboardBrowserCursorError,
  decodeDashboardBrowserCursor,
  encodeDashboardBrowserCursor,
  type DashboardBrowserCursorScope,
} from './dashboard-browser-cursors';

const key = Buffer.alloc(32, 7);
const base: DashboardBrowserCursorScope = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  repositoryId: '22222222-2222-4222-8222-222222222222',
  canonicalRunId: '33333333-3333-4333-8333-333333333333',
  collection: 'files',
};
const snapshot = 'a'.repeat(64);

describe('dashboard browser child cursors', () => {
  it.each([
    'commands',
    'tools',
    'tests',
    'gitSnapshots',
    'gitDiffs',
    'errors',
    'usage',
    'files',
    'findings',
    'summaryClaims',
    'summarySupports',
  ] as const)(
    'round-trips authenticated %s pagination without exposing the legacy position',
    (collection) => {
      const scoped = {
        ...base,
        collection,
        ...(collection === 'summarySupports'
          ? { qualifier: 'c'.repeat(64) }
          : {}),
      };
      const cursor = encodeDashboardBrowserCursor(
        key,
        scoped,
        snapshot,
        'legacy_position',
      );
      expect(decodeDashboardBrowserCursor(key, scoped, cursor)).toEqual({
        snapshot,
        position: 'legacy_position',
      });
      expect(cursor).not.toContain('legacy_position');
      expect(cursor).not.toContain(base.organizationId);
    },
  );

  it('replays exactly and distinguishes the terminal no-cursor state', () => {
    const first = encodeDashboardBrowserCursor(key, base, snapshot, 'position');
    const replay = encodeDashboardBrowserCursor(
      key,
      base,
      snapshot,
      'position',
    );
    expect(replay).toBe(first);
    expect(first).toBeTruthy();
    expect(null).toBeNull();
  });

  it.each([
    [{ ...base, collection: 'findings' as const }, key],
    [{ ...base, repositoryId: '44444444-4444-4444-8444-444444444444' }, key],
    [{ ...base, canonicalRunId: '55555555-5555-4555-8555-555555555555' }, key],
    [{ ...base, organizationId: '66666666-6666-4666-8666-666666666666' }, key],
    [base, Buffer.alloc(32, 8)],
  ])(
    'rejects collection, run, tenant scope, and key rotation',
    (scope, readKey) => {
      const cursor = encodeDashboardBrowserCursor(
        key,
        base,
        snapshot,
        'position',
      );
      expect(() =>
        decodeDashboardBrowserCursor(readKey, scope, cursor),
      ).toThrow(DashboardBrowserCursorError);
    },
  );

  it('rejects mutation and malformed or oversized nested positions', () => {
    const cursor = encodeDashboardBrowserCursor(
      key,
      base,
      snapshot,
      'position',
    );
    expect(() =>
      decodeDashboardBrowserCursor(
        key,
        base,
        `${cursor.slice(0, -1)}${cursor.endsWith('A') ? 'B' : 'A'}`,
      ),
    ).toThrow(DashboardBrowserCursorError);
    expect(() =>
      encodeDashboardBrowserCursor(key, base, snapshot, 'x'.repeat(769)),
    ).toThrow(DashboardBrowserCursorError);
  });

  it('fails visibly when the underlying projection snapshot is replaced', () => {
    expect(() =>
      assertDashboardBrowserSnapshot(snapshot, 'b'.repeat(64)),
    ).toThrow(expect.objectContaining({ code: 'stale_cursor' }));
    expect(() =>
      assertDashboardBrowserSnapshot(undefined, snapshot),
    ).not.toThrow();
  });

  it('binds summary support continuations to the exact claim as well as run', () => {
    const scoped = {
      ...base,
      collection: 'summarySupports' as const,
      qualifier: 'c'.repeat(64),
    };
    const cursor = encodeDashboardBrowserCursor(
      key,
      scoped,
      snapshot,
      'position',
    );
    expect(() =>
      decodeDashboardBrowserCursor(
        key,
        { ...scoped, qualifier: 'd'.repeat(64) },
        cursor,
      ),
    ).toThrow(DashboardBrowserCursorError);
  });
});
