import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  dashboardCursorScope,
  decodeDashboardCursor,
  encodeDashboardCursor,
  InvalidDashboardCursorError,
} from './dashboard-cursors.js';

const signingKey = Buffer.alloc(32, 7);
const organizationId = '11111111-1111-4111-8111-111111111111';
const repositoryId = '22222222-2222-4222-8222-222222222222';
const payload = {
  version: 1,
  kind: 'dashboard-runs',
  scope: dashboardCursorScope(organizationId, repositoryId),
  snapshotCount: 3,
  afterCreatedAt: '2026-10-15T00:00:00.000Z',
  afterRunId: '33333333-3333-4333-8333-333333333333',
};

function envelope(cursor: string): {
  payload: Record<string, unknown>;
  signature: string;
} {
  return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
    payload: Record<string, unknown>;
    signature: string;
  };
}

function encodeEnvelope(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

describe('dashboard cursor authentication', () => {
  it('round-trips only with the dedicated 32-byte signing authority', () => {
    const cursor = encodeDashboardCursor(signingKey, payload);
    expect(decodeDashboardCursor(signingKey, cursor)).toEqual(payload);
    for (const invalidKey of [Buffer.alloc(31), Buffer.alloc(33)])
      expect(() => decodeDashboardCursor(invalidKey, cursor)).toThrow(
        InvalidDashboardCursorError,
      );
  });

  it.each([
    ['version', 2],
    ['kind', 'dashboard-timeline'],
    ['scope', dashboardCursorScope(organizationId, undefined)],
    ['snapshotCount', 4],
    ['afterCreatedAt', '2026-10-15T00:00:00.001Z'],
    ['afterRunId', '44444444-4444-4444-8444-444444444444'],
  ])('rejects mutation of signed payload position %s', (name, value) => {
    const original = envelope(encodeDashboardCursor(signingKey, payload));
    original.payload[name] = value;
    expect(() =>
      decodeDashboardCursor(signingKey, encodeEnvelope(original)),
    ).toThrow(InvalidDashboardCursorError);
  });

  it('rejects signature changes and non-canonical encodings', () => {
    const cursor = encodeDashboardCursor(signingKey, payload);
    const changed = envelope(cursor);
    changed.signature = `${changed.signature.slice(0, -1)}${
      changed.signature.endsWith('0') ? '1' : '0'
    }`;
    for (const value of [
      encodeEnvelope(changed),
      `${cursor}=`,
      'not+base64url',
    ])
      expect(() => decodeDashboardCursor(signingKey, value)).toThrow(
        InvalidDashboardCursorError,
      );
  });

  it.each([
    ['snapshotCount', 4],
    ['snapshotMaxSequence', 11],
    ['afterSequence', 6],
    ['afterEventId', '55555555-5555-4555-8555-555555555555'],
  ])('rejects timeline snapshot/continuation mutation %s', (name, value) => {
    const timeline = {
      version: 1,
      kind: 'dashboard-timeline',
      scope: dashboardCursorScope(
        organizationId,
        repositoryId,
        '44444444-4444-4444-8444-444444444444',
      ),
      snapshotCount: 3,
      snapshotMaxSequence: 10,
      afterSequence: 5,
      afterEventId: '33333333-3333-4333-8333-333333333333',
    };
    const changed = envelope(encodeDashboardCursor(signingKey, timeline));
    changed.payload[name] = value;
    expect(() =>
      decodeDashboardCursor(signingKey, encodeEnvelope(changed)),
    ).toThrow(InvalidDashboardCursorError);
  });

  it('binds tenant and filter inside the signed payload', () => {
    expect(dashboardCursorScope(organizationId, repositoryId)).not.toBe(
      dashboardCursorScope(
        '99999999-9999-4999-8999-999999999999',
        repositoryId,
      ),
    );
    expect(dashboardCursorScope(organizationId, repositoryId)).not.toBe(
      dashboardCursorScope(
        organizationId,
        '88888888-8888-4888-8888-888888888888',
      ),
    );
  });

  it('cannot be forged from the organization or dashboard access token', () => {
    const accessToken = 'known-dashboard-token';
    const guessedKeys = [
      createHash('sha256').update(organizationId).digest(),
      createHash('sha256').update(accessToken).digest(),
    ];
    for (const guessedKey of guessedKeys) {
      const forged = encodeDashboardCursor(guessedKey, payload);
      expect(() => decodeDashboardCursor(signingKey, forged)).toThrow(
        InvalidDashboardCursorError,
      );
    }
  });
});
