# BBX-004: Idempotent Ingestion API

- **Status:** Done
- **Owner:** Implementation Chat
- **Review:** Review Chat
- **Architecture:** ADR-0001, ADR-0002, ADR-0003, and proposed ADR-0004

## Goal

Implement the authenticated version 1 evidence-batch write path so new batches
are accepted atomically, exact retries succeed without duplication, conflicting
identifier reuse is rejected, and every newly accepted batch creates durable
processing intent before the HTTP response succeeds.

## Context

Use the canonical contract and durable constraints defined by
`docs/architecture/evidence-model.md`, ADR-0002, and ADR-0003. ADR-0004 must be
accepted with this task because it defines the processing-intent and future queue
handoff guarantee required by the delivery sequence.

## In Scope

- Add a versioned Fastify endpoint:
  `POST /v1/repositories/:repositoryId/evidence-batches`.
- Add strict HTTP success and error contracts to `@blackbox/contracts` without
  changing the canonical evidence batch itself.
- Authenticate a high-entropy bearer token at the Fastify boundary and derive
  trusted organization identity from server configuration or an injected test
  authenticator.
- Resolve the server-owned repository inside the authenticated organization;
  do not accept organization identity in the route or body.
- Create or resolve the run from the canonical `runId`, binding it permanently
  to the authenticated organization and requested repository.
- Implement one framework-independent ingestion application service and one
  retry-safe PostgreSQL transaction for batch, event, membership, artifact-link,
  and processing-intent persistence.
- Add a checked-in migration and Prisma model for durable processing intents.
- Add deterministic extraction of version 1 artifact references and their RFC
  6901 locations from the closed canonical event union.
- Add focused HTTP tests and real PostgreSQL integration/concurrency tests.
- Document runtime configuration and request/response behavior.

## Required HTTP Contract

### Authentication and request boundary

- Require `Authorization: Bearer <token>` and compare credentials in constant
  time. Missing, malformed, and incorrect credentials return the same generic
  `401` response.
- The default v0.1 authenticator reads an explicit organization UUID and a
  SHA-256 digest of a high-entropy token from runtime configuration. It fails
  closed when configuration is missing or invalid and never logs either value.
- Validate `repositoryId` as a UUID and parse the body with the version-selected
  strict `EvidenceBatchSchema` before persistence.
- Reject malformed JSON with `400`, unauthorized requests with `401`, unsupported
  media type with `415`, oversized bodies with `413`, validation or unsupported
  schema version with `422`, hidden/not-owned repositories with `404`, and
  durable identity conflicts with `409`.
- Configure and document an explicit 16 MiB request-body limit. A later collector
  must split batches that exceed the transport limit even when their event count
  is otherwise valid.
- Error responses use stable machine-readable codes and safe messages. They do
  not echo credentials, raw bodies, connection values, or conflicting stored
  evidence.

### Success responses

- A newly committed batch returns `202` with outcome `accepted`.
- An exact retry of an already committed batch returns `200` with outcome
  `already_accepted`.
- Both responses identify the canonical `batchId` and `runId` and return the
  original server receipt time. They do not claim that processing, verification,
  analysis, or artifact upload completed.

## Required Ingestion Semantics

- Compare validated stored JSON using PostgreSQL `jsonb` semantics, not transport
  whitespace, object key order, or an invented canonical byte hash.
- Reusing a canonical batch ID with identical content in the same organization
  is an exact retry. Different content or run ownership is a conflict.
- A new batch may reuse an existing event or artifact only when its complete
  validated canonical JSON is identical and ownership matches.
- Reusing an event/artifact ID with different content, reusing a sequence for a
  different event, or binding a canonical run to another repository is a
  conflict; immutable data is never updated to resolve it.
- Persist a new batch receipt, new raw records, ordered membership, artifact
  declarations/links, and exactly one pending processing intent in one database
  transaction.
- Any conflict or persistence failure rolls back the complete new-batch write.
- Map known constraint races by reading the committed winner after rollback;
  concurrent identical requests converge to one accepted batch and one intent,
  while concurrent conflicting requests yield one success and one `409`.
- Use bounded retry only for documented transient transaction failures. Do not
  turn unknown database errors into an idempotent success.
- Capture server receipt time once per newly accepted batch and use it
  consistently for its server-authored receipt fields where the existing schema
  permits.

## Processing Intent Model

- Store a server UUID, `organization_id`, `run_id`, `batch_id`, closed intent
  kind, pending state, creation/availability timestamps, and delivery-attempt
  metadata needed by the future relay.
- Enforce same-organization/run ownership and one intent per batch and kind with
  database constraints.
- Processing intent is operational and may be updated by later relay work; raw
  batches and events remain append-only.
- Do not add `pgmq`, relay, worker consumption, projections, or analysis in this
  task.

## Architecture Constraints

- Fastify owns HTTP/authentication mapping; it does not contain transaction
  logic.
- The ingestion service accepts typed trusted context and validated batches; it
  does not depend on Fastify request objects.
- Database access remains explicit, injected, lazy, and disposable. Importing a
  package must not connect.
- Keep Supabase and `pgmq` types outside core domain and database public APIs.
- Do not add a generic repository abstraction unrelated to this write path.
- Do not mutate the version 1 evidence envelope or trust client tenant,
  receipt-time, storage, verification, or processing claims.

## Out of Scope

- Token issuance UI, multiple token records, rotation workflows, RBAC, SSO, RLS,
  or organization/repository provisioning APIs.
