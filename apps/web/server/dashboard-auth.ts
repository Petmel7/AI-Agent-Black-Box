import 'server-only';

import { createHash, timingSafeEqual } from 'node:crypto';

import type { DashboardServerConfig } from './dashboard-config';

export const DASHBOARD_BASIC_USERNAME = 'blackbox';
export const DASHBOARD_AUTHENTICATED_HEADER =
  'x-blackbox-dashboard-authenticated';
export const DASHBOARD_PROXY_TOKEN_HEADER = 'x-blackbox-proxy-token';
const CHALLENGE = 'Basic realm="AI Agent Black Box", charset="UTF-8"';

export type DashboardAuthenticationResult =
  { authenticated: true } | { authenticated: false };

function trustedProxyTransport(
  request: Request,
  config: DashboardServerConfig,
): boolean {
  if (config.allowInsecureLoopback) {
    if (
      request.headers.has('forwarded') ||
      request.headers.has(DASHBOARD_PROXY_TOKEN_HEADER)
    )
      return false;
    const protocol = request.headers.get('x-forwarded-proto');
    return protocol === null || protocol === 'http';
  }
  if (request.headers.has('forwarded')) return false;
  if (request.headers.get('x-forwarded-proto') !== 'https') return false;
  const token = request.headers.get(DASHBOARD_PROXY_TOKEN_HEADER);
  if (
    !token ||
    token.length > 256 ||
    !/^[A-Za-z0-9_-]{32,256}$/.test(token) ||
    !config.trustedProxyTokenSha256
  )
    return false;
  return verifyDashboardToken(token, config.trustedProxyTokenSha256);
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function basicCredentials(header: string | null) {
  if (!header || header.length > 2_048) return null;
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/.exec(header);
  if (!match || match[1]!.length % 4 !== 0) return null;
  try {
    const bytes = Buffer.from(match[1]!, 'base64');
    if (bytes.toString('base64') !== match[1]) return null;
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const separator = decoded.indexOf(':');
    if (separator < 0) return null;
    const username = decoded.slice(0, separator);
    const token = decoded.slice(separator + 1);
    if (
      username !== DASHBOARD_BASIC_USERNAME ||
      token.length < 1 ||
      token.length > 1_024 ||
      containsControlCharacter(token)
    )
      return null;
    return { token };
  } catch {
    return null;
  }
}

export function verifyDashboardToken(
  token: string,
  expectedSha256: string,
  compare: (left: Uint8Array, right: Uint8Array) => boolean = timingSafeEqual,
): boolean {
  const presented = createHash('sha256').update(token, 'utf8').digest();
  const expected = Buffer.from(expectedSha256, 'hex');
  return compare(presented, expected);
}

export function authenticateDashboardRequest(
  request: Request,
  config: DashboardServerConfig,
): DashboardAuthenticationResult {
  if (!trustedProxyTransport(request, config)) return { authenticated: false };
  const credentials = basicCredentials(request.headers.get('authorization'));
  if (!credentials) return { authenticated: false };
  return verifyDashboardToken(credentials.token, config.accessTokenSha256)
    ? { authenticated: true }
    : { authenticated: false };
}

function strippedDashboardHeaders(request: Request): Headers {
  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()]) {
    const normalized = name.toLowerCase();
    if (
      normalized === 'authorization' ||
      normalized === 'forwarded' ||
      normalized === DASHBOARD_PROXY_TOKEN_HEADER ||
      normalized === DASHBOARD_AUTHENTICATED_HEADER ||
      normalized.startsWith('x-forwarded-')
    )
      headers.delete(name);
  }
  return headers;
}

/** Removes browser-controlled trust headers and injects one proxy-owned marker. */
export function authenticatedDashboardHeaders(request: Request): Headers {
  const headers = strippedDashboardHeaders(request);
  headers.set(DASHBOARD_AUTHENTICATED_HEADER, '1');
  return headers;
}

/** Re-sanitizes after Next has added its own forwarding headers downstream. */
export function sanitizedDashboardRouteHeaders(request: Request): Headers {
  const authenticated = isAuthenticatedDashboardRequest(request);
  const headers = strippedDashboardHeaders(request);
  if (authenticated) headers.set(DASHBOARD_AUTHENTICATED_HEADER, '1');
  return headers;
}

export function isAuthenticatedDashboardRequest(request: Request): boolean {
  return request.headers.get(DASHBOARD_AUTHENTICATED_HEADER) === '1';
}

export function dashboardUnauthorizedResponse(): Response {
  return new Response('Unauthorized', {
    status: 401,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'text/plain; charset=utf-8',
      'www-authenticate': CHALLENGE,
    },
  });
}

export function dashboardUnavailableResponse(): Response {
  return new Response('Service unavailable', {
    status: 503,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'text/plain; charset=utf-8',
    },
  });
}
