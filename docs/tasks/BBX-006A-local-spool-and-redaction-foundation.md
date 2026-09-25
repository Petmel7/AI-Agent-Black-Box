# BBX-006A: Local Spool and Redaction Foundation

- **Status:** Done
- **Owner:** Implementation Chat
- **Review:** Review Chat
- **Architecture:** ADR-0001 through ADR-0005, plus proposed ADR-0006 and ADR-0007

## Goal

Implement the offline-first collector foundation that assigns stable run/event
identity, redacts and bounds opted-in text before persistence, stores immutable
events and artifacts outside the repository, creates stable evidence batches,
and exposes safe local status without requiring a backend.

## Context

BBX-006 is split so local durability and privacy can be reviewed before adding
HTTP/TUS delivery and wrapped-process failure behavior. BBX-006B will consume
this task's public collector/spool boundary without changing stored canonical
identity. ADR-0006 and ADR-0007 must be accepted with this task.

## In Scope

- Collector-owned modules inside `apps/cli`; no empty shared package.
- Built-in Node 24 `node:sqlite`, versioned local migrations, WAL, defensive
  settings, busy handling, and explicit lifecycle.
- Durable run identity, transactional per-run sequence allocation, immutable
  validated events, redacted artifact files, stable batches, and local
  operational status.
- Metadata-only capture by default and explicit bounded textual capture through
  ADR-0007's initial ruleset.
- Filesystem/quota recovery diagnostics without destructive cleanup.
- `blackbox status [--json] [--run <run-id>]` for content-free local visibility.
- A small public collector-session API for BBX-007/008 and delivery-claim API for
  BBX-006B.

## Out of Scope

- HTTP ingestion, authentication, retry/backoff, TUS, remote acknowledgement, or
  signed capabilities; BBX-006B owns them.
- Child-process wrapping, exit/signal propagation, or backend-outage isolation;
  BBX-006B owns them.
- Git capture/attribution and Codex telemetry mapping.
- Background daemons, automatic deletion/retention, destructive repair, spool
  encryption, keychain integration, or arbitrary user regular expressions.
- PostgreSQL, Supabase, server routes, projections, findings, summaries, or UI.

## Configuration and Location

- Resolve the default spool under the platform's per-user application-data
  location and outside the captured repository. Allow an explicit override for
  tests and recovery.
- Read capture profile, quota, repository-root placeholder, explicitly selected
  environment names, and optional local literal-file path only at the CLI
  composition root.
- Validate configuration before opening a session. Never print rule values,
  secret environment values, or literal-file content.
- Create directories/files with restrictive current-user permissions where the
  platform supports them. Document that v0.1 is not encrypted at rest.

## SQLite Requirements

Implement atomic local migrations for at least:

- schema metadata;
- runs, capture owner/lease, state, and next sequence;
- immutable canonical events;
- immutable artifact metadata and opaque relative file identity;
- immutable serialized batches and ordered membership;
- mutable batch/artifact work state, lease token/expiry, safe error code,
  attempt count, next-attempt time, and remote acknowledgement placeholders.

Required guarantees:

- Enable and verify foreign keys, WAL, defensive mode, and bounded busy timeout
  on each file-backed connection.
- Use immediate transactions for run creation/ownership, event+sequence commit,
  batch creation, and work claims.
- Validate canonical events and batches with `@blackbox/contracts` before commit.
- Persist stable UUIDs, `sentAt`, membership, and exact serialized validated
  batch bodies. Retries cannot regenerate the same ID with different content.
- Enforce ownership, uniqueness, state, range, and immutable-content invariants
  with constraints/triggers where practical.
- A stale lease token cannot update work. Expired work becomes eligible through
  an explicit recovery operation without changing canonical content.
- A newer unsupported schema fails closed. Migrations never reset, downgrade,
  delete, or rewrite existing evidence.
- Imports and construction perform no filesystem I/O. Open, migrate, recover,
  and close are explicit and disposable.

## Artifact and Filesystem Requirements

- Keep files below the spool root under opaque collector names; never use
  untrusted filenames or write inside the repository.
- Accept only bounded textual input in this task. Decode strict UTF-8, redact in
  memory, then write final bytes through temp-file, flush, atomic rename, and
  database-reference ordering.
- Compute byte length and SHA-256 over the exact stored bytes and build canonical
  references from those observations.
- Enforce the 50,000,000-byte server maximum, 4,096-character excerpt maximum,
  documented input/rule limits, and a documented default total spool quota.
- Never automatically delete unacknowledged, blocked, or otherwise retained
  data. Quota pressure produces explicit truncated/omitted/unavailable state.
- Detect missing/corrupt referenced files and orphan temp/final files as safe
  status problems; do not silently recreate or delete them.

## Redaction Requirements

- Implement metadata-only default and explicit per-capture-class opt-in.
- Implement fixed high-confidence detectors, in-memory collector credential
  literals, conservative secret-like environment values, explicitly named
  environment values, and exact literals from an explicitly selected file.
