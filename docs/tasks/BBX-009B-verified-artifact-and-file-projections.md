# BBX-009B: Verified Artifact and File Projections

- **Status:** Approved
- **Owner:** Implementation Chat
- **Review:** Review Chat
- **Depends on:** BBX-009A completed at `b80c1553ae4dc66b84027c2cb44503cda9696a2a`
- **Architecture:** Accepted ADR-0001 through ADR-0010; no new ADR required

## Goal

Close the trusted file-evidence processing loop: atomically enqueue work when a
Git file-list artifact becomes verified, read it through a bounded server-side
storage boundary, independently re-check its declared integrity, strictly parse
the versioned format, atomically rebuild current file-change projections, and
expose file freshness and completeness through tenant-safe query functions.

## Context

BBX-005 verifies uploaded bytes before an upload attempt becomes `verified`.
BBX-007 records a redacted deterministic `git.file-list` v1 artifact and links
it from `git.diff.captured`. BBX-009A relays durable intents, consumes private
`pgmq` messages, builds the `core` projection, and exposes processing state, but
deliberately does not read artifact bytes or project paths.

ADR-0010 already assigns the artifact-completion trigger, bounded artifact
reader, Git file-list parser, file projections, and unified freshness to this
slice. ADR-0005 defines the private server-owned storage and integrity boundary,
and ADR-0008 defines the artifact format and temporal attribution semantics.
Therefore no ADR-0011 is needed. A new ADR is required only if implementation
would change those accepted decisions, such as adding public object URLs,
supporting compressed file-list artifacts, or changing attribution semantics.

## In Scope

- An atomic, idempotent `artifact.verified` processing intent for verified Git
  file-list artifacts.
- A provider-neutral bounded object-reader port and a private Supabase Storage
  implementation usable by the worker without an app-to-app dependency.
- Independent length and SHA-256 verification before artifact bytes are parsed.
- A strict versioned parser for `git.file-list` schema version 1.
- A deterministic `files` projector version 1 that rebuilds the complete current
  file-change snapshot for one run.
- Tenant-safe, cursor-paged file-change queries and unified core/files freshness.
- Real PostgreSQL, real `pgmq`, deterministic storage-adapter, concurrency,
  fault-injection, and worker lifecycle coverage.

## Out of Scope

- Reading or projecting Git diff text, status artifacts, command output, test
  reports, or any artifact kind other than `git.file-list`.
- Compression/decompression. Version 1 accepts only uncompressed strict UTF-8
  JSON file lists with the documented media type and encoding.
- Changing the collector format, canonical evidence envelope, BBX-005 upload
  protocol, or ingestion HTTP response semantics.
- Causal claims. `observed-during-run` remains temporal evidence and must not be
  presented as proof that the agent caused a change.
- Deterministic findings, sensitive-path policy, test/change correlation,
  summaries, verdicts, dashboard/API routes, export, or BBX-010+ behavior.
- Public storage URLs, client-side service credentials, object retention,
  orphan cleanup, repair/deletion, or multiple storage providers.
- Bulk replay UI, historical projection-version retention, or dead-letter UI.

## Required Changes

### Artifact-completion intent

- Extend the durable intent model with `artifact.verified` while keeping the
  queue payload exactly `{ schemaVersion, intentId }`.
- Generalize intent ownership so an intent targets exactly one accepted batch or
  one artifact declaration. Enforce the kind/target combination, same-tenant
  run ownership, and target uniqueness with database constraints and partial
  unique indexes; do not use application checks as the only protection.
- In the same transaction that first commits a successful verification, create
  exactly one pending intent when the declaration:
  - has kind `git.file-list`;
  - is linked at `/payload/fileListArtifact` from a canonical
    `git.diff.captured` event in the same organization and run; and
  - matches that event's immutable artifact reference.
- Repeated finalize requests, stale verification owners, duplicate observations,
  and concurrent successful verification must not create another intent.
- Preserve existing batch-intent behavior and ordinary PostgreSQL portability.
  No queue call occurs inside artifact verification and no `pgmq` object enters
  a Prisma migration.
- Existing verified file-list artifacts must receive an explicit bounded
  backfill/replay operation rather than a migration-time network read. The
  operation is idempotent and creates only missing intents.

### Storage and integrity boundary

- Introduce a small reusable `@blackbox/artifact-storage` package. It owns the
  provider-neutral object-reader contract, bounded stream consumption, and the
  private authenticated Supabase read adapter. It must not depend on Prisma,
  Fastify, Next.js, worker composition, or domain projection rows.
