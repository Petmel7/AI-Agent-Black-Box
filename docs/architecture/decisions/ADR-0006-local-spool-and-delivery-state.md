# ADR-0006: Durable Local Spool and Delivery State Machine

- **Status:** Accepted
- **Date:** 2026-09-24
- **Decision owners:** Project architecture

## Context

The local collector must keep recording while ingestion or object storage is
unavailable, survive process and machine restarts, preserve canonical identity
across retries, and make undelivered evidence visible. Its local durability
model cannot depend on a successful cloud request, and retry state cannot be
encoded by mutating canonical evidence.

BBX-004 and BBX-005 already define idempotent evidence and artifact endpoints.
The collector now needs a durable state machine that uses those guarantees
without silently dropping data, duplicating identity, or allowing concurrent
collector processes to deliver the same local work unsafely.

## Decision

Use a versioned SQLite spool plus an adjacent immutable artifact directory as
the collector's local source of truth until remote acknowledgement.

### Runtime and location

Use the built-in `node:sqlite` module from the repository's pinned Node 24
runtime. It avoids an additional native dependency and is sufficient for the
single-machine transactional boundary. The module remains behind a small
collector-owned adapter so a later runtime change does not affect domain state.

The default spool lives in the operating system's per-user application-data
location, never inside the captured repository. An explicit spool-directory
override is allowed for testing and operator recovery. The collector creates
directories and files with restrictive current-user permissions where the
platform supports them and never commits spool files to Git.

SQLite uses foreign keys, WAL mode, a bounded busy timeout, defensive settings,
and atomic versioned migrations. A spool with a newer unsupported schema fails
closed; it is never reset or downgraded automatically.

### Durable identities and immutable content

The collector commits a canonical run UUID before the wrapped process starts.
For each run, the next sequence is allocated in the same immediate transaction
that validates and inserts the immutable canonical event. Committed sequences
and identifiers are never reused or rewritten. Gaps remain legal.

Events, artifact declarations, redacted artifact bytes, batch IDs, `sentAt`,
membership, and serialized validated batch bodies are stable once committed.
Retry always sends the same stored bytes for the same canonical identifier. A
change in content requires a new identifier.

Artifact bytes are written to a temporary file, flushed, atomically renamed to
an immutable server-independent local name, and only then referenced by a
SQLite transaction. A crash may leave an unreferenced file but must not leave a
committed row pointing to a partially written artifact. Recovery may report and
later remove confirmed orphans; it never guesses that referenced data is safe
to delete.

### Independent state axes

Canonical evidence stays immutable while mutable local operational records use
closed states.

Run capture state:

- `active`: the owning collector may append observations;
- `closed`: a terminal observation was durably recorded;
- `interrupted`: the owner lease expired without a durable terminal observation.

Batch delivery state:

- `pending`: ready or waiting for its next attempt;
- `leased`: one delivery owner holds a bounded lease;
- `delivered`: ingestion returned a validated `accepted` or
  `already_accepted` response for the identical batch;
- `blocked`: a non-retryable authentication, validation, ownership, or integrity
  response requires operator action;
- `superseded`: an explicitly rejected oversized batch was replaced by smaller
  stable batches before any acceptance was possible.

Artifact delivery state:

- `pending`: declared remotely or awaiting an upload attempt;
- `leased`: one delivery owner is uploading or requesting verification;
- `verified`: the server returned a validated verified result;
- `blocked`: a non-retryable declaration or integrity response requires
  operator action.

Leases use wall-clock expiry only for local work ownership, not evidence order.
Claim and transition operations use SQLite transactions and compare the current
stored lease token. An expired lease returns work to `pending`; a stale owner
cannot record success. Concurrent processes may repeat safe remote requests but
must converge on one durable local result.

### Batching and ordering

Only consecutive pending events from one run may form a batch. Batch creation
enforces the canonical maximum of 500 events and a conservative serialized-byte
limit below the server's 16 MiB request limit. The exact validated JSON body is
persisted before delivery.

Batch membership is a transport concern and does not change event sequence.
Acknowledgement of a later batch does not imply acknowledgement of an earlier
one, but the default scheduler delivers batches per run in sequence order to
keep recovery understandable.

An explicit server `413` may supersede an unaccepted batch and create smaller
batches containing the same immutable events with fresh batch IDs. An ambiguous
network failure never triggers rebatching because the original request may have
committed; it retries the identical batch first.

