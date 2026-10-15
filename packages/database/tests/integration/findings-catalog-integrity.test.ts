import { randomUUID } from 'node:crypto';

import { EvidenceBatchSchema } from '@blackbox/contracts';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createDatabaseClient,
  ingestEvidenceBatch,
  processCoreIntent,
  processFindingsIntent,
  processSummaryIntent,
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
const summaryOptions = {
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

async function createSummary(scope: Scope): Promise<Catalog> {
  const catalog = await createCatalog(scope);
  await publishSummary(catalog);
  return catalog;
}

async function publishSummary(catalog: Catalog): Promise<void> {
  const handle = createDatabaseClient({ connectionString });
  try {
    const intent = await handle.client.processingIntent.findFirstOrThrow({
      where: { organizationId: catalog.organizationId, runId: catalog.runId },
      select: { id: true },
    });
    expect(
      await processSummaryIntent(handle.client, intent.id, summaryOptions),
    ).toBe('applied');
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

async function expectTransactionFailure(
  action: (client: PoolClient) => Promise<unknown>,
  expected: Record<string, unknown>,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await expect(action(client)).rejects.toMatchObject(expected);
  } finally {
    await rollback(client);
    client.release();
  }
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

  it('allows a complete atomic delete-and-reinsert replacement, preserves references, and invalidates the summary', async () => {
    const catalog = await createSummary(await seedScope());
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
    expect(
      (
        await pool.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM summary_run_projections WHERE run_id = $1',
          [catalog.runId],
        )
      ).rows[0]!.count,
    ).toBe('0');
  });

  it('invalidates a summary for an aggregate-preserving triggered/clear result swap', async () => {
    const catalog = await createCatalog(await seedScope());
    const clearCandidate = (
      await pool.query<{ id: string }>(
        `SELECT id FROM finding_rule_results
          WHERE run_id = $1 AND outcome = 'unknown' AND severity = 'medium'
          ORDER BY catalog_order LIMIT 1`,
        [catalog.runId],
      )
    ).rows[0]!;
    const prepare = await pool.connect();
    try {
      await prepare.query('BEGIN');
      await prepare.query(
        `UPDATE finding_rule_results
            SET outcome = 'clear', coverage = 'complete'
          WHERE id = $1`,
        [clearCandidate.id],
      );
      await prepare.query(
        `UPDATE findings_run_projections
            SET unknown_count = unknown_count - 1
          WHERE run_id = $1`,
        [catalog.runId],
      );
      await prepare.query('COMMIT');
    } finally {
      await rollback(prepare);
      prepare.release();
    }
    const triggered = (
      await pool.query<{
        id: string;
        rule_id: string;
      }>(
        `SELECT id, rule_id FROM finding_rule_results
          WHERE run_id = $1 AND outcome = 'triggered'
          ORDER BY catalog_order LIMIT 1`,
        [catalog.runId],
      )
    ).rows[0]!;
    const clear = (
      await pool.query<{
        id: string;
        rule_id: string;
      }>(
        `SELECT id, rule_id FROM finding_rule_results
          WHERE run_id = $1 AND outcome = 'clear'
          ORDER BY catalog_order LIMIT 1`,
        [catalog.runId],
      )
    ).rows[0]!;
    const reference = (
      await pool.query<{
        event_id: string;
      }>(
        `SELECT event_id FROM finding_evidence_references
          WHERE result_id = $1 ORDER BY ordinal LIMIT 1`,
        [triggered.id],
      )
    ).rows[0]!;
    await pool.query(
      `INSERT INTO finding_evidence_references
        (organization_id, run_id, result_id, ordinal, event_id)
       VALUES ($1, $2, $3, 0, $4)`,
      [catalog.organizationId, catalog.runId, clear.id, reference.event_id],
    );
    await publishSummary(catalog);

    await pool.query(
      `UPDATE finding_rule_results
          SET outcome = CASE
            WHEN rule_id = $2 THEN 'clear'
            WHEN rule_id = $3 THEN 'triggered'
            ELSE outcome
          END
        WHERE run_id = $1 AND rule_id IN ($2, $3)`,
      [catalog.runId, triggered.rule_id, clear.rule_id],
    );

    expect(
      (
        await pool.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM summary_run_projections WHERE run_id = $1',
          [catalog.runId],
        )
      ).rows[0]!.count,
    ).toBe('0');
    const projection = await pool.query<{
      triggered_count: number;
      deterministic_outcome: string;
    }>(
      'SELECT triggered_count, deterministic_outcome FROM findings_run_projections WHERE run_id = $1',
      [catalog.runId],
    );
    expect(projection.rows[0]).toEqual({
      triggered_count: 1,
      deterministic_outcome: 'review',
    });
  });

  it('invalidates material projection changes and rolls invalidation back with the mutation', async () => {
    const catalog = await createSummary(await seedScope());
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'UPDATE findings_run_projections SET analyzer_version = analyzer_version + 1 WHERE run_id = $1',
        [catalog.runId],
      );
      expect(
        (
          await client.query<{ count: string }>(
            'SELECT count(*)::text AS count FROM summary_run_projections WHERE run_id = $1',
            [catalog.runId],
          )
        ).rows[0]!.count,
      ).toBe('0');
      await client.query('ROLLBACK');
      expect(
        (
          await pool.query<{ count: string }>(
            'SELECT count(*)::text AS count FROM summary_run_projections WHERE run_id = $1',
            [catalog.runId],
          )
        ).rows[0]!.count,
      ).toBe('1');
    } finally {
      await rollback(client);
      client.release();
    }

    await pool.query(
      'UPDATE findings_run_projections SET analyzer_version = analyzer_version + 1 WHERE run_id = $1',
      [catalog.runId],
    );
    expect(
      (
        await pool.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM summary_run_projections WHERE run_id = $1',
          [catalog.runId],
        )
      ).rows[0]!.count,
    ).toBe('0');
  });

  it('requires every summary claim to have the support kind allowed by its class', async () => {
    const summary = await createSummary(await seedScope());
    const rows = await pool.query<{
      claim_class: string;
      support_kind: string;
      count: string;
    }>(
      `SELECT claim.claim_class, support.support_kind, count(*)::text AS count
         FROM summary_claims claim
         JOIN summary_claim_supports support ON support.claim_id = claim.id
        WHERE claim.run_id = $1
        GROUP BY claim.claim_class, support.support_kind`,
      [summary.runId],
    );
    expect(rows.rows.length).toBeGreaterThan(0);
    expect(
      rows.rows.every(
        (row) =>
          (row.claim_class === 'observation' &&
            row.support_kind === 'evidence') ||
          (row.claim_class !== 'observation' && row.support_kind === 'finding'),
      ),
    ).toBe(true);
    const unsupported = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM summary_claims claim
        WHERE claim.run_id = $1
          AND NOT EXISTS (SELECT 1 FROM summary_claim_supports support WHERE support.claim_id = claim.id)`,
      [summary.runId],
    );
    expect(unsupported.rows[0]!.count).toBe('0');
  });

  it('permits only complete summary evidence locator shapes', async () => {
    const summary = await createSummary(await seedScope());
    const claim = (
      await pool.query<{
        id: string;
        claim_class: string;
        support_count: number;
      }>(
        `SELECT id, claim_class, support_count FROM summary_claims
          WHERE run_id = $1 AND claim_class = 'observation'
          ORDER BY section_order, claim_order LIMIT 1`,
        [summary.runId],
      )
    ).rows[0]!;
    const evidence = (await linkedArtifacts(summary.runId))[0]!;
    const validPresence = new Set(['00000', '11100', '11111']);
    const initialSupportCount = claim.support_count;
    let nextSupportOrdinal = initialSupportCount;

    for (let value = 0; value < 32; value += 1) {
      const presence = value.toString(2).padStart(5, '0');
      const parameters = [
        summary.organizationId,
        summary.runId,
        claim.id,
        claim.claim_class,
        nextSupportOrdinal,
        evidence.eventId,
        presence[0] === '1' ? evidence.artifactId : null,
        presence[1] === '1' ? evidence.eventArtifactPointer : null,
        presence[2] === '1' ? '/tests/0' : null,
        presence[3] === '1' ? 0 : null,
        presence[4] === '1' ? `entry-${presence}` : null,
      ];
      const statement = `INSERT INTO summary_claim_supports
        (organization_id, run_id, claim_id, claim_class, ordinal,
         support_kind, event_id, artifact_declaration_id,
         event_artifact_pointer, json_pointer, file_ordinal, entry_id)
       VALUES ($1, $2, $3, $4, $5, 'evidence', $6, $7, $8, $9, $10, $11)`;
      if (!validPresence.has(presence)) {
        await expect(pool.query(statement, parameters)).rejects.toMatchObject({
          code: '23514',
          constraint: 'summary_supports_kind_check',
        });
        continue;
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(statement, parameters);
        await client.query(
          'UPDATE summary_claims SET support_count = support_count + 1 WHERE id = $1',
          [claim.id],
        );
        await client.query('COMMIT');
        nextSupportOrdinal += 1;
      } finally {
        await rollback(client);
        client.release();
      }
    }

    const stored = await pool.query<{ presence: string }>(
      `SELECT
         (CASE WHEN artifact_declaration_id IS NULL THEN '0' ELSE '1' END ||
          CASE WHEN event_artifact_pointer IS NULL THEN '0' ELSE '1' END ||
          CASE WHEN json_pointer IS NULL THEN '0' ELSE '1' END ||
          CASE WHEN file_ordinal IS NULL THEN '0' ELSE '1' END ||
         CASE WHEN entry_id IS NULL THEN '0' ELSE '1' END) AS presence
         FROM summary_claim_supports
        WHERE claim_id = $1 AND ordinal >= $2
        ORDER BY ordinal`,
      [claim.id, initialSupportCount],
    );
    expect(stored.rows.map((row) => row.presence)).toEqual([
      '00000',
      '11100',
      '11111',
    ]);
  });

  it('permits only a complete summary finding identity shape', async () => {
    const summary = await createSummary(await seedScope());
    const claim = (
      await pool.query<{
        id: string;
        claim_class: string;
        support_count: number;
      }>(
        `SELECT id, claim_class, support_count FROM summary_claims
          WHERE run_id = $1 AND claim_class = 'limitation'
          ORDER BY section_order, claim_order LIMIT 1`,
        [summary.runId],
      )
    ).rows[0]!;
    const finding = (
      await pool.query<{
        id: string;
        result_key: string;
        rule_id: string;
        rule_version: number;
        source_fingerprint: string;
      }>(
        `SELECT result.id, result.result_key, result.rule_id, result.rule_version,
                projection.source_fingerprint
           FROM finding_rule_results result
           JOIN findings_run_projections projection ON projection.run_id = result.run_id
          WHERE result.run_id = $1
            AND NOT EXISTS (
              SELECT 1 FROM summary_claim_supports support
               WHERE support.claim_id = $2 AND support.finding_result_id = result.id
            )
          ORDER BY result.catalog_order LIMIT 1`,
        [summary.runId, claim.id],
      )
    ).rows[0]!;
    const initialSupportCount = claim.support_count;
    const statement = `INSERT INTO summary_claim_supports
      (organization_id, run_id, claim_id, claim_class, ordinal,
       support_kind, finding_result_id, finding_result_key,
       finding_rule_id, finding_rule_version, findings_source_fingerprint)
     VALUES ($1, $2, $3, $4, $5, 'finding', $6, $7, $8, $9, $10)`;

    for (let value = 0; value < 32; value += 1) {
      const presence = value.toString(2).padStart(5, '0');
      const parameters = [
        summary.organizationId,
        summary.runId,
        claim.id,
        claim.claim_class,
        initialSupportCount,
        presence[0] === '1' ? finding.id : null,
        presence[1] === '1' ? finding.result_key : null,
        presence[2] === '1' ? finding.rule_id : null,
        presence[3] === '1' ? finding.rule_version : null,
        presence[4] === '1' ? finding.source_fingerprint : null,
      ];
      if (presence !== '11111') {
        await expectTransactionFailure(
          (client) => client.query(statement, parameters),
          { code: '23514', constraint: 'summary_supports_kind_check' },
        );
        continue;
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(statement, parameters);
        await client.query(
          'UPDATE summary_claims SET support_count = support_count + 1 WHERE id = $1',
          [claim.id],
        );
        await client.query('COMMIT');
      } finally {
        await rollback(client);
        client.release();
      }
    }

    const stored = await pool.query<{ presence: string }>(
      `SELECT
         (CASE WHEN finding_result_id IS NULL THEN '0' ELSE '1' END ||
          CASE WHEN finding_result_key IS NULL THEN '0' ELSE '1' END ||
          CASE WHEN finding_rule_id IS NULL THEN '0' ELSE '1' END ||
          CASE WHEN finding_rule_version IS NULL THEN '0' ELSE '1' END ||
          CASE WHEN findings_source_fingerprint IS NULL THEN '0' ELSE '1' END) AS presence
         FROM summary_claim_supports
        WHERE claim_id = $1 AND ordinal = $2`,
      [claim.id, initialSupportCount],
    );
    expect(stored.rows).toEqual([{ presence: '11111' }]);
  });

  it('rejects dangling, cross-run, cross-tenant, and partial summary support shapes', async () => {
    const scope = await seedScope();
    const source = await createSummary(scope);
    const sameTenant = await createSummary(scope);
    const crossTenant = await createSummary(await seedScope());
    const sourceClaim = (
      await pool.query<{
        id: string;
        claim_class: string;
        support_count: number;
      }>(
        `SELECT id, claim_class, support_count FROM summary_claims
          WHERE run_id = $1 AND claim_class = 'limitation'
          ORDER BY section_order, claim_order LIMIT 1`,
        [source.runId],
      )
    ).rows[0]!;
    const targetFinding = async (runId: string) =>
      (
        await pool.query<{
          id: string;
          result_key: string;
          rule_id: string;
          rule_version: number;
          source_fingerprint: string;
        }>(
          `SELECT result.id, result.result_key, result.rule_id, result.rule_version,
                  projection.source_fingerprint
             FROM finding_rule_results result
             JOIN findings_run_projections projection ON projection.run_id = result.run_id
            WHERE result.run_id = $1 ORDER BY result.catalog_order LIMIT 1`,
          [runId],
        )
      ).rows[0]!;

    const ownFinding = await targetFinding(source.runId);
    const sameTenantFinding = await targetFinding(sameTenant.runId);
    const crossTenantFinding = await targetFinding(crossTenant.runId);
    const insertFindingSupport = (
      client: PoolClient,
      target: typeof ownFinding,
      resultId = target.id,
      sourceFingerprint = ownFinding.source_fingerprint,
    ) =>
      client.query(
        `INSERT INTO summary_claim_supports
          (organization_id, run_id, claim_id, claim_class, ordinal,
           support_kind, finding_result_id, finding_result_key,
           finding_rule_id, finding_rule_version, findings_source_fingerprint)
         VALUES ($1, $2, $3, $4, $5, 'finding', $6, $7, $8, $9, $10)`,
        [
          source.organizationId,
          source.runId,
          sourceClaim.id,
          sourceClaim.claim_class,
          sourceClaim.support_count,
          resultId,
          target.result_key,
          target.rule_id,
          target.rule_version,
          sourceFingerprint,
        ],
      );

    await expectTransactionFailure(
      (client) =>
        client.query(
          `INSERT INTO summary_claim_supports
          (organization_id, run_id, claim_id, claim_class, ordinal,
           support_kind, finding_result_id)
         VALUES ($1, $2, $3, $4, $5, 'finding', $6)`,
          [
            source.organizationId,
            source.runId,
            sourceClaim.id,
            sourceClaim.claim_class,
            sourceClaim.support_count,
            ownFinding.id,
          ],
        ),
      { code: '23514', constraint: 'summary_supports_kind_check' },
    );
    await expectTransactionFailure(
      (client) => insertFindingSupport(client, ownFinding, randomUUID()),
      { code: '23503', constraint: 'summary_supports_finding_result_fkey' },
    );
    await expectTransactionFailure(
      (client) => insertFindingSupport(client, sameTenantFinding),
      { code: '23503', constraint: 'summary_supports_finding_result_fkey' },
    );
    await expectTransactionFailure(
      (client) => insertFindingSupport(client, crossTenantFinding),
      { code: '23503', constraint: 'summary_supports_finding_result_fkey' },
    );
    await expectTransactionFailure(
      (client) =>
        insertFindingSupport(
          client,
          ownFinding,
          ownFinding.id,
          sameTenantFinding.source_fingerprint,
        ),
      {
        code: '23503',
        constraint: 'summary_supports_findings_snapshot_fkey',
      },
    );

    const observation = (
      await pool.query<{
        id: string;
        claim_class: string;
        support_count: number;
      }>(
        `SELECT id, claim_class, support_count FROM summary_claims
          WHERE run_id = $1 AND claim_class = 'observation'
          ORDER BY section_order, claim_order LIMIT 1`,
        [source.runId],
      )
    ).rows[0]!;
    const eventId = async (runId: string) =>
      (
        await pool.query<{ id: string }>(
          'SELECT id FROM evidence_events WHERE run_id = $1 ORDER BY sequence LIMIT 1',
          [runId],
        )
      ).rows[0]!.id;
    const sameTenantEventId = await eventId(sameTenant.runId);
    const crossTenantEventId = await eventId(crossTenant.runId);
    const evidence = (await linkedArtifacts(source.runId))[0]!;

    await expectTransactionFailure(
      (client) =>
        client.query(
          `INSERT INTO summary_claim_supports
          (organization_id, run_id, claim_id, claim_class, ordinal,
           support_kind, finding_result_id, finding_result_key,
           finding_rule_id, finding_rule_version, findings_source_fingerprint)
         VALUES ($1, $2, $3, $4, $5, 'finding', $6, $7, $8, $9, $10)`,
          [
            source.organizationId,
            source.runId,
            observation.id,
            observation.claim_class,
            observation.support_count,
            ownFinding.id,
            ownFinding.result_key,
            ownFinding.rule_id,
            ownFinding.rule_version,
            ownFinding.source_fingerprint,
          ],
        ),
      { code: '23514', constraint: 'summary_supports_kind_check' },
    );
    await expectTransactionFailure(
      (client) =>
        client.query(
          `INSERT INTO summary_claim_supports
          (organization_id, run_id, claim_id, claim_class, ordinal,
           support_kind, event_id, artifact_declaration_id)
         VALUES ($1, $2, $3, $4, $5, 'evidence', $6, $7)`,
          [
            source.organizationId,
            source.runId,
            observation.id,
            observation.claim_class,
            observation.support_count,
            evidence.eventId,
            evidence.artifactId,
          ],
        ),
      { code: '23514', constraint: 'summary_supports_kind_check' },
    );
    for (const invalidEventId of [
      randomUUID(),
      sameTenantEventId,
      crossTenantEventId,
    ])
      await expectTransactionFailure(
        (client) =>
          client.query(
            `INSERT INTO summary_claim_supports
              (organization_id, run_id, claim_id, claim_class, ordinal,
               support_kind, event_id)
             VALUES ($1, $2, $3, $4, $5, 'evidence', $6)`,
            [
              source.organizationId,
              source.runId,
              observation.id,
              observation.claim_class,
              observation.support_count,
              invalidEventId,
            ],
          ),
        { code: '23503', constraint: 'summary_supports_org_run_event_fkey' },
      );
    await expectTransactionFailure(
      (client) =>
        client.query(
          `INSERT INTO summary_claim_supports
            (organization_id, run_id, claim_id, claim_class, ordinal,
             support_kind, event_id, artifact_declaration_id,
             event_artifact_pointer, json_pointer)
           VALUES ($1, $2, $3, $4, $5, 'evidence', $6, $7, $8, $9)`,
          [
            source.organizationId,
            source.runId,
            observation.id,
            observation.claim_class,
            observation.support_count,
            evidence.eventId,
            evidence.artifactId,
            `${evidence.eventArtifactPointer}/missing`,
            '/tests/0',
          ],
        ),
      {
        code: '23503',
        constraint: 'summary_supports_event_artifact_pointer_fkey',
      },
    );
    await expectTransactionFailure(
      async (client) => {
        await client.query(
          `INSERT INTO summary_claim_supports
            (organization_id, run_id, claim_id, claim_class, ordinal,
             support_kind, event_id, artifact_declaration_id,
             event_artifact_pointer, json_pointer)
           VALUES ($1, $2, $3, $4, $5, 'evidence', $6, $7, $8, $9)`,
          [
            source.organizationId,
            source.runId,
            observation.id,
            observation.claim_class,
            observation.support_count,
            evidence.eventId,
            evidence.artifactId,
            evidence.eventArtifactPointer,
            '/fixture-completeness',
          ],
        );
        await client.query('SET CONSTRAINTS ALL IMMEDIATE');
      },
      { code: '23514', message: 'summary_claim_support_incomplete' },
    );
  });

  it('defers incomplete support deletion and rolls back an incomplete finding replacement', async () => {
    const summary = await createSummary(await seedScope());
    const claim = (
      await pool.query<{ id: string }>(
        'SELECT id FROM summary_claims WHERE run_id = $1 ORDER BY section_order, claim_order LIMIT 1',
        [summary.runId],
      )
    ).rows[0]!;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'DELETE FROM summary_claim_supports WHERE claim_id = $1',
        [claim.id],
      );
      await expect(client.query('COMMIT')).rejects.toMatchObject({
        code: '23514',
        message: 'summary_claim_support_incomplete',
      });
    } finally {
      await rollback(client);
      client.release();
    }
    await expect(
      pool.query('DELETE FROM finding_rule_results WHERE run_id = $1', [
        summary.runId,
      ]),
    ).rejects.toMatchObject({
      code: '23514',
      message: 'findings_catalog_incomplete',
    });
    expect(
      (
        await pool.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM summary_run_projections WHERE run_id = $1',
          [summary.runId],
        )
      ).rows[0]!.count,
    ).toBe('1');
  });
});
