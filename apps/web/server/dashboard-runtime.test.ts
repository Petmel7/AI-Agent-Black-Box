import type { ArtifactObjectReader } from '@blackbox/artifact-storage';
import type { DatabaseClientHandle } from '@blackbox/database';
import { describe, expect, it, vi } from 'vitest';

const queryMocks = vi.hoisted(() => ({
  listRuns: vi.fn(async (client: unknown, input: unknown) => {
    void client;
    void input;
    return { items: [], nextCursor: null };
  }),
  listTimeline: vi.fn(async (client: unknown, input: unknown) => {
    void client;
    void input;
    return { items: [], nextCursor: null };
  }),
  getRunDetail: vi.fn(
    async (client: unknown, input: unknown): Promise<unknown> => {
      void client;
      void input;
      return null;
    },
  ),
  listFiles: vi.fn(async (client: unknown, input: unknown) => {
    void client;
    void input;
    return {
      processingState: 'ready',
      processingErrorCode: null,
      snapshotFingerprint: 'a'.repeat(64),
      items: [],
      nextCursor: 'legacy_files' as string | null,
    };
  }),
  listFindings: vi.fn(async (client: unknown, input: unknown) => {
    void client;
    void input;
    return {
      processingState: 'ready',
      processingErrorCode: null,
      deterministicOutcome: 'pass',
      coverage: 'complete',
      snapshotFingerprint: 'b'.repeat(64),
      items: [],
      nextCursor: 'legacy_findings' as string | null,
    };
  }),
  listClaims: vi.fn(async (client: unknown, input: unknown) => {
    void client;
    void input;
    return {
      processingState: 'ready',
      summaryAvailability: 'available',
      processingErrorCode: null,
      outcome: 'pass',
      generatorVersion: 1,
      formatVersion: 1,
      templateVersion: 1,
      claimsTruncated: false,
      omittedClaimCount: 0,
      sections: [],
      snapshotKey: 'c'.repeat(64),
      items: [],
      nextCursor: 'legacy_claims' as string | null,
    };
  }),
  listSupports: vi.fn(async (client: unknown, input: unknown) => {
    void client;
    void input;
    return {
      processingState: 'ready',
      summaryAvailability: 'available',
      processingErrorCode: null,
      claimKey: 'd'.repeat(64),
      snapshotKey: 'c'.repeat(64),
      items: [],
      nextCursor: 'legacy_supports' as string | null,
    };
  }),
  resolveEvidence: vi.fn(
    async (client: unknown, input: unknown, preview: unknown) => {
      void client;
      void input;
      void preview;
      return null;
    },
  ),
}));

vi.mock('@blackbox/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@blackbox/database')>()),
  listDashboardRuns: queryMocks.listRuns,
  listDashboardTimeline: queryMocks.listTimeline,
  getCoreRunDetail: queryMocks.getRunDetail,
  listFileChanges: queryMocks.listFiles,
  listFindings: queryMocks.listFindings,
  listSummaryClaims: queryMocks.listClaims,
  listSummarySupports: queryMocks.listSupports,
  resolveDashboardEvidence: queryMocks.resolveEvidence,
}));

import type { DashboardServerConfig } from './dashboard-config';
import { decodeDashboardBrowserCursor } from './dashboard-browser-cursors';
import { createDashboardRuntime } from './dashboard-runtime';

const config: DashboardServerConfig = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  accessTokenSha256: '0'.repeat(64),
  cursorSigningKey: Buffer.alloc(32, 7),
  trustedProxyTokenSha256: '1'.repeat(64),
  databaseUrl: 'postgresql://dashboard:secret@localhost:5432/blackbox',
  allowInsecureLoopback: false,
  storage: {
    url: 'https://example.supabase.co',
    serviceRoleKey: 'secret',
    bucket: 'private',
    connectTimeoutMs: 1_000,
  },
  preview: {
    maximumBytes: 1_024,
    inactivityTimeoutMs: 1_000,
    attemptTimeoutMs: 2_000,
  },
};

