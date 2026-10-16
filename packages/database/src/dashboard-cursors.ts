import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const CURSOR = /^[A-Za-z0-9_-]+$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_CURSOR_LENGTH = 2_048;

export class InvalidDashboardCursorError extends Error {
  constructor() {
    super('Invalid dashboard cursor.');
    this.name = 'InvalidDashboardCursorError';
  }
}

function invalid(): never {
  throw new InvalidDashboardCursorError();
}

function signingKey(value: Uint8Array): Uint8Array {
  return value instanceof Uint8Array && value.byteLength === 32
    ? value
    : invalid();
}

export function assertDashboardCursorSigningKey(value: Uint8Array): void {
  signingKey(value);
}

export function dashboardCursorScope(
  organizationId: string,
  ...parts: Array<string | undefined>
): string {
  return createHash('sha256')
    .update(
      [organizationId, ...parts.map((part) => part ?? '*')].join('\u0000'),
    )
    .digest('hex');
}

function exactKeys(value: object, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function sign(key: Uint8Array, payload: object): string {
  return createHmac('sha256', signingKey(key))
    .update(JSON.stringify(payload))
    .digest('hex');
}

export function encodeDashboardCursor(
  key: Uint8Array,
  payload: object,
): string {
  return Buffer.from(
    JSON.stringify({ payload, signature: sign(key, payload) }),
    'utf8',
  ).toString('base64url');
}

export function decodeDashboardCursor(
  key: Uint8Array,
  value: string,
): Record<string, unknown> {
  try {
    signingKey(key);
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value.length > MAX_CURSOR_LENGTH ||
      !CURSOR.test(value)
    )
      return invalid();
    const encoded = Buffer.from(value, 'base64url');
    if (encoded.toString('base64url') !== value) return invalid();
    const envelope = JSON.parse(encoded.toString('utf8')) as Record<
      string,
      unknown
    >;
    if (
      !exactKeys(envelope, ['payload', 'signature']) ||
      envelope.payload === null ||
      typeof envelope.payload !== 'object' ||
      typeof envelope.signature !== 'string' ||
      !SHA256.test(envelope.signature)
    )
      return invalid();
    const expected = Buffer.from(sign(key, envelope.payload as object), 'hex');
    const actual = Buffer.from(envelope.signature, 'hex');
    if (!timingSafeEqual(expected, actual)) return invalid();
    return envelope.payload as Record<string, unknown>;
  } catch (error) {
    if (error instanceof InvalidDashboardCursorError) throw error;
    throw new InvalidDashboardCursorError();
  }
}
