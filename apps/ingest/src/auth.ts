import { createHash, timingSafeEqual } from 'node:crypto';

import { UuidSchema } from '@blackbox/contracts';

export interface AuthenticatedOrganization {
  organizationId: string;
}
export type BearerAuthenticator = (
  authorizationHeader: string | undefined,
) => AuthenticatedOrganization | undefined;
export interface BearerAuthenticationConfig {
  organizationId: string | undefined;
  tokenSha256: string | undefined;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export function createBearerAuthenticator(
  config: BearerAuthenticationConfig,
): BearerAuthenticator {
  const organization = UuidSchema.safeParse(config.organizationId);
  const digest = config.tokenSha256?.trim().toLowerCase();
  if (!organization.success || !digest || !SHA256_PATTERN.test(digest))
    return () => undefined;
  const expected = Buffer.from(digest, 'hex');
  return (authorizationHeader) => {
    const match = /^Bearer ([^\s]+)$/.exec(authorizationHeader ?? '');
    const presented = createHash('sha256')
      .update(match?.[1] ?? '')
      .digest();
    return match && timingSafeEqual(presented, expected)
      ? { organizationId: organization.data }
      : undefined;
  };
}

export function createEnvironmentAuthenticator(
  environment: NodeJS.ProcessEnv = process.env,
): BearerAuthenticator {
  return createBearerAuthenticator({
    organizationId: environment.INGEST_ORGANIZATION_ID,
    tokenSha256: environment.INGEST_BEARER_TOKEN_SHA256,
  });
}
