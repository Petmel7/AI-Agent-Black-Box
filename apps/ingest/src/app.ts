import {
  ArtifactCompletionResponseSchema,
  ArtifactErrorResponseSchema,
  ArtifactOperationBodySchema,
  ArtifactRouteParamsSchema,
  ArtifactStorageStatusResponseSchema,
  ArtifactUploadRouteParamsSchema,
  ArtifactUploadSessionResponseSchema,
  EvidenceBatchIngestionResponseSchema,
  EvidenceBatchRouteParamsSchema,
  EvidenceBatchSchema,
  HealthResponseSchema,
  INGESTION_BODY_LIMIT_BYTES,
  IngestionErrorResponseSchema,
} from '@blackbox/contracts';
import {
  ArtifactNotFoundError,
  ArtifactUploadIllegalStateError,
  EvidenceConflictError,
  RepositoryNotFoundError,
} from '@blackbox/database';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';

import {
  createEnvironmentAuthenticator,
  type AuthenticatedOrganization,
  type BearerAuthenticator,
} from './auth.js';
import type { IngestionService } from './ingestion-service.js';
import {
  ArtifactDeclarationTooLargeError,
  ArtifactStorageUnavailableError,
  ArtifactTransportService,
  ArtifactUploadExpiredError,
} from './artifact-service.js';

export interface ArtifactRouteService {
  createSession: ArtifactTransportService['createSession'];
  complete: ArtifactTransportService['complete'];
  status: ArtifactTransportService['status'];
}

export interface BuildAppOptions {
  authenticator?: BearerAuthenticator;
  ingestionService?: IngestionService;
  artifactService?: ArtifactRouteService;
  onClose?: () => Promise<void>;
}

const artifactMessages = {
  unauthorized: 'Authentication is required.',
  unsupported_media_type: 'Content-Type must be application/json.',
  invalid_request: 'The request is invalid.',
  artifact_not_found: 'Artifact was not found.',
  declaration_too_large:
    'The artifact declaration exceeds the configured limit.',
  upload_expired: 'The upload authorization has expired.',
  storage_unavailable: 'Artifact storage is temporarily unavailable.',
  integrity_mismatch: 'Stored artifact bytes do not match the declaration.',
  illegal_state: 'The artifact upload is not available for this operation.',
  internal_error: 'The request could not be completed.',
} as const;

