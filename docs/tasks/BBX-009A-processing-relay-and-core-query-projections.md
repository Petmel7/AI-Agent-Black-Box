# BBX-009A: Processing Relay and Core Query Projections

- **Status:** Approved
- **Owner:** Implementation Chat
- **Review:** Review Chat
- **Depends on:** BBX-008 completed at `5bb54a7c936eb2642c11463994c6a070bce0a74c`
- **Architecture:** Proposed ADR-0010; accepted ADR-0001 through ADR-0009

## Goal

Close the first backend processing loop: relay durable batch intents to a
private `pgmq` queue, consume them at least once, atomically rebuild versioned
core projections from immutable canonical events, and expose tenant-safe query
functions with explicit freshness and completeness.

## Context

ADR-0004 defines atomic processing intent and at-least-once queue handoff.
ADR-0010 defines relay, consumer receipt, projector versioning, atomic rebuild,
processing state, and query semantics. The current worker is lifecycle-only and
the current database contains raw evidence plus pending intents but no queue
adapter or projections.

This is BBX-009A. Verified artifact download, Git file-list parsing, and file
change projections are deliberately reserved for BBX-009B.

## In Scope

- Standard-PostgreSQL migrations for safe intent leases/states, processing
  receipts/state, and core projection tables.
- Explicit idempotent provisioning/verification for one private durable
  `pgmq` queue.
- Bounded outbox relay and at-least-once queue consumer.
- A deterministic `core` projector version 1 that rebuilds one complete run.
- Core run, command, tool, test, Git metadata, error, and usage projections.
- Tenant-scoped run-list and run-detail query functions.
- Real PostgreSQL and real `pgmq` integration/concurrency/crash tests.
- Production worker composition, polling, retry, and graceful shutdown.

## Out of Scope

- Artifact byte reads, object storage credentials, file-list parsing, file/path
  projections, or `artifact.verified` intents; BBX-009B owns them.
- Deterministic findings, policies, LLM summaries, dashboard/API routes, export,
  notifications, or GitHub integration.
- Test inference from commands, command-output parsing, remote test execution,
  or new canonical evidence kinds.
- Bulk-rebuild UI/CLI, old projection-version retention, dead-letter UI,
  retention/deletion, analytics warehouse, or multiple queue backends.
- Public/PostgREST queue access, `pgmq_public`, client-side queue credentials, or
  queue payloads containing tenant/evidence data.
- Changes to collector, Codex adapter, canonical wire contracts, ingestion HTTP
  success semantics, or raw append-only evidence.

## Required Changes

### Durable processing model

- Extend processing intent state with a visible terminal blocked state and add
  lease UUID, queue message ID, and constraints that make pending, leased,
  delivered, and blocked rows internally coherent.
- Use PostgreSQL `clock_timestamp()` after lock acquisition for lease and retry
  decisions. All claim and terminal transitions require the matching unexpired
  lease UUID; stale owners cannot publish success, release, or block work.
- Claim bounded ready/expired work with `FOR UPDATE SKIP LOCKED`. Increment
  attempts exactly once per successful claim, use bounded deterministic backoff
  inputs, and preserve only safe error codes.
- Add processing application receipts unique by intent UUID, projector name,
  and projector version. Enforce same-organization/run ownership with composite
  keys and constraints.
- Add one per-run/per-projector processing-state row with projector version,
  state, lease identity/expiry, attempts, source event count/max sequence,
  completion time, and safe error code. Missing or stale state must be
  distinguishable from ready state.
- Processing/projection rows are mutable derived data. Do not weaken or remove
  append-only guards on raw tables.

### Queue provisioning and adapter

- Use a fixed private basic queue `bbx_processing_v1` through direct PostgreSQL
  calls to the `pgmq` schema. Queue payload version 1 contains exactly
  `schemaVersion` and `intentId`.
- Add an explicit idempotent worker operations command that verifies the `pgmq`
  extension and creates/verifies the queue. Normal worker startup verifies but
  does not create or repair infrastructure.
- Do not add `pgmq` extension/queue objects to core Prisma migrations and do not
  use `pgmq_public` or the Supabase Data API.
- Runtime-validate queue records, safe integer message IDs/read counts, and the
  strict payload. Queue/database errors must not print payloads, connection
  strings, credentials, or raw evidence.
- Keep the queue adapter injected and lazy. Importing packages or constructing
  the worker performs no connection or provisioning.

### Outbox relay

- Add a bounded relay cycle: claim intents, publish each stable payload with
  `pgmq.send`, then mark delivered only through its live lease. Do not hold the
  intent transaction open during queue I/O.
- A crash or injected failure before send leaves recoverable leased work; after
  send but before transition it may create a duplicate queue message. Both must
  converge without duplicate projections.
- Retry documented transient failures with persisted bounded backoff. Missing
  queue infrastructure, invalid stored intent structure, exhausted attempts,
  and non-retryable failures become visible safe blocked state.
- Exact ingestion retries and repeated relay cycles must not create another
  processing intent. The relay may publish duplicates only in the acknowledged
  at-least-once crash window.

