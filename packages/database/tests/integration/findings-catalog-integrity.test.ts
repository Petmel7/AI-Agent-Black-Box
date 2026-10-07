import { randomUUID } from 'node:crypto';

import { EvidenceBatchSchema } from '@blackbox/contracts';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createDatabaseClient,
  ingestEvidenceBatch,
  processCoreIntent,
  processFindingsIntent,
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
    max: 4,
    options: `-c search_path=${configuredSchema ?? 'public'}`,
  });
});
afterAll(() => pool.end());

const coreOptions = {
  eventPageSize: 100,
  maxEvents: 100,
  maxProjectedChildren: 100,
  leaseSeconds: 30,
  attemptTimeoutMs: 20_000,
  transitionMarginMs: 1_000,
  maxAttempts: 3,
  retryBaseSeconds: 1,
  retryMaxSeconds: 5,
};

const findingsOptions = {
  leaseSeconds: 10,
  attemptTimeoutMs: 2_000,
  transitionMarginMs: 100,
  maxAttempts: 2,
  retryBaseSeconds: 1,
  retryMaxSeconds: 1,
};

const capturedCommand = {
  state: 'captured' as const,
  excerpt: 'pnpm test',
  truncated: false,
  redaction: { applied: true, rulesetVersion: 'rules-v1' },
};
const omitted = { state: 'omitted' as const };

function reportArtifact() {
  return {
    artifactId: randomUUID(),
    kind: 'test-report',
    mediaType: 'application/json',
    byteLength: 2,
    sha256: 'a'.repeat(64),
    redaction: { applied: true, rulesetVersion: 'rules-v1' },
    characterEncoding: 'utf-8',
  } as const;
}

interface Scope {
  organizationId: string;
  repositoryId: string;
}

interface Catalog extends Scope {
  canonicalRunId: string;
  runId: string;
}

async function seedScope(): Promise<Scope> {
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
  return { organizationId, repositoryId };
}

function catalogBatch(canonicalRunId = randomUUID()) {
  const firstCommandId = randomUUID();
  const secondCommandId = randomUUID();
  const firstReport = reportArtifact();
  const secondReport = reportArtifact();
  const event = (sequence: number) => ({
    schemaVersion: 1 as const,
    eventId: randomUUID(),
    runId: canonicalRunId,
    sequence,
    observedAt: '2026-10-07T00:00:00.000Z',
    source: { component: 'collector' as const },
  });

  return EvidenceBatchSchema.parse({
    schemaVersion: 1,
    batchId: randomUUID(),
    runId: canonicalRunId,
    sentAt: '2026-10-07T00:00:01.000Z',
    events: [
      {
        ...event(0),
        kind: 'run.started',
        payload: { adapter: 'codex-jsonl', provider: 'codex' },
      },
      {
        ...event(1),
        kind: 'command.started',
        payload: {
          commandId: firstCommandId,
          command: capturedCommand,
          workingDirectory: omitted,
        },
      },
      {
        ...event(2),
        kind: 'command.finished',
        payload: {
          commandId: firstCommandId,
          outcome: 'failed',
          exitCode: 1,
          stdout: omitted,
          stderr: omitted,
        },
      },
      {
        ...event(3),
        kind: 'command.started',
        payload: {
          commandId: secondCommandId,
          command: capturedCommand,
          workingDirectory: omitted,
        },
      },
      {
        ...event(4),
        kind: 'command.finished',
        payload: {
          commandId: secondCommandId,
          outcome: 'failed',
          exitCode: 1,
          stdout: omitted,
          stderr: omitted,
        },
      },
      {
        ...event(5),
        kind: 'test.run.finished',
        payload: {
          testRunId: randomUUID(),
          framework: 'vitest',
          outcome: 'passed',
          reportArtifact: firstReport,
        },
      },
      {
        ...event(6),
        kind: 'test.run.finished',
        payload: {
          testRunId: randomUUID(),
          framework: 'vitest',
          outcome: 'passed',
          reportArtifact: secondReport,
        },
      },
      {
        ...event(7),
        kind: 'run.finished',
        payload: { outcome: 'failed', durationMs: 1 },
      },
    ],
  });
}

