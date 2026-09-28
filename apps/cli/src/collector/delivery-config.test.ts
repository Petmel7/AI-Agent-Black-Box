import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  deliveryConfigFromEnvironment,
  validateRemoteUrl,
} from './delivery-config.js';
import { composeCollectorFromEnvironment } from './environment.js';
import { Redactor } from './redaction.js';

describe('collector delivery configuration', () => {
  it('distinguishes offline configuration and validates a complete setup', () => {
    expect(deliveryConfigFromEnvironment({})).toEqual({ state: 'offline' });
    const repositoryId = randomUUID();
    const configured = deliveryConfigFromEnvironment({
      BLACKBOX_API_BASE_URL: 'http://127.0.0.1:43123',
      BLACKBOX_API_TOKEN: 'token-safe-for-test',
      BLACKBOX_REPOSITORY_ID: repositoryId,
    });
    expect(configured).toMatchObject({
      state: 'configured',
      config: {
        apiBaseUrl: 'http://127.0.0.1:43123',
        repositoryId,
      },
    });
  });

  it.each([
    'http://example.com',
    'ftp://localhost/file',
    'https://user:secret@example.com',
    'https://example.com/path#fragment',
    'https://example.com/path?query=secret',
    '/relative',
  ])('rejects unsafe remote URL %s', (url) => {
    expect(() => validateRemoteUrl(url, 'remote URL')).toThrow();
  });

  it('accepts HTTPS and both loopback families only', () => {
    expect(validateRemoteUrl('https://example.com/api', 'URL').protocol).toBe(
      'https:',
    );
    expect(validateRemoteUrl('http://localhost:3000', 'URL').hostname).toBe(
      'localhost',
    );
    expect(validateRemoteUrl('http://[::1]:3000', 'URL').hostname).toBe(
      '[::1]',
    );
  });

  it('rejects partial, unbounded, and unsafe header configuration', () => {
    const base = {
      BLACKBOX_API_BASE_URL: 'https://example.com',
      BLACKBOX_API_TOKEN: 'safe-token',
      BLACKBOX_REPOSITORY_ID: randomUUID(),
    };
    for (const env of [
      { BLACKBOX_API_BASE_URL: base.BLACKBOX_API_BASE_URL },
      { ...base, BLACKBOX_API_TOKEN: 'bad\r\ntoken' },
      { ...base, BLACKBOX_DRAIN_MAX_ATTEMPTS: '0' },
      { ...base, BLACKBOX_DRAIN_MAX_ITEMS: '1.5' },
      { ...base, BLACKBOX_OVERALL_TIMEOUT_MS: 'Infinity' },
      {
        ...base,
        BLACKBOX_RETRY_BASE_MS: '5000',
        BLACKBOX_RETRY_MAX_MS: '1000',
      },
    ])
      expect(() => deliveryConfigFromEnvironment(env)).toThrow();
  });

  it('adds the API token to the in-memory collector redactor', () => {
    const token = `bbx-token-${randomUUID()}`;
    const composition = composeCollectorFromEnvironment(
      { BLACKBOX_API_TOKEN: token },
      [],
    );
    const redacted = new Redactor(composition.redactorOptions).redact(
      `authorization ${token}`,
    );
    expect(redacted.text).not.toContain(token);
  });
});
