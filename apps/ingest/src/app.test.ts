import { randomUUID } from 'node:crypto';

import {
  EvidenceBatchIngestionResponseSchema,
  HealthResponseSchema,
  IngestionErrorResponseSchema,
  type EvidenceBatch,
} from '@blackbox/contracts';
import {
  EvidenceConflictError,
  RepositoryNotFoundError,
} from '@blackbox/database';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from './app.js';

const apps: ReturnType<typeof buildApp>[] = [];
const organizationId = randomUUID();
const repositoryId = randomUUID();

function batch(overrides: Partial<EvidenceBatch> = {}): EvidenceBatch {
  const runId = overrides.runId ?? randomUUID();
  return {
    schemaVersion: 1,
    batchId: randomUUID(),
    runId,
    sentAt: '2026-09-23T10:00:00.000Z',
    events: [
      {
        schemaVersion: 1,
        eventId: randomUUID(),
        runId,
        sequence: 0,
        kind: 'run.started',
        observedAt: '2026-09-23T10:00:00.000Z',
        source: { component: 'collector' },
        payload: { adapter: 'codex', provider: 'codex' },
      },
    ],
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('ingest application', () => {
  it('keeps the existing health contract', async () => {
    const app = buildApp();
    apps.push(app);
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(HealthResponseSchema.parse(response.json())).toEqual({
      status: 'ok',
      service: 'ingest',
    });
  });

  it.each([
    ['accepted', 202],
    ['already_accepted', 200],
  ] as const)(
    'maps %s to its strict success response',
    async (outcome, status) => {
      const value = batch();
      const ingest = vi.fn().mockResolvedValue({
        outcome,
        batchId: value.batchId,
        runId: value.runId,
        receivedAt: new Date('2026-09-23T10:01:00.000Z'),
      });
      const app = buildApp({
        authenticator: () => ({ organizationId }),
        ingestionService: { ingest },
      });
      apps.push(app);
      const response = await app.inject({
        method: 'POST',
        url: `/v1/repositories/${repositoryId}/evidence-batches`,
        headers: { authorization: 'Bearer secret' },
        payload: value,
      });
      expect(response.statusCode).toBe(status);
      expect(
        EvidenceBatchIngestionResponseSchema.parse(response.json()).outcome,
      ).toBe(outcome);
      expect(ingest).toHaveBeenCalledWith({
        organizationId,
        repositoryId,
        batch: value,
      });
    },
  );

  it.each([undefined, 'Basic abc', 'Bearer wrong'])(
    'returns the same 401 and never persists for credential %s',
    async (authorization) => {
      const ingest = vi.fn();
      const app = buildApp({
        authenticator: () => undefined,
        ingestionService: { ingest },
      });
      apps.push(app);
      const response = await app.inject({
        method: 'POST',
        url: `/v1/repositories/${repositoryId}/evidence-batches`,
        headers: authorization ? { authorization } : {},
        payload: batch(),
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        error: { code: 'unauthorized', message: 'Authentication is required.' },
      });
      expect(ingest).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, 'Basic abc', 'Bearer wrong'])(
    'authenticates before parsing malformed or oversized bodies for credential %s',
    async (authorization) => {
      const ingest = vi.fn();
      const app = buildApp({
        authenticator: () => undefined,
        ingestionService: { ingest },
      });
      apps.push(app);
      const headers = {
        'content-type': 'application/json',
        ...(authorization ? { authorization } : {}),
      };
      const malformed = await app.inject({
        method: 'POST',
        url: `/v1/repositories/${repositoryId}/evidence-batches`,
        headers,
        payload: '{bad',
      });
      const oversized = await app.inject({
        method: 'POST',
        url: `/v1/repositories/${repositoryId}/evidence-batches`,
        headers,
        payload: JSON.stringify({ value: 'x'.repeat(16 * 1024 * 1024) }),
      });
      const unauthorized = {
        error: { code: 'unauthorized', message: 'Authentication is required.' },
      };
      expect([malformed.statusCode, malformed.json()]).toEqual([
        401,
        unauthorized,
      ]);
      expect([oversized.statusCode, oversized.json()]).toEqual([
        401,
        unauthorized,
      ]);
      expect(ingest).not.toHaveBeenCalled();
    },
  );

  it.each([
    [new RepositoryNotFoundError(), 404, 'repository_not_found'],
    [new EvidenceConflictError(), 409, 'evidence_conflict'],
  ] as const)('maps safe application errors', async (failure, status, code) => {
    const app = buildApp({
      authenticator: () => ({ organizationId }),
      ingestionService: { ingest: vi.fn().mockRejectedValue(failure) },
    });
    apps.push(app);
    const response = await app.inject({
      method: 'POST',
      url: `/v1/repositories/${repositoryId}/evidence-batches`,
      payload: batch(),
    });
    expect(response.statusCode).toBe(status);
    expect(IngestionErrorResponseSchema.parse(response.json()).error.code).toBe(
      code,
    );
  });

  it('does not distinguish missing from wrong-tenant repositories', async () => {
    const errors = [];
    for (const reason of ['missing', 'wrong tenant']) {
      const app = buildApp({
        authenticator: () => ({ organizationId }),
        ingestionService: {
          ingest: vi.fn().mockRejectedValue(new RepositoryNotFoundError()),
        },
      });
      apps.push(app);
      const response = await app.inject({
        method: 'POST',
        url: `/v1/repositories/${repositoryId}/evidence-batches`,
        payload: batch(),
      });
      errors.push([reason, response.statusCode, response.json()]);
    }
    expect(errors[0]?.slice(1)).toEqual(errors[1]?.slice(1));
  });

  it.each([
    [
      'invalid route UUID',
      `/v1/repositories/nope/evidence-batches`,
      batch(),
      422,
      'invalid_request',
    ],
    [
      'unsupported version',
      `/v1/repositories/${repositoryId}/evidence-batches`,
      { ...batch(), schemaVersion: 2 },
      422,
      'unsupported_schema_version',
    ],
    [
      'invalid batch',
      `/v1/repositories/${repositoryId}/evidence-batches`,
      { schemaVersion: 1 },
      422,
      'invalid_request',
    ],
  ] as const)(
    'rejects %s safely',
    async (_name, url, payload, status, code) => {
      const app = buildApp({
        authenticator: () => ({ organizationId }),
        ingestionService: { ingest: vi.fn() },
      });
      apps.push(app);
      const response = await app.inject({ method: 'POST', url, payload });
      expect(response.statusCode).toBe(status);
      expect(
        IngestionErrorResponseSchema.parse(response.json()).error.code,
      ).toBe(code);
    },
  );

  it('maps malformed JSON and unsupported media types', async () => {
    const app = buildApp({
      authenticator: () => ({ organizationId }),
      ingestionService: { ingest: vi.fn() },
    });
    apps.push(app);
    const malformed = await app.inject({
      method: 'POST',
      url: `/v1/repositories/${repositoryId}/evidence-batches`,
      headers: { 'content-type': 'application/json' },
      payload: '{bad',
    });
    const media = await app.inject({
      method: 'POST',
      url: `/v1/repositories/${repositoryId}/evidence-batches`,
      headers: { 'content-type': 'text/plain' },
      payload: '{}',
    });
    expect([malformed.statusCode, malformed.json().error.code]).toEqual([
      400,
      'malformed_json',
    ]);
    expect([media.statusCode, media.json().error.code]).toEqual([
      415,
      'unsupported_media_type',
    ]);
  });

  it('enforces the 16 MiB request limit', async () => {
    const app = buildApp({
      authenticator: () => ({ organizationId }),
      ingestionService: { ingest: vi.fn() },
    });
    apps.push(app);
    const response = await app.inject({
      method: 'POST',
      url: `/v1/repositories/${repositoryId}/evidence-batches`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ value: 'x'.repeat(16 * 1024 * 1024) }),
    });
    expect([response.statusCode, response.json().error.code]).toEqual([
      413,
      'payload_too_large',
    ]);
  });
});
