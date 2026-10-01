import {
  createDatabaseClient,
  provisionProcessingQueue,
} from '@blackbox/database';

const databaseUrl = process.env.WORKER_DATABASE_URL?.trim();
if (!databaseUrl) throw new Error('WORKER_DATABASE_URL is required.');
const handle = createDatabaseClient({ connectionString: databaseUrl });
try {
  await provisionProcessingQueue(handle.client);
} finally {
  await handle.dispose();
}
