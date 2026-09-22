import { randomUUID } from 'node:crypto';

import { PrismaPg } from '@prisma/adapter-pg';
import type { DatabaseError, Pool as PoolType } from 'pg';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { validateTestDatabaseUrl } from '../../scripts/validate-test-database-url.mjs';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error(
    'TEST_DATABASE_URL is required for database integration tests.',
  );
}

const configuredSchema = new URL(connectionString).searchParams.get('schema');
if (configuredSchema && !/^[a-z_][a-z0-9_]*$/.test(configuredSchema)) {
  throw new Error(
    'TEST_DATABASE_URL schema must be a safe PostgreSQL identifier.',
  );
}

let pool: PoolType;

type Seed = {
  organizationId: string;
  repositoryId: string;
  runId: string;
  canonicalRunId: string;
};

type RawEvent = {
  schemaVersion: 1;
  eventId: string;
  runId: string;
  sequence: number;
  kind: string;
  observedAt: string;
  occurredAt?: string;
  source: { component: 'collector' };
  payload: Record<string, unknown>;
};

type RawArtifactReference = {
  artifactId: string;
  kind: string;
  mediaType: string;
  byteLength: number;
  sha256: string;
  redaction: { applied: boolean; rulesetVersion?: string };
  compression?: string;
  characterEncoding?: string;
};

function artifactReference(
  overrides: Partial<RawArtifactReference> = {},
): RawArtifactReference {
  return {
    artifactId: randomUUID(),
    kind: 'test-report',
    mediaType: 'application/json',
    byteLength: 12,
    sha256: 'a'.repeat(64),
    redaction: { applied: false },
    characterEncoding: 'utf-8',
    ...overrides,
  };
}

function rawEvent(
  canonicalRunId: string,
  eventId: string,
  sequence: number,
  artifact?: RawArtifactReference,
): RawEvent {
  if (artifact) {
    return {
      schemaVersion: 1,
      eventId,
      runId: canonicalRunId,
      sequence,
      kind: 'test.run.finished',
      observedAt: new Date().toISOString(),
      source: { component: 'collector' },
      payload: {
        testRunId: randomUUID(),
        framework: 'vitest',
        outcome: 'passed',
        reportArtifact: artifact,
      },
    };
  }

  return {
    schemaVersion: 1,
    eventId,
    runId: canonicalRunId,
    sequence,
    kind: 'run.started',
    observedAt: new Date().toISOString(),
    source: { component: 'collector' },
    payload: { adapter: 'codex', provider: 'codex' },
  };
}

