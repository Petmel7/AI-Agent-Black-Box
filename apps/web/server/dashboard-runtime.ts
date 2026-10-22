import 'server-only';

import {
  SupabaseArtifactReader,
  type ArtifactObjectReader,
} from '@blackbox/artifact-storage';
import {
  createDatabaseClient,
  DashboardQueryError,
  getCoreRunDetail,
  listFileChanges,
  listFindings,
  listDashboardRuns,
  listDashboardTimeline,
  listSummaryClaims,
  listSummarySupports,
  resolveDashboardEvidence,
  type DatabaseClientHandle,
  type DashboardEvidenceLocator,
} from '@blackbox/database';

import { deriveDashboardPresentationState } from '../lib/presentation';
import type { DashboardPresentationState } from '../lib/presentation';
import { createDashboardArtifactPreviewReader } from './artifact-preview';
import {
  assertDashboardBrowserSnapshot,
  decodeDashboardBrowserCursor,
  DashboardBrowserCursorError,
  encodeDashboardBrowserCursor,
  type DashboardBrowserCollection,
} from './dashboard-browser-cursors';
import {
  loadDashboardConfig,
  type DashboardServerConfig,
} from './dashboard-config';

export type DashboardRunDetailView = NonNullable<
  Awaited<ReturnType<typeof getCoreRunDetail>>
> & { presentationState: DashboardPresentationState };

type DashboardRunPage = Awaited<ReturnType<typeof listDashboardRuns>>;
export type DashboardRunListView = Omit<DashboardRunPage, 'items'> & {
  items: Array<
    DashboardRunPage['items'][number] & {
      presentationState: DashboardPresentationState;
    }
  >;
};

type VisibleFilePage = Omit<
  NonNullable<Awaited<ReturnType<typeof listFileChanges>>>,
  'snapshotFingerprint'
>;
type VisibleFindingPage = Omit<
  NonNullable<Awaited<ReturnType<typeof listFindings>>>,
  'snapshotFingerprint'
>;
type VisibleClaimPage = Omit<
  NonNullable<Awaited<ReturnType<typeof listSummaryClaims>>>,
  'snapshotKey'
>;
type VisibleSupportPage = Omit<
  NonNullable<Awaited<ReturnType<typeof listSummarySupports>>>,
  'snapshotKey'
>;

