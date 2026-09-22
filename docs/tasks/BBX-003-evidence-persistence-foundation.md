# BBX-003: Evidence Persistence Foundation

- **Status:** Approved
- **Owner:** Implementation Chat
- **Review:** Review Chat
- **Architecture:** [ADR-0001](../architecture/decisions/ADR-0001-modular-monolith.md), [ADR-0002](../architecture/decisions/ADR-0002-canonical-evidence-envelope.md), [ADR-0003](../architecture/decisions/ADR-0003-durable-evidence-persistence.md)

## Goal

Implement the first production-shaped PostgreSQL persistence foundation for
version 1 evidence, with checked-in Prisma migrations and real database tests
that enforce tenant ownership, canonical identity, per-run ordering,
append-only raw records, batch membership, and artifact declaration integrity.

## Context

BBX-002 established the strict client-side evidence and batch contracts. The
next dependency is durable server-owned storage. Building HTTP ingestion first
would leave idempotency and evidence-integrity guarantees inside request-handler
code without database constraints or concurrency-safe foundations.

This task creates the relational boundary needed by the later ingestion service.
It does not implement the ingestion transaction or expose an endpoint.

## In Scope

- Configure the existing `@blackbox/database` workspace for Prisma ORM 7 and
  PostgreSQL migrations using the versions pinned by the repository.
- Add only the runtime and development dependencies required for the generated
  Prisma client, the PostgreSQL driver adapter, package code, and database tests.
- Add the initial checked-in migration and Prisma models for:
  - organizations;
  - repositories;
  - runs with collector-owned canonical run identity;
  - immutable accepted evidence batches;
  - immutable raw evidence events;
  - ordered batch-to-event membership;
  - immutable artifact declarations;
  - event-to-artifact reference linkage.
- Store the complete validated version 1 batch/event/reference objects as
  PostgreSQL `jsonb` where defined by ADR-0003, alongside indexed scalar fields.
- Add server receipt timestamps using database UTC time.
- Add database-generated UUID primary keys distinct from canonical client UUIDs.
- Add all durable uniqueness, ownership, range, and referential constraints
  required by ADR-0003.
- Add migration-owned SQL for constraints, indexes, and append-only guards that
  Prisma cannot express.
- Export a small database-client construction/disposal boundary suitable for
  later dependency injection. Do not create an import-time global connection.
- Add scripts and documentation for generation, migration deployment, migration
  verification, and integration tests.
- Add `compose.integration.yml` with a `postgres:16-alpine` service and health
  check for reproducible local integration tests.
- Add an explicit `TEST_DATABASE_URL` example and keep database integration
  commands isolated from runtime or production-looking connection variables.
- Add an ephemeral PostgreSQL service to CI and make the database integration
  suite mandatory there.

## Required Durable Model

The exact Prisma relation names may vary, but the migration must provide these
semantics.

### Organization and repository

- Organization is the trusted tenant root.
- Repository has a server-owned ID and belongs to exactly one organization.
- Mutable display values are not used as foreign keys or durable identity.

### Run

- Run has a server-owned database ID.
- Run belongs to exactly one organization and repository.
- The collector-owned canonical `runId` is stored separately.
- Canonical run identity is unique within an organization.
- This task does not derive a run status from lifecycle events.

### Evidence batch

- Batch has a server-owned database ID and a separate canonical `batchId`.
- Batch belongs to exactly one organization and run.
- Canonical batch identity is unique within an organization, preventing reuse
  against another run in the same tenant.
- Store `schemaVersion`, `sentAt`, server-authored `receivedAt`, and the complete
  validated batch object.
- Batch rows are append-only.

### Evidence event

- Event has a server-owned database ID and a separate canonical `eventId`.
- Event belongs to exactly one organization and run.
- Canonical event identity is unique within an organization.
- `sequence` is unique within a run and stored in a type/range capable of every
  non-negative JavaScript safe integer.