- Reuse that package from ingestion for authenticated verification reads and
  from the worker for projection reads. Keep upload-session/TUS behavior in the
  ingestion application and preserve its public behavior.
- Obtain bucket/object identity only from the server-owned verified upload
  attempt. Never trust object locations, URLs, credentials, or headers from the
  queue payload, raw artifact JSON, or query caller.
- Disable redirects for every authenticated storage request. Bound connect,
  inactivity, overall attempt time, response bytes, and cancellation. Worker
  shutdown must abort the request and stream without publishing partial state.
- Before parsing, stream and compare the exact declaration byte length and
  lowercase SHA-256. Reject early overflow, short reads, hash mismatch, missing
  objects, multiple conflicting verified attempts, and changed server-owned
  identity with stable secret-safe error codes.
- Do not modify the immutable declaration or rewrite `verified` upload history
  when a later read fails. Do not log bytes, service credentials, authorization
  headers, signed capabilities, bucket names, object keys, or provider bodies.
- Retry only documented transient provider/network failures. Integrity,
  encoding, media-type, compression, and schema violations are non-retryable.

### Git file-list v1 contract

- Add an exported strict runtime schema for the documented `git.file-list` v1
  artifact without changing the canonical evidence envelope or event schemas.
  The collector need not be refactored, but compatibility tests must validate a
  real collector-produced fixture against the reader schema.
- Require exactly the documented root values:
  `schemaVersion`, `diffId`, `fromSnapshotId`, `toSnapshotId`,
  `attributionIsTemporalNotCausal: true`, and ordered `files`.
- Require every file entry to preserve its opaque `entryId`, redacted display
  path, before/after state, attribution, optional safe reason, and optional
  `displayAmbiguous`/`displayReason: redaction-collision` metadata. Preserve
  original identities/display paths for rename transitions when present.
- Validate that root IDs match the owning `git.diff.captured` projection and
  canonical event, and that the declaration is the event's exact
  `fileListArtifact` reference.
- Enforce the existing 20,000,000-byte artifact ceiling, 10,000-entry ceiling,
  bounded strings/nesting, strict UTF-8, JSON object shape, no unknown fields,
  no duplicate logical identities/ordinals, and deterministic input ordering.
- Treat paths as already-redacted display evidence. Never reverse redaction,
  use a display path as identity, or strengthen temporal attribution.

### Files projector v1

- Add a separate projector named `files`, version 1. Do not fold artifact state
  into `core` or change core projector version 1.
- For each artifact intent, lock the run and deterministically rebuild the
  complete current file projection from every canonical `git.diff.captured`
  event and its exact file-list declaration, not just the triggering artifact.
- Discover the complete source set from immutable database relations. A run
  with a declared file list that is absent, unverified, conflicting, invalid,
  or unavailable must expose an explicit non-ready completeness state/reason;
  it must not silently project a partial successful file set.
- Bound file-list artifacts per run, cumulative downloaded bytes, total entries,
  projected rows, storage concurrency, memory, and attempt duration. Exceeding a
  bound rolls back the entire new snapshot and retains the old complete one.
- Build a source fingerprint from the canonical Git diff identities, declaration
  hashes/lengths, selected verified upload identities, and projector version.
  Before publication, re-lock and revalidate the exact source set and live
  processing lease. A concurrent event, upload-state change, lease loss, or
  deadline expiry must prevent stale publication.
- In one transaction, replace the run's full current file projection, publish
  its processing state/fingerprint/completeness, and create the exact
  application receipt. Readers see either the old complete snapshot or the new
  complete snapshot, never a mixture.
- Exact receipt replay performs no storage read or rewrite. Different intents
  that converge on the same current fingerprint create their own receipts
  without rewriting semantically identical rows.
- Store at least organization/run/repository ownership, source event and
  sequence, diff and snapshot IDs, artifact declaration/upload identity,
  deterministic ordinal, opaque current/original entry identities, redacted
  current/original display paths, ambiguity metadata, before/after JSON states,
  attribution, and safe reason. Database uniqueness and foreign keys must
  preserve tenant/run ownership and deterministic ordering.
- Storage or parse failure publishes no partial rows. Use the BBX-009A bounded
  retry/failure/poison convergence and keep safe failure detail separate from
  raw immutable evidence.

### Freshness and query API

- Keep `core` and `files` processing states independent. A ready core projection
  does not imply that artifact-backed file evidence is ready.
