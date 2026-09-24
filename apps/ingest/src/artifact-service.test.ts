import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import {
  authorizeArtifactUpload,
  claimArtifactVerification,
  finalizeArtifactVerification,
  rejectArtifactVerification,
  releaseArtifactVerification,
} from '@blackbox/database';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ArtifactObjectMissingError,
  ArtifactStorageUnavailableError,
  ArtifactTransportService,
  type ArtifactStoragePort,
} from './artifact-service.js';

vi.mock('@blackbox/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@blackbox/database')>();
  return {
    ...actual,
    authorizeArtifactUpload: vi.fn(),
    claimArtifactVerification: vi.fn(),
    finalizeArtifactVerification: vi.fn(),
    getArtifactStorageRecord: vi.fn(),
    rejectArtifactVerification: vi.fn(),
    releaseArtifactVerification: vi.fn(),
  };
});

const artifactId = randomUUID();
const uploadId = randomUUID();
const bytes = Buffer.from('exact-redacted-bytes');
const digest = createHash('sha256').update(bytes).digest('hex');
const scope = {
  organizationId: randomUUID(),
  repositoryId: randomUUID(),
  artifactId,
  uploadId,
};

function claimed() {
  return {
    outcome: 'claimed' as const,
    leaseId: randomUUID(),
    declaration: {
      id: randomUUID(),
      canonicalArtifactId: artifactId,
      byteLength: BigInt(bytes.length),
      sha256: digest,
      mediaType: 'application/octet-stream',
      compression: null,
    },
    attempt: {
      id: uploadId,
      objectKey: 'server/owned/key',
      state: 'verifying' as const,
      expiresAt: new Date(Date.now() + 60_000),
      observedByteLength: null,
      observedSha256: null,
      verifiedAt: null,
      lastErrorCode: null,
    },
  };
}

function storage(read: () => Promise<Readable>): ArtifactStoragePort {
  return {
    issueUploadCapability: vi.fn(),
    openReadable: vi.fn(read),
    deleteObject: vi.fn().mockResolvedValue(undefined),
  };
}

function service(value: ArtifactStoragePort) {
  return new ArtifactTransportService({
    database: {} as never,
    storage: value,
    maximumBytes: 100,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(claimArtifactVerification).mockResolvedValue(claimed());
  vi.mocked(finalizeArtifactVerification).mockImplementation(
    async (_database, input) => ({
      outcome: 'applied',
      attempt: {
        ...claimed().attempt,
        state: 'verified',
        observedByteLength: input.byteLength,
        observedSha256: input.sha256,
        verifiedAt: input.verifiedAt,
      },
    }),
  );
  vi.mocked(rejectArtifactVerification).mockImplementation(
    async (_database, input) => ({
      outcome: 'applied',
      attempt: {
        ...claimed().attempt,
        state: 'rejected',
        observedByteLength: input.byteLength,
        observedSha256: input.sha256,
        lastErrorCode: input.reason,
      },
    }),
  );
});

describe('artifact transport verification', () => {
  it('returns verification_in_progress without touching storage for an active owner', async () => {
    const active = claimed();
    vi.mocked(claimArtifactVerification).mockResolvedValue({
      outcome: 'in_progress',
      declaration: active.declaration,
      attempt: active.attempt,
    });
    const fake = storage(async () => Readable.from([bytes]));
    await expect(service(fake).complete(scope)).resolves.toMatchObject({
      outcome: 'verification_in_progress',
      retryable: true,
    });
    expect(fake.openReadable).not.toHaveBeenCalled();
    expect(finalizeArtifactVerification).not.toHaveBeenCalled();
  });

  it('verifies only after streaming exact chunked stored bytes', async () => {
    const fake = storage(async () =>
      Readable.from([bytes.subarray(0, 4), bytes.subarray(4)]),
    );
    const result = await service(fake).complete(scope);
    expect(result.outcome).toBe('verified');
    expect(finalizeArtifactVerification).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        byteLength: BigInt(bytes.length),
        sha256: digest,
      }),
    );
    expect(fake.openReadable).toHaveBeenCalledWith('server/owned/key');
  });

  it.each([
    ['changed', Buffer.from('exact-redacted-byteX'), 'integrity_mismatch'],
    ['truncated', bytes.subarray(0, bytes.length - 1), 'integrity_mismatch'],
    [
      'extended',
      Buffer.concat([bytes, Buffer.from('x')]),
      'integrity_mismatch',
    ],
    ['over limit', Buffer.alloc(101), 'payload_too_large'],
  ] as const)(
    'durably rejects %s bytes and deletes best-effort',
    async (_name, actual, reason) => {
      const fake = storage(async () => Readable.from([actual]));
      const result = await service(fake).complete(scope);
      expect(result).toMatchObject({
        outcome: 'rejected',
        reason,
        retryable: false,
      });
      expect(rejectArtifactVerification).toHaveBeenCalled();
      expect(fake.deleteObject).toHaveBeenCalledWith('server/owned/key');
      expect(finalizeArtifactVerification).not.toHaveBeenCalled();
    },
  );

  it('rejects a missing object without trusting provider metadata', async () => {
    const fake = storage(async () => {
      throw new ArtifactObjectMissingError();
    });
    await expect(service(fake).complete(scope)).resolves.toMatchObject({
      outcome: 'rejected',
      reason: 'object_missing',
    });
    expect(rejectArtifactVerification).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ byteLength: null, sha256: null }),
    );
  });

  it('releases the lease and remains retryable when storage is unavailable', async () => {
    const fake = storage(async () => {
      throw new Error('provider details must not escape');
    });
    await expect(service(fake).complete(scope)).rejects.toBeInstanceOf(
      ArtifactStorageUnavailableError,
    );
    expect(releaseArtifactVerification).toHaveBeenCalled();
    expect(rejectArtifactVerification).not.toHaveBeenCalled();
  });

  it('keeps durable rejection even when best-effort deletion fails', async () => {
    const fake = storage(async () => Readable.from([Buffer.from('wrong')]));
    vi.mocked(fake.deleteObject).mockRejectedValue(new Error('unavailable'));
    await expect(service(fake).complete(scope)).resolves.toMatchObject({
      outcome: 'rejected',
      reason: 'integrity_mismatch',
    });
  });

  it('returns the winning terminal state when an expired lease loses finalize', async () => {
    vi.mocked(finalizeArtifactVerification).mockResolvedValue({
      outcome: 'lease_lost',
      attempt: {
        ...claimed().attempt,
        state: 'rejected',
        lastErrorCode: 'integrity_mismatch',
      },
    });
    await expect(
      service(storage(async () => Readable.from([bytes]))).complete(scope),
    ).resolves.toMatchObject({
      outcome: 'rejected',
      reason: 'integrity_mismatch',
    });
  });
});