async function createCatalog(scope: Scope): Promise<Catalog> {
  const batch = catalogBatch();
  const handle = createDatabaseClient({ connectionString });
  try {
    await ingestEvidenceBatch(handle.client, { ...scope, batch });
    const run = await handle.client.run.findUniqueOrThrow({
      where: {
        organizationId_canonicalRunId: {
          organizationId: scope.organizationId,
          canonicalRunId: batch.runId,
        },
      },
      select: { id: true },
    });
    const intent = await handle.client.processingIntent.findFirstOrThrow({
      where: {
        organizationId: scope.organizationId,
        runId: run.id,
        kind: 'EVIDENCE_BATCH_ACCEPTED',
      },
      select: { id: true },
    });
    expect(await processCoreIntent(handle.client, intent.id, coreOptions)).toBe(
      'applied',
    );
    expect(
      await processFindingsIntent(handle.client, intent.id, findingsOptions),
    ).toBe('applied');
    expect(
      await handle.client.findingRuleResult.count({ where: { runId: run.id } }),
    ).toBe(9);
    expect(
      await handle.client.findingEvidenceReference.count({
        where: {
          runId: run.id,
          result: { ruleId: 'bbx.repeated-failed-command' },
        },
      }),
    ).toBe(2);
    return { ...scope, canonicalRunId: batch.runId, runId: run.id };
  } finally {
    await handle.dispose();
  }
}

async function resultId(runId: string, ruleId: string): Promise<string> {
  return (
    await pool.query<{ id: string }>(
      'SELECT id FROM finding_rule_results WHERE run_id = $1 AND rule_id = $2',
      [runId, ruleId],
    )
  ).rows[0]!.id;
}

interface LinkedArtifact {
  eventId: string;
  artifactId: string;
  eventArtifactPointer: string;
}

async function linkedArtifacts(runId: string): Promise<LinkedArtifact[]> {
  return (
    await pool.query<LinkedArtifact>(
      `SELECT link.event_id AS "eventId", link.artifact_id AS "artifactId",
              link.json_pointer AS "eventArtifactPointer"
         FROM evidence_event_artifacts link
         JOIN evidence_events event ON event.id = link.event_id
        WHERE link.run_id = $1
        ORDER BY event.sequence, link.json_pointer`,
      [runId],
    )
  ).rows;
}

interface ReferenceInsert {
  organizationId: string;
  runId: string;
  resultId: string;
  ordinal: number;
  eventId: string;
  artifactDeclarationId: string | null;
  eventArtifactPointer: string | null;
  jsonPointer: string | null;
  fileOrdinal: number | null;
  entryId: string | null;
}

