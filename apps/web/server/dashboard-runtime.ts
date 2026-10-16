import 'server-only';

import {
  SupabaseArtifactReader,
  type ArtifactObjectReader,
} from '@blackbox/artifact-storage';
import {
  createDatabaseClient,
  listDashboardRuns,
  listDashboardTimeline,
  resolveDashboardEvidence,
  type DatabaseClientHandle,
  type DashboardEvidenceLocator,
} from '@blackbox/database';

import { deriveDashboardPresentationState } from '../lib/presentation';
import { createDashboardArtifactPreviewReader } from './artifact-preview';
import {
  loadDashboardConfig,
  type DashboardServerConfig,
} from './dashboard-config';

export interface DashboardRuntime {
  listRuns(input: {
    repositoryId?: string;
    limit: number;
    cursor?: string;
  }): ReturnType<typeof listDashboardRuns>;
  listTimeline(input: {
    repositoryId: string;
    canonicalRunId: string;
    limit: number;
    cursor?: string;
  }): ReturnType<typeof listDashboardTimeline>;
  resolveEvidence(input: {
    repositoryId: string;
    canonicalRunId: string;
    locator: DashboardEvidenceLocator;
    signal?: AbortSignal;
  }): ReturnType<typeof resolveDashboardEvidence>;
  dispose(): Promise<void>;
}

export interface DashboardRuntimeDependencies {
  config?: DashboardServerConfig;
  environment?: Readonly<Record<string, string | undefined>>;
  database?: DatabaseClientHandle;
  artifactReader?: ArtifactObjectReader;
}

export function createDashboardRuntime(
  dependencies: DashboardRuntimeDependencies = {},
): DashboardRuntime {
  const config =
    dependencies.config ?? loadDashboardConfig(dependencies.environment);
  const database =
    dependencies.database ??
    createDatabaseClient({ connectionString: config.databaseUrl });
  const artifactReader =
    dependencies.artifactReader ??
    new SupabaseArtifactReader({
      url: config.storage.url,
      serviceRoleKey: config.storage.serviceRoleKey,
      bucket: config.storage.bucket,
      connectTimeoutMs: config.storage.connectTimeoutMs,
    });
  const preview = createDashboardArtifactPreviewReader(
    artifactReader,
    config.preview,
  );
  let disposed = false;
  return {
    async listRuns(input) {
      const page = await listDashboardRuns(database.client, {
        organizationId: config.organizationId,
        cursorSigningKey: config.cursorSigningKey,
        limit: input.limit,
        ...(input.repositoryId === undefined
          ? {}
          : { repositoryId: input.repositoryId }),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      });
      return {
        ...page,
        items: page.items.map((item) => ({
          ...item,
          presentationState: deriveDashboardPresentationState({
            observedOutcome: item.observedOutcome as
              'succeeded' | 'failed' | 'cancelled' | 'unknown' | null,
            processingState: item.processingState,
            filesProcessingState: item.filesProcessingState,
            findingsProcessingState: item.findingsProcessingState,
            summaryProcessingState: item.summaryProcessingState,
            deterministicOutcome: item.deterministicOutcome as
              'pass' | 'review' | 'unknown' | null,
            summaryAvailability: item.summaryAvailability,
            summaryOutcome: item.summaryOutcome as
              'pass' | 'review' | 'unknown' | null,
          }),
        })),
      };
    },
    listTimeline(input) {
      return listDashboardTimeline(database.client, {
        organizationId: config.organizationId,
        cursorSigningKey: config.cursorSigningKey,
        repositoryId: input.repositoryId,
        canonicalRunId: input.canonicalRunId,
        limit: input.limit,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      });
    },
    resolveEvidence(input) {
      return resolveDashboardEvidence(
        database.client,
        {
          organizationId: config.organizationId,
          repositoryId: input.repositoryId,
          canonicalRunId: input.canonicalRunId,
          locator: input.locator,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        },
        preview,
      );
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await database.dispose();
    },
  };
}

let singleton: DashboardRuntime | undefined;

export function getDashboardRuntime(): DashboardRuntime {
  singleton ??= createDashboardRuntime();
  return singleton;
}

/** Test/process lifecycle hook; disposal is idempotent and clears ownership. */
export async function disposeDashboardRuntime(): Promise<void> {
  const current = singleton;
  singleton = undefined;
  await current?.dispose();
}