- Store `schemaVersion`, `kind`, `observedAt`, optional `occurredAt`,
  server-authored `receivedAt`, and the complete validated event object.
- Event rows are append-only.

### Batch membership

- Membership links a batch and event from the same organization and run.
- Position is zero-based, non-negative, and unique within a batch.
- The same event cannot appear twice in one batch.
- Membership rows are append-only.

### Artifact declaration and event linkage

- Artifact declaration has a server-owned database ID and separate canonical
  `artifactId`.
- It belongs to one organization and run.
- Canonical artifact identity is unique within an organization.
- Store kind, media type, byte length, lowercase SHA-256, redaction metadata,
  optional compression/encoding, receipt time, and the complete validated
  reference object.
- Byte length accepts only non-negative JavaScript safe integers.
- Event-artifact linkage cannot cross organization or run ownership and records
  the RFC 6901 JSON Pointer locating the reference in the immutable event.
- Declaration and linkage rows are append-only.
- Object keys, buckets, URLs, upload state, and hash-verification claims are not
  stored by this task.

## Required Database Guarantees

- Every tenant-owned row carries `organization_id`.
- Composite ownership constraints prevent cross-organization and cross-run
  relationships even if application code supplies mismatched IDs.
- Supported schema version is constrained to integer `1` for these v0.1 rows.
- Sequence, position, and byte-length values are constrained to the inclusive
  JavaScript safe-integer range where applicable.
- Artifact SHA-256 values are constrained to lowercase 64-character hexadecimal.
- Raw rows cannot be updated or deleted through ordinary application database
  operations; parent deletion must not cascade-delete raw evidence.
- Unique constraints are named or otherwise stable enough for BBX-004 to map
  concurrency races to machine-readable outcomes.
- No database trigger or default invents `occurredAt`.
- Server receipt times do not trust client-provided timestamps.

## Database Package Boundary

- Use the Prisma 7 configuration mechanism supported by the committed Prisma
  version.
- Runtime construction accepts an explicit connection string or already-created
  adapter through a testable API; it must not silently fall back to ambient
  PostgreSQL defaults.
- Database integration helpers require `TEST_DATABASE_URL`. They must not fall
  back to `DATABASE_URL`, `DIRECT_URL`, or driver defaults.
- Missing runtime connection configuration fails clearly without logging the
  connection string.
- Importing `@blackbox/database` must not open a connection.
- Generated client files remain generated output and are not hand-edited.
- Core database exports must not expose Supabase-specific client types.

## Integration Test Requirements

Run tests against a real ephemeral PostgreSQL database after applying the
checked-in migration from an empty database. Tests must prove at least:

- migration deployment succeeds from empty state;
- valid organization → repository → run → batch/event/membership records persist;
- two organizations may use the same canonical run/event UUID without collision
  when the model intentionally scopes identity by organization;
- canonical run, batch, event, and artifact duplicates are rejected inside one
  organization;
- duplicate event sequence inside one run is rejected;
- the same sequence may exist in different runs;
- batch membership rejects duplicate positions and repeated events;
- cross-organization and cross-run relationships are rejected;
- negative and greater-than-safe-integer sequence, position, and byte length are
  rejected by the database;
- malformed or uppercase artifact SHA-256 is rejected;
- `receivedAt` is database-authored and `occurredAt` remains nullable;
- update and delete attempts against each append-only raw table are rejected;
- parent deletion cannot silently cascade away raw evidence;
- importing the package does not connect and explicit client disposal releases
  the test process cleanly.

Tests must use unique records or isolated databases/transactions. Do not add an
application-accessible bypass that weakens append-only behavior merely to clean
up test data.

## CI Requirements

- Use `postgres:16-alpine` in both CI and `compose.integration.yml`; never use a
  floating `latest` tag.
- Use health checks before migration or tests.
- Supply only ephemeral CI credentials.
- Apply checked-in migrations before running integration tests.
- Keep the existing frozen install, format, lint, typecheck, test, and build
  validation.
