import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  ArtifactRouteParamsSchema,
  ArtifactStorageStatusResponseSchema,
  ArtifactUploadSessionResponseSchema,
} from './artifacts.js';

describe('artifact transport contracts', () => {
  it('accepts the closed TUS capability response and rejects provider fields', () => {
    const response = {
      schemaVersion: 1,
      outcome: 'upload_authorized',
      artifactId: randomUUID(),
      uploadId: randomUUID(),
      protocol: 'tus',
      endpoint: 'https://storage.example/upload/resumable',
      capabilityToken: 'secret',
      expiresAt: '2026-09-24T12:00:00.000Z',
      maximumBytes: 50_000_000,
    } as const;
    expect(ArtifactUploadSessionResponseSchema.parse(response)).toEqual(
      response,
    );
    expect(
      ArtifactUploadSessionResponseSchema.safeParse({
        ...response,
        objectKey: 'not-public',
      }).success,
    ).toBe(false);
  });

  it('keeps status metadata safe and strict', () => {
    const status = {
      schemaVersion: 1,
      artifactId: randomUUID(),
      state: 'declared',
    } as const;
    expect(ArtifactStorageStatusResponseSchema.parse(status)).toEqual(status);
    expect(
      ArtifactStorageStatusResponseSchema.safeParse({
        ...status,
        bucket: 'private',
      }).success,
    ).toBe(false);
  });

  it('strictly validates repository and artifact UUIDs', () => {
    expect(
      ArtifactRouteParamsSchema.safeParse({
        repositoryId: randomUUID(),
        artifactId: randomUUID(),
      }).success,
    ).toBe(true);
    expect(
      ArtifactRouteParamsSchema.safeParse({
        repositoryId: 'bad',
        artifactId: randomUUID(),
      }).success,
    ).toBe(false);
  });
});