describe('artifact upload session authorization', () => {
  it('persists and advertises the exact provider-enforced expiry', async () => {
    const capabilityExpiry = new Date('2026-09-24T12:15:00.000Z');
    const fake = storage(async () => Readable.from([]));
    vi.mocked(fake.issueUploadCapability).mockResolvedValue({
      protocol: 'tus',
      endpoint: 'https://storage.example/session/opaque',
      capabilityToken: 'scoped-token',
      expiresAt: capabilityExpiry,
      requiredChunkSize: 6 * 1024 * 1024,
    });
    vi.mocked(authorizeArtifactUpload).mockImplementation(
      async (_database, _input, issueCapability) => {
        const target = {
          uploadId,
          objectKey: 'server/owned/key',
          byteLength: BigInt(bytes.length),
          mediaType: 'application/octet-stream',
        };
        const issued = await issueCapability(target);
        return {
          outcome: 'created',
          declaration: {
            id: randomUUID(),
            canonicalArtifactId: artifactId,
            byteLength: target.byteLength,
            sha256: digest,
            mediaType: target.mediaType,
            compression: null,
          },
          attempt: {
            id: uploadId,
            objectKey: target.objectKey,
            state: 'issued',
            expiresAt: issued.expiresAt,
            observedByteLength: null,
            observedSha256: null,
            verifiedAt: null,
            lastErrorCode: null,
          },
          capability: issued.value,
        };
      },
    );

    const result = await service(fake).createSession({
      organizationId: scope.organizationId,
      repositoryId: scope.repositoryId,
      artifactId,
    });
    expect(result).toMatchObject({
      expiresAt: capabilityExpiry.toISOString(),
      endpoint: 'https://storage.example/session/opaque',
      capabilityToken: 'scoped-token',
    });
    expect(fake.issueUploadCapability).toHaveBeenCalledWith({
      uploadId,
      objectKey: 'server/owned/key',
      byteLength: BigInt(bytes.length),
      mediaType: 'application/octet-stream',
    });
  });

  it('maps provider failure without persisting provider details', async () => {
    const fake = storage(async () => Readable.from([]));
    vi.mocked(fake.issueUploadCapability).mockRejectedValue(
      new Error('provider secret'),
    );
    vi.mocked(authorizeArtifactUpload).mockImplementation(
      async (_database, _input, issueCapability) => {
        await issueCapability({
          uploadId,
          objectKey: 'server/owned/key',
          byteLength: BigInt(bytes.length),
          mediaType: 'application/octet-stream',
        });
        throw new Error('unreachable');
      },
    );
    await expect(
      service(fake).createSession({
        organizationId: scope.organizationId,
        repositoryId: scope.repositoryId,
        artifactId,
      }),
    ).rejects.toBeInstanceOf(ArtifactStorageUnavailableError);
  });
});
