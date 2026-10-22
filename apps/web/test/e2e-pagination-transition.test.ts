import { describe, expect, it } from 'vitest';

import {
  exclusivePaginationState,
  renderedPageMatchesCursor,
  sanitizedDigest,
  stableItemMarker,
} from './e2e-pagination-transition';

describe('E2E pagination transition evidence', () => {
  it('accepts exactly one rendered next or terminal control', () => {
    expect(exclusivePaginationState(1, 0)).toBe('next');
    expect(exclusivePaginationState(0, 1)).toBe('terminal');
    expect(exclusivePaginationState(0, 0)).toBeNull();
    expect(exclusivePaginationState(1, 1)).toBeNull();
    expect(exclusivePaginationState(2, 0)).toBeNull();
  });

  it('requires both the expected signed cursor and a new rendered marker', () => {
    const first = stableItemMarker(['run-a', 'run-b']);
    const second = stableItemMarker(['run-c']);
    const expectedCursorDigest = sanitizedDigest('signed-page-two')!;

    expect(
      renderedPageMatchesCursor({
        expectedCursorDigest,
        actualCursorDigest: expectedCursorDigest,
        previousItemMarker: first,
        actualItemMarker: first,
      }),
    ).toBe(false);
    expect(
      renderedPageMatchesCursor({
        expectedCursorDigest,
        actualCursorDigest: sanitizedDigest('different-cursor'),
        previousItemMarker: first,
        actualItemMarker: second,
      }),
    ).toBe(false);
    expect(
      renderedPageMatchesCursor({
        expectedCursorDigest,
        actualCursorDigest: expectedCursorDigest,
        previousItemMarker: first,
        actualItemMarker: second,
      }),
    ).toBe(true);
  });

  it('produces deterministic digests without retaining cursor input', () => {
    const cursor = 'signed-cursor-value';
    const digest = sanitizedDigest(cursor);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain(cursor);
    expect(sanitizedDigest(null)).toBeNull();
  });
});