- Do not accept arbitrary user regex.
- Replace repository-root and user-home prefixes with stable placeholders for
  opted-in paths.
- Apply redaction before excerpting, hashing, file/spool writes, batching, or
  diagnostics. Use `collector-redaction-v1` consistently.
- Use a constant replacement independent of value/length, merge overlapping
  matches, and handle input-boundary matches deterministically.
- Invalid encoding or redaction failure must become omitted/unavailable; raw
  fallback is forbidden.
- Diagnostics contain stable safe codes and aggregate counts only.

## Batching and Status

- Form a batch from consecutive unbatched events of one run in sequence order,
  with at most 500 events and a conservative serialized limit below 16 MiB.
- Commit the exact strict-contract body before making it eligible for BBX-006B.
- Keep batch membership separate from canonical ordering.
- Expose repository-independent APIs to claim/release/transition work with
  bounded leases; do not include any network implementation.
- Human and JSON status distinguish active/closed/interrupted runs; pending,
  leased, retry-delayed, delivered/verified placeholders, and blocked work;
  counts/bytes; next retry; safe error codes; corruption/quota degradation.
- Status never displays captured text, artifact content, absolute artifact
  paths, rule values, credentials, tokens, signed URLs, or raw errors.

## Required Tests

- Fresh/repeated migration, newer-version rejection, pragma verification,
  import-without-I/O, explicit disposal, and real temporary file-backed SQLite.
- Concurrent run ownership/sequence allocation across connections, immutable
  records, stable serialization, constraint failures, work claims, stale-owner
  rejection, lease recovery, and bounded busy behavior.
- Built-in/configured redaction, overlaps, constant replacement, path
  placeholders, invalid UTF-8, disabled capture, redactor failure, and bounds.
- Secret sentinels absent from SQLite, WAL/SHM, artifacts/temp files, serialized
  batches, status, stdout, and stderr.
- Failure injection around temp write, flush, rename, and DB commit proves no row
  references partial/missing bytes and orphan state is visible.
- Quota tests prove explicit degradation and no automatic deletion.
- Status human/JSON output is stable, bounded, and content-free; existing
  help/version behavior remains compatible.

## Acceptance Criteria

- Run/event/artifact/batch identity is stable and allocated without a backend.
- Sequence allocation and work claims remain correct under concurrent local
  connections and crash recovery.
- Metadata-only is the default; opted-in content is bounded and redacted before
  every durable representation.
- No unredacted sentinel, credential, absolute private path, or rule value
  appears in the complete spool/files/log/status surface.
- No collector operation creates or changes a file in the captured repository.
- Unacknowledged data is never deleted automatically, and corruption/quota
  degradation is visible.
- BBX-006B can consume stable serialized batches/artifacts and lease-safe work
  through explicit typed APIs without bypassing invariants.

## Validation

```text
pnpm install --frozen-lockfile
pnpm --filter @blackbox/cli test
pnpm format:check
pnpm lint --force
pnpm typecheck --force
pnpm test --force
pnpm build --force
git diff --check
git status --short --untracked-files=all
```

Tests use unique temporary directories only. They must not start Docker, access
PostgreSQL/Supabase or an external network, or install global services without
explicit user authorization.

## Deliverables

- Accepted ADR-0006 and ADR-0007.
- Collector configuration, redaction, bounded capture, artifact filesystem,
  SQLite spool/migrations, batching, leases/recovery, and status modules.
- Updated CLI help, environment example, root/CLI documentation, and a safe
  local-spool recovery runbook.
- Required deterministic security, concurrency, filesystem, and crash tests.

## Referenced Documents

- `AGENTS.md`
- `docs/product/v0.1-scope.md`
- `docs/architecture/overview.md`
- `docs/architecture/v0.1-delivery-sequence.md`
- `docs/architecture/evidence-model.md`
- `docs/architecture/decisions/ADR-0001-modular-monolith.md`
- `docs/architecture/decisions/ADR-0002-canonical-evidence-envelope.md`
- `docs/architecture/decisions/ADR-0005-artifact-upload-and-integrity.md`
- `docs/architecture/decisions/ADR-0006-local-spool-and-delivery-state.md`
- `docs/architecture/decisions/ADR-0007-collector-redaction-and-bounded-capture.md`
- `docs/review-guidelines.md`

## Risks

- `node:sqlite` is release-candidate API in Node 24 and requires compatibility
  tests against the repository's supported runtime.
- SQLite synchronous calls can stall capture if transactions or content writes
  are too broad.
- Filesystem durability/permissions differ by platform.
- Pattern redaction has false positives and false negatives and cannot prove
  arbitrary content safe.
- Disk exhaustion may prevent even a durable degradation marker; safe stderr
  warning remains necessary.

## Open Questions

1. Confirm ADR-0006 and ADR-0007.
2. Confirm built-in `node:sqlite` and no native SQLite dependency.
3. Confirm metadata-only default, fixed/literal/environment rules, and no
   arbitrary user regex in v0.1.
4. Confirm BBX-006A stops before network/TUS and wrapped-process implementation.
