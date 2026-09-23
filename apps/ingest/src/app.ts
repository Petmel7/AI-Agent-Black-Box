import {
  EvidenceBatchIngestionResponseSchema,
  EvidenceBatchRouteParamsSchema,
  EvidenceBatchSchema,
  HealthResponseSchema,
  INGESTION_BODY_LIMIT_BYTES,
  IngestionErrorResponseSchema,
} from '@blackbox/contracts';
import {
  EvidenceConflictError,
  RepositoryNotFoundError,
} from '@blackbox/database';
import Fastify from 'fastify';

import {
  createEnvironmentAuthenticator,
  type AuthenticatedOrganization,
  type BearerAuthenticator,
} from './auth.js';
import type { IngestionService } from './ingestion-service.js';

export interface BuildAppOptions {
  authenticator?: BearerAuthenticator;
  ingestionService?: IngestionService;
  onClose?: () => Promise<void>;
}

const messages = {
  malformed_json: 'The request body is not valid JSON.',
  unauthorized: 'Authentication is required.',
  unsupported_media_type: 'Content-Type must be application/json.',
  payload_too_large: 'The request body exceeds the 16 MiB limit.',
  unsupported_schema_version: 'The evidence schema version is not supported.',
  invalid_request: 'The request is invalid.',
  repository_not_found: 'Repository was not found.',
  evidence_conflict: 'Evidence identity conflicts with stored evidence.',
  internal_error: 'The request could not be completed.',
} as const;

function errorBody(code: keyof typeof messages) {
  return IngestionErrorResponseSchema.parse({
    error: { code, message: messages[code] },
  });
}

function transportError(error: unknown) {
  const record =
    typeof error === 'object' && error !== null
      ? (error as Record<string, unknown>)
      : {};
  if (record.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE')
    return { status: 415, code: 'unsupported_media_type' as const };
  if (record.code === 'FST_ERR_CTP_BODY_TOO_LARGE')
    return { status: 413, code: 'payload_too_large' as const };
  if (record.code === 'FST_ERR_CTP_INVALID_JSON_BODY')
    return { status: 400, code: 'malformed_json' as const };
  if (error instanceof SyntaxError && record.statusCode === 400)
    return { status: 400, code: 'malformed_json' as const };
  return undefined;
}

export function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({ logger: false, bodyLimit: INGESTION_BODY_LIMIT_BYTES });
  const authenticate =
    options.authenticator ?? createEnvironmentAuthenticator();
  const authenticatedOrganizations = new WeakMap<
    object,
    AuthenticatedOrganization
  >();
  if (options.onClose) app.addHook('onClose', options.onClose);

  app.setErrorHandler((error, _request, reply) => {
    const mapped = transportError(error);
    return mapped
      ? reply.code(mapped.status).send(errorBody(mapped.code))
      : reply.code(500).send(errorBody('internal_error'));
  });

  app.get('/health', async () =>
    HealthResponseSchema.parse({ status: 'ok', service: 'ingest' }),
  );

  app.post(
    '/v1/repositories/:repositoryId/evidence-batches',
    {
      onRequest: async (request, reply) => {
        const identity = authenticate(request.headers.authorization);
        if (!identity) {
          return reply.code(401).send(errorBody('unauthorized'));
        }
        authenticatedOrganizations.set(request, identity);
      },
    },
    async (request, reply) => {
      const identity = authenticatedOrganizations.get(request);
      if (!identity) return reply.code(401).send(errorBody('unauthorized'));
      if (
        request.headers['content-type']
          ?.split(';', 1)[0]
          ?.trim()
          .toLowerCase() !== 'application/json'
      ) {
        return reply.code(415).send(errorBody('unsupported_media_type'));
      }
      const params = EvidenceBatchRouteParamsSchema.safeParse(request.params);
      if (!params.success)
        return reply.code(422).send(errorBody('invalid_request'));
      const body = request.body;
      if (
        typeof body === 'object' &&
        body !== null &&
        'schemaVersion' in body &&
        (body as { schemaVersion?: unknown }).schemaVersion !== 1
      ) {
        return reply.code(422).send(errorBody('unsupported_schema_version'));
      }
      const batch = EvidenceBatchSchema.safeParse(body);
      if (!batch.success)
        return reply.code(422).send(errorBody('invalid_request'));
      if (!options.ingestionService)
        return reply.code(500).send(errorBody('internal_error'));
      try {
        const result = await options.ingestionService.ingest({
          organizationId: identity.organizationId,
          repositoryId: params.data.repositoryId,
          batch: batch.data,
        });
        const response = EvidenceBatchIngestionResponseSchema.parse({
          ...result,
          receivedAt: result.receivedAt.toISOString(),
        });
        return reply
          .code(result.outcome === 'accepted' ? 202 : 200)
          .send(response);
      } catch (error) {
        if (error instanceof RepositoryNotFoundError)
          return reply.code(404).send(errorBody('repository_not_found'));
        if (error instanceof EvidenceConflictError)
          return reply.code(409).send(errorBody('evidence_conflict'));
        request.log.error(
          { code: 'INGESTION_FAILED' },
          'Evidence ingestion failed',
        );
        return reply.code(500).send(errorBody('internal_error'));
      }
    },
  );

  return app;
}
