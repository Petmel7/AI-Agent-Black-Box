import { UuidSchema } from '@blackbox/contracts';

import { CollectorError } from './errors.js';

export const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_OVERALL_TIMEOUT_MS = 60_000;
export const DEFAULT_DRAIN_MAX_ATTEMPTS = 20;
export const DEFAULT_DRAIN_MAX_ITEMS = 20;
export const DEFAULT_DRAIN_MAX_ELAPSED_MS = 60_000;
export const DEFAULT_RETRY_BASE_MS = 1_000;
export const DEFAULT_RETRY_MAX_MS = 5 * 60_000;
export const MAX_TIMEOUT_MS = 10 * 60_000;
export const MAX_DRAIN_ATTEMPTS = 1_000;
export const MAX_DRAIN_ITEMS = 1_000;
export const MAX_RETRY_MS = 24 * 60 * 60_000;
export const MAX_RESPONSE_BYTES = 64 * 1024;

export interface DeliveryConfig {
  apiBaseUrl: string;
  apiToken: string;
  connectTimeoutMs: number;
  drainMaxAttempts: number;
  drainMaxElapsedMs: number;
  drainMaxItems: number;
  overallTimeoutMs: number;
  repositoryId: string;
  requestTimeoutMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
}

export type DeliveryConfiguration =
  { state: 'offline' } | { config: DeliveryConfig; state: 'configured' };

function integer(
  value: string | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum)
    throw new CollectorError(
      'invalid-config',
      `${label} is outside its supported range`,
    );
  return parsed;
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '[::1]'
  );
}

export function validateRemoteUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new CollectorError('invalid-config', `${label} is invalid`, {
      cause,
    });
  }
  if (
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && isLoopbackHostname(url.hostname))) ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    url.search !== ''
  )
    throw new CollectorError('invalid-config', `${label} is not permitted`);
  return url;
}

export function deliveryConfigFromEnvironment(
  env: NodeJS.ProcessEnv,
): DeliveryConfiguration {
  const base = env.BLACKBOX_API_BASE_URL;
  const repositoryId = env.BLACKBOX_REPOSITORY_ID;
  const token = env.BLACKBOX_API_TOKEN;
  if (!base && !repositoryId && !token) return { state: 'offline' };
  if (!base || !repositoryId || !token)
    throw new CollectorError(
      'invalid-config',
      'remote collector configuration is incomplete',
    );
  const url = validateRemoteUrl(base, 'API base URL');
  if (!UuidSchema.safeParse(repositoryId).success)
    throw new CollectorError(
      'invalid-config',
      'repository identifier is invalid',
    );
  if (token.length < 1 || token.length > 4_096 || /[\r\n]/u.test(token))
    throw new CollectorError('invalid-config', 'API token is invalid');
  const connectTimeoutMs = integer(
    env.BLACKBOX_CONNECT_TIMEOUT_MS,
    DEFAULT_CONNECT_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
    'connect timeout',
  );
  const requestTimeoutMs = integer(
    env.BLACKBOX_REQUEST_TIMEOUT_MS,
    DEFAULT_REQUEST_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
    'request timeout',
  );
  const overallTimeoutMs = integer(
    env.BLACKBOX_OVERALL_TIMEOUT_MS,
    DEFAULT_OVERALL_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
    'overall timeout',
  );
  const retryBaseMs = integer(
    env.BLACKBOX_RETRY_BASE_MS,
    DEFAULT_RETRY_BASE_MS,
    MAX_RETRY_MS,
    'retry base delay',
  );
  const retryMaxMs = integer(
    env.BLACKBOX_RETRY_MAX_MS,
    DEFAULT_RETRY_MAX_MS,
    MAX_RETRY_MS,
    'retry maximum delay',
  );
  if (retryBaseMs > retryMaxMs)
    throw new CollectorError(
      'invalid-config',
      'retry base delay exceeds its maximum',
    );
  return {
    state: 'configured',
    config: Object.freeze({
      apiBaseUrl: url.toString().replace(/\/$/u, ''),
      apiToken: token,
      connectTimeoutMs,
      drainMaxAttempts: integer(
        env.BLACKBOX_DRAIN_MAX_ATTEMPTS,
        DEFAULT_DRAIN_MAX_ATTEMPTS,
        MAX_DRAIN_ATTEMPTS,
        'drain attempt bound',
      ),
      drainMaxElapsedMs: integer(
        env.BLACKBOX_DRAIN_MAX_ELAPSED_MS,
        DEFAULT_DRAIN_MAX_ELAPSED_MS,
        MAX_TIMEOUT_MS,
        'drain elapsed-time bound',
      ),
      drainMaxItems: integer(
        env.BLACKBOX_DRAIN_MAX_ITEMS,
        DEFAULT_DRAIN_MAX_ITEMS,
        MAX_DRAIN_ITEMS,
        'drain item bound',
      ),
      overallTimeoutMs,
      repositoryId,
      requestTimeoutMs,
      retryBaseMs,
      retryMaxMs,
    }),
  };
}
