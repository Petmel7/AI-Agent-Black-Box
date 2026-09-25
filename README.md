# AI Agent Black Box

AI Agent Black Box is an evidence and quality layer for AI-generated code. The repository contains the monorepo foundation, canonical version 1 evidence contracts, the PostgreSQL evidence-persistence foundation, the authenticated idempotent ingestion write path, private artifact transport with server-side integrity verification, and the offline local spool/redaction foundation. Queue relay and later processing behavior are intentionally not implemented yet.

## Prerequisites

- Node.js 24 LTS (the exact major is recorded in `.nvmrc`)
- pnpm 11 (Corepack can install the version recorded in `package.json`)
- Docker with Compose, only for database integration tests

## Install

```sh
corepack enable
pnpm install --frozen-lockfile
```

No Supabase project, queue, storage, or LLM credentials are required. Normal generation, validation, and builds remain credential-free. Real database integration tests use the isolated PostgreSQL service documented in `packages/database/README.md`.

## Development

Run all development processes:

```sh
pnpm dev
```

Individual applications can be selected with a Turbo filter, for example:

```sh
pnpm dev --filter @blackbox/web
pnpm dev --filter @blackbox/ingest
```

The CLI can be built and invoked from its workspace:

```sh
pnpm --filter @blackbox/cli build
pnpm --filter @blackbox/cli start -- --help
pnpm --filter @blackbox/cli start -- status --json
```

## Validation

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

`pnpm test` explicitly skips only the database integration suite when
`TEST_DATABASE_URL` is absent. Run the database workflow separately when
validating persistence changes.

## Workspace layout

- `apps/web`: Next.js dashboard and control-plane boundary.
- `apps/ingest`: Fastify machine-ingestion boundary.
- `apps/worker`: asynchronous worker process boundary.
- `apps/cli`: local `blackbox` collector command boundary.
- `packages/contracts`: shared runtime-validated contracts.
- `packages/database`: Prisma schema and database boundary.
- `packages/config`: shared TypeScript and ESLint configuration.
- `docs`: product, architecture, review, and approved task documents.

Environment variable names and connection guidance for the database boundary are documented in `packages/database/README.md`.
Local collector capture, privacy, and spool configuration are documented in
`apps/cli/README.md`; non-destructive recovery is documented in
`docs/operations/local-spool-recovery.md`.

## Ingestion API

`POST /v1/repositories/:repositoryId/evidence-batches` accepts strict version 1
evidence batches with `Content-Type: application/json` and
`Authorization: Bearer <token>`. The request body limit is 16 MiB. A new batch
returns `202 accepted`; an exact retry returns `200 already_accepted` with the
original receipt time. Success confirms only atomic evidence and pending-intent
persistence, not queue delivery, artifact upload, or analysis.

Errors use `{ "error": { "code", "message" } }`. Stable mappings are `400`
`malformed_json`, `401` `unauthorized`, `404` `repository_not_found`, `409`
`evidence_conflict`, `413` `payload_too_large`, `415`
`unsupported_media_type`, and `422` `invalid_request` or
`unsupported_schema_version`. Messages are generic and never echo credentials,
request bodies, stored evidence, or connection settings.

The default v0.1 authenticator requires `INGEST_ORGANIZATION_ID` and the
lowercase SHA-256 token digest in `INGEST_BEARER_TOKEN_SHA256`. `DATABASE_URL`
is required by the ingestion process for writes. Missing or invalid auth
configuration fails closed. Do not store or log the raw bearer token.

## Artifact transport

The authenticated artifact API creates upload sessions, completes server-side
verification, and reports safe storage state:

```text
POST /v1/repositories/:repositoryId/artifacts/:artifactId/uploads
POST /v1/repositories/:repositoryId/artifacts/:artifactId/uploads/:uploadId/complete
GET  /v1/repositories/:repositoryId/artifacts/:artifactId/storage
```

The upload response contains a short-lived TUS capability but never a bucket,
object key, service credential, or public URL. Completion accepts identifiers
only; it does not accept client hashes, lengths, object paths, URLs, or
verification claims. See `docs/operations/artifact-storage.md` for private
bucket and runtime configuration.