- Extend framework-independent tenant-safe queries with:
  - files projector state/version/freshness/completeness on run list/detail;
  - bounded file-change pagination ordered by source sequence and ordinal with a
    stable opaque cursor;
  - safe source event, diff, snapshot, artifact, and entry identifiers needed
    for later evidence navigation.
- Compute effective file evidence/counts from a current compatible files
  projection. When required file evidence is missing, stale, processing,
  incomplete, or failed, return unknown plus stable reasons rather than the
  optimistic canonical metadata count.
- A files snapshot is current only when its stored source fingerprint matches
  the current canonical Git diff/declaration/verified-upload source set and the
  expected projector version. Missing/version-mismatched rows are stale.
- Wrong-tenant and missing run/file resources remain indistinguishable. Query
  results must not expose raw object identity, storage configuration, URLs,
  credentials, queue payloads, or unredacted paths.
- Do not assign quality verdicts or interpret path sensitivity in this task.

### Worker and operations

- Extend the existing injected consumer dispatcher so batch intents invoke
  `core` and artifact intents invoke `files`. Unknown or mismatched intent kinds
  fail closed and converge through the existing poison policy.
- Keep relay, visibility, lease, attempt-deadline, transition-margin, and
  shutdown invariants from BBX-009A. Storage timeout plus final transition must
  fit within the live projection lease and queue visibility window.
- Import/construction remains lazy and credential-free. Worker startup validates
  storage configuration without making a request; owned clients open/close once.
- Document configuration, intent backfill/replay, file states, retry versus
  terminal failures, storage outage recovery, projector versioning, and why
  projected attribution is temporal rather than causal.

## Acceptance Criteria

- Successful verification and its one `artifact.verified` intent commit
  atomically; rollback leaves neither. Exact and concurrent retries converge to
  one intent, and batch intents retain their existing behavior.
- The idempotent backfill creates only missing intents for already-verified,
  canonically linked Git file lists and performs no object reads.
- Queue payloads remain opaque and unchanged. Relay crash windows and duplicate
  queue delivery converge to one receipt per intent/projector/version.
- Worker object reads use only server-owned identity, never follow redirects,
  honor cancellation/deadlines/bounds, and independently prove exact byte length
  and SHA-256 before parsing.
- Missing, oversized, truncated, mutated, wrong-hash, wrong-media-type,
  compressed, non-UTF-8, invalid-JSON, unknown-version, and structurally invalid
  objects produce the specified retryable or terminal safe state without
  partial projection or mutation of raw evidence/upload history.
- Strict v1 parsing preserves opaque identities, rename endpoints, collision
  metadata, ordering, and all four attribution values. It never stores a raw
  private path or converts temporal attribution into causality.
- Multiple diffs/artifacts for one run rebuild one deterministic complete file
  snapshot. Duplicate delivery, concurrent consumers, late lower-sequence Git
  events, a verification race, and a source change during download cannot
  publish stale or mixed rows.
- Exact replay with the same source and files projector v1 is semantically
  identical. Version/fingerprint mismatch is reported stale until replay.
- Tenant-scoped run and file queries use stable pagination, cannot reveal
  another organization, and distinguish ready, processing, stale, incomplete,
  and failed file evidence from observed agent outcome and core state.
- Existing ingestion upload/TUS behavior, core projections, raw append-only
  guards, collector output, and non-file artifact handling remain green.
- No findings, policy, summary, dashboard/API, diff-text parsing, or BBX-010+
  behavior is introduced.

## Required Tests

- Runtime-schema and collector compatibility tests for valid v1 data, every
  field/enum, strict unknown-field rejection, bounds, IDs, ordering, duplicate
  identity, rename, binary metadata, unavailable entries, and redaction
  collisions.
- Storage package tests with loopback/fake providers for redirects across all
  relevant status codes, timeout/cancellation, streaming overflow/underflow,
  hash mismatch, provider errors, credential/header isolation, malformed
  responses, and resource cleanup. No live Supabase account is required.
- Real standard-PostgreSQL migration tests for intent target coherence,
  partial uniqueness, tenant/run ownership, verified-trigger atomicity,
  backfill idempotency, projection ownership/order, and atomic replacement.
- Real `pgmq` tests for artifact-intent send/read/archive, duplicate messages,
  visibility expiry, archive-window crash, malformed/mismatched intent, and
  poison convergence.