- A missing or unhealthy CI database must fail the integration step rather than
  silently skip it.
- Local validation without a configured test database may skip only the
  integration suite with an explicit message; document the command that runs it.
- Migration and integration scripts must fail closed when `TEST_DATABASE_URL` is
  absent or does not identify the expected isolated test database. They must not
  substitute `DATABASE_URL` or `DIRECT_URL`.

## Out of Scope

- HTTP routes, request/response contracts, API-token authentication, rate limits,
  or Fastify behavior.
- The exact-retry versus conflicting-reuse application algorithm and error
  response mapping.
- Queue, `pgmq`, transactional outbox, worker, or processing-state behavior.
- Supabase project provisioning, RLS policies, storage clients, buckets, object
  keys, signed URLs, or artifact bytes.
- Canonical JSON byte serialization, signing, or public content fingerprints.
- Command, test, file-change, finding, summary, or dashboard projections.
- Codex adapters, collector behavior, Git capture, redaction implementation, or
  SQLite spooling.
- Retention, partitioning, archival, repair tools, audit export, or data residency.
- Changes to version 1 evidence contracts unless architecture first returns
  BBX-002/ADR-0002 to a compatible versioning decision.

## Architecture Constraints

- Follow ADR-0001, ADR-0002, and ADR-0003.
- PostgreSQL and checked-in migrations are the durable source of truth.
- Prisma schema describes the supported client model; migration SQL is
  authoritative for PostgreSQL invariants Prisma cannot express.
- Keep server-owned database identity, tenant identity, canonical client
  identity, and provider-native identity visibly distinct.
- Do not use upsert-to-update semantics for raw evidence.
- Do not add mutable status fields to raw event, batch, membership, or artifact
  declaration tables.
- Do not couple the domain boundary to Supabase APIs.
- Preserve all BBX-002 contract behavior and existing application builds.

## Acceptance Criteria

- A fresh PostgreSQL database reaches the expected schema using only checked-in
  migrations.
- Prisma generation and validation work with the repository's pinned toolchain.
- The database model covers every responsibility listed in ADR-0003 without
  introducing projection or ingestion behavior.
- All durable identity, ownership, ordering, range, and append-only guarantees
  are enforced by PostgreSQL and proven by negative integration tests.
- Full validated batch/event/reference JSON is retained without treating database
  records as the public wire contract.
- The database client boundary is explicit, lazy, injectable, and cleanly
  disposable.
- CI runs the database integration suite against ephemeral PostgreSQL and retains
  every existing validation step.
- No secrets or developer database credentials are committed or emitted in test
  output.
- No unrelated application, evidence-contract, collector, ingestion, worker,
  projection, or UI behavior changes are introduced.
- Required validation commands pass against the final worktree.

## Validation Commands

The implementation must add stable package scripts and document their exact
names. The final validation must include the equivalent of:

```text
pnpm install --frozen-lockfile
pnpm --filter @blackbox/database db:generate
pnpm --filter @blackbox/database db:validate
pnpm --filter @blackbox/database db:migrate:deploy
pnpm --filter @blackbox/database test:integration
pnpm format:check
pnpm lint --force
pnpm typecheck --force
pnpm test --force
pnpm build --force
git diff --check
git status --short --untracked-files=all
```

Commands that connect to PostgreSQL must use an explicitly supplied ephemeral
test URL. Do not run migrations against an ambiguous or production-looking URL.

## Deliverables

- Prisma 7 configuration and updated database workspace configuration.
- Initial evidence persistence Prisma schema.
- Checked-in PostgreSQL migration with reviewed custom constraints/guards.
- Explicit lazy database-client boundary.
- PostgreSQL integration tests and test helpers.
- `compose.integration.yml` using `postgres:16-alpine` and documented start,
  health, test, and stop commands.
- CI PostgreSQL service and mandatory migration/integration step.
- Updated database and root environment documentation, including an empty
  `TEST_DATABASE_URL` placeholder without committed credentials.