### Consumer and atomic projector

- Read bounded queue batches with a configured visibility timeout longer than
  the maximum projection attempt. Validate the complete message before trusted
  database lookup.
- For a valid intent, acquire/renew bounded processing ownership, lock the run,
  load its complete raw event set by canonical sequence through bounded keyset
  pages, and parse every event with its version-specific canonical schema.
- Define bounded configuration for events and projected children per run.
  Exceeding either limit must roll back the attempted snapshot, preserve all raw
  evidence, and publish a stable safe failure code without retaining raw values.
- Implement deterministic pure projection logic independent of Prisma rows,
  queue records, wall-clock time, or iteration order outside canonical sequence.
- In one database transaction, replace all current core projection children for
  that run, publish the run projection and source fingerprint, mark processing
  ready, and create the exact application receipt.
- If the exact receipt already exists, perform no rebuild. If another intent
  reaches the same current fingerprint after taking the run lock, create its
  receipt without rewriting semantically identical projections.
- Archive the queue message only after commit or exact-receipt confirmation.
  Archive failure leaves a safe duplicate for later convergence.
- Projection failure rolls back the entire new snapshot, records bounded retry
  state separately, and leaves the queue message recoverable through visibility
  timeout. After bounded exhaustion, expose failed processing without deleting
  raw evidence.

### Core projection semantics

- Add current tenant/run-owned projections for run lifecycle, commands, tool
  calls, explicit test runs, Git snapshots, Git diffs, errors, and individual
  usage observations. Retain canonical source event IDs and sequences on every
  row.
- Pair command/tool starts and finishes only by canonical operation UUID.
  Missing halves remain incomplete; duplicate/conflicting halves become an
  explicit conflict. Never choose last-write-wins silently.
- Derive run outcome only from a unique valid `run.finished`. Preserve agent
  outcome separately from processing state and evidence completeness.
- Aggregate tests only from `test.run.finished`. No observed test events means
  `not_observed`, not zero passing tests.
- Aggregate each token category only from reported measurements and retain an
  unavailable-observation count. Do not derive provider total tokens or cost.
- Project Git snapshot/diff metadata and canonical artifact references without
  reading artifact bytes or claiming file/path evidence.
- Build conservative run counts/duration/files-changed metadata only from
  complete unambiguous canonical observations; otherwise expose unknown plus a
  stable completeness reason.

### Freshness and query API

- Store projector name/version, raw event count, and maximum canonical sequence
  with each run projection. Treat a missing, version-mismatched, or fingerprint-
  mismatched snapshot as stale/processing.
- Provide bounded framework-independent database functions for:
  - tenant/repository-scoped run listing with stable cursor pagination;
  - one tenant/repository/run detail with processing state, freshness,
    completeness, observed outcome, conservative aggregates, and projected
    children;
  - bounded child pagination where a collection can exceed one response.
- Query authorization inputs are trusted server context, never queue payload or
  canonical source metadata. Wrong-tenant/missing resources remain
  indistinguishable.
- Return canonical evidence/artifact identifiers needed for later navigation,
  but never raw database credentials, queue payloads, object keys, or storage
  URLs.
- Do not assign `PASS` or `REVIEW`; expose processing, completeness, and observed
  run outcome independently.

### Worker runtime and documentation

- Replace the lifecycle stub with injected relay and consumer loops. Bound poll
  delay, batch size, concurrency, attempts, leases, visibility timeout, and
  shutdown wait; prohibit hot loops when no work or infrastructure is down.
- `start()` validates configuration and opens owned clients once. `stop()` is
  idempotent, stops new claims, waits a bounded time for in-flight work, safely
  releases or abandons leases for retry, removes resources/listeners, and closes
  owned clients once.
- Configuration supports explicit database/queue connection input without
  printing values. Test URLs must pass the existing isolated-database authority
  guard before any connection.
- Document queue provisioning, worker configuration, processing states,
  retries, blocked recovery, freshness, projector versioning, safe replay, and
  the BBX-009B artifact/file boundary.

## Acceptance Criteria

- New batch acceptance still commits raw evidence and exactly one pending intent
  without calling the queue; exact retries add no intent.
- Fresh standard PostgreSQL migrations succeed without `pgmq` installed. The
  explicit provisioning command creates/verifies the fixed queue on a
  `pgmq`-enabled test database and normal startup fails safely when it is absent.
- Concurrent relay processes claim disjoint work. Lease expiry recovers crashed
  claims, stale owners cannot transition them, and transient/blocked outcomes
  preserve coherent database state.
- Failure before send, during send, after send, and before delivered transition
  demonstrates the allowed duplicate window without lost processing intent.
- Duplicate queue messages and crashes before/after projection commit/archive
  converge to one receipt and one semantically identical current projection.
- Concurrent intents for one run serialize safely; readers see only the old or
  new complete projection snapshot.
- Out-of-order batches, late lower sequences, repeated events across batches,
  sequence gaps, incomplete operations, multiple terminals, unsupported schema,
  and conflicting operation identity produce the specified current, incomplete,
  retry, or failed state without corrupting raw evidence.
