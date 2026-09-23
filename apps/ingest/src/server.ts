import { createDatabaseClient, ingestEvidenceBatch } from '@blackbox/database';

import { buildApp } from './app.js';

const port = Number.parseInt(process.env.PORT ?? '3001', 10);
const host = process.env.HOST ?? '0.0.0.0';
const databaseUrl = process.env.DATABASE_URL;
const database = databaseUrl
  ? createDatabaseClient({ connectionString: databaseUrl })
  : undefined;
const app = database
  ? buildApp({
      ingestionService: {
        ingest: (input) => ingestEvidenceBatch(database.client, input),
      },
      onClose: database.dispose,
    })
  : buildApp();

try {
  await app.listen({ host, port });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exitCode = 1;
}
