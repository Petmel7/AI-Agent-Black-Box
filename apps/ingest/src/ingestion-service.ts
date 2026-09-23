import type { EvidenceBatch } from '@blackbox/contracts';
import type { IngestEvidenceBatchResult } from '@blackbox/database';

export interface IngestionServiceInput {
  organizationId: string;
  repositoryId: string;
  batch: EvidenceBatch;
}
export interface IngestionService {
  ingest(input: IngestionServiceInput): Promise<IngestEvidenceBatchResult>;
}
