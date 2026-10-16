import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  DashboardConfigurationError,
  loadDashboardConfig,
} from './dashboard-config';

const tokenDigest = createHash('sha256')
  .update('dashboard-token')
  .digest('hex');
const proxyDigest = createHash('sha256').update('p'.repeat(43)).digest('hex');
const cursorKeyBytes = Buffer.alloc(32, 7);
const cursorKey = cursorKeyBytes.toString('base64url');
const storageCredential = 'storage-secret-sentinel';

function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function environment(
  values: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    DASHBOARD_ORGANIZATION_ID: '11111111-1111-4111-8111-111111111111',
    DASHBOARD_ACCESS_TOKEN_SHA256: tokenDigest,
    DASHBOARD_CURSOR_SIGNING_KEY: cursorKey,
    DASHBOARD_TRUSTED_PROXY_TOKEN_SHA256: proxyDigest,
    DATABASE_URL: 'postgresql://dashboard:secret@localhost:5432/blackbox',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: storageCredential,
    ARTIFACT_STORAGE_BUCKET: 'private-evidence',
    ...values,
  };
}

describe('dashboard server configuration', () => {
  it('parses the complete strict server-only configuration', () => {
    expect(loadDashboardConfig(environment())).toMatchObject({
      organizationId: '11111111-1111-4111-8111-111111111111',
      accessTokenSha256: tokenDigest,
      trustedProxyTokenSha256: proxyDigest,
      allowInsecureLoopback: false,
      preview: {
        maximumBytes: 65_536,
        inactivityTimeoutMs: 15_000,
        attemptTimeoutMs: 30_000,
      },
    });
  });

  it.each([
    ['DASHBOARD_ORGANIZATION_ID', undefined],
    ['DASHBOARD_ORGANIZATION_ID', 'not-a-uuid'],
    ['DASHBOARD_ACCESS_TOKEN_SHA256', undefined],
    ['DASHBOARD_ACCESS_TOKEN_SHA256', tokenDigest.toUpperCase()],
    ['DASHBOARD_CURSOR_SIGNING_KEY', undefined],
    ['DASHBOARD_CURSOR_SIGNING_KEY', `${cursorKey}=`],
    ['DASHBOARD_CURSOR_SIGNING_KEY', Buffer.alloc(31).toString('base64url')],
    ['DASHBOARD_TRUSTED_PROXY_TOKEN_SHA256', undefined],
    ['DASHBOARD_TRUSTED_PROXY_TOKEN_SHA256', proxyDigest.toUpperCase()],
    ['DATABASE_URL', undefined],
    ['DATABASE_URL', 'https://database.example'],
    ['SUPABASE_URL', undefined],
    ['SUPABASE_URL', 'http://storage.example'],
    ['SUPABASE_URL', 'ftp://localhost'],
    ['SUPABASE_SERVICE_ROLE_KEY', undefined],
    ['ARTIFACT_STORAGE_BUCKET', '../unsafe'],
    ['DASHBOARD_ALLOW_INSECURE_LOOPBACK', 'yes'],
    ['DASHBOARD_PREVIEW_MAX_BYTES', '262145'],
    ['DASHBOARD_PREVIEW_CONNECT_TIMEOUT_MS', '60001'],
    ['DASHBOARD_PREVIEW_INACTIVITY_TIMEOUT_MS', '0'],
    ['DASHBOARD_PREVIEW_ATTEMPT_TIMEOUT_MS', '-1'],
  ])('fails closed for %s=%s', (name, value) => {
    expect(() => loadDashboardConfig(environment({ [name]: value }))).toThrow(
      DashboardConfigurationError,
    );
  });

  it('rejects reuse of the ingestion credential', () => {
    expect(() =>
      loadDashboardConfig(
        environment({ INGEST_BEARER_TOKEN_SHA256: tokenDigest }),
      ),
    ).toThrow(DashboardConfigurationError);
  });

  it('rejects direct reuse of the cursor key as another credential', () => {
    const cursorCredentialDigest = digest(cursorKey);
    for (const values of [
      { DASHBOARD_ACCESS_TOKEN_SHA256: cursorCredentialDigest },
      { INGEST_BEARER_TOKEN_SHA256: cursorCredentialDigest },
      { DASHBOARD_TRUSTED_PROXY_TOKEN_SHA256: cursorCredentialDigest },
    ])
      expect(() => loadDashboardConfig(environment(values))).toThrow(
        DashboardConfigurationError,
      );
  });

  it.each([
    ['dashboard/ingestion', { INGEST_BEARER_TOKEN_SHA256: tokenDigest }],
    ['dashboard/proxy', { DASHBOARD_TRUSTED_PROXY_TOKEN_SHA256: tokenDigest }],
    [
      'dashboard/cursor text',
      { DASHBOARD_ACCESS_TOKEN_SHA256: digest(cursorKey) },
    ],
    [
      'dashboard/cursor bytes',
      { DASHBOARD_ACCESS_TOKEN_SHA256: digest(cursorKeyBytes) },
    ],
    [
      'dashboard/storage',
      { DASHBOARD_ACCESS_TOKEN_SHA256: digest(storageCredential) },
    ],
    ['ingestion/proxy', { INGEST_BEARER_TOKEN_SHA256: proxyDigest }],
    [
      'ingestion/cursor text',
      { INGEST_BEARER_TOKEN_SHA256: digest(cursorKey) },
    ],
    [
      'ingestion/cursor bytes',
      { INGEST_BEARER_TOKEN_SHA256: digest(cursorKeyBytes) },
    ],
    [
      'ingestion/storage',
      { INGEST_BEARER_TOKEN_SHA256: digest(storageCredential) },
    ],
    [
      'proxy/cursor text',
      { DASHBOARD_TRUSTED_PROXY_TOKEN_SHA256: digest(cursorKey) },
    ],
    [
      'proxy/cursor bytes',
      { DASHBOARD_TRUSTED_PROXY_TOKEN_SHA256: digest(cursorKeyBytes) },
    ],
    ['cursor/storage text', { SUPABASE_SERVICE_ROLE_KEY: cursorKey }],
    [
      'cursor/storage bytes',
      { SUPABASE_SERVICE_ROLE_KEY: cursorKeyBytes.toString('utf8') },
    ],
  ])('rejects %s credential reuse', (_name, values) => {
    let thrown: unknown;
    try {
      loadDashboardConfig(environment(values));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DashboardConfigurationError);
    expect((thrown as Error).message).toBe(
      'Dashboard configuration is invalid.',
    );
    const serialized = JSON.stringify(
      thrown,
      Object.getOwnPropertyNames(thrown as object),
    );
    for (const value of Object.values(values))
      expect(serialized).not.toContain(value);
  });

  it('rejects a raw proxy token reused as the storage credential', () => {
    const sharedCredential = Buffer.alloc(32, 11).toString('base64url');
    const values = {
      DASHBOARD_TRUSTED_PROXY_TOKEN_SHA256: digest(sharedCredential),
      SUPABASE_SERVICE_ROLE_KEY: sharedCredential,
    };
    let thrown: unknown;
    try {
      loadDashboardConfig(environment(values));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DashboardConfigurationError);
    expect((thrown as DashboardConfigurationError).code).toBe(
      'dashboard_configuration_invalid',
    );
    expect(
      JSON.stringify(thrown, Object.getOwnPropertyNames(thrown as object)),
    ).not.toContain(sharedCredential);
    expect(
      JSON.stringify(thrown, Object.getOwnPropertyNames(thrown as object)),
    ).not.toContain(values.DASHBOARD_TRUSTED_PROXY_TOKEN_SHA256);
  });

  it.each([
    'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.signature',
    'sb_secret_service-role-format',
    'opaque-service-role+/=_value',
  ])('preserves a valid storage service-role format', (serviceRoleKey) => {
    const config = loadDashboardConfig(
      environment({ SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey }),
    );
    expect(config.storage.serviceRoleKey).toBe(serviceRoleKey);
  });

  it('permits insecure HTTP only for non-production loopback-bound development', () => {
    const development = loadDashboardConfig(
      environment({
        NODE_ENV: 'development',
        DASHBOARD_ALLOW_INSECURE_LOOPBACK: 'true',
        DASHBOARD_SERVER_BIND_HOST: '127.0.0.1',
        DASHBOARD_TRUSTED_PROXY_TOKEN_SHA256: undefined,
      }),
    );
    expect(development.allowInsecureLoopback).toBe(true);
    expect(development.trustedProxyTokenSha256).toBeNull();
    for (const values of [
      {
        NODE_ENV: 'production',
        DASHBOARD_ALLOW_INSECURE_LOOPBACK: 'true',
        DASHBOARD_SERVER_BIND_HOST: '127.0.0.1',
      },
      {
        NODE_ENV: 'development',
        DASHBOARD_ALLOW_INSECURE_LOOPBACK: 'true',
        DASHBOARD_SERVER_BIND_HOST: '0.0.0.0',
      },
      {
        NODE_ENV: 'development',
        DASHBOARD_ALLOW_INSECURE_LOOPBACK: 'true',
        DASHBOARD_SERVER_BIND_HOST: undefined,
      },
    ])
      expect(() => loadDashboardConfig(environment(values))).toThrow(
        DashboardConfigurationError,
      );
  });

  it('never includes configuration values in thrown errors', () => {
    const sentinel = 'connection-secret-sentinel';
    let thrown: unknown;
    try {
      loadDashboardConfig(environment({ DATABASE_URL: sentinel }));
    } catch (error) {
      thrown = error;
    }
    expect(
      JSON.stringify(thrown, Object.getOwnPropertyNames(thrown as object)),
    ).not.toContain(sentinel);
    expect((thrown as Error).message).toBe(
      'Dashboard configuration is invalid.',
    );
    const serialized = JSON.stringify(loadDashboardConfig(environment()));
    for (const secret of [
      cursorKey,
      tokenDigest,
      proxyDigest,
      '11111111-1111-4111-8111-111111111111',
      'postgresql://dashboard:secret@localhost:5432/blackbox',
      storageCredential,
      digest(storageCredential),
    ])
      expect(serialized).not.toContain(secret);
  });
});
