import { createHash, randomUUID } from 'node:crypto';

import { EvidenceBatchSchema } from '@blackbox/contracts';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ArtifactDeclarationLimitError,
  ArtifactNotFoundError,
  authorizeArtifactUpload,
  claimArtifactVerification,
  createDatabaseClient,
  finalizeArtifactVerification,
  ingestEvidenceBatch,
  rejectArtifactVerification,
  releaseArtifactVerification,
} from '../../src/index.js';

const connectionString = (() => {
  const value = process.env.TEST_DATABASE_URL;
  if (!value)
    throw new Error(
      'TEST_DATABASE_URL is required for database integration tests.',
    );
  return value;
})();
const configuredSchema = new URL(connectionString).searchParams.get('schema');
let pool: Pool;

beforeAll(() => {
  pool = new Pool({
    connectionString,
    max: 6,
    options: `-c search_path=${configuredSchema ?? 'public'}`,
  });
});
afterAll(() => pool.end());

async function seedArtifact(bytes = Buffer.from('artifact')) {
  const organizationId = (
    await pool.query<{ id: string }>(
      'INSERT INTO organizations DEFAULT VALUES RETURNING id',
    )
  ).rows[0]!.id;
  const repositoryId = (
    await pool.query<{ id: string }>(
      'INSERT INTO repositories (organization_id) VALUES ($1) RETURNING id',
      [organizationId],
    )
  ).rows[0]!.id;
  const runId = randomUUID();
  const artifactId = randomUUID();
  const batch = EvidenceBatchSchema.parse({
    schemaVersion: 1,
    batchId: randomUUID(),
    runId,
    sentAt: new Date().toISOString(),
    events: [
      {
        schemaVersion: 1,
        eventId: randomUUID(),
        runId,
        sequence: 0,
        kind: 'test.run.finished',
        observedAt: new Date().toISOString(),
        source: { component: 'test-parser' },
        payload: {
          testRunId: randomUUID(),
          framework: 'vitest',
          outcome: 'passed',
          reportArtifact: {
            artifactId,
            kind: 'test-report',
            mediaType: 'text/plain',
            byteLength: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            redaction: { applied: true, rulesetVersion: 'v1' },
            characterEncoding: 'utf-8',
          },
        },
      },
    ],
  });
  const handle = createDatabaseClient({ connectionString });
  await ingestEvidenceBatch(handle.client, {
    organizationId,
    repositoryId,
    batch,
  });
  return { handle, organizationId, repositoryId, artifactId, bytes };
}

function authorizationInput(
  seed: Awaited<ReturnType<typeof seedArtifact>>,
  now = new Date(),
) {
  return {
    organizationId: seed.organizationId,
    repositoryId: seed.repositoryId,
    artifactId: seed.artifactId,
    now,
    maximumBytes: 50_000_000n,
  };
}

function authorize(
  seed: Awaited<ReturnType<typeof seedArtifact>>,
  now = new Date(),
  maximumBytes = 50_000_000n,
  capabilityLifetimeMs = 60_000,
) {
  const expiresAt = new Date(now.getTime() + capabilityLifetimeMs);
  return authorizeArtifactUpload(
    seed.handle.client,
    { ...authorizationInput(seed, now), maximumBytes },
    async (target) => ({ expiresAt, value: { ...target, expiresAt } }),
  );
}

async function waitForDatabaseTime(seconds: number) {
  await pool.query('SELECT pg_sleep($1)', [seconds]);
}

