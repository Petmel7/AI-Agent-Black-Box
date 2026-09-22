# AI Agent Black Box

AI Agent Black Box is an evidence and quality layer for AI-generated code. The repository contains the monorepo foundation, canonical version 1 evidence contracts, and the PostgreSQL evidence-persistence foundation. HTTP ingestion and later processing behavior are intentionally not implemented yet.

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