describe('dashboard runtime lifecycle', () => {
  it('deterministically disposes the owned database handle once', async () => {
    const dispose = vi.fn(async () => undefined);
    const database = {
      client: {},
      dispose,
    } as unknown as DatabaseClientHandle;
    const artifactReader = {
      open: vi.fn(),
    } as unknown as ArtifactObjectReader;
    const runtime = createDashboardRuntime({
      config,
      database,
      artifactReader,
    });
    await runtime.dispose();
    await runtime.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('allowlists inputs and cannot have the configured tenant or cursor key overwritten', async () => {
    queryMocks.listRuns.mockClear();
    queryMocks.listTimeline.mockClear();
    queryMocks.resolveEvidence.mockClear();
    const database = {
      client: {},
      dispose: vi.fn(async () => undefined),
    } as unknown as DatabaseClientHandle;
    const runtime = createDashboardRuntime({
      config,
      database,
      artifactReader: { open: vi.fn() } as unknown as ArtifactObjectReader,
    });
    const attackerOrganization = '22222222-2222-4222-8222-222222222222';
    const attackerKey = Buffer.alloc(32, 9);
    await runtime.listRuns({
      limit: 5,
      organizationId: attackerOrganization,
      cursorSigningKey: attackerKey,
      injected: 'value',
    } as unknown as Parameters<typeof runtime.listRuns>[0]);
    await runtime.listTimeline({
      repositoryId: '33333333-3333-4333-8333-333333333333',
      canonicalRunId: '44444444-4444-4444-8444-444444444444',
      limit: 5,
      organizationId: attackerOrganization,
      cursorSigningKey: attackerKey,
      injected: 'value',
    } as unknown as Parameters<typeof runtime.listTimeline>[0]);
    const signal = new AbortController().signal;
    await runtime.resolveEvidence({
      repositoryId: '33333333-3333-4333-8333-333333333333',
      canonicalRunId: '44444444-4444-4444-8444-444444444444',
      locator: {
        kind: 'event',
        eventId: '55555555-5555-4555-8555-555555555555',
      },
      signal,
      organizationId: attackerOrganization,
      injected: 'value',
    } as unknown as Parameters<typeof runtime.resolveEvidence>[0]);
    const repositoryId = '33333333-3333-4333-8333-333333333333';
    const canonicalRunId = '44444444-4444-4444-8444-444444444444';
    const files = await runtime.listFiles({
      repositoryId,
      canonicalRunId,
      limit: 7,
    });
    expect(queryMocks.listRuns.mock.calls[0]?.[1]).toEqual({
      organizationId: config.organizationId,
      cursorSigningKey: config.cursorSigningKey,
      limit: 5,
    });
    expect(queryMocks.listTimeline.mock.calls[0]?.[1]).toEqual({
      organizationId: config.organizationId,
      cursorSigningKey: config.cursorSigningKey,
      repositoryId: '33333333-3333-4333-8333-333333333333',
      canonicalRunId: '44444444-4444-4444-8444-444444444444',
      limit: 5,
    });
    expect(queryMocks.resolveEvidence.mock.calls[0]?.[1]).toEqual({
      organizationId: config.organizationId,
      repositoryId: '33333333-3333-4333-8333-333333333333',
      canonicalRunId: '44444444-4444-4444-8444-444444444444',
      locator: {
        kind: 'event',
        eventId: '55555555-5555-4555-8555-555555555555',
      },
      signal,
    });
    expect(queryMocks.listFiles.mock.calls.at(-1)?.[1]).toEqual({
      organizationId: config.organizationId,
      repositoryId,
      canonicalRunId,
      limit: 7,
    });
    expect(files).not.toHaveProperty('snapshotFingerprint');
    expect(files?.nextCursor).not.toBe('legacy_files');
    expect(
      decodeDashboardBrowserCursor(
        config.cursorSigningKey,
        {
          organizationId: config.organizationId,
          repositoryId,
          canonicalRunId,
          collection: 'files',
        },
        files!.nextCursor!,
      ),
    ).toEqual({ snapshot: 'a'.repeat(64), position: 'legacy_files' });
    await runtime.dispose();
  });

  it('rejects replaced snapshots instead of restarting legacy pagination', async () => {
    const database = {
      client: {},
      dispose: vi.fn(async () => undefined),
    } as unknown as DatabaseClientHandle;
    const runtime = createDashboardRuntime({
      config,
      database,
      artifactReader: { open: vi.fn() } as unknown as ArtifactObjectReader,
    });
    const repositoryId = '33333333-3333-4333-8333-333333333333';
    const canonicalRunId = '44444444-4444-4444-8444-444444444444';
    const first = await runtime.listFiles({
      repositoryId,
      canonicalRunId,
      limit: 7,
    });
    queryMocks.listFiles.mockResolvedValueOnce({
      processingState: 'ready',
      processingErrorCode: null,
      snapshotFingerprint: 'e'.repeat(64),
      items: [],
      nextCursor: null,
    });
    await expect(
      runtime.listFiles({
        repositoryId,
        canonicalRunId,
        limit: 7,
        cursor: first!.nextCursor!,
      }),
    ).rejects.toMatchObject({ code: 'stale_cursor' });
    await runtime.dispose();
  });

  it('reissues every legacy projection continuation in the exact browser scope', async () => {
    const runtime = createDashboardRuntime({
      config,
      database: {
        client: {},
        dispose: vi.fn(async () => undefined),
      } as unknown as DatabaseClientHandle,
      artifactReader: { open: vi.fn() } as unknown as ArtifactObjectReader,
    });
    const repositoryId = '33333333-3333-4333-8333-333333333333';
    const canonicalRunId = '44444444-4444-4444-8444-444444444444';
    const claimKey = 'd'.repeat(64);
    const [findings, claims, supports] = await Promise.all([
      runtime.listFindings({ repositoryId, canonicalRunId, limit: 5 }),
      runtime.listSummaryClaims({ repositoryId, canonicalRunId, limit: 5 }),
      runtime.listSummarySupports({
        repositoryId,
        canonicalRunId,
        claimKey,
        limit: 5,
      }),
    ]);
    for (const [collection, page, snapshot, position, qualifier] of [
      ['findings', findings, 'b'.repeat(64), 'legacy_findings', undefined],
      ['summaryClaims', claims, 'c'.repeat(64), 'legacy_claims', undefined],
      [
        'summarySupports',
        supports,
        'c'.repeat(64),
        'legacy_supports',
        claimKey,
      ],
    ] as const) {
      expect(page).not.toHaveProperty('snapshotFingerprint');
      expect(page).not.toHaveProperty('snapshotKey');
      expect(page?.nextCursor).not.toBe(position);
      expect(
        decodeDashboardBrowserCursor(
          config.cursorSigningKey,
          {
            organizationId: config.organizationId,
            repositoryId,
            canonicalRunId,
            collection,
            ...(qualifier ? { qualifier } : {}),
          },
          page!.nextCursor!,
        ),
      ).toEqual({ snapshot, position });
    }
    await runtime.dispose();
  });

  it('authenticates every projected child collection cursor', async () => {
    const collections = [
      'commands',
      'tools',
      'tests',
      'gitSnapshots',
      'gitDiffs',
      'errors',
      'usage',
    ] as const;
    queryMocks.getRunDetail.mockResolvedValueOnce({
      runId: '44444444-4444-4444-8444-444444444444',
      createdAt: '2026-10-15T00:00:00.000Z',
      processingState: 'ready',
      processingErrorCode: null,
      filesProcessingState: 'ready',
      filesProcessingErrorCode: null,
      findingsProcessingState: 'ready',
      findingsProcessingErrorCode: null,
      summaryProcessingState: 'ready',
      summaryProcessingErrorCode: null,
      deterministicOutcome: 'pass',
      summaryAvailability: 'available',
      summaryOutcome: 'pass',
      projection: {
        observedOutcome: 'succeeded',
        source: { fingerprint: 'f'.repeat(64) },
        ...Object.fromEntries(
          collections.map((collection) => [
            collection,
            { items: [], nextCursor: `legacy_${collection}` },
          ]),
        ),
      },
    });
    const runtime = createDashboardRuntime({
      config,
      database: {
        client: {},
        dispose: vi.fn(async () => undefined),
      } as unknown as DatabaseClientHandle,
      artifactReader: { open: vi.fn() } as unknown as ArtifactObjectReader,
    });
    const repositoryId = '33333333-3333-4333-8333-333333333333';
    const canonicalRunId = '44444444-4444-4444-8444-444444444444';
    const detail = await runtime.getRunDetail({
      repositoryId,
      canonicalRunId,
      limit: 5,
    });
    for (const collection of collections) {
      const browserCursor = detail!.projection![collection].nextCursor!;
      expect(browserCursor).not.toBe(`legacy_${collection}`);
      expect(
        decodeDashboardBrowserCursor(
          config.cursorSigningKey,
          {
            organizationId: config.organizationId,
            repositoryId,
            canonicalRunId,
            collection,
          },
          browserCursor,
        ),
      ).toEqual({
        snapshot: 'f'.repeat(64),
        position: `legacy_${collection}`,
      });
    }
    await runtime.dispose();
  });
});
