import 'server-only';

import {
  dashboardCursorScope,
  decodeDashboardCursor,
  encodeDashboardCursor,
} from '@blackbox/database';

const SHA256 = /^[0-9a-f]{64}$/;
const POSITION = /^[A-Za-z0-9_-]{1,768}$/;

export type DashboardBrowserCollection =
  | 'commands'
  | 'tools'
  | 'tests'
  | 'gitSnapshots'
  | 'gitDiffs'
  | 'errors'
  | 'usage'
  | 'files'
  | 'findings'
  | 'summaryClaims'
  | 'summarySupports';

export interface DashboardBrowserCursorScope {
  organizationId: string;
  repositoryId: string;
  canonicalRunId: string;
  collection: DashboardBrowserCollection;
  qualifier?: string;
}

export class DashboardBrowserCursorError extends Error {
  constructor(readonly code: 'invalid_cursor' | 'stale_cursor') {
    super('Dashboard pagination cursor is invalid or stale.');
    this.name = 'DashboardBrowserCursorError';
  }
}

function exactKeys(value: object, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function scope(value: DashboardBrowserCursorScope): string {
  return dashboardCursorScope(
    value.organizationId,
    value.repositoryId,
    value.canonicalRunId,
    value.collection,
    value.qualifier,
  );
}

export function encodeDashboardBrowserCursor(
  key: Uint8Array,
  cursorScope: DashboardBrowserCursorScope,
  snapshot: string,
  position: string,
): string {
  if (!SHA256.test(snapshot) || !POSITION.test(position))
    throw new DashboardBrowserCursorError('invalid_cursor');
  return encodeDashboardCursor(key, {
    version: 1,
    kind: 'dashboard-child',
    scope: scope(cursorScope),
    snapshot,
    position,
  });
}

export function decodeDashboardBrowserCursor(
  key: Uint8Array,
  cursorScope: DashboardBrowserCursorScope,
  value: string,
): { snapshot: string; position: string } {
  try {
    const payload = decodeDashboardCursor(key, value);
    if (
      !exactKeys(payload, [
        'version',
        'kind',
        'scope',
        'snapshot',
        'position',
      ]) ||
      payload.version !== 1 ||
      payload.kind !== 'dashboard-child' ||
      payload.scope !== scope(cursorScope) ||
      typeof payload.snapshot !== 'string' ||
      !SHA256.test(payload.snapshot) ||
      typeof payload.position !== 'string' ||
      !POSITION.test(payload.position)
    )
      throw new Error();
    return { snapshot: payload.snapshot, position: payload.position };
  } catch {
    throw new DashboardBrowserCursorError('invalid_cursor');
  }
}

export function assertDashboardBrowserSnapshot(
  expected: string | undefined,
  actual: string | null,
): void {
  if (expected !== undefined && expected !== actual)
    throw new DashboardBrowserCursorError('stale_cursor');
}
