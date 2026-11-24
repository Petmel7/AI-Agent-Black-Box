import { createHash } from 'node:crypto';

export class CanonicalJsonSizeError extends RangeError {
  constructor() {
    super('Canonical JSON exceeds its byte limit.');
    this.name = 'CanonicalJsonSizeError';
  }
}

function compareUtf8(left: string, right: string): number {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1)
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  return a.length - b.length;
}

/**
 * Implementation-independent canonical JSON used by Export V1: UTF-8 object
 * keys in byte order, contract-ordered arrays, safe integer numbers, and no
 * insignificant whitespace.
 */
function* canonicalChunks(value: unknown): Generator<string> {
  if (value === null) {
    yield 'null';
    return;
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    yield JSON.stringify(value);
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value))
      throw new TypeError('Canonical export numbers must be safe integers.');
    yield JSON.stringify(value);
    return;
  }
  if (Array.isArray(value)) {
    yield '[';
    for (const [index, item] of value.entries()) {
      if (index > 0) yield ',';
      yield* canonicalChunks(item);
    }
    yield ']';
    return;
  }
  if (typeof value !== 'object')
    throw new TypeError('Canonical export values must be JSON values.');
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null)
    throw new TypeError('Canonical export objects must be plain objects.');
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort(compareUtf8);
  yield '{';
  for (const [index, key] of keys.entries()) {
    if (index > 0) yield ',';
    yield JSON.stringify(key);
    yield ':';
    yield* canonicalChunks(record[key]);
  }
  yield '}';
}

export function canonicalJson(value: unknown): string {
  return [...canonicalChunks(value)].join('');
}

export function canonicalUtf8(
  value: unknown,
  maximumBytes?: number,
): Uint8Array {
  if (
    maximumBytes !== undefined &&
    (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1)
  )
    throw new TypeError(
      'Canonical JSON byte limit must be a positive integer.',
    );
  const maximum = maximumBytes ?? Number.MAX_SAFE_INTEGER;
  const encoder = new TextEncoder();
  let buffer = new Uint8Array(Math.min(1_024, maximum));
  let length = 0;
  let pending = '';
  const append = (text: string) => {
    const bytes = encoder.encode(text);
    const required = length + bytes.byteLength;
    if (required > maximum) throw new CanonicalJsonSizeError();
    if (required > buffer.byteLength) {
      let capacity = buffer.byteLength;
      while (capacity < required)
        capacity = Math.min(maximum, Math.max(capacity * 2, required));
      const grown = new Uint8Array(capacity);
      grown.set(buffer.subarray(0, length));
      buffer = grown;
    }
    buffer.set(bytes, length);
    length = required;
  };
  for (const chunk of canonicalChunks(value)) {
    pending += chunk;
    if (pending.length >= 32_768) {
      append(pending);
      pending = '';
    }
  }
  if (pending.length > 0) append(pending);
  return buffer.subarray(0, length);
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