async function seedRun(
  options: {
    organizationId?: string;
    canonicalRunId?: string;
  } = {},
): Promise<Seed> {
  const organizationId =
    options.organizationId ??
    (
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
  const canonicalRunId = options.canonicalRunId ?? randomUUID();
  const runId = (
    await pool.query<{ id: string }>(
      `INSERT INTO runs (organization_id, repository_id, canonical_run_id)
       VALUES ($1, $2, $3) RETURNING id`,
      [organizationId, repositoryId, canonicalRunId],
    )
  ).rows[0]!.id;

  return { organizationId, repositoryId, runId, canonicalRunId };
}

async function insertBatch(
  seed: Seed,
  canonicalBatchId = randomUUID(),
  events = [rawEvent(seed.canonicalRunId, randomUUID(), 0)],
) {
  const rawBatch = {
    schemaVersion: 1,
    batchId: canonicalBatchId,
    runId: seed.canonicalRunId,
    sentAt: new Date().toISOString(),
    events,
  };
  return pool.query<{ id: string; received_at: Date }>(
    `INSERT INTO evidence_batches
       (organization_id, run_id, canonical_batch_id, schema_version, sent_at,
        received_at, raw_batch)
     VALUES ($1, $2, $3, 1, $4, '2000-01-01', $5)
     RETURNING id, received_at`,
    [
      seed.organizationId,
      seed.runId,
      canonicalBatchId,
      rawBatch.sentAt,
      rawBatch,
    ],
  );
}

async function insertEvent(
  seed: Seed,
  options: {
    canonicalEventId?: string;
    sequence?: bigint;
    occurredAt?: string | null;
    raw?: RawEvent;
  } = {},
) {
  const canonicalEventId =
    options.canonicalEventId ?? options.raw?.eventId ?? randomUUID();
  const sequence = options.sequence ?? BigInt(options.raw?.sequence ?? 0);
  const event =
    options.raw ??
    rawEvent(seed.canonicalRunId, canonicalEventId, Number(sequence));
  const occurredAt =
    options.occurredAt !== undefined
      ? options.occurredAt
      : (event.occurredAt ?? null);
  return pool.query<{
    id: string;
    received_at: Date;
    occurred_at: Date | null;
  }>(
    `INSERT INTO evidence_events
       (organization_id, run_id, canonical_event_id, schema_version, sequence,
        kind, observed_at, occurred_at, raw_event)
     VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8)
     RETURNING id, received_at, occurred_at`,
    [
      seed.organizationId,
      seed.runId,
      canonicalEventId,
      sequence.toString(),
      event.kind,
      event.observedAt,
      occurredAt,
      event,
    ],
  );
}

async function insertArtifact(
  seed: Seed,
  options: {
    canonicalArtifactId?: string;
    byteLength?: bigint;
    sha256?: string;
    reference?: RawArtifactReference;
  } = {},
) {
  const canonicalArtifactId =
    options.canonicalArtifactId ??
    options.reference?.artifactId ??
    randomUUID();
  const byteLength =
    options.byteLength ?? BigInt(options.reference?.byteLength ?? 12);
  const sha256 = options.sha256 ?? options.reference?.sha256 ?? 'a'.repeat(64);
  const reference =
    options.reference ??
    artifactReference({
      artifactId: canonicalArtifactId,
      byteLength: Number(byteLength),
      sha256,
    });
  return pool.query<{ id: string; received_at: Date }>(
    `INSERT INTO artifact_declarations
       (organization_id, run_id, canonical_artifact_id, kind, media_type,
        byte_length, sha256, redaction_applied, redaction_ruleset_version,
        compression, character_encoding, received_at, raw_reference)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
               '2000-01-01', $12)
     RETURNING id, received_at`,
    [
      seed.organizationId,
      seed.runId,
      canonicalArtifactId,
      reference.kind,
      reference.mediaType,
      byteLength.toString(),
      sha256,
      reference.redaction.applied,
      reference.redaction.rulesetVersion ?? null,
      reference.compression ?? null,
      reference.characterEncoding ?? null,
      reference,
    ],
  );
}

async function expectDatabaseError(
  operation: Promise<unknown>,
  code: string,
  constraint?: string,
) {
  try {
    await operation;
    throw new Error('Expected PostgreSQL to reject the operation.');
  } catch (error) {
    const databaseError = error as DatabaseError;
    expect(databaseError.code).toBe(code);
    if (constraint) {
      expect(databaseError.constraint).toBe(constraint);
    }
  }
}

beforeAll(async () => {
  pool = new Pool({
    connectionString,
    max: 2,
    options: `-c search_path=${configuredSchema ?? 'public'}`,
  });
  const schemaResult = await pool.query<{ current_schema: string }>(
    'SELECT current_schema()',
  );
  expect(schemaResult.rows[0]!.current_schema).toBe(
    configuredSchema ?? 'public',
  );
  console.log(
    `Database integration schema verified: ${schemaResult.rows[0]!.current_schema}`,
  );
  const result = await pool.query<{ migration_name: string }>(
    `SELECT migration_name FROM _prisma_migrations
     WHERE migration_name = '20260922150000_evidence_persistence_foundation'
       AND finished_at IS NOT NULL`,
  );
  expect(result.rows).toHaveLength(1);
});

afterAll(async () => {
  await pool.end();
});

describe('evidence persistence foundation', () => {
  it('persists the valid ownership hierarchy, raw JSON, membership, and artifact linkage', async () => {
    const before = Date.now() - 2_000;
    const seed = await seedRun();
    const reference = artifactReference();
    const eventDocument = rawEvent(
      seed.canonicalRunId,
      randomUUID(),
      0,
      reference,
    );
    const batch = await insertBatch(seed, randomUUID(), [eventDocument]);
    const event = await insertEvent(seed, { raw: eventDocument });
    const artifact = await insertArtifact(seed, { reference });
    const membership = await pool.query<{ id: string }>(
      `INSERT INTO evidence_batch_events
         (organization_id, run_id, batch_id, event_id, position)
       VALUES ($1, $2, $3, $4, 0) RETURNING id`,
      [seed.organizationId, seed.runId, batch.rows[0]!.id, event.rows[0]!.id],
    );
    const link = await pool.query<{ id: string }>(
      `INSERT INTO evidence_event_artifacts
         (organization_id, run_id, event_id, artifact_id, json_pointer)
       VALUES ($1, $2, $3, $4, '/payload/reportArtifact') RETURNING id`,
      [
        seed.organizationId,
        seed.runId,
        event.rows[0]!.id,
        artifact.rows[0]!.id,
      ],
    );

    expect(batch.rows[0]!.id).not.toBe(seed.runId);
    expect(batch.rows[0]!.received_at.getTime()).toBeGreaterThan(before);
    expect(event.rows[0]!.id).toBeTruthy();
    expect(artifact.rows[0]!.received_at.getTime()).toBeGreaterThan(before);
    expect(membership.rows[0]!.id).toBeTruthy();
    expect(link.rows[0]!.id).toBeTruthy();
    const stored = await pool.query<{
      raw_batch: { batchId: string };
      raw_event: RawEvent;
      raw_reference: { artifactId: string };
    }>(
      `SELECT b.raw_batch, e.raw_event, a.raw_reference
       FROM evidence_batches b
       JOIN evidence_batch_events m ON m.batch_id = b.id
       JOIN evidence_events e ON e.id = m.event_id
       JOIN evidence_event_artifacts l ON l.event_id = e.id
       JOIN artifact_declarations a ON a.id = l.artifact_id
       WHERE b.id = $1`,
      [batch.rows[0]!.id],
    );
    expect(stored.rows[0]!.raw_event.runId).toBe(seed.canonicalRunId);
    expect(stored.rows[0]!.raw_batch.batchId).toBeTruthy();
    expect(stored.rows[0]!.raw_reference.artifactId).toBeTruthy();
  });

  it('scopes canonical run and event identities to an organization', async () => {
    const canonicalRunId = randomUUID();
    const canonicalEventId = randomUUID();
    const first = await seedRun({ canonicalRunId });
    const second = await seedRun({ canonicalRunId });

    await insertEvent(first, { canonicalEventId });
    await insertEvent(second, { canonicalEventId });
  });

  it('rejects canonical run, batch, event, and artifact duplicates within an organization', async () => {
    const first = await seedRun();
    await expectDatabaseError(
      seedRun({
        organizationId: first.organizationId,
        canonicalRunId: first.canonicalRunId,
      }),
      '23505',
      'runs_org_canonical_run_id_key',
    );

    const batchId = randomUUID();
    await insertBatch(first, batchId);
    await expectDatabaseError(
      insertBatch(first, batchId),
      '23505',
      'batches_org_canonical_batch_id_key',
    );

    const eventId = randomUUID();
    await insertEvent(first, { canonicalEventId: eventId, sequence: 10n });
    await expectDatabaseError(
      insertEvent(first, { canonicalEventId: eventId, sequence: 11n }),
      '23505',
      'events_org_canonical_event_id_key',
    );

    const artifactId = randomUUID();
    await insertArtifact(first, { canonicalArtifactId: artifactId });
    await expectDatabaseError(
      insertArtifact(first, { canonicalArtifactId: artifactId }),
      '23505',
      'artifacts_org_canonical_artifact_id_key',
    );
  });

  it('enforces sequence uniqueness per run while allowing the same sequence in another run', async () => {
    const first = await seedRun();
    const second = await seedRun({ organizationId: first.organizationId });
    await insertEvent(first, { sequence: 22n });
    await expectDatabaseError(
      insertEvent(first, { sequence: 22n }),
      '23505',
      'events_run_sequence_key',
    );
    await insertEvent(second, { sequence: 22n });
  });

  it('rejects duplicate batch positions and repeated events', async () => {
    const seed = await seedRun();
    const eventDocument = rawEvent(seed.canonicalRunId, randomUUID(), 1);
    const batchId = (await insertBatch(seed, randomUUID(), [eventDocument]))
      .rows[0]!.id;
    const eventId = (await insertEvent(seed, { raw: eventDocument })).rows[0]!
      .id;
    const insertMembership = (
      targetBatchId: string,
      targetEventId: string,
      position: bigint,
    ) =>
      pool.query(
        `INSERT INTO evidence_batch_events
           (organization_id, run_id, batch_id, event_id, position)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          seed.organizationId,
          seed.runId,
          targetBatchId,
          targetEventId,
          position.toString(),
        ],
      );

    await insertMembership(batchId, eventId, 0n);
    await expectDatabaseError(
      insertMembership(batchId, eventId, 0n),
      '23505',
      'batch_events_batch_position_key',
    );

    const repeatedBatchId = (
      await insertBatch(seed, randomUUID(), [eventDocument, eventDocument])
    ).rows[0]!.id;
    await insertMembership(repeatedBatchId, eventId, 0n);
    await expectDatabaseError(
      insertMembership(repeatedBatchId, eventId, 1n),
      '23505',
      'batch_events_batch_event_key',
    );
  });

  it('rejects cross-organization and cross-run relationships', async () => {
    const first = await seedRun();
    const otherOrganization = await seedRun();
    const sameOrganization = await seedRun({
      organizationId: first.organizationId,
    });
    const batchId = (await insertBatch(first)).rows[0]!.id;
    const eventId = (await insertEvent(sameOrganization)).rows[0]!.id;

    await expectDatabaseError(
      pool.query(
        `INSERT INTO runs (organization_id, repository_id, canonical_run_id)
         VALUES ($1, $2, $3)`,
        [first.organizationId, otherOrganization.repositoryId, randomUUID()],
      ),
      '23503',
      'runs_org_repository_fkey',
    );

    await expectDatabaseError(
      pool.query(
        `INSERT INTO evidence_batch_events
           (organization_id, run_id, batch_id, event_id, position)
         VALUES ($1, $2, $3, $4, 0)`,
        [first.organizationId, first.runId, batchId, eventId],
      ),
      '23503',
      'batch_events_org_run_event_fkey',
    );

    await expectDatabaseError(
      pool.query(
        `INSERT INTO evidence_events
           (organization_id, run_id, canonical_event_id, schema_version, sequence,
            kind, observed_at, raw_event)
         VALUES ($1, $2, $3, 1, 100, 'run.started', CURRENT_TIMESTAMP, '{}'::jsonb)`,
        [otherOrganization.organizationId, first.runId, randomUUID()],
      ),
      '23503',
      'events_org_run_fkey',
    );

    const firstEventId = (await insertEvent(first, { sequence: 3n })).rows[0]!
      .id;
    const otherArtifactId = (await insertArtifact(sameOrganization)).rows[0]!
      .id;
    await expectDatabaseError(
      pool.query(
        `INSERT INTO evidence_event_artifacts
           (organization_id, run_id, event_id, artifact_id, json_pointer)
         VALUES ($1, $2, $3, $4, '/payload/artifact')`,
        [first.organizationId, first.runId, firstEventId, otherArtifactId],
      ),
      '23503',
      'event_artifacts_org_run_artifact_fkey',
    );
  });

  it('rejects every batch scalar mismatch with the immutable raw batch', async () => {
    const seed = await seedRun();
    const mutations: Array<(batch: Record<string, unknown>) => void> = [
      (batch) => {
        batch.schemaVersion = 2;
      },
      (batch) => {
        batch.batchId = randomUUID();
      },
      (batch) => {
        batch.runId = randomUUID();
      },
      (batch) => {
        batch.sentAt = new Date(Date.now() + 60_000).toISOString();
      },
    ];

    for (const mutate of mutations) {
      const batchId = randomUUID();
      const sentAt = new Date().toISOString();
      const batch: Record<string, unknown> = {
        schemaVersion: 1,
        batchId,
        runId: seed.canonicalRunId,
        sentAt,
        events: [rawEvent(seed.canonicalRunId, randomUUID(), 0)],
      };
      mutate(batch);
      await expectDatabaseError(
        pool.query(
          `INSERT INTO evidence_batches
             (organization_id, run_id, canonical_batch_id, schema_version,
              sent_at, raw_batch)
           VALUES ($1, $2, $3, 1, $4, $5)`,
          [seed.organizationId, seed.runId, batchId, sentAt, batch],
        ),
        '23514',
        'batches_raw_scalar_consistency_check',
      );
    }
  });

  it('rejects every event scalar and occurredAt mismatch with the immutable raw event', async () => {
    const seed = await seedRun();
    const cases: Array<{
      mutate(event: RawEvent): void;
      occurredAt?: string | null;
      constraint?: string;
    }> = [
      { mutate: (event) => Object.assign(event, { schemaVersion: 2 }) },
      { mutate: (event) => Object.assign(event, { eventId: randomUUID() }) },
      { mutate: (event) => Object.assign(event, { runId: randomUUID() }) },
      { mutate: (event) => Object.assign(event, { sequence: 999 }) },
      { mutate: (event) => Object.assign(event, { kind: 'run.finished' }) },
      {
        mutate: (event) =>
          Object.assign(event, {
            observedAt: new Date(Date.now() + 60_000).toISOString(),
          }),
      },
      {
        mutate: () => undefined,
        occurredAt: new Date().toISOString(),
        constraint: 'events_raw_occurred_at_consistency_check',
      },
      {
        mutate: (event) => {
          event.occurredAt = new Date().toISOString();
        },
        occurredAt: new Date(Date.now() + 60_000).toISOString(),
        constraint: 'events_raw_occurred_at_consistency_check',
      },
      {
        mutate: (event) => {
          event.occurredAt = new Date().toISOString();
        },
        occurredAt: null,
        constraint: 'events_raw_occurred_at_consistency_check',
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      const eventId = randomUUID();
      const sequence = 1_000 + index;
      const event = rawEvent(seed.canonicalRunId, eventId, sequence);
      const scalarObservedAt = event.observedAt;
      const scalarKind = event.kind;
      testCase.mutate(event);
      await expectDatabaseError(
        pool.query(
          `INSERT INTO evidence_events
             (organization_id, run_id, canonical_event_id, schema_version,
              sequence, kind, observed_at, occurred_at, raw_event)
           VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8)`,
          [
            seed.organizationId,
            seed.runId,
            eventId,
            sequence,
            scalarKind,
            scalarObservedAt,
            testCase.occurredAt ?? null,
            event,
          ],
        ),
        '23514',
        testCase.constraint ?? 'events_raw_scalar_consistency_check',
      );
    }
  });

  it('rejects every artifact scalar mismatch with the immutable raw reference', async () => {
    const seed = await seedRun();
    const mutations: Array<(reference: RawArtifactReference) => void> = [
      (reference) => Object.assign(reference, { artifactId: randomUUID() }),
      (reference) => Object.assign(reference, { kind: 'other-kind' }),
      (reference) => Object.assign(reference, { mediaType: 'text/plain' }),
      (reference) => Object.assign(reference, { byteLength: 13 }),
      (reference) => Object.assign(reference, { sha256: 'b'.repeat(64) }),
      (reference) =>
        Object.assign(reference, {
          redaction: { applied: true, rulesetVersion: 'rules-v1' },
        }),
      (reference) => Object.assign(reference, { compression: 'gzip' }),
      (reference) => Object.assign(reference, { characterEncoding: 'utf-16' }),
    ];

    for (const mutate of mutations) {
      const artifactId = randomUUID();
      const reference = artifactReference({ artifactId });
      mutate(reference);
      await expectDatabaseError(
        pool.query(
          `INSERT INTO artifact_declarations
             (organization_id, run_id, canonical_artifact_id, kind, media_type,
              byte_length, sha256, redaction_applied, character_encoding,
              raw_reference)
           VALUES ($1, $2, $3, 'test-report', 'application/json', 12, $4,
                   false, 'utf-8', $5)`,
          [
            seed.organizationId,
            seed.runId,
            artifactId,
            'a'.repeat(64),
            reference,
          ],
        ),
        '23514',
        'artifacts_raw_scalar_consistency_check',
      );
    }
  });

  it('binds membership position and event to raw_batch.events', async () => {
    const seed = await seedRun();
    const firstDocument = rawEvent(seed.canonicalRunId, randomUUID(), 30);
    const secondDocument = rawEvent(seed.canonicalRunId, randomUUID(), 31);
    const batchId = (await insertBatch(seed, randomUUID(), [firstDocument]))
      .rows[0]!.id;
    const firstEventId = (await insertEvent(seed, { raw: firstDocument }))
      .rows[0]!.id;
    const secondEventId = (await insertEvent(seed, { raw: secondDocument }))
      .rows[0]!.id;

    await expectDatabaseError(
      pool.query(
        `INSERT INTO evidence_batch_events
           (organization_id, run_id, batch_id, event_id, position)
         VALUES ($1, $2, $3, $4, 0)`,
        [seed.organizationId, seed.runId, batchId, secondEventId],
      ),
      '23514',
      'batch_events_raw_event_consistency_check',
    );
    await expectDatabaseError(
      pool.query(
        `INSERT INTO evidence_batch_events
           (organization_id, run_id, batch_id, event_id, position)
         VALUES ($1, $2, $3, $4, 1)`,
        [seed.organizationId, seed.runId, batchId, firstEventId],
      ),
      '23514',
      'batch_events_raw_position_check',
    );
  });

  it('requires artifact pointers to resolve to the complete linked reference', async () => {
    const seed = await seedRun();
    const declaration = artifactReference();
    const artifactId = (await insertArtifact(seed, { reference: declaration }))
      .rows[0]!.id;
    const matchingEvent = rawEvent(
      seed.canonicalRunId,
      randomUUID(),
      40,
      declaration,
    );
    const matchingEventId = (await insertEvent(seed, { raw: matchingEvent }))
      .rows[0]!.id;
    const insertLink = (eventId: string, pointer: string) =>
      pool.query(
        `INSERT INTO evidence_event_artifacts
           (organization_id, run_id, event_id, artifact_id, json_pointer)
         VALUES ($1, $2, $3, $4, $5)`,
        [seed.organizationId, seed.runId, eventId, artifactId, pointer],
      );

    await expectDatabaseError(
      insertLink(matchingEventId, '/payload/missing'),
      '23514',
      'event_artifacts_reference_match_check',
    );
    await expectDatabaseError(
      insertLink(matchingEventId, '/payload/framework'),
      '23514',
      'event_artifacts_reference_match_check',
    );

    const wrongIdEvent = rawEvent(seed.canonicalRunId, randomUUID(), 41, {
      ...declaration,
      artifactId: randomUUID(),
    });
    const wrongIdEventId = (await insertEvent(seed, { raw: wrongIdEvent }))
      .rows[0]!.id;
    await expectDatabaseError(
      insertLink(wrongIdEventId, '/payload/reportArtifact'),
      '23514',
      'event_artifacts_reference_match_check',
    );

    const wrongIntegrityEvent = rawEvent(
      seed.canonicalRunId,
      randomUUID(),
      42,
      { ...declaration, sha256: 'b'.repeat(64) },
    );
    const wrongIntegrityEventId = (
      await insertEvent(seed, { raw: wrongIntegrityEvent })
    ).rows[0]!.id;
    await expectDatabaseError(
      insertLink(wrongIntegrityEventId, '/payload/reportArtifact'),
      '23514',
      'event_artifacts_reference_match_check',
    );
  });

  it('rejects unsupported schema versions and malformed canonical UUIDs', async () => {
    const seed = await seedRun();
    const unsupportedEventId = randomUUID();
    const unsupportedObservedAt = new Date().toISOString();
    const unsupportedEvent = {
      ...rawEvent(seed.canonicalRunId, unsupportedEventId, 0),
      schemaVersion: 2,
      observedAt: unsupportedObservedAt,
    };
    await expectDatabaseError(
      pool.query(
        `INSERT INTO evidence_events
           (organization_id, run_id, canonical_event_id, schema_version, sequence,
            kind, observed_at, raw_event)
         VALUES ($1, $2, $3, 2, 0, 'run.started', $4, $5)`,
        [
          seed.organizationId,
          seed.runId,
          unsupportedEventId,
          unsupportedObservedAt,
          unsupportedEvent,
        ],
      ),
      '23514',
      'events_schema_version_check',
    );
    const unsupportedBatchId = randomUUID();
    const unsupportedSentAt = new Date().toISOString();
    const unsupportedBatch = {
      schemaVersion: 2,
      batchId: unsupportedBatchId,
      runId: seed.canonicalRunId,
      sentAt: unsupportedSentAt,
      events: [unsupportedEvent],
    };
    await expectDatabaseError(
      pool.query(
        `INSERT INTO evidence_batches
           (organization_id, run_id, canonical_batch_id, schema_version, sent_at,
            raw_batch)
         VALUES ($1, $2, $3, 2, $4, $5)`,
        [
          seed.organizationId,
          seed.runId,
          unsupportedBatchId,
          unsupportedSentAt,
          unsupportedBatch,
        ],
      ),
      '23514',
      'batches_schema_version_check',
    );
    await expectDatabaseError(
      pool.query(
        `INSERT INTO evidence_events
           (organization_id, run_id, canonical_event_id, schema_version, sequence,
            kind, observed_at, raw_event)
         VALUES ($1, $2, 'not-a-uuid', 1, 0, 'run.started', CURRENT_TIMESTAMP,
                 '{}'::jsonb)`,
        [seed.organizationId, seed.runId],
      ),
      '22P02',
    );
  });

  it.each([-1n, 9_007_199_254_740_992n])(
    'rejects out-of-range event sequence %s',
    async (sequence) => {
      await expectDatabaseError(
        insertEvent(await seedRun(), { sequence }),
        '23514',
        'events_sequence_safe_integer_check',
      );
    },
  );

  it.each([-1n, 9_007_199_254_740_992n])(
    'rejects out-of-range batch position %s',
    async (position) => {
      const seed = await seedRun();
      const batchId = (await insertBatch(seed)).rows[0]!.id;
      const eventId = (await insertEvent(seed)).rows[0]!.id;
      await expectDatabaseError(
        pool.query(
          `INSERT INTO evidence_batch_events
             (organization_id, run_id, batch_id, event_id, position)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            seed.organizationId,
            seed.runId,
            batchId,
            eventId,
            position.toString(),
          ],
        ),
        '23514',
        'batch_events_position_safe_integer_check',
      );
    },
  );

  it.each([-1n, 9_007_199_254_740_992n])(
    'rejects out-of-range artifact byte length %s',
    async (byteLength) => {
      await expectDatabaseError(
        insertArtifact(await seedRun(), { byteLength }),
        '23514',
        'artifacts_byte_length_safe_integer_check',
      );
    },
  );

  it.each(['not-a-hash', 'A'.repeat(64)])(
    'rejects malformed artifact SHA-256 %s',
    async (sha256) => {
      await expectDatabaseError(
        insertArtifact(await seedRun(), { sha256 }),
        '23514',
        'artifacts_sha256_lowercase_check',
      );
    },
  );

  it('authors receipt timestamps in PostgreSQL and leaves occurredAt nullable', async () => {
    const seed = await seedRun();
    const before = Date.now() - 2_000;
    const eventId = randomUUID();
    const event = rawEvent(seed.canonicalRunId, eventId, 0);
    const result = await pool.query<{
      received_at: Date;
      occurred_at: Date | null;
    }>(
      `INSERT INTO evidence_events
         (organization_id, run_id, canonical_event_id, schema_version, sequence,
          kind, observed_at, occurred_at, received_at, raw_event)
       VALUES ($1, $2, $3, 1, 0, $4, $5, NULL, '2000-01-01', $6)
       RETURNING received_at, occurred_at`,
      [
        seed.organizationId,
        seed.runId,
        eventId,
        event.kind,
        event.observedAt,
        event,
      ],
    );

    expect(result.rows[0]!.received_at.getTime()).toBeGreaterThan(before);
    expect(result.rows[0]!.occurred_at).toBeNull();
  });

  it('accepts matching six-digit sentAt at TIMESTAMPTZ(3) storage precision', async () => {
    const seed = await seedRun();
    const sentAt = '2026-09-22T12:34:56.123456Z';
    const batchId = randomUUID();
    const batch = {
      schemaVersion: 1,
      batchId,
      runId: seed.canonicalRunId,
      sentAt,
      events: [rawEvent(seed.canonicalRunId, randomUUID(), 0)],
    };
    const result = await pool.query<{ sent_at: Date }>(
      `INSERT INTO evidence_batches
         (organization_id, run_id, canonical_batch_id, schema_version, sent_at,
          raw_batch)
       VALUES ($1, $2, $3, 1, $4, $5)
       RETURNING sent_at`,
      [seed.organizationId, seed.runId, batchId, sentAt, batch],
    );

    expect(result.rows[0]!.sent_at.toISOString()).toBe(
      '2026-09-22T12:34:56.123Z',
    );
  });

  it('accepts matching six-digit observedAt at TIMESTAMPTZ(3) storage precision', async () => {
    const seed = await seedRun();
    const observedAt = '2026-09-22T12:34:56.123456Z';
    const event = {
      ...rawEvent(seed.canonicalRunId, randomUUID(), 70),
      observedAt,
    };
    const result = await insertEvent(seed, { raw: event });

    expect(result.rows[0]!.id).toBeTruthy();
  });

  it('accepts matching six-digit occurredAt at TIMESTAMPTZ(3) storage precision', async () => {
    const seed = await seedRun();
    const occurredAt = '2026-09-22T12:34:56.123456Z';
    const event = {
      ...rawEvent(seed.canonicalRunId, randomUUID(), 71),
      occurredAt,
    };
    const result = await insertEvent(seed, { raw: event });

    expect(result.rows[0]!.occurred_at?.toISOString()).toBe(
      '2026-09-22T12:34:56.123Z',
    );
  });

  it('rejects updates and deletes for every append-only raw table', async () => {
    const seed = await seedRun();
    const reference = artifactReference();
    const eventDocument = rawEvent(
      seed.canonicalRunId,
      randomUUID(),
      0,
      reference,
    );
    const batchId = (await insertBatch(seed, randomUUID(), [eventDocument]))
      .rows[0]!.id;
    const eventId = (await insertEvent(seed, { raw: eventDocument })).rows[0]!
      .id;
    const artifactId = (await insertArtifact(seed, { reference })).rows[0]!.id;
    const membershipId = (
      await pool.query<{ id: string }>(
        `INSERT INTO evidence_batch_events
           (organization_id, run_id, batch_id, event_id, position)
         VALUES ($1, $2, $3, $4, 0) RETURNING id`,
        [seed.organizationId, seed.runId, batchId, eventId],
      )
    ).rows[0]!.id;
    const linkId = (
      await pool.query<{ id: string }>(
        `INSERT INTO evidence_event_artifacts
           (organization_id, run_id, event_id, artifact_id, json_pointer)
         VALUES ($1, $2, $3, $4, '/payload/reportArtifact') RETURNING id`,
        [seed.organizationId, seed.runId, eventId, artifactId],
      )
    ).rows[0]!.id;
    const rows = [
      ['evidence_batches', batchId],
      ['evidence_events', eventId],
      ['evidence_batch_events', membershipId],
      ['artifact_declarations', artifactId],
      ['evidence_event_artifacts', linkId],
    ] as const;

    for (const [table, id] of rows) {
      await expectDatabaseError(
        pool.query(`UPDATE ${table} SET id = id WHERE id = $1`, [id]),
        '55000',
      );
      await expectDatabaseError(
        pool.query(`DELETE FROM ${table} WHERE id = $1`, [id]),
        '55000',
      );
    }
  });

  it('rejects TRUNCATE for every append-only raw table', async () => {
    const tables = [
      'evidence_batches',
      'evidence_events',
      'evidence_batch_events',
      'artifact_declarations',
      'evidence_event_artifacts',
    ] as const;

    for (const table of tables) {
      await expectDatabaseError(
        pool.query(`TRUNCATE TABLE ${table} CASCADE`),
        '55000',
      );
    }
  });

  it('prevents parent deletion from cascading raw evidence away', async () => {
    const seed = await seedRun();
    const eventId = (await insertEvent(seed)).rows[0]!.id;
    await expectDatabaseError(
      pool.query('DELETE FROM runs WHERE id = $1', [seed.runId]),
      '23503',
    );
    const remaining = await pool.query<{ count: string }>(
      'SELECT count(*) FROM evidence_events WHERE id = $1',
      [eventId],
    );
    expect(remaining.rows[0]!.count).toBe('1');
  });

  it('imports without connection configuration and disposes an explicit client', async () => {
    const savedDatabaseUrl = process.env.DATABASE_URL;
    const savedDirectUrl = process.env.DIRECT_URL;
    const savedTestDatabaseUrl = process.env.TEST_DATABASE_URL;
    delete process.env.DATABASE_URL;
    delete process.env.DIRECT_URL;
    delete process.env.TEST_DATABASE_URL;
    const { createDatabaseClient } = await import('../../src/index.js');
    if (savedDatabaseUrl !== undefined)
      process.env.DATABASE_URL = savedDatabaseUrl;
    if (savedDirectUrl !== undefined) process.env.DIRECT_URL = savedDirectUrl;
    if (savedTestDatabaseUrl !== undefined) {
      process.env.TEST_DATABASE_URL = savedTestDatabaseUrl;
    }

    expect(() =>
      createDatabaseClient({} as { connectionString: string }),
    ).toThrow('requires an explicit connection string or adapter');

    const handle = createDatabaseClient({ connectionString });
    const result = await handle.client.$queryRaw<Array<{ value: number }>>`
      SELECT 1 AS value
    `;
    expect(result).toEqual([{ value: 1 }]);
    await handle.dispose();
  });

  it('rejects incomplete PostgreSQL authorities without driver fallback', async () => {
    const incompleteUrls = [
      'postgresql:///blackbox_test',
      'postgresql://localhost/blackbox_test',
      'postgresql://@localhost/blackbox_test',
    ];
    const { createDatabaseClient } = await import('../../src/index.js');

    for (const incompleteUrl of incompleteUrls) {
      expect(() => validateTestDatabaseUrl(incompleteUrl)).toThrow(
        'explicit hostname and username',
      );
      expect(() =>
        createDatabaseClient({ connectionString: incompleteUrl }),
      ).toThrow('explicit hostname and username');
    }

    expect(validateTestDatabaseUrl(connectionString)).toBe(connectionString);
  });

  it('accepts an injected adapter and disposes it explicitly', async () => {
    const { createDatabaseClient } = await import('../../src/index.js');
    const handle = createDatabaseClient({
      adapter: new PrismaPg({ connectionString }),
    });
    await expect(handle.client.organization.count()).resolves.toBeGreaterThan(
      0,
    );
    await handle.dispose();
  });
});
