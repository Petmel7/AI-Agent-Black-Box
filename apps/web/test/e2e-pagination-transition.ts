import { createHash } from 'node:crypto';

export function sanitizedDigest(value: string | null): string | null {
  return value === null
    ? null
    : createHash('sha256').update(value).digest('hex');
}

export function stableItemMarker(keys: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(keys)).digest('hex');
}

export function exclusivePaginationState(
  nextCount: number,
  terminalCount: number,
): 'next' | 'terminal' | null {
  if (nextCount === 1 && terminalCount === 0) return 'next';
  if (nextCount === 0 && terminalCount === 1) return 'terminal';
  return null;
}

export function renderedPageMatchesCursor(input: {
  expectedCursorDigest: string;
  actualCursorDigest: string | null;
  previousItemMarker: string;
  actualItemMarker: string;
}): boolean {
  return (
    input.actualCursorDigest === input.expectedCursorDigest &&
    input.actualItemMarker !== input.previousItemMarker
  );
}