- Multi-client concurrency and fault-injection tests for concurrent finalize,
  verification rollback, same-run artifact consumers, source changes during
  read, lease/deadline loss, retry exhaustion, receipt dedupe, and old/new
  snapshot visibility.
- Query tests for unified core/files freshness, all completeness states, version
  mismatch, effective unknown file counts, stable run/file pagination including
  equal boundary keys, tenant isolation, and safe identifiers.
- Worker lifecycle tests for lazy configuration, bounded reads/concurrency,
  cancellation, storage/database/queue outages, in-flight shutdown, client
  closure, no hot loop, and secret-safe diagnostics.
- Regression tests for BBX-005 verification, BBX-009A batch/core processing,
  ingestion routes, collector Git fixtures, and repository-wide behavior.

## Validation

This task changes migrations, verification finalization, storage credentials,
tenant isolation, queue dispatch, evidence interpretation, and concurrent
publication. Run focused checks while editing, then one complete high-risk gate
on the final implementation state:

```text
pnpm install --frozen-lockfile
pnpm --filter @blackbox/database db:generate
pnpm --filter @blackbox/database db:validate
pnpm --filter @blackbox/database db:migrate:deploy
pnpm --filter @blackbox/database test:integration
pnpm --filter @blackbox/database test:queue
pnpm --filter @blackbox/artifact-storage test
pnpm --filter @blackbox/ingest test
pnpm --filter @blackbox/worker test
pnpm format:check
pnpm lint --force
pnpm typecheck --force
pnpm test --force
pnpm build --force
git diff --check
git status --short --untracked-files=all
```

Run PostgreSQL/PGMQ checks only against an explicitly authorized isolated
database using the CI-pinned image. Do not access port 5432 or an unidentified
database. Deterministic storage tests use injected fakes/loopback servers; do
not contact live Supabase or another network service. Do not start Docker,
install dependencies, or access a network locally without separate explicit
authorization.

Hosted CI must build the new workspace package, deploy a fresh migration set,
provision the pinned private queue, and run both PostgreSQL and queue suites.

## Deliverables

- Standard-PostgreSQL migration and Prisma models for artifact intents and file
  projections.
- Shared bounded artifact-storage reader package and private Supabase adapter.
- Strict Git file-list v1 runtime schema and compatibility fixtures.
- Deterministic files projector, atomic persistence, and worker dispatch.
- Tenant-safe file queries and unified freshness/completeness responses.
- Backfill/replay operation, operations documentation, and focused/high-risk
  validation evidence in the compact implementation report.

## Referenced Decisions and Documents

- `AGENTS.md`
- `docs/product/v0.1-scope.md`
- `docs/architecture/overview.md`
- `docs/architecture/evidence-model.md`
- `docs/architecture/git-artifact-formats-v1.md`
- `docs/architecture/v0.1-delivery-sequence.md`
- `docs/architecture/decisions/ADR-0003-durable-evidence-persistence.md`
- `docs/architecture/decisions/ADR-0004-transactional-processing-outbox.md`
- `docs/architecture/decisions/ADR-0005-artifact-upload-and-integrity.md`
- `docs/architecture/decisions/ADR-0008-local-git-evidence-and-attribution.md`
- `docs/architecture/decisions/ADR-0010-replayable-projections-and-processing-state.md`
- `docs/tasks/BBX-005-artifact-transport-and-storage.md`
- `docs/tasks/BBX-007-git-before-after-evidence.md`
- `docs/tasks/BBX-009A-processing-relay-and-core-query-projections.md`
- `docs/review-guidelines.md`

## Risks

- A verified object can later be missing or mutated; independent reads must fail
  visibly without rewriting immutable verification history.
- Downloading multiple bounded artifacts before an atomic rebuild can exceed
  attempt/lease/visibility limits unless cumulative budgets share one deadline.
- A projector can look ready while a new Git diff or verification commits;
  source-set revalidation and fingerprinting must close that publication race.
- Display paths are redacted evidence but can collide. Losing opaque identities
  or ambiguity metadata would produce misleading file rows.
- Refactoring authenticated reads into a shared package can regress ingestion
  verification unless its existing redirect, credential, and integrity tests
  remain part of the gate.
- Local high-risk validation requires separately authorized Docker/database
  access; live Supabase validation remains intentionally excluded.

## Open Questions

None. Findings, sensitive-path classification, test/change correlation, and
quality verdicts begin in BBX-010 and must consume only current compatible core
and files projections. Compression, additional artifact formats/providers, and
bulk replay administration require later approved work and, where they change
accepted architecture, a new or amended ADR.
