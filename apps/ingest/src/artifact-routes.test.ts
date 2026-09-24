import { randomUUID } from 'node:crypto';

import {
  ArtifactCompletionResponseSchema,
  ArtifactStorageStatusResponseSchema,
  ArtifactUploadSessionResponseSchema,
} from '@blackbox/contracts';
import { ArtifactNotFoundError } from '@blackbox/database';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp, type ArtifactRouteService } from './app.js';
import { ArtifactStorageUnavailableError } from './artifact-service.js';

const apps: ReturnType<typeof buildApp>[] = [];
const organizationId = randomUUID();
const repositoryId = randomUUID();
const artifactId = randomUUID();
const uploadId = randomUUID();

function routeService(
  overrides: Partial<ArtifactRouteService> = {},
): ArtifactRouteService {
  return {
    createSession: vi.fn().mockResolvedValue({
      schemaVersion: 1,
      outcome: 'upload_authorized',
      artifactId,
      uploadId,
      protocol: 'tus',
      endpoint: 'https://storage.example/upload/resumable',
      capabilityToken: 'secret-capability',
      expiresAt: '2026-09-24T12:15:00.000Z',
      requiredChunkSize: 6 * 1024 * 1024,
      maximumBytes: 50_000_000,
    }),
    complete: vi.fn().mockResolvedValue({
      schemaVersion: 1,
      outcome: 'verified',
      artifactId,
      verification: {
        uploadId,
        byteLength: 5,
        sha256: 'a'.repeat(64),
        verifiedAt: '2026-09-24T12:05:00.000Z',
      },
    }),
    status: vi.fn().mockResolvedValue({
      schemaVersion: 1,
      artifactId,
      state: 'declared',
    }),
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('artifact routes', () => {
  it.each([
    [
      'POST',
      `/v1/repositories/${repositoryId}/artifacts/${artifactId}/uploads`,
    ],
    [
      'POST',
      `/v1/repositories/${repositoryId}/artifacts/${artifactId}/uploads/${uploadId}/complete`,
    ],
    ['GET', `/v1/repositories/${repositoryId}/artifacts/${artifactId}/storage`],
  ] as const)(
    'authenticates %s %s before service access',
    async (method, url) => {
      const service = routeService();
      const app = buildApp({
        authenticator: () => undefined,
        artifactService: service,
      });
      apps.push(app);
      const response = await app.inject({ method, url });
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('unauthorized');
      expect(service.createSession).not.toHaveBeenCalled();
      expect(service.complete).not.toHaveBeenCalled();
      expect(service.status).not.toHaveBeenCalled();
    },
  );

  it('returns only the strict documented upload capability fields', async () => {
    const service = routeService();
    const app = buildApp({
      authenticator: () => ({ organizationId }),
      artifactService: service,
    });
    apps.push(app);
    const response = await app.inject({
      method: 'POST',
      url: `/v1/repositories/${repositoryId}/artifacts/${artifactId}/uploads`,
      payload: {},
    });
    expect(response.statusCode).toBe(201);
    const parsed = ArtifactUploadSessionResponseSchema.parse(response.json());
    expect(Object.keys(parsed).sort()).toEqual([
      'artifactId',
      'capabilityToken',
      'endpoint',
      'expiresAt',
      'maximumBytes',
      'outcome',
      'protocol',
      'requiredChunkSize',
      'schemaVersion',
      'uploadId',
    ]);
    expect(JSON.stringify(parsed)).not.toContain('objectKey');
    expect(service.createSession).toHaveBeenCalledWith({
      organizationId,
      repositoryId,
      artifactId,
    });
  });

  it('validates completion and status responses', async () => {
    const service = routeService();
    const app = buildApp({
      authenticator: () => ({ organizationId }),
      artifactService: service,
    });
    apps.push(app);
    const completion = await app.inject({
      method: 'POST',
      url: `/v1/repositories/${repositoryId}/artifacts/${artifactId}/uploads/${uploadId}/complete`,
      payload: {},
    });
    const status = await app.inject({
      method: 'GET',
      url: `/v1/repositories/${repositoryId}/artifacts/${artifactId}/storage`,
    });
    expect(completion.statusCode).toBe(200);
    expect(
      ArtifactCompletionResponseSchema.parse(completion.json()).outcome,
    ).toBe('verified');
    expect(ArtifactStorageStatusResponseSchema.parse(status.json()).state).toBe(
      'declared',
    );
  });

  it('hides missing and cross-scope artifacts behind the same response', async () => {
    const responses = [];
    for (const label of ['missing', 'wrong organization', 'wrong repository']) {
      const service = routeService({
        createSession: vi.fn().mockRejectedValue(new ArtifactNotFoundError()),
      });
      const app = buildApp({
        authenticator: () => ({ organizationId }),
        artifactService: service,
      });
      apps.push(app);
      const response = await app.inject({
        method: 'POST',
        url: `/v1/repositories/${repositoryId}/artifacts/${artifactId}/uploads`,
        payload: {},
      });
      responses.push([label, response.statusCode, response.json()]);
    }
    expect(responses[0]?.slice(1)).toEqual(responses[1]?.slice(1));
    expect(responses[1]?.slice(1)).toEqual(responses[2]?.slice(1));
  });

  it.each([
    `/v1/repositories/nope/artifacts/${artifactId}/uploads`,
    `/v1/repositories/${repositoryId}/artifacts/nope/uploads`,
    `/v1/repositories/${repositoryId}/artifacts/${artifactId}/uploads/nope/complete`,
  ])('strictly rejects invalid route identifiers', async (url) => {
    const app = buildApp({
      authenticator: () => ({ organizationId }),
      artifactService: routeService(),
    });
    apps.push(app);
    const response = await app.inject({ method: 'POST', url, payload: {} });
    expect([response.statusCode, response.json().error.code]).toEqual([
      422,
      'invalid_request',
    ]);
  });

  it('rejects client-selected identity and integrity fields in operation bodies', async () => {
    const service = routeService();
    const app = buildApp({
      authenticator: () => ({ organizationId }),
      artifactService: service,
    });
    apps.push(app);
    for (const [url, payload] of [
      [
        `/v1/repositories/${repositoryId}/artifacts/${artifactId}/uploads`,
        { objectKey: 'client/path', bucket: 'public' },
      ],
      [
        `/v1/repositories/${repositoryId}/artifacts/${artifactId}/uploads/${uploadId}/complete`,
        { sha256: 'a'.repeat(64), byteLength: 1, verified: true },
      ],
    ] as const) {
      const response = await app.inject({ method: 'POST', url, payload });
      expect([response.statusCode, response.json().error.code]).toEqual([
        422,
        'invalid_request',
      ]);
    }
    expect(service.createSession).not.toHaveBeenCalled();
    expect(service.complete).not.toHaveBeenCalled();
  });

  it.each([
    `/v1/repositories/${repositoryId}/artifacts/${artifactId}/uploads`,
    `/v1/repositories/${repositoryId}/artifacts/${artifactId}/uploads/${uploadId}/complete`,
  ])(
    'rejects a non-JSON media type before body validation for %s',
    async (url) => {
      const service = routeService();
      const app = buildApp({
        authenticator: () => ({ organizationId }),
        artifactService: service,
      });
      apps.push(app);
      const response = await app.inject({
        method: 'POST',
        url,
        headers: { 'content-type': 'text/plain' },
        payload: '{not-json',
      });
      expect([response.statusCode, response.json().error.code]).toEqual([
        415,
        'unsupported_media_type',
      ]);
      expect(service.createSession).not.toHaveBeenCalled();
      expect(service.complete).not.toHaveBeenCalled();
    },
  );

  it.each([
    `/v1/repositories/${repositoryId}/artifacts/${artifactId}/uploads`,
    `/v1/repositories/${repositoryId}/artifacts/${artifactId}/uploads/${uploadId}/complete`,
  ])('accepts application/json media type parameters for %s', async (url) => {
    const service = routeService();
    const app = buildApp({
      authenticator: () => ({ organizationId }),
      artifactService: service,
    });
    apps.push(app);
    const response = await app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      payload: '{}',
    });
    expect(response.statusCode).not.toBe(415);
  });

  it('does not expose storage, capability, credential, or connection details in errors', async () => {
    const secret =
      'Bearer service-role-secret https://storage.example/signed?token=secret server/object/key postgresql://credential';
    const service = routeService({
      createSession: vi.fn().mockRejectedValue(
        new ArtifactStorageUnavailableError('unavailable', {
          cause: new Error(secret),
        }),
      ),
    });
    const app = buildApp({
      authenticator: () => ({ organizationId }),
      artifactService: service,
    });
    apps.push(app);
    const response = await app.inject({
      method: 'POST',
      url: `/v1/repositories/${repositoryId}/artifacts/${artifactId}/uploads`,
      payload: {},
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: {
        code: 'storage_unavailable',
        message: 'Artifact storage is temporarily unavailable.',
      },
    });
    expect(response.body).not.toContain(secret);
  });
});
