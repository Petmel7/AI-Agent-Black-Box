import { randomUUID } from 'node:crypto';

import { EvidenceBatchSchema } from '@blackbox/contracts';
import { createDatabaseClient, ingestEvidenceBatch } from '@blackbox/database';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function authorizedDatabaseAuthority() {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error('The E2E database authority is required.');
  const parsed = new URL(value);
  if (
    parsed.protocol !== 'postgresql:' ||
    parsed.hostname !== '127.0.0.1' ||
    parsed.port !== '55433' ||
    parsed.pathname !== '/blackbox_integration' ||
    parsed.username !== 'blackbox'
  )
    throw new Error(
      'The E2E database authority is outside the isolated scope.',
    );
  return value;
}

/** Adds one supported source run so an already-issued run-list cursor becomes stale. */
export async function replaceRunListSourceSnapshot() {
  const organizationId = process.env.DASHBOARD_ORGANIZATION_ID;
  const repositoryId = process.env.BBX_E2E_REPOSITORY_ID;
  if (!organizationId || !UUID.test(organizationId))
    throw new Error('The E2E organization identity is invalid.');
  if (!repositoryId || !UUID.test(repositoryId))
    throw new Error('The E2E repository identity is invalid.');

  const runId = randomUUID();
  const now = new Date().toISOString();
  const batch = EvidenceBatchSchema.parse({
    schemaVersion: 1,
    batchId: randomUUID(),
    runId,
    sentAt: now,
    events: [
      {
        schemaVersion: 1,
        eventId: randomUUID(),
        runId,
        sequence: 0,
        kind: 'run.started',
        observedAt: now,
        source: { component: 'collector' },
        payload: { adapter: 'codex-jsonl', provider: 'codex' },
      },
      {
        schemaVersion: 1,
        eventId: randomUUID(),
        runId,
        sequence: 1,
        kind: 'run.finished',
        observedAt: now,
        source: { component: 'collector' },
        payload: { outcome: 'succeeded', durationMs: 1 },
      },
    ],
  });
  const database = createDatabaseClient({
    connectionString: authorizedDatabaseAuthority(),
  });
  try {
    await ingestEvidenceBatch(database.client, {
      organizationId,
      repositoryId,
      batch,
    });
  } finally {
    await database.dispose();
  }
}