- Completion report mapping every acceptance criterion and invariant to test
  evidence.

## Referenced Documents

- [`AGENTS.md`](../../AGENTS.md)
- [v0.1 scope](../product/v0.1-scope.md)
- [Architecture overview](../architecture/overview.md)
- [v0.1 delivery sequence](../architecture/v0.1-delivery-sequence.md)
- [Canonical Evidence Model](../architecture/evidence-model.md)
- [ADR-0001](../architecture/decisions/ADR-0001-modular-monolith.md)
- [ADR-0002](../architecture/decisions/ADR-0002-canonical-evidence-envelope.md)
- [ADR-0003](../architecture/decisions/ADR-0003-durable-evidence-persistence.md)
- [Review guidelines](../review-guidelines.md)

## Risks

- Prisma schema alone cannot express every PostgreSQL invariant; an unreviewed
  generated migration could omit critical composite or append-only constraints.
- Append-only guards can accidentally block migrations or test cleanup if their
  operational model is not explicit.
- Redundant `organization_id` values improve tenant constraints but require
  composite ownership checks to prevent drift.
- JSONB preserves validated semantic content but is not a canonical signed byte
  representation.
- Database integration tests can become flaky if they reuse state or race service
  readiness.
- A generic database repository API introduced too early could hide the exact
  transaction semantics BBX-004 needs.

## Resolved Architecture Inputs

- CI and local integration use `postgres:16-alpine`, never `latest`.
- Local integration uses the checked-in `compose.integration.yml` helper.
- Database integration commands require the isolated `TEST_DATABASE_URL` and do
  not fall back to runtime `DATABASE_URL` or migration `DIRECT_URL`.
- A real Supabase project and its credentials are not required by BBX-003.
- `DATABASE_URL` remains reserved for later runtime processes and `DIRECT_URL`
  remains reserved for later direct migration access to a deployed environment.

No open architecture questions remain. If implementation reveals that the
approved Prisma 7 or PostgreSQL boundary cannot satisfy these constraints,
return the task to architecture instead of weakening test isolation or evidence
integrity.

## Implementation Prompt

```text
Implement BBX-003 exactly as approved in docs/tasks/BBX-003-evidence-persistence-foundation.md.

Read AGENTS.md, the v0.1 delivery sequence, the Canonical Evidence Model,
ADR-0001, ADR-0002, ADR-0003, and the review guidelines before editing. Keep the
change inside the database workspace, its migration/test infrastructure, CI, and
the documentation explicitly required by BBX-003.

Treat migration SQL as security- and integrity-sensitive code. Prove constraints
against real PostgreSQL, including negative ownership, duplicate, range, and
append-only cases. Do not implement HTTP ingestion, queueing, object storage,
projections, or provider/collector behavior.

Run every required validation command against the final state. Report acceptance
criteria, changed files, exact command results, deviations, and residual risks.
Do not commit or push before independent review.
```

## Review Prompt

```text
Review BBX-003 against AGENTS.md, its approved task specification, ADR-0001,
ADR-0002, ADR-0003, the Canonical Evidence Model, and the v0.1 delivery sequence.

Do not modify files. Inspect the complete schema, generated migration SQL,
database-client boundary, CI changes, dependency changes, and tests. Independently
apply migrations to a fresh PostgreSQL database and exercise failure cases.

Prioritize cross-tenant or cross-run references, mutable/deletable raw evidence,
silent cascades, weak uniqueness under concurrency, client UUIDs used as trusted
database identity, unsafe integer storage, incorrect timestamp ownership,
artifact metadata drift, migration/client mismatch, implicit connections, leaked
credentials, and integration tests that skip in CI.

Report actionable findings first with priority, exact file/line or migration
statement, concrete trigger, impact, and smallest safe correction. Then provide
an acceptance-criteria matrix, commands executed, residual risks, validation
gaps, and a verdict of PASS or NEEDS FIXES.
```
