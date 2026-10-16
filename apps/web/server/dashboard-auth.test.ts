import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  authenticatedDashboardHeaders,
  authenticateDashboardRequest,
  DASHBOARD_AUTHENTICATED_HEADER,
  dashboardUnauthorizedResponse,
  DASHBOARD_BASIC_USERNAME,
  verifyDashboardToken,
} from './dashboard-auth';
import type { DashboardServerConfig } from './dashboard-config';

const token = 'dashboard-secret-sentinel';
const digest = createHash('sha256').update(token).digest('hex');
const proxyToken = 'proxy-proof-secret-sentinel-token-000000000';
const proxyDigest = createHash('sha256').update(proxyToken).digest('hex');
const config: DashboardServerConfig = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  accessTokenSha256: digest,
  cursorSigningKey: Buffer.alloc(32, 7),
  trustedProxyTokenSha256: proxyDigest,
  databaseUrl: 'postgresql://dashboard:secret@localhost:5432/blackbox',
  allowInsecureLoopback: false,
  storage: {
    url: 'https://example.supabase.co',
    serviceRoleKey: 'storage-secret',
    bucket: 'private',
    connectTimeoutMs: 1_000,
  },
  preview: {
    maximumBytes: 1_024,
    inactivityTimeoutMs: 1_000,
    attemptTimeoutMs: 2_000,
  },
};

function authorization(password = token, username = DASHBOARD_BASIC_USERNAME) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

function request(
  url: string,
  header?: string,
  transportHeaders: Record<string, string> = {
    'x-forwarded-proto': 'https',
    'x-blackbox-proxy-token': proxyToken,
  },
) {
  return new Request(url, {
    headers: {
      ...(header ? { authorization: header } : {}),
      ...transportHeaders,
    },
  });
}

describe('dashboard HTTP Basic boundary', () => {
  it('accepts only the fixed username and valid password with trusted TLS termination', () => {
    expect(
      authenticateDashboardRequest(
        request('https://dashboard.example/', authorization()),
        config,
      ),
    ).toEqual({ authenticated: true });
    expect(
      authenticateDashboardRequest(
        request('https://dashboard.example/', authorization(token, 'tenant')),
        config,
      ),
    ).toEqual({ authenticated: false });
  });

  it('rejects URL and forwarding spoofing without exact proxy proof', () => {
    const header = authorization();
    for (const candidate of [
      request('https://dashboard.example/', header, {}),
      request('http://dashboard.example/', header, {
        'x-forwarded-proto': 'https',
      }),
      request('http://dashboard.example/', header, {
        'x-forwarded-proto': 'https, https',
        'x-blackbox-proxy-token': proxyToken,
      }),
      request('http://dashboard.example/', header, {
        'x-forwarded-proto': 'HTTPS',
        'x-blackbox-proxy-token': proxyToken,
      }),
      request('http://dashboard.example/', header, {
        forwarded: 'for=client;proto=https',
        'x-forwarded-proto': 'https',
        'x-blackbox-proxy-token': proxyToken,
      }),
      request('http://dashboard.example/', header, {
        'x-forwarded-proto': 'https',
        'x-blackbox-proxy-token': `${proxyToken}, ${proxyToken}`,
      }),
      request('http://dashboard.example/', header, {
        'x-forwarded-proto': 'https',
        'x-blackbox-proxy-token': 'wrong-proof-token-000000000000000000000',
      }),
    ])
      expect(
        authenticateDashboardRequest(candidate, config).authenticated,
      ).toBe(false);
  });

  it.each([undefined, 'Bearer secret', authorization('wrong-token')])(
    'rejects missing or invalid credentials generically',
    (header) => {
      expect(
        authenticateDashboardRequest(
          request('https://dashboard.example/', header),
          config,
        ),
      ).toEqual({ authenticated: false });
      const response = dashboardUnauthorizedResponse();
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe(
        'Basic realm="AI Agent Black Box", charset="UTF-8"',
      );
      expect(response.headers.get('cache-control')).toBe('no-store');
    },
  );

  it('allows plaintext HTTP only for explicitly enabled loopback development', () => {
    const header = authorization();
    expect(
      authenticateDashboardRequest(
        request('http://127.0.0.1:3000/', header, {}),
        config,
      ).authenticated,
    ).toBe(false);
    const enabled: DashboardServerConfig = {
      ...config,
      organizationId: config.organizationId,
      accessTokenSha256: config.accessTokenSha256,
      cursorSigningKey: config.cursorSigningKey,
      trustedProxyTokenSha256: null,
      databaseUrl: config.databaseUrl,
      allowInsecureLoopback: true,
    };
    expect(
      authenticateDashboardRequest(
        request('http://localhost:3000/', header, {}),
        enabled,
      ).authenticated,
    ).toBe(true);
    expect(
      authenticateDashboardRequest(
        request('http://spoofed.example/', header, {}),
        enabled,
      ).authenticated,
    ).toBe(true);
    expect(
      authenticateDashboardRequest(
        request('http://spoofed.example/', header, {
          'x-forwarded-proto': 'https',
          'x-blackbox-proxy-token': proxyToken,
        }),
        enabled,
      ).authenticated,
    ).toBe(false);
  });

  it('strips credentials and all browser-controlled transport headers downstream', () => {
    const headers = authenticatedDashboardHeaders(
      request('http://dashboard.example/', authorization(), {
        forwarded: 'for=client;proto=https',
        'x-forwarded-for': 'client',
        'x-forwarded-host': 'dashboard.example',
        'x-forwarded-proto': 'https',
        'x-blackbox-proxy-token': proxyToken,
        [DASHBOARD_AUTHENTICATED_HEADER]: 'spoofed',
      }),
    );
    expect(headers.get(DASHBOARD_AUTHENTICATED_HEADER)).toBe('1');
    for (const name of [
      'authorization',
      'forwarded',
      'x-forwarded-for',
      'x-forwarded-host',
      'x-forwarded-proto',
      'x-blackbox-proxy-token',
    ])
      expect(headers.has(name), name).toBe(false);
  });

  it('always compares fixed-size digests at the constant-time boundary', () => {
    const compare = vi.fn<(left: Uint8Array, right: Uint8Array) => boolean>(
      () => false,
    );
    expect(verifyDashboardToken('wrong', digest, compare)).toBe(false);
    expect(compare).toHaveBeenCalledOnce();
    const [presented, expected] = compare.mock.calls[0]!;
    expect(presented).toHaveLength(32);
    expect(expected).toHaveLength(32);
  });

  it('does not disclose credential or tenant sentinels in failures', async () => {
    const response = dashboardUnauthorizedResponse();
    const serialized = `${await response.text()} ${JSON.stringify([
      ...response.headers,
    ])}`;
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(config.organizationId);
    expect(serialized).not.toContain(config.databaseUrl);
    expect(serialized).not.toContain(proxyToken);
    expect(serialized).not.toContain(config.trustedProxyTokenSha256!);
    expect(serialized).not.toContain(
      Buffer.from(config.cursorSigningKey).toString('base64url'),
    );
  });
});
