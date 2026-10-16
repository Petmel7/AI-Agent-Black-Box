import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { DASHBOARD_AUTHENTICATED_HEADER } from '../../../../server/dashboard-auth';
import {
  DashboardConfigurationError,
  type DashboardServerConfig,
} from '../../../../server/dashboard-config';
import { createDashboardRunsHandler } from './route';

const token = 'route-secret-sentinel';
const config: DashboardServerConfig = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  accessTokenSha256: createHash('sha256').update(token).digest('hex'),
  cursorSigningKey: Buffer.alloc(32, 7),
  trustedProxyTokenSha256: createHash('sha256').update('proxy').digest('hex'),
  databaseUrl: 'postgresql://dashboard:database-secret@localhost/db',
  allowInsecureLoopback: false,
  storage: {
    url: 'https://example.supabase.co',
    serviceRoleKey: 'storage-secret-sentinel',
    bucket: 'private',
    connectTimeoutMs: 1_000,
  },
  preview: {
    maximumBytes: 1_024,
    inactivityTimeoutMs: 1_000,
    attemptTimeoutMs: 2_000,
  },
};

function request(path: string, password = token) {
  return new Request(`https://dashboard.example${path}`, {
    headers: {
      [DASHBOARD_AUTHENTICATED_HEADER]:
        password === token ? '1' : 'invalid-marker',
    },
  });
}

describe('GET /api/dashboard/runs boundary fixture', () => {
  it('never accepts organization selection from browser input', async () => {
    const listRuns = vi.fn();
    const handler = createDashboardRunsHandler({
      config: () => config,
      runtime: () => ({ listRuns }),
    });
    const response = await handler(
      request(
        `/api/dashboard/runs?organizationId=22222222-2222-4222-8222-222222222222`,
      ),
    );
    expect(response.status).toBe(400);
    expect(listRuns).not.toHaveBeenCalled();
  });

  it.each([
    '/api/dashboard/runs?limit=0',
    '/api/dashboard/runs?limit=101',
    '/api/dashboard/runs?cursor=not%2Bbase64url',
    '/api/dashboard/runs?limit=1&limit=2',
    '/api/dashboard/runs?unexpected=value',
  ])('rejects malformed or unbounded input before a read: %s', async (path) => {
    const listRuns = vi.fn();
    const handler = createDashboardRunsHandler({
      config: () => config,
      runtime: () => ({ listRuns }),
    });
    expect((await handler(request(path))).status).toBe(400);
    expect(listRuns).not.toHaveBeenCalled();
  });

  it('passes only bounded repository/filter inputs to the trusted runtime', async () => {
    const repositoryId = '22222222-2222-4222-8222-222222222222';
    const listRuns = vi.fn(async () => ({ items: [], nextCursor: null }));
    const handler = createDashboardRunsHandler({
      config: () => config,
      runtime: () => ({ listRuns }),
    });
    const response = await handler(
      request(`/api/dashboard/runs?repositoryId=${repositoryId}&limit=10`),
    );
    expect(response.status).toBe(200);
    expect(listRuns).toHaveBeenCalledWith({ repositoryId, limit: 10 });
    const serialized = await response.text();
    expect(serialized).not.toContain(config.organizationId);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(config.databaseUrl);
    expect(serialized).not.toContain(config.storage.serviceRoleKey);
  });

  it('returns the same generic challenge before any read for invalid credentials', async () => {
    const listRuns = vi.fn();
    const handler = createDashboardRunsHandler({
      config: () => config,
      runtime: () => ({ listRuns }),
    });
    const response = await handler(request('/api/dashboard/runs', 'wrong'));
    expect(response.status).toBe(401);
    expect(await response.text()).toBe('Unauthorized');
    expect(listRuns).not.toHaveBeenCalled();
  });

  it('fails closed generically before reads when server configuration is invalid', async () => {
    const listRuns = vi.fn();
    const handler = createDashboardRunsHandler({
      config: () => {
        throw new DashboardConfigurationError();
      },
      runtime: () => ({ listRuns }),
    });
    const response = await handler(request('/api/dashboard/runs'));
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('Service unavailable');
    expect(listRuns).not.toHaveBeenCalled();
  });
});