function artifactErrorBody(code: keyof typeof artifactMessages) {
  return ArtifactErrorResponseSchema.parse({
    error: { code, message: artifactMessages[code] },
  });
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

function hasJsonMediaType(contentType: string | undefined): boolean {
  return (
    contentType?.split(';', 1)[0]?.trim().toLowerCase() === 'application/json'
  );
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
  const authenticateRequest = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    const identity = authenticate(request.headers.authorization);
    if (!identity)
      return reply.code(401).send(artifactErrorBody('unauthorized'));
    authenticatedOrganizations.set(request, identity);
  };
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
      if (!hasJsonMediaType(request.headers['content-type'])) {
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

  app.post(
    '/v1/repositories/:repositoryId/artifacts/:artifactId/uploads',
    { onRequest: authenticateRequest },
    async (request, reply) => {
      const identity = authenticatedOrganizations.get(request);
      if (!identity)
        return reply.code(401).send(artifactErrorBody('unauthorized'));
      if (!hasJsonMediaType(request.headers['content-type']))
        return reply
          .code(415)
          .send(artifactErrorBody('unsupported_media_type'));
      const params = ArtifactRouteParamsSchema.safeParse(request.params);
      if (!params.success)
        return reply.code(422).send(artifactErrorBody('invalid_request'));
      if (
        request.body !== undefined &&
        !ArtifactOperationBodySchema.safeParse(request.body).success
      )
        return reply.code(422).send(artifactErrorBody('invalid_request'));
      if (!options.artifactService)
        return reply.code(500).send(artifactErrorBody('internal_error'));
      try {
        const result = ArtifactUploadSessionResponseSchema.parse(
          await options.artifactService.createSession({
            organizationId: identity.organizationId,
            ...params.data,
          }),
        );
        return reply
          .code(result.outcome === 'upload_authorized' ? 201 : 200)
          .send(result);
      } catch (error) {
        if (error instanceof ArtifactNotFoundError)
          return reply.code(404).send(artifactErrorBody('artifact_not_found'));
        if (error instanceof ArtifactDeclarationTooLargeError)
          return reply
            .code(413)
            .send(artifactErrorBody('declaration_too_large'));
        if (error instanceof ArtifactStorageUnavailableError)
          return reply.code(503).send(artifactErrorBody('storage_unavailable'));
        if (error instanceof ArtifactUploadIllegalStateError)
          return reply.code(409).send(artifactErrorBody('illegal_state'));
        request.log.error(
          { code: 'ARTIFACT_SESSION_FAILED' },
          'Artifact session failed',
        );
        return reply.code(500).send(artifactErrorBody('internal_error'));
      }
    },
  );

  app.post(
    '/v1/repositories/:repositoryId/artifacts/:artifactId/uploads/:uploadId/complete',
    { onRequest: authenticateRequest },
    async (request, reply) => {
      const identity = authenticatedOrganizations.get(request);
      if (!identity)
        return reply.code(401).send(artifactErrorBody('unauthorized'));
      if (!hasJsonMediaType(request.headers['content-type']))
        return reply
          .code(415)
          .send(artifactErrorBody('unsupported_media_type'));
      const params = ArtifactUploadRouteParamsSchema.safeParse(request.params);
      if (!params.success)
        return reply.code(422).send(artifactErrorBody('invalid_request'));
      if (
        request.body !== undefined &&
        !ArtifactOperationBodySchema.safeParse(request.body).success
      )
        return reply.code(422).send(artifactErrorBody('invalid_request'));
      if (!options.artifactService)
        return reply.code(500).send(artifactErrorBody('internal_error'));
      try {
        const result = ArtifactCompletionResponseSchema.parse(
          await options.artifactService.complete({
            organizationId: identity.organizationId,
            ...params.data,
          }),
        );
        return reply
          .code(
            result.outcome === 'verification_in_progress'
              ? 202
              : result.outcome === 'rejected'
                ? 409
                : 200,
          )
          .send(result);
      } catch (error) {
        if (error instanceof ArtifactNotFoundError)
          return reply.code(404).send(artifactErrorBody('artifact_not_found'));
        if (error instanceof ArtifactUploadExpiredError)
          return reply.code(410).send(artifactErrorBody('upload_expired'));
        if (error instanceof ArtifactStorageUnavailableError)
          return reply.code(503).send(artifactErrorBody('storage_unavailable'));
        if (error instanceof ArtifactUploadIllegalStateError)
          return reply.code(409).send(artifactErrorBody('illegal_state'));
        request.log.error(
          { code: 'ARTIFACT_COMPLETION_FAILED' },
          'Artifact completion failed',
        );
        return reply.code(500).send(artifactErrorBody('internal_error'));
      }
    },
  );

  app.get(
    '/v1/repositories/:repositoryId/artifacts/:artifactId/storage',
    { onRequest: authenticateRequest },
    async (request, reply) => {
      const identity = authenticatedOrganizations.get(request);
      if (!identity)
        return reply.code(401).send(artifactErrorBody('unauthorized'));
      const params = ArtifactRouteParamsSchema.safeParse(request.params);
      if (!params.success)
        return reply.code(422).send(artifactErrorBody('invalid_request'));
      if (!options.artifactService)
        return reply.code(500).send(artifactErrorBody('internal_error'));
      try {
        return ArtifactStorageStatusResponseSchema.parse(
          await options.artifactService.status({
            organizationId: identity.organizationId,
            ...params.data,
          }),
        );
      } catch (error) {
        if (error instanceof ArtifactNotFoundError)
          return reply.code(404).send(artifactErrorBody('artifact_not_found'));
        request.log.error(
          { code: 'ARTIFACT_STATUS_FAILED' },
          'Artifact status failed',
        );
        return reply.code(500).send(artifactErrorBody('internal_error'));
      }
    },
  );

  return app;
}