describe('artifact upload persistence', () => {
  it('deploys the migration and enforces active, object-key, ownership, and append-only boundaries', async () => {
    const migration = await pool.query(
      `SELECT 1 FROM _prisma_migrations WHERE migration_name IN ('20260924140000_artifact_upload_attempts', '20260925120000_artifact_lease_expiry_guard', '20260925130000_artifact_active_lease_expiry_guard') AND finished_at IS NOT NULL`,
    );
    expect(migration.rows).toHaveLength(3);
    const seed = await seedArtifact();
    const authorized = await authorize(seed);
    await expect(
      pool.query(
        'DELETE FROM artifact_declarations WHERE canonical_artifact_id = $1',
        [seed.artifactId],
      ),
    ).rejects.toMatchObject({ code: expect.stringMatching(/55000|23503/) });
    await expect(
      pool.query(
        'UPDATE artifact_upload_attempts SET object_key = $1 WHERE id = $2',
        ['client-selected', authorized.attempt.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await seed.handle.dispose();
  });

  it('reuses one unexpired attempt concurrently and creates a fresh key after expiry', async () => {
    const seed = await seedArtifact();
    const now = new Date();
    const results = await Promise.all([
      authorize(seed, now),
      authorize(seed, now),
    ]);
    expect(new Set(results.map((result) => result.attempt.id)).size).toBe(1);
    expect(results.map((result) => result.outcome).sort()).toEqual([
      'created',
      'reused',
    ]);
    expect(results[0]!.attempt.expiresAt).toEqual(
      new Date(now.getTime() + 60_000),
    );
    expect(results[0]!.capability?.expiresAt).toEqual(
      new Date(now.getTime() + 60_000),
    );
    const later = new Date(now.getTime() + 120_000);
    const replacement = await authorize(seed, later);
    expect(replacement.attempt.id).not.toBe(results[0]!.attempt.id);
    expect(replacement.attempt.objectKey).not.toBe(
      results[0]!.attempt.objectKey,
    );
    await seed.handle.dispose();
  });

  it('rejects over-limit declarations before creating an attempt', async () => {
    const seed = await seedArtifact(Buffer.alloc(12));
    await expect(authorize(seed, new Date(), 11n)).rejects.toBeInstanceOf(
      ArtifactDeclarationLimitError,
    );
    const count = await pool.query<{ count: string }>(
      'SELECT count(*) FROM artifact_upload_attempts WHERE organization_id = $1',
      [seed.organizationId],
    );
    expect(count.rows[0]!.count).toBe('0');
    await seed.handle.dispose();
  });

  it('hides attempts across organization, repository, artifact, and upload identifiers', async () => {
    const seed = await seedArtifact();
    const other = await seedArtifact();
    const authorization = await authorize(seed);
    for (const scope of [
      {
        organizationId: other.organizationId,
        repositoryId: seed.repositoryId,
        artifactId: seed.artifactId,
      },
      {
        organizationId: seed.organizationId,
        repositoryId: other.repositoryId,
        artifactId: seed.artifactId,
      },
      {
        organizationId: seed.organizationId,
        repositoryId: seed.repositoryId,
        artifactId: other.artifactId,
      },
    ]) {
      await expect(
        claimArtifactVerification(seed.handle.client, {
          ...scope,
          uploadId: authorization.attempt.id,
          leaseDurationMs: 30_000,
        }),
      ).rejects.toBeInstanceOf(ArtifactNotFoundError);
    }
    await Promise.all([seed.handle.dispose(), other.handle.dispose()]);
  });

  it('converges completion, exact retry, and expired-lease recovery on one verified result', async () => {
    const seed = await seedArtifact();
    const authorization = await authorize(seed);
    const first = await claimArtifactVerification(seed.handle.client, {
      ...authorizationInput(seed),
      uploadId: authorization.attempt.id,
      leaseDurationMs: 50,
    });
    expect(first.outcome).toBe('claimed');
    await waitForDatabaseTime(0.1);
    const recovered = await claimArtifactVerification(seed.handle.client, {
      ...authorizationInput(seed),
      uploadId: authorization.attempt.id,
      leaseDurationMs: 30_000,
    });
    expect(recovered.outcome).toBe('claimed');
    if (recovered.outcome !== 'claimed') throw new Error('expected claim');
    const finalized = await finalizeArtifactVerification(seed.handle.client, {
      uploadId: authorization.attempt.id,
      leaseId: recovered.leaseId,
      byteLength: BigInt(seed.bytes.length),
      sha256: createHash('sha256').update(seed.bytes).digest('hex'),
      verifiedAt: new Date(),
    });
    expect(finalized).toMatchObject({
      outcome: 'applied',
      attempt: { state: 'verified' },
    });
    const retry = await claimArtifactVerification(seed.handle.client, {
      ...authorizationInput(seed),
      uploadId: authorization.attempt.id,
      leaseDurationMs: 30_000,
    });
    expect(retry.outcome).toBe('verified');
    await seed.handle.dispose();
  });

  it('gives concurrent completion claims one bounded lease and one retryable result', async () => {
    const seed = await seedArtifact();
    const authorization = await authorize(seed);
    const input = {
      ...authorizationInput(seed),
      uploadId: authorization.attempt.id,
      leaseDurationMs: 30_000,
    };
    const claims = await Promise.all([
      claimArtifactVerification(seed.handle.client, input),
      claimArtifactVerification(seed.handle.client, input),
    ]);
    expect(claims.map((claim) => claim.outcome).sort()).toEqual([
      'claimed',
      'in_progress',
    ]);
    await seed.handle.dispose();
  });

  it('preserves an active verifier across capability expiry and expires only after its lease', async () => {
    const seed = await seedArtifact();
    const authorization = await authorize(seed, new Date(), 50_000_000n, 1_500);
    const owner = await claimArtifactVerification(seed.handle.client, {
      ...authorizationInput(seed),
      uploadId: authorization.attempt.id,
      leaseDurationMs: 5_000,
    });
    if (owner.outcome !== 'claimed') throw new Error('expected claim');
    await waitForDatabaseTime(1.7);

    const retries = await Promise.all([
      claimArtifactVerification(seed.handle.client, {
        ...authorizationInput(seed),
        uploadId: authorization.attempt.id,
        leaseDurationMs: 5_000,
      }),
      claimArtifactVerification(seed.handle.client, {
        ...authorizationInput(seed),
        uploadId: authorization.attempt.id,
        leaseDurationMs: 5_000,
      }),
    ]);
    expect(retries.map((retry) => retry.outcome)).toEqual([
      'in_progress',
      'in_progress',
    ]);
    await expect(
      pool.query(
        `UPDATE artifact_upload_attempts
            SET state = 'expired', verification_lease_id = NULL,
                lease_expires_at = NULL, expired_at = clock_timestamp()
          WHERE id = $1`,
        [authorization.attempt.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    const finalized = await finalizeArtifactVerification(seed.handle.client, {
      uploadId: authorization.attempt.id,
      leaseId: owner.leaseId,
      byteLength: BigInt(seed.bytes.length),
      sha256: createHash('sha256').update(seed.bytes).digest('hex'),
      verifiedAt: new Date(),
    });
    expect(finalized).toMatchObject({
      outcome: 'applied',
      attempt: { state: 'verified' },
    });

    const expiring = await seedArtifact();
    const expiringAuthorization = await authorize(
      expiring,
      new Date(),
      50_000_000n,
      1_200,
    );
    const expiringOwner = await claimArtifactVerification(
      expiring.handle.client,
      {
        ...authorizationInput(expiring),
        uploadId: expiringAuthorization.attempt.id,
        leaseDurationMs: 1_700,
      },
    );
    expect(expiringOwner.outcome).toBe('claimed');
    await waitForDatabaseTime(1.9);
    const recovered = await claimArtifactVerification(expiring.handle.client, {
      ...authorizationInput(expiring),
      uploadId: expiringAuthorization.attempt.id,
      leaseDurationMs: 5_000,
    });
    expect(recovered).toMatchObject({
      outcome: 'expired',
      attempt: { state: 'expired' },
    });
    await Promise.all([seed.handle.dispose(), expiring.handle.dispose()]);
  });

  it('blocks stale terminal writes, permits takeover, and converges old and new owners', async () => {
    const seed = await seedArtifact();
    const authorization = await authorize(seed);
    const expiredClaim = await claimArtifactVerification(seed.handle.client, {
      ...authorizationInput(seed),
      uploadId: authorization.attempt.id,
      leaseDurationMs: 50,
    });
    if (expiredClaim.outcome !== 'claimed') throw new Error('expected claim');
    await waitForDatabaseTime(0.1);

    const staleFinalize = await finalizeArtifactVerification(
      seed.handle.client,
      {
        uploadId: authorization.attempt.id,
        leaseId: expiredClaim.leaseId,
        byteLength: BigInt(seed.bytes.length),
        sha256: createHash('sha256').update(seed.bytes).digest('hex'),
        verifiedAt: new Date(),
      },
    );
    const staleReject = await rejectArtifactVerification(seed.handle.client, {
      uploadId: authorization.attempt.id,
      leaseId: expiredClaim.leaseId,
      reason: 'integrity_mismatch',
      byteLength: BigInt(seed.bytes.length),
      sha256: createHash('sha256').update(seed.bytes).digest('hex'),
      rejectedAt: new Date(),
    });
    expect(staleFinalize).toMatchObject({
      outcome: 'lease_lost',
      attempt: { state: 'verifying' },
    });
    expect(staleReject).toMatchObject({
      outcome: 'lease_lost',
      attempt: { state: 'verifying' },
    });
    await expect(
      pool.query(
        `UPDATE artifact_upload_attempts
            SET state = 'rejected', verification_lease_id = NULL,
                lease_expires_at = NULL, rejected_at = clock_timestamp(),
                last_error_code = 'object_missing'
          WHERE id = $1`,
        [authorization.attempt.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });

    const takeover = await claimArtifactVerification(seed.handle.client, {
      ...authorizationInput(seed),
      uploadId: authorization.attempt.id,
      leaseDurationMs: 30_000,
    });
    if (takeover.outcome !== 'claimed') throw new Error('expected takeover');
    const [oldOwner, newOwner] = await Promise.all([
      rejectArtifactVerification(seed.handle.client, {
        uploadId: authorization.attempt.id,
        leaseId: expiredClaim.leaseId,
        reason: 'integrity_mismatch',
        byteLength: BigInt(seed.bytes.length),
        sha256: createHash('sha256').update(seed.bytes).digest('hex'),
        rejectedAt: new Date(),
      }),
      finalizeArtifactVerification(seed.handle.client, {
        uploadId: authorization.attempt.id,
        leaseId: takeover.leaseId,
        byteLength: BigInt(seed.bytes.length),
        sha256: createHash('sha256').update(seed.bytes).digest('hex'),
        verifiedAt: new Date(),
      }),
    ]);
    expect(oldOwner.outcome).toBe('lease_lost');
    expect(newOwner).toMatchObject({
      outcome: 'applied',
      attempt: { state: 'verified' },
    });
    const winner = await pool.query<{ state: string }>(
      'SELECT state::text AS state FROM artifact_upload_attempts WHERE id = $1',
      [authorization.attempt.id],
    );
    expect(winner.rows[0]!.state).toBe('verified');
    await seed.handle.dispose();
  });

  it('leaves no false verified state after rejection, storage release, or failed finalization', async () => {
    const seed = await seedArtifact();
    const first = await authorize(seed);
    const firstClaim = await claimArtifactVerification(seed.handle.client, {
      ...authorizationInput(seed),
      uploadId: first.attempt.id,
      leaseDurationMs: 30_000,
    });
    if (firstClaim.outcome !== 'claimed') throw new Error('expected claim');
    await releaseArtifactVerification(seed.handle.client, {
      uploadId: first.attempt.id,
      leaseId: firstClaim.leaseId,
    });
    const reclaimed = await claimArtifactVerification(seed.handle.client, {
      ...authorizationInput(seed),
      uploadId: first.attempt.id,
      leaseDurationMs: 30_000,
    });
    if (reclaimed.outcome !== 'claimed') throw new Error('expected claim');
    await expect(
      finalizeArtifactVerification(seed.handle.client, {
        uploadId: first.attempt.id,
        leaseId: reclaimed.leaseId,
        byteLength: 1n,
        sha256: 'not-a-hash',
        verifiedAt: new Date(),
      }),
    ).rejects.toBeTruthy();
    const stillClaimed = await pool.query<{ state: string }>(
      'SELECT state::text AS state FROM artifact_upload_attempts WHERE id = $1',
      [first.attempt.id],
    );
    expect(stillClaimed.rows[0]!.state).toBe('verifying');
    await rejectArtifactVerification(seed.handle.client, {
      uploadId: first.attempt.id,
      leaseId: reclaimed.leaseId,
      reason: 'integrity_mismatch',
      byteLength: 1n,
      sha256: createHash('sha256').update('x').digest('hex'),
      rejectedAt: new Date(),
    });
    const replacement = await authorize(seed);
    expect(replacement.outcome).toBe('created');
    expect(replacement.attempt.objectKey).not.toBe(first.attempt.objectKey);
    const rows = await pool.query<{
      verified: string;
      declarations: string;
      references: string;
    }>(
      `SELECT
        (SELECT count(*) FROM artifact_upload_attempts WHERE organization_id = $1 AND state = 'verified') AS verified,
        (SELECT count(*) FROM artifact_declarations WHERE organization_id = $1) AS declarations,
        (SELECT count(*) FROM evidence_event_artifacts WHERE organization_id = $1) AS references`,
      [seed.organizationId],
    );
    expect(rows.rows[0]).toEqual({
      verified: '0',
      declarations: '1',
      references: '1',
    });
    await seed.handle.dispose();
  });
});
