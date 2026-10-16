import 'server-only';

import { createHash } from 'node:crypto';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const BUCKET = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

export interface DashboardServerConfig {
  organizationId: string;
  accessTokenSha256: string;
  cursorSigningKey: Uint8Array;
  trustedProxyTokenSha256: string | null;
  databaseUrl: string;
  allowInsecureLoopback: boolean;
  storage: {
    url: string;
    serviceRoleKey: string;
    bucket: string;
    connectTimeoutMs: number;
  };
  preview: {
    maximumBytes: number;
    inactivityTimeoutMs: number;
    attemptTimeoutMs: number;
  };
}

export class DashboardConfigurationError extends Error {
  readonly code = 'dashboard_configuration_invalid';

  constructor() {
    super('Dashboard configuration is invalid.');
    this.name = 'DashboardConfigurationError';
  }
}

function fail(): never {
  throw new DashboardConfigurationError();
}

function required(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = environment[name]?.trim();
  return value ? value : fail();
}

function requiredRawSecret(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = environment[name];
  return value && value.trim().length > 0 ? value : fail();
}

function integer(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
  maximum: number,
): number {
  const raw = environment[name];
  if (raw === undefined || raw.length === 0) return fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) return fail();
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > maximum) return fail();
  return value;
}

function httpsUrl(raw: string): string {
  try {
    const value = new URL(raw);
    if (
      value.username ||
      value.password ||
      (value.protocol !== 'https:' &&
        !(value.protocol === 'http:' && value.hostname === 'localhost'))
    )
      return fail();
    return value.toString().replace(/\/$/, '');
  } catch {
    return fail();
  }
}

function databaseUrl(raw: string): string {
  try {
    const value = new URL(raw);
    if (
      (value.protocol !== 'postgres:' && value.protocol !== 'postgresql:') ||
      !value.hostname ||
      !value.username
    )
      return fail();
    return raw;
  } catch {
    return fail();
  }
}

function cursorSigningKey(raw: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]{43}$/.test(raw)) return fail();
  const decoded = Buffer.from(raw, 'base64url');
  if (decoded.byteLength !== 32 || decoded.toString('base64url') !== raw)
    return fail();
  return decoded;
}

function isLoopbackBinding(value: string): boolean {
  return value === '127.0.0.1' || value === '::1';
}

export function loadDashboardConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): DashboardServerConfig {
  const organizationId = required(environment, 'DASHBOARD_ORGANIZATION_ID');
  const accessTokenSha256 = required(
    environment,
    'DASHBOARD_ACCESS_TOKEN_SHA256',
  );
  const signingKeyRaw = required(environment, 'DASHBOARD_CURSOR_SIGNING_KEY');
  const signingKey = cursorSigningKey(signingKeyRaw);
  const storageServiceRoleKey = requiredRawSecret(
    environment,
    'SUPABASE_SERVICE_ROLE_KEY',
  );
  const storageServiceRoleKeyDigest = createHash('sha256')
    .update(storageServiceRoleKey)
    .digest('hex');
  if (!UUID.test(organizationId) || !SHA256.test(accessTokenSha256)) fail();
  const ingestDigest = environment.INGEST_BEARER_TOKEN_SHA256?.trim();
  if (ingestDigest && ingestDigest === accessTokenSha256) fail();

  const allowRaw = environment.DASHBOARD_ALLOW_INSECURE_LOOPBACK;
  if (allowRaw !== undefined && allowRaw !== 'true' && allowRaw !== 'false')
    fail();
  const allowInsecureLoopback = allowRaw === 'true';
  if (
    allowInsecureLoopback &&
    (environment.NODE_ENV === 'production' ||
      !isLoopbackBinding(required(environment, 'DASHBOARD_SERVER_BIND_HOST')))
  )
    fail();
  const proxyRaw = environment.DASHBOARD_TRUSTED_PROXY_TOKEN_SHA256?.trim();
  const proxyDigest = proxyRaw ? proxyRaw : undefined;
  if (
    (!allowInsecureLoopback && !proxyDigest) ||
    (proxyDigest !== undefined && !SHA256.test(proxyDigest)) ||
    proxyDigest === accessTokenSha256 ||
    (ingestDigest !== undefined && proxyDigest === ingestDigest)
  )
    fail();
  const signingKeyDigest = createHash('sha256')
    .update(signingKey)
    .digest('hex');
  const signingKeyTextDigest = createHash('sha256')
    .update(signingKeyRaw)
    .digest('hex');
  if (
    signingKeyDigest === accessTokenSha256 ||
    signingKeyDigest === ingestDigest ||
    signingKeyDigest === proxyDigest ||
    signingKeyTextDigest === accessTokenSha256 ||
    signingKeyTextDigest === ingestDigest ||
    signingKeyTextDigest === proxyDigest ||
    signingKeyDigest === storageServiceRoleKeyDigest ||
    signingKeyTextDigest === storageServiceRoleKeyDigest ||
    storageServiceRoleKeyDigest === accessTokenSha256 ||
    storageServiceRoleKeyDigest === ingestDigest ||
    storageServiceRoleKeyDigest === proxyDigest
  )
    fail();
  const bucket = required(environment, 'ARTIFACT_STORAGE_BUCKET');
  if (!BUCKET.test(bucket)) fail();

  const storage = {
    url: httpsUrl(required(environment, 'SUPABASE_URL')),
    bucket,
    connectTimeoutMs: integer(
      environment,
      'DASHBOARD_PREVIEW_CONNECT_TIMEOUT_MS',
      10_000,
      60_000,
    ),
  } as DashboardServerConfig['storage'];
  Object.defineProperty(storage, 'serviceRoleKey', {
    value: storageServiceRoleKey,
  });
  Object.freeze(storage);
  const config = {
    allowInsecureLoopback,
    storage,
    preview: Object.freeze({
      maximumBytes: integer(
        environment,
        'DASHBOARD_PREVIEW_MAX_BYTES',
        65_536,
        262_144,
      ),
      inactivityTimeoutMs: integer(
        environment,
        'DASHBOARD_PREVIEW_INACTIVITY_TIMEOUT_MS',
        15_000,
        60_000,
      ),
      attemptTimeoutMs: integer(
        environment,
        'DASHBOARD_PREVIEW_ATTEMPT_TIMEOUT_MS',
        30_000,
        120_000,
      ),
    }),
  } as DashboardServerConfig;
  for (const [name, value] of [
    ['organizationId', organizationId.toLowerCase()],
    ['accessTokenSha256', accessTokenSha256],
    ['cursorSigningKey', signingKey],
    ['trustedProxyTokenSha256', proxyDigest ?? null],
    ['databaseUrl', databaseUrl(required(environment, 'DATABASE_URL'))],
  ] as const)
    Object.defineProperty(config, name, { value });
  return Object.freeze(config);
}