function insertReference(input: ReferenceInsert) {
  return pool.query(
    `INSERT INTO finding_evidence_references
      (organization_id, run_id, result_id, ordinal, event_id,
       artifact_declaration_id, event_artifact_pointer, json_pointer,
       file_ordinal, entry_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      input.organizationId,
      input.runId,
      input.resultId,
      input.ordinal,
      input.eventId,
      input.artifactDeclarationId,
      input.eventArtifactPointer,
      input.jsonPointer,
      input.fileOrdinal,
      input.entryId,
    ],
  );
}

async function rollback(client: PoolClient): Promise<void> {
  await client.query('ROLLBACK').catch(() => undefined);
}

describe('findings catalog ownership integrity', () => {
  it('permits only complete evidence-reference shapes across every nullable locator combination', async () => {
    const catalog = await createCatalog(await seedScope());
    const result = await resultId(catalog.runId, 'bbx.out-of-scope-change');
    const links = await linkedArtifacts(catalog.runId);
    expect(links).toHaveLength(2);
    const evidence = links[0]!;
    const validPresence = new Set(['00000', '11100', '11111']);

    for (let value = 0; value < 32; value += 1) {
      const presence = value.toString(2).padStart(5, '0');
      const hasArtifact = presence[0] === '1';
      const hasEventPointer = presence[1] === '1';
      const hasJsonPointer = presence[2] === '1';
      const hasFileOrdinal = presence[3] === '1';
      const hasEntryId = presence[4] === '1';
      const insertion = insertReference({
        organizationId: catalog.organizationId,
        runId: catalog.runId,
        resultId: result,
        ordinal: 10 + value,
        eventId: evidence.eventId,
        artifactDeclarationId: hasArtifact ? evidence.artifactId : null,
        eventArtifactPointer: hasEventPointer
          ? evidence.eventArtifactPointer
          : null,
        jsonPointer: hasJsonPointer ? '/tests/0' : null,
        fileOrdinal: hasFileOrdinal ? 0 : null,
        entryId: hasEntryId ? `entry-${presence}` : null,
      });
      if (validPresence.has(presence))
        await expect(insertion).resolves.toMatchObject({ rowCount: 1 });
      else
        await expect(insertion).rejects.toMatchObject({
          code: '23514',
          constraint: 'finding_refs_pointer_check',
        });
    }

    const stored = await pool.query<{
      artifactDeclarationId: string | null;
      eventArtifactPointer: string | null;
      jsonPointer: string | null;
      fileOrdinal: number | null;
      entryId: string | null;
    }>(
      `SELECT artifact_declaration_id AS "artifactDeclarationId",
              event_artifact_pointer AS "eventArtifactPointer",
              json_pointer AS "jsonPointer", file_ordinal AS "fileOrdinal",
              entry_id AS "entryId"
         FROM finding_evidence_references
        WHERE result_id = $1
        ORDER BY ordinal`,
      [result],
    );
    expect(
      stored.rows.map((row) =>
        [
          row.artifactDeclarationId,
          row.eventArtifactPointer,
          row.jsonPointer,
          row.fileOrdinal,
          row.entryId,
        ]
          .map((item) => (item === null ? '0' : '1'))
          .join(''),
      ),
    ).toEqual(['00000', '11100', '11111']);
  });

  it('rejects mismatched artifact, pointer, run, and tenant references', async () => {
    const scope = await seedScope();
    const source = await createCatalog(scope);
    const sameTenantTarget = await createCatalog(scope);
    const crossTenantTarget = await createCatalog(await seedScope());
    const result = await resultId(source.runId, 'bbx.out-of-scope-change');
    const sourceLinks = await linkedArtifacts(source.runId);
    const sameTenantLink = (await linkedArtifacts(sameTenantTarget.runId))[0]!;
    const crossTenantLink = (
      await linkedArtifacts(crossTenantTarget.runId)
    )[0]!;
    expect(sourceLinks).toHaveLength(2);
    const evidence = sourceLinks[0]!;
    const unrelatedArtifact = sourceLinks[1]!;
    const completeReference = {
      organizationId: source.organizationId,
      runId: source.runId,
      resultId: result,
      eventId: evidence.eventId,
      artifactDeclarationId: evidence.artifactId,
      eventArtifactPointer: evidence.eventArtifactPointer,
      jsonPointer: '/tests/0',
      fileOrdinal: null,
      entryId: null,
    };

    await expect(
      insertReference({
        ...completeReference,
        ordinal: 90,
        artifactDeclarationId: unrelatedArtifact.artifactId,
      }),
    ).rejects.toMatchObject({
      code: '23503',
      constraint: 'finding_refs_event_artifact_pointer_fkey',
    });
    await expect(
      insertReference({
        ...completeReference,
        ordinal: 91,
        eventArtifactPointer: '/payload/notReportArtifact',
      }),
    ).rejects.toMatchObject({
      code: '23503',
      constraint: 'finding_refs_event_artifact_pointer_fkey',
    });
    await expect(
      insertReference({
        ...completeReference,
        ordinal: 92,
        jsonPointer: '/bad~2escape',
      }),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'finding_refs_pointer_check',
    });
    await expect(
      insertReference({
        ...completeReference,
        artifactDeclarationId: sameTenantLink.artifactId,
        ordinal: 93,
      }),
    ).rejects.toMatchObject({
      code: '23503',
      constraint: 'finding_refs_org_run_artifact_fkey',
    });
    await expect(
      insertReference({
        ...completeReference,
        artifactDeclarationId: crossTenantLink.artifactId,
        ordinal: 94,
      }),
    ).rejects.toMatchObject({
      code: '23503',
      constraint: 'finding_refs_org_run_artifact_fkey',
    });
  });

  it('rejects direct projection, result, and reference ownership mutations', async () => {
    const scope = await seedScope();
    const source = await createCatalog(scope);
    const target = await createCatalog(scope);
    const repeatedResultId = await resultId(
      source.runId,
      'bbx.repeated-failed-command',
    );
    const unrelatedResultId = await resultId(
      source.runId,
      'bbx.out-of-scope-change',
    );
    const referenceId = (
      await pool.query<{ id: string }>(
        'SELECT id FROM finding_evidence_references WHERE result_id = $1 ORDER BY ordinal LIMIT 1',
        [repeatedResultId],
      )
    ).rows[0]!.id;

    await expect(
      pool.query(
        'UPDATE findings_run_projections SET run_id = $1 WHERE run_id = $2',
        [target.runId, source.runId],
      ),
    ).rejects.toMatchObject({
      code: '23514',
      message: 'findings_run_ownership_immutable',
    });
    await expect(
      pool.query('UPDATE finding_rule_results SET id = $1 WHERE id = $2', [
        randomUUID(),
        repeatedResultId,
      ]),
    ).rejects.toMatchObject({
      code: '23514',
      message: 'finding_result_ownership_immutable',
    });
    await expect(
      pool.query(
        'UPDATE finding_evidence_references SET result_id = $1 WHERE id = $2',
        [unrelatedResultId, referenceId],
      ),
    ).rejects.toMatchObject({
      code: '23514',
      message: 'finding_reference_ownership_immutable',
    });
  });

  it('rejects moving a result into a freed slot in another complete run', async () => {
    const scope = await seedScope();
    const source = await createCatalog(scope);
    const target = await createCatalog(scope);
    const sourceResultId = await resultId(
      source.runId,
      'bbx.repeated-failed-command',
    );
    const targetResultId = await resultId(
      target.runId,
      'bbx.repeated-failed-command',
    );
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM finding_rule_results WHERE id = $1', [
        targetResultId,
      ]);
      await expect(
        client.query(
          'UPDATE finding_rule_results SET run_id = $1 WHERE id = $2',
          [target.runId, sourceResultId],
        ),
      ).rejects.toMatchObject({
        code: '23514',
        message: 'finding_result_ownership_immutable',
      });
    } finally {
      await rollback(client);
      client.release();
    }

    const counts = await pool.query<{ run_id: string; count: string }>(
      `SELECT run_id, count(*)::text AS count
         FROM finding_rule_results
        WHERE run_id = ANY($1::uuid[])
        GROUP BY run_id`,
      [[source.runId, target.runId]],
    );
    expect(
      Object.fromEntries(counts.rows.map((row) => [row.run_id, row.count])),
    ).toEqual({ [source.runId]: '9', [target.runId]: '9' });
  });

  it('rejects moving the sole evidence reference to another run', async () => {
    const scope = await seedScope();
    const source = await createCatalog(scope);
    const target = await createCatalog(scope);
    const sourceResultId = await resultId(
      source.runId,
      'bbx.repeated-failed-command',
    );
    const targetResultId = await resultId(
      target.runId,
      'bbx.repeated-failed-command',
    );
    for (const owner of [sourceResultId, targetResultId])
      await pool.query(
        `DELETE FROM finding_evidence_references
          WHERE result_id = $1
            AND id <> (
              SELECT id FROM finding_evidence_references
               WHERE result_id = $1 ORDER BY ordinal LIMIT 1
            )`,
        [owner],
      );

    const sourceReference = (
      await pool.query<{
        id: string;
        ordinal: number;
      }>(
        'SELECT id, ordinal FROM finding_evidence_references WHERE result_id = $1',
        [sourceResultId],
      )
    ).rows[0]!;
    const targetReference = (
      await pool.query<{
        id: string;
        event_id: string;
        ordinal: number;
      }>(
        'SELECT id, event_id, ordinal FROM finding_evidence_references WHERE result_id = $1',
        [targetResultId],
      )
    ).rows[0]!;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'DELETE FROM finding_evidence_references WHERE id = $1',
        [targetReference.id],
      );
      await expect(
        client.query(
          `UPDATE finding_evidence_references
              SET run_id = $1, result_id = $2, event_id = $3, ordinal = $4
            WHERE id = $5`,
          [
            target.runId,
            targetResultId,
            targetReference.event_id,
            targetReference.ordinal,
            sourceReference.id,
          ],
        ),
      ).rejects.toMatchObject({
        code: '23514',
        message: 'finding_reference_ownership_immutable',
      });
    } finally {
      await rollback(client);
      client.release();
    }

    const counts = await pool.query<{ result_id: string; count: string }>(
      `SELECT result_id, count(*)::text AS count
         FROM finding_evidence_references
        WHERE result_id = ANY($1::uuid[])
        GROUP BY result_id`,
      [[sourceResultId, targetResultId]],
    );
    expect(
      Object.fromEntries(counts.rows.map((row) => [row.result_id, row.count])),
    ).toEqual({ [sourceResultId]: '1', [targetResultId]: '1' });
  });

  it('defers a single-result deletion until commit and rejects the incomplete catalog', async () => {
    const catalog = await createCatalog(await seedScope());
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'DELETE FROM finding_rule_results WHERE run_id = $1 AND catalog_order = 0',
        [catalog.runId],
      );
      expect(
        (
          await client.query<{ count: string }>(
            'SELECT count(*)::text AS count FROM finding_rule_results WHERE run_id = $1',
            [catalog.runId],
          )
        ).rows[0]!.count,
      ).toBe('8');
      await expect(client.query('COMMIT')).rejects.toMatchObject({
        code: '23514',
        message: 'findings_catalog_incomplete',
      });
    } finally {
      await rollback(client);
      client.release();
    }

    expect(
      (
        await pool.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM finding_rule_results WHERE run_id = $1',
          [catalog.runId],
        )
      ).rows[0]!.count,
    ).toBe('9');
  });

  it('allows a complete atomic delete-and-reinsert replacement with references preserved', async () => {
    const catalog = await createCatalog(await seedScope());
    const oldResultIds = (
      await pool.query<{ id: string }>(
        'SELECT id FROM finding_rule_results WHERE run_id = $1 ORDER BY catalog_order',
        [catalog.runId],
      )
    ).rows.map((row) => row.id);
    const referenceQuery = `
      SELECT result.rule_id AS "ruleId", reference.ordinal,
             reference.event_id AS "eventId",
             reference.artifact_declaration_id AS "artifactDeclarationId",
             reference.event_artifact_pointer AS "eventArtifactPointer",
             reference.json_pointer AS "jsonPointer",
             reference.file_ordinal AS "fileOrdinal",
             reference.entry_id AS "entryId"
        FROM finding_evidence_references reference
        JOIN finding_rule_results result ON result.id = reference.result_id
       WHERE result.run_id = $1
       ORDER BY result.rule_id, reference.ordinal`;
    const beforeReferences = (await pool.query(referenceQuery, [catalog.runId]))
      .rows;
    expect(beforeReferences).toHaveLength(2);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `CREATE TEMP TABLE bbx010_saved_results ON COMMIT DROP AS
         SELECT result.*, gen_random_uuid() AS replacement_id
           FROM finding_rule_results result
          WHERE run_id = $1`,
        [catalog.runId],
      );
      await client.query(
        `CREATE TEMP TABLE bbx010_saved_references ON COMMIT DROP AS
         SELECT reference.*, saved.replacement_id
           FROM finding_evidence_references reference
           JOIN bbx010_saved_results saved ON saved.id = reference.result_id`,
      );
      await client.query('DELETE FROM finding_rule_results WHERE run_id = $1', [
        catalog.runId,
      ]);
      await client.query(
        `INSERT INTO finding_rule_results
          (id, organization_id, run_id, result_key, catalog_order, rule_id,
           rule_version, severity, outcome, coverage, reason_codes, explanation,
           match_count, matches, matches_truncated, references_truncated)
         SELECT replacement_id, organization_id, run_id, result_key,
                catalog_order, rule_id, rule_version, severity, outcome,
                coverage, reason_codes, explanation, match_count, matches,
                matches_truncated, references_truncated
           FROM bbx010_saved_results
          ORDER BY catalog_order`,
      );
      await client.query(
        `INSERT INTO finding_evidence_references
          (id, organization_id, run_id, result_id, ordinal, event_id,
           artifact_declaration_id, event_artifact_pointer, json_pointer,
           file_ordinal, entry_id)
         SELECT gen_random_uuid(), organization_id, run_id, replacement_id,
                ordinal, event_id, artifact_declaration_id,
                event_artifact_pointer, json_pointer, file_ordinal, entry_id
           FROM bbx010_saved_references
          ORDER BY replacement_id, ordinal`,
      );
      await client.query('COMMIT');
    } finally {
      await rollback(client);
      client.release();
    }

    const newResultIds = (
      await pool.query<{ id: string }>(
        'SELECT id FROM finding_rule_results WHERE run_id = $1 ORDER BY catalog_order',
        [catalog.runId],
      )
    ).rows.map((row) => row.id);
    expect(newResultIds).toHaveLength(9);
    expect(newResultIds.some((id) => oldResultIds.includes(id))).toBe(false);
    expect((await pool.query(referenceQuery, [catalog.runId])).rows).toEqual(
      beforeReferences,
    );
  });
});
