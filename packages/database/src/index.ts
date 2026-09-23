export {
  createDatabaseClient,
  type DatabaseAdapter,
  type DatabaseClient,
  type DatabaseClientHandle,
  type DatabaseClientOptions,
} from './client.js';
export {
  EvidenceConflictError,
  ingestEvidenceBatch,
  RepositoryNotFoundError,
  type IngestEvidenceBatchInput,
  type IngestEvidenceBatchResult,
  type IngestionFailureHooks,
} from './ingestion.js';