### Retry classification

- Validated `202 accepted` and `200 already_accepted` are success.
- Network failures, timeouts, `408`, `425`, `429`, and `5xx` are retryable.
- `Retry-After` is honored within configured bounds; otherwise use exponential
  backoff with jitter and a persisted attempt count.
- `401`, hidden `404`, validation/unsupported-version responses, `409` identity
  conflicts, and artifact integrity rejection become visible `blocked` work.
- Unknown or malformed responses fail closed and remain retryable with a safe
  diagnostic until an operator can inspect them.

Retries are finite per drain invocation but unlimited over the lifetime of
retained work. There is no background daemon in v0.1. Delivery runs during a
bounded best-effort flush and through an explicit retry command.

### Artifact upload recovery

The spool retains redacted immutable bytes and the server upload identifier
until verification. It never persists API tokens, signed upload tokens, raw
authorization headers, or service credentials.

TUS session URLs and signed capabilities remain in memory. A network failure in
the same process may resume the session by querying its offset. After process
restart or capability expiry, the collector requests a fresh authorized session
and may restart byte transfer from zero. This intentionally prefers secret
non-persistence over byte-level resume across process restart. Stable artifact
identity and server idempotency still make the overall delivery restart-safe.

### Wrapped-process isolation

Spool initialization and durable run creation must succeed before launching the
wrapped process. After launch, ingestion, storage, retry, or later collector
errors never replace the wrapped process exit status. The collector writes one
safe warning, leaves recoverable work in the spool, and exposes the pending or
blocked state through status output.

Signals are forwarded where the platform supports them. A collector crash may
leave the run without `run.finished`; recovery marks only local operational
state as interrupted and never fabricates a canonical outcome.

### Capacity and retention

Capture has explicit per-item limits and a configurable total spool quota. The
collector never automatically deletes pending, leased, blocked, or otherwise
unacknowledged evidence to make room. When optional content cannot fit, it is
represented as truncated, omitted, or unavailable before event persistence. If
essential evidence cannot be committed, capture degradation is reported
visibly while the already-running child is allowed to finish.

Automatic retention and deletion of remotely acknowledged data are deferred.
An explicit future cleanup command may remove only data proven delivered and
verified.

## Consequences

### Positive

- Canonical IDs and exact request bodies survive retries and restarts.
- Backend outages do not control the wrapped process outcome.
- SQLite transactions provide a small, inspectable concurrency boundary.
- Secrets and signed storage capabilities are not durable local state.
- Operator-visible blocked state replaces silent loss or infinite hot loops.

### Negative

- Restarting during an artifact upload may resend bytes from zero.
- Synchronous `node:sqlite` operations must remain small and off hot streaming
  paths.
- WAL, leases, local migrations, orphan files, and spool quotas require careful
  crash and concurrency tests.
- A full spool cannot preserve new essential evidence and must degrade visibly.

## Alternatives Considered

### JSON files only

Rejected because atomic multi-record state transitions, leases, uniqueness, and
queryable recovery would require rebuilding database behavior incorrectly.

### Store the spool inside each repository

Rejected because the recorder must not modify the captured source tree and
because spool files could be committed accidentally.

### Persist signed upload capabilities for exact TUS resume after restart

Rejected for v0.1 because the unencrypted spool is not a credential vault.
Restart-safe artifact identity is more important than preserving the last byte
offset.

### Delete oldest pending evidence when the quota is full

Rejected because it violates the requirement to never discard an undelivered
run silently.

### Add a background delivery service

Deferred. An explicit command and bounded lifecycle flush are sufficient for a
single-developer v0.1 and avoid another long-running process.

## Follow-up Work

- BBX-006 implements the spool, delivery state machine, retry client, and
  recovery/status commands.
- BBX-007 supplies Git observations and redacted Git artifacts.
- BBX-008 supplies documented Codex observations to the collector session.
- BBX-013 proves restart recovery end to end and may add acknowledged-data
  cleanup.

## References

- [Architecture overview](../overview.md)
- [Canonical Evidence Model](../evidence-model.md)
- [v0.1 delivery sequence](../v0.1-delivery-sequence.md)
- [ADR-0002](ADR-0002-canonical-evidence-envelope.md)
- [ADR-0005](ADR-0005-artifact-upload-and-integrity.md)
- [Node.js SQLite API](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html)