export interface DashboardRuntime {
  listRuns(input: {
    repositoryId?: string;
    limit: number;
    cursor?: string;
  }): Promise<DashboardRunListView>;
  listTimeline(input: {
    repositoryId: string;
    canonicalRunId: string;
    limit: number;
    cursor?: string;
  }): ReturnType<typeof listDashboardTimeline>;
  getRunDetail(input: {
    repositoryId: string;
    canonicalRunId: string;
    limit: number;
    cursors?: Partial<Record<DashboardBrowserCollection, string>>;
  }): Promise<DashboardRunDetailView | null>;
  listFiles(input: {
    repositoryId: string;
    canonicalRunId: string;
    limit: number;
    cursor?: string;
  }): Promise<VisibleFilePage | null>;
  listFindings(input: {
    repositoryId: string;
    canonicalRunId: string;
    limit: number;
    cursor?: string;
  }): Promise<VisibleFindingPage | null>;
  listSummaryClaims(input: {
    repositoryId: string;
    canonicalRunId: string;
    limit: number;
    cursor?: string;
  }): Promise<VisibleClaimPage | null>;
  listSummarySupports(input: {
    repositoryId: string;
    canonicalRunId: string;
    claimKey: string;
    limit: number;
    cursor?: string;
  }): Promise<VisibleSupportPage | null>;
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

export function isDashboardReadRequestError(error: unknown): boolean {
  return (
    error instanceof DashboardBrowserCursorError ||
    error instanceof DashboardQueryError
  );
}

async function legacyProjectionPage<T>(
  cursorWasProvided: boolean,
  read: () => Promise<T>,
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (cursorWasProvided && error instanceof TypeError)
      throw new DashboardBrowserCursorError('stale_cursor');
    throw error;
  }
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
  const cursorScope = (
    repositoryId: string,
    canonicalRunId: string,
    collection: DashboardBrowserCollection,
    qualifier?: string,
  ) => ({
    organizationId: config.organizationId,
    repositoryId,
    canonicalRunId,
    collection,
    ...(qualifier === undefined ? {} : { qualifier }),
  });
  const decodeCursor = (
    repositoryId: string,
    canonicalRunId: string,
    collection: DashboardBrowserCollection,
    value: string | undefined,
    qualifier?: string,
  ) =>
    value === undefined
      ? undefined
      : decodeDashboardBrowserCursor(
          config.cursorSigningKey,
          cursorScope(repositoryId, canonicalRunId, collection, qualifier),
          value,
        );
  const encodeCursor = (
    repositoryId: string,
    canonicalRunId: string,
    collection: DashboardBrowserCollection,
    snapshot: string | null,
    position: string | null,
    qualifier?: string,
  ) =>
    snapshot === null || position === null
      ? null
      : encodeDashboardBrowserCursor(
          config.cursorSigningKey,
          cursorScope(repositoryId, canonicalRunId, collection, qualifier),
          snapshot,
          position,
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
    async getRunDetail(input) {
      const collections = [
        'commands',
        'tools',
        'tests',
        'gitSnapshots',
        'gitDiffs',
        'errors',
        'usage',
      ] as const;
      const decoded = Object.fromEntries(
        collections.map((collection) => [
          collection,
          decodeCursor(
            input.repositoryId,
            input.canonicalRunId,
            collection,
            input.cursors?.[collection],
          ),
        ]),
      ) as Record<
        (typeof collections)[number],
        { snapshot: string; position: string } | undefined
      >;
      const detail = await getCoreRunDetail(database.client, {
        organizationId: config.organizationId,
        repositoryId: input.repositoryId,
        canonicalRunId: input.canonicalRunId,
        childLimit: input.limit,
        childCursors: Object.fromEntries(
          collections.flatMap((collection) =>
            decoded[collection]
              ? [[collection, decoded[collection]!.position]]
              : [],
          ),
        ),
      });
      if (!detail) return null;
      const snapshot = detail.projection?.source.fingerprint ?? null;
      for (const collection of collections)
        assertDashboardBrowserSnapshot(decoded[collection]?.snapshot, snapshot);
      if (!detail.projection)
        return {
          ...detail,
          presentationState: deriveDashboardPresentationState({
            observedOutcome: null,
            processingState: detail.processingState,
            filesProcessingState: detail.filesProcessingState,
            findingsProcessingState: detail.findingsProcessingState,
            summaryProcessingState: detail.summaryProcessingState,
            deterministicOutcome: detail.deterministicOutcome as
              'pass' | 'review' | 'unknown' | null,
            summaryAvailability: detail.summaryAvailability,
            summaryOutcome: detail.summaryOutcome as
              'pass' | 'review' | 'unknown' | null,
          }),
        };
      const secureCollection = <T extends { nextCursor: string | null }>(
        collection: (typeof collections)[number],
        page: T,
      ): T => ({
        ...page,
        nextCursor: encodeCursor(
          input.repositoryId,
          input.canonicalRunId,
          collection,
          snapshot,
          page.nextCursor,
        ),
      });
      return {
        ...detail,
        presentationState: deriveDashboardPresentationState({
          observedOutcome: detail.projection.observedOutcome as
            'succeeded' | 'failed' | 'cancelled' | 'unknown' | null,
          processingState: detail.processingState,
          filesProcessingState: detail.filesProcessingState,
          findingsProcessingState: detail.findingsProcessingState,
          summaryProcessingState: detail.summaryProcessingState,
          deterministicOutcome: detail.deterministicOutcome as
            'pass' | 'review' | 'unknown' | null,
          summaryAvailability: detail.summaryAvailability,
          summaryOutcome: detail.summaryOutcome as
            'pass' | 'review' | 'unknown' | null,
        }),
        projection: {
          ...detail.projection,
          commands: secureCollection('commands', detail.projection.commands),
          tools: secureCollection('tools', detail.projection.tools),
          tests: secureCollection('tests', detail.projection.tests),
          gitSnapshots: secureCollection(
            'gitSnapshots',
            detail.projection.gitSnapshots,
          ),
          gitDiffs: secureCollection('gitDiffs', detail.projection.gitDiffs),
          errors: secureCollection('errors', detail.projection.errors),
          usage: secureCollection('usage', detail.projection.usage),
        },
      };
    },
    async listFiles(input) {
      const decoded = decodeCursor(
        input.repositoryId,
        input.canonicalRunId,
        'files',
        input.cursor,
      );
      const page = await legacyProjectionPage(decoded !== undefined, () =>
        listFileChanges(database.client, {
          organizationId: config.organizationId,
          repositoryId: input.repositoryId,
          canonicalRunId: input.canonicalRunId,
          limit: input.limit,
          ...(decoded === undefined ? {} : { cursor: decoded.position }),
        }),
      );
      if (!page) return null;
      assertDashboardBrowserSnapshot(
        decoded?.snapshot,
        page.snapshotFingerprint,
      );
      const { snapshotFingerprint, ...visible } = page;
      return {
        ...visible,
        nextCursor: encodeCursor(
          input.repositoryId,
          input.canonicalRunId,
          'files',
          snapshotFingerprint,
          page.nextCursor,
        ),
      };
    },
    async listFindings(input) {
      const decoded = decodeCursor(
        input.repositoryId,
        input.canonicalRunId,
        'findings',
        input.cursor,
      );
      const page = await legacyProjectionPage(decoded !== undefined, () =>
        listFindings(database.client, {
          organizationId: config.organizationId,
          repositoryId: input.repositoryId,
          canonicalRunId: input.canonicalRunId,
          limit: input.limit,
          ...(decoded === undefined ? {} : { cursor: decoded.position }),
        }),
      );
      if (!page) return null;
      assertDashboardBrowserSnapshot(
        decoded?.snapshot,
        page.snapshotFingerprint,
      );
      const { snapshotFingerprint, ...visible } = page;
      return {
        ...visible,
        nextCursor: encodeCursor(
          input.repositoryId,
          input.canonicalRunId,
          'findings',
          snapshotFingerprint,
          page.nextCursor,
        ),
      };
    },
    async listSummaryClaims(input) {
      const decoded = decodeCursor(
        input.repositoryId,
        input.canonicalRunId,
        'summaryClaims',
        input.cursor,
      );
      const page = await legacyProjectionPage(decoded !== undefined, () =>
        listSummaryClaims(database.client, {
          organizationId: config.organizationId,
          repositoryId: input.repositoryId,
          canonicalRunId: input.canonicalRunId,
          limit: input.limit,
          ...(decoded === undefined ? {} : { cursor: decoded.position }),
        }),
      );
      if (!page) return null;
      assertDashboardBrowserSnapshot(decoded?.snapshot, page.snapshotKey);
      const { snapshotKey, ...visible } = page;
      return {
        ...visible,
        nextCursor: encodeCursor(
          input.repositoryId,
          input.canonicalRunId,
          'summaryClaims',
          snapshotKey,
          page.nextCursor,
        ),
      };
    },
    async listSummarySupports(input) {
      const decoded = decodeCursor(
        input.repositoryId,
        input.canonicalRunId,
        'summarySupports',
        input.cursor,
        input.claimKey,
      );
      const page = await legacyProjectionPage(decoded !== undefined, () =>
        listSummarySupports(database.client, {
          organizationId: config.organizationId,
          repositoryId: input.repositoryId,
          canonicalRunId: input.canonicalRunId,
          claimKey: input.claimKey,
          limit: input.limit,
          ...(decoded === undefined ? {} : { cursor: decoded.position }),
        }),
      );
      if (!page) return null;
      assertDashboardBrowserSnapshot(decoded?.snapshot, page.snapshotKey);
      const { snapshotKey, ...visible } = page;
      return {
        ...visible,
        nextCursor: encodeCursor(
          input.repositoryId,
          input.canonicalRunId,
          'summarySupports',
          snapshotKey,
          page.nextCursor,
          input.claimKey,
        ),
      };
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
