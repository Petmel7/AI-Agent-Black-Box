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
  resolveDashboardEvidence: queryMocks.resolveEvidence,
}));

import type { DashboardServerConfig } from './dashboard-config';
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
    await runtime.dispose();
  });
});
