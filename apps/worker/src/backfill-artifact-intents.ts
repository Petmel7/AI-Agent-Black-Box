import {
  backfillArtifactVerifiedIntents,
  createDatabaseClient,
} from '@blackbox/database';

const databaseUrl = process.env.WORKER_DATABASE_URL?.trim();
if (!databaseUrl) throw new Error('WORKER_DATABASE_URL is required.');
const rawLimit = process.env.WORKER_ARTIFACT_INTENT_BACKFILL_LIMIT ?? '1000';
const limit = Number(rawLimit);
if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000)
  throw new Error(
    'WORKER_ARTIFACT_INTENT_BACKFILL_LIMIT must be between 1 and 10000.',
  );

const handle = createDatabaseClient({ connectionString: databaseUrl });
try {
  const created = await backfillArtifactVerifiedIntents(handle.client, limit);
  process.stdout.write(`Created ${created} artifact verification intent(s).\n`);
} finally {
  await handle.dispose();
}
