import { createDatabaseClient, ingestEvidenceBatch } from '@blackbox/database';

import { buildApp } from './app.js';
import { ArtifactTransportService } from './artifact-service.js';
import { createEnvironmentArtifactStorage } from './supabase-storage.js';

const port = Number.parseInt(process.env.PORT ?? '3001', 10);
const host = process.env.HOST ?? '0.0.0.0';
const databaseUrl = process.env.DATABASE_URL;
const database = databaseUrl
  ? createDatabaseClient({ connectionString: databaseUrl })
  : undefined;
const maximumArtifactBytes = Number.parseInt(
  process.env.ARTIFACT_MAX_BYTES ?? '50000000',
  10,
);
const artifactService = database
  ? new ArtifactTransportService({
      database: database.client,
      storage: createEnvironmentArtifactStorage(),
      maximumBytes: maximumArtifactBytes,
    })
  : undefined;
const app = database
  ? buildApp({
      ingestionService: {
        ingest: (input) => ingestEvidenceBatch(database.client, input),
      },
      artifactService: artifactService!,
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