- Rate limiting beyond authentication and the explicit request-body limit.
- Artifact bytes, upload URLs, object storage, or hash verification.
- Queue provisioning, outbox relay, worker consumption, projections, findings,
  summaries, dashboard behavior, or processing completion state.
- Collector retry/spool behavior and provider adapters.
- Canonical JSON serialization, signing, or public content fingerprints.

## Required Tests

### HTTP and authentication

- Valid authenticated request maps new and exact-retry outcomes to `202` and
  `200` respectively.
- Missing, malformed, and incorrect tokens return indistinguishable `401`
  responses without calling persistence.
- Wrong-tenant and missing repositories are not distinguishable to the client.
- Malformed JSON, unsupported media type/version, invalid route UUID, invalid
  batch, and oversized body map to the documented safe errors.
- Response schemas are strict and no secret or raw payload appears in logs or
  errors.

### PostgreSQL integration and concurrency

- Fresh migrations create the processing-intent model and constraints.
- A valid batch persists the complete durable graph and one pending intent.
- Exact batch retry changes no row counts and returns the original receipt.
- A later batch can reuse identical events/artifacts and creates only its own
  membership and intent.
- Batch, event, sequence, artifact, run/repository, organization, membership, and
  artifact-reference conflicts reject and roll back atomically.
- Injected failure before intent insertion and before commit leaves no partial
  batch graph.
- Concurrent identical requests converge; concurrent conflicting requests have
  one winner and one stable conflict.
- Import and app construction do not connect; disposal closes owned resources.

## Acceptance Criteria

- The endpoint accepts only authenticated, version 1, runtime-validated batches
  for a repository owned by the authenticated organization.
- New acceptance, exact retry, validation failure, missing ownership, and every
  material conflict have stable HTTP outcomes and machine-readable codes.
- Database constraints and transaction behavior preserve tenant ownership,
  immutable evidence, event ordering, and artifact integrity under concurrency.
- Evidence and one processing intent commit atomically; exact retries never add
  another intent.
- No queue or analysis call occurs in the request path.
- Existing health behavior and BBX-002/003 contracts remain compatible.
- No credentials, authorization headers, raw bodies, or connection strings are
  committed or emitted.
- Required high-risk validation passes on the final state.

## Validation

Because this task changes authentication, migrations, tenant isolation,
evidence integrity, concurrency, and dependencies, implementation and review
must run the full deterministic gate plus real PostgreSQL integration tests:

```text
pnpm install --frozen-lockfile
pnpm --filter @blackbox/database db:generate
pnpm --filter @blackbox/database db:validate
pnpm --filter @blackbox/database db:migrate:deploy
pnpm --filter @blackbox/database test:integration
pnpm --filter @blackbox/ingest test
pnpm format:check
pnpm lint --force
pnpm typecheck --force
pnpm test --force
pnpm build --force
git diff --check
git status --short --untracked-files=all
```

Database commands require the explicit isolated `TEST_DATABASE_URL`. Do not
start Docker or connect to another database without explicit user authorization.

## Deliverables

- Accepted ADR-0004.
- Versioned ingestion HTTP contracts and artifact-reference extraction helper.
- Authenticated Fastify route and composition-root configuration.
- Framework-independent idempotent ingestion service.
- Prisma processing-intent model and checked-in migration.
- Unit, integration, concurrency, and HTTP contract tests.
- Updated ingest/database/runtime documentation and environment examples.

## Referenced Documents

- `AGENTS.md`
- `docs/product/v0.1-scope.md`
- `docs/architecture/overview.md`
- `docs/architecture/v0.1-delivery-sequence.md`
- `docs/architecture/evidence-model.md`
- `docs/architecture/decisions/ADR-0001-modular-monolith.md`
- `docs/architecture/decisions/ADR-0002-canonical-evidence-envelope.md`
- `docs/architecture/decisions/ADR-0003-durable-evidence-persistence.md`
- `docs/architecture/decisions/ADR-0004-transactional-processing-outbox.md`
- `docs/review-guidelines.md`

## Risks

- Constraint races can be misclassified if reconciliation relies only on driver
  error text instead of the committed winner.
- Authentication or repository lookup errors can leak tenant existence.
- Artifact-reference extraction can silently omit a valid pointer if it is not
  exhaustive over the closed event union.
- Transaction retries can duplicate work unless intent uniqueness is durable.
- A 16 MiB transport limit means event-count-valid batches may still need
  collector-side byte splitting.

## Open Questions

1. Confirm the transactional-outbox decision in proposed ADR-0004.
2. Confirm static high-entropy bearer-token digest plus organization UUID as the
   v0.1 concrete authenticator; durable multi-token management remains deferred.
3. Confirm the 16 MiB request-body limit as the initial transport bound.

## Implementation Prompt

```text
$bbx-implement docs/tasks/BBX-004-idempotent-ingestion-api.md
Use the committed Approved task and Accepted ADR-0004 baseline in the saved checkout. Implement only the authenticated idempotent write path and atomic processing intent, run the required high-risk validation, and stop before task-status change, commit, push, or finalization.
```

## Review Prompt

```text
$bbx-review docs/tasks/BBX-004-idempotent-ingestion-api.md
Review the current diff against its committed baseline. Independently verify authentication, tenant isolation, exact-retry/conflict semantics, transaction rollback, concurrency races, artifact extraction, and atomic processing intent using the required high-risk checks. Do not edit or finalize.
```
