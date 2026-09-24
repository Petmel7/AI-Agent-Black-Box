# Database package

This package owns the Prisma schema, checked-in PostgreSQL migrations, and the
explicit relational client boundary. The BBX-003 migration contains the raw
version 1 evidence foundation and PostgreSQL-owned integrity guards.

## Connection boundaries

- `DATABASE_URL` is reserved for later deployed application composition.
- `DIRECT_URL` is reserved for later deployed migration composition.
- `TEST_DATABASE_URL` is the only variable accepted by the checked-in database
  migration and integration helpers. The ingestion process receives its
  explicit `DATABASE_URL` only at its composition root.

The helpers do not fall back to another variable or PostgreSQL driver defaults.
They reject an empty URL and require the isolated database name `blackbox_test`
or `blackbox_integration`, plus an explicit hostname and username. Prisma
generation and schema validation do not connect.
Importing `@blackbox/database` does not construct a client or read a connection
variable. Callers must pass either a connection string or a created adapter to
`createDatabaseClient` and call the returned `dispose()` method.

The BBX-004 migration adds mutable processing-intent records. The ingestion
transaction commits exactly one pending `evidence_batch.accepted` intent with
each new batch. A later relay may update delivery metadata; it must not mutate
raw evidence. No queue connection is made by this package.

The BBX-005 migration adds mutable artifact-upload attempts, bounded verification
leases, terminal integrity observations, partial uniqueness for active and
verified attempts, and migration-owned legal-transition guards. These rows are
operational state; they never update or delete append-only artifact declarations
or raw references.

## Prisma commands

From the repository root:

```sh
pnpm --filter @blackbox/database db:generate
pnpm --filter @blackbox/database db:validate
```

With an isolated test URL explicitly exported:

```sh
pnpm --filter @blackbox/database db:migrate:deploy
pnpm --filter @blackbox/database db:migrate:verify
pnpm --filter @blackbox/database test:integration
```

## Local PostgreSQL integration workflow

The Compose service uses PostgreSQL 16 and local-only ephemeral credentials:

```sh
docker compose -f compose.integration.yml up -d --wait
```

Set this only in the invoking shell; do not commit it to `.env`:

```text
TEST_DATABASE_URL=postgresql://blackbox:blackbox_integration@localhost:55432/blackbox_integration
```

Then deploy from an empty database, verify migration state, and run the suite:

```sh
pnpm --filter @blackbox/database db:migrate:deploy
pnpm --filter @blackbox/database db:migrate:verify
pnpm --filter @blackbox/database test:integration
pnpm --filter @blackbox/ingest test
```

This direct sequence works from a clean checkout after `db:generate`; the test
runners resolve workspace package names to their public source entrypoints and
do not depend on stale `dist` output. Production and build consumers continue
to use each package's default compiled export.

Stop the ephemeral service and remove its anonymous data volume:

```sh
docker compose -f compose.integration.yml down -v
```

The integration tests create unique immutable records and intentionally do not
add an application-accessible cleanup bypass.

`pnpm test` from the repository root passes an explicitly configured
`TEST_DATABASE_URL` only to test tasks without including its value in Turbo's
cache key. Test-task caching is disabled so a prior unconfigured skip cannot be
replayed when the variable is later supplied. When it is absent, the database
package prints the approved local skip message. CI still runs migration and
integration commands explicitly before the repository-wide test task.
