import { createHash, randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createBearerAuthenticator } from './auth.js';

describe('bearer authentication', () => {
  it('authenticates the configured token digest without accepting the digest itself', () => {
    const token = 'high-entropy-token-value';
    const organizationId = randomUUID();
    const tokenSha256 = createHash('sha256').update(token).digest('hex');
    const authenticate = createBearerAuthenticator({
      organizationId,
      tokenSha256,
    });
    expect(authenticate(`Bearer ${token}`)).toEqual({ organizationId });
    expect(authenticate(`Bearer ${tokenSha256}`)).toBeUndefined();
  });

  it.each([
    { organizationId: undefined, tokenSha256: 'a'.repeat(64) },
    { organizationId: randomUUID(), tokenSha256: undefined },
    { organizationId: 'invalid', tokenSha256: 'invalid' },
  ])('fails closed for invalid configuration', (config) => {
    expect(
      createBearerAuthenticator(config)('Bearer anything'),
    ).toBeUndefined();
  });
});