- Keyset-paged rebuilding respects documented event/projected-child ceilings;
  an oversized run becomes visibly failed without partial rows or unbounded
  worker memory.
- Rebuilding unchanged raw evidence with core projector v1 is semantically
  identical. A projector-version mismatch is stale until an explicit replay.
- Tenant-scoped run list/detail queries cannot reveal another organization and
  distinguish processing, stale, ready, incomplete, and failed states.
- Test, token, duration, file-count, command/tool, error, and outcome aggregates
  never claim facts absent from canonical evidence.
- Worker startup/shutdown, cancellation, lease/visibility expiry, malformed
  messages, queue outage, database outage, and poison work are bounded,
  recoverable, and secret-safe.
- No artifact download, file projection, finding, summary, dashboard/API,
  collector, canonical-contract, or later-roadmap behavior is introduced.

## Required Tests

- Pure projector unit tests for every canonical v1 event kind, deterministic
  ordering, operation pairing, conflicts, incompleteness, aggregates,
  fingerprints, version mismatch, and replay equivalence.
- Real standard-PostgreSQL migration tests for all projection ownership,
  uniqueness, state coherence, lease, receipt, and atomic-rebuild constraints.
- Real `pgmq` integration tests for provisioning, send/read/archive, visibility
  expiry, duplicate publication, malformed payloads, outage/recovery, and safe
  archive retry.
- Multi-client concurrency and fault-injection tests for relay claims, stale
  leases, same-run consumers, every crash window, rollback, receipt dedupe, and
  old/new snapshot visibility.
- Query tests for tenant isolation, stable pagination, stale detection, safe
  identifiers, conservative aggregates, and wrong-tenant/missing equivalence.
- Worker lifecycle tests for lazy import/construction, start/stop idempotency,
  signals, bounded polling, in-flight shutdown, resource closure, and no hot
  loop.
- Secret-sentinel tests covering queue payloads, errors, diagnostics, logs, and
  query results without printing connection configuration or raw evidence.

## Validation

This task changes migrations, tenant isolation, evidence interpretation,
concurrency, queue delivery, and worker lifecycle. Run focused checks while
editing, then the complete high-risk gate on the final state:

```text
pnpm install --frozen-lockfile
pnpm --filter @blackbox/database db:generate
pnpm --filter @blackbox/database db:validate
pnpm --filter @blackbox/database db:migrate:deploy
pnpm --filter @blackbox/database test:integration
pnpm --filter @blackbox/worker test
pnpm format:check
pnpm lint --force
pnpm typecheck --force
pnpm test --force
pnpm build --force
git diff --check
git status --short --untracked-files=all
```

Run queue integration against an explicitly authorized isolated
`pgmq`-enabled PostgreSQL database. Keep ordinary fresh-migration coverage that
does not require the extension. Hosted CI must provision a pinned
`pgmq`-enabled PostgreSQL image and run both migration and queue suites. Do not
start Docker, provision infrastructure, install dependencies, or access a
network locally without separate explicit authorization.

## Deliverables

- Accepted ADR-0010.
- Standard-PostgreSQL migration and Prisma models for processing/projections.
- Private `pgmq` provisioner, adapter, outbox relay, and idempotent consumer.
- Deterministic core projector and atomic persistence service.
- Tenant-safe run-list/run-detail query functions.
- Production worker composition and operations documentation.
- Focused, database, queue, concurrency, and full-gate evidence in the compact
  implementation report.

## Referenced Decisions and Documents

- `AGENTS.md`
- `docs/product/v0.1-scope.md`
- `docs/architecture/overview.md`
- `docs/architecture/evidence-model.md`
- `docs/architecture/v0.1-delivery-sequence.md`
- `docs/architecture/decisions/ADR-0001-modular-monolith.md`
- `docs/architecture/decisions/ADR-0002-canonical-evidence-envelope.md`
- `docs/architecture/decisions/ADR-0003-durable-evidence-persistence.md`
- `docs/architecture/decisions/ADR-0004-transactional-processing-outbox.md`
- `docs/architecture/decisions/ADR-0010-replayable-projections-and-processing-state.md`
- `docs/tasks/BBX-003-evidence-persistence-foundation.md`
- `docs/tasks/BBX-004-idempotent-ingestion-api.md`
- `docs/review-guidelines.md`

## Risks

- Relay/consumer crash windows can lose work or duplicate projection unless
  lease and receipt transitions are independently enforced.
- A mutable projection can look current while raw events arrived concurrently;
  fingerprint and run locking must cover late lower sequences.
- Full-run rebuild transactions may grow with very large runs; v0.1 bounds and
  pagination must prevent unbounded memory or responses.
- `pgmq` function/version drift or visibility configuration can invalidate retry
  assumptions; production and CI must pin and test the selected extension.
- Incorrect operation pairing or aggregation can create persuasive but false
  dashboard evidence.
- Local queue validation requires separate explicit infrastructure authority.

## Open Questions

None. Artifact-backed file projection, bulk replay UX, retention, alternative
queues, or incremental projection requires a later approved task and, where
applicable, an amended architecture decision.
