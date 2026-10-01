# ADR-0010: Replayable Projections and Processing State

- **Status:** Accepted
- **Date:** 2026-10-01
- **Decision owners:** Project architecture

## Context

Accepted evidence is immutable and queryable by canonical event sequence, but
the dashboard, findings, and summaries need tenant-safe run, command, tool,
test, Git, error, and usage views. Building those views in the ingestion request
would couple acceptance latency to processing and would make later projector
changes rewrite or reinterpret raw evidence in place.

ADR-0004 already requires a PostgreSQL transactional outbox and an at-least-once
handoff to `pgmq`. BBX-009 must now relay those intents, consume duplicate queue
messages safely, publish projections atomically, expose processing freshness,
and permit deterministic rebuilds without changing accepted batches or events.

Artifact-backed Git file projection has an additional dependency: the file-list
artifact may not be verified when its event batch is accepted. That work needs a
separate verified-artifact trigger and storage-reader boundary, so it should not
be hidden inside the first core projector implementation.

This decision introduces durable mutable models, replay/versioning semantics,
queue-consumer idempotency, and a new consistency boundary. It therefore meets
the ADR criteria in `docs/architecture/overview.md`.

## Decision

### Raw evidence remains authoritative

Immutable `evidence_events`, ordered by collector sequence within one run, are
the only source of truth for core projections. Projectors revalidate each stored
versioned event with the matching canonical schema before interpreting it. They
never derive facts from batch order, queue order, mutable projection rows, or
provider-native payloads.

Projection rows, processing attempts, queue delivery metadata, and consumer
receipts are derived operational state. They may be replaced or retried without
mutating batches, events, memberships, artifact declarations, or canonical
identities.

### Outbox relay and private queue

Use one private durable basic `pgmq` queue named `bbx_processing_v1`. The worker
connects through PostgreSQL and calls the private `pgmq` functions directly; it
does not expose `pgmq_public`, use PostgREST, or grant client roles queue access.

The queue payload is a strict versioned object containing only the processing
intent UUID. Organization, run, batch, projector, and evidence data are always
reloaded from trusted relational rows. Queue message IDs and delivery order are
operational metadata, never evidence identity or timeline order.

Queue provisioning is an explicit idempotent infrastructure command, not a core
Prisma migration. Core evidence and projection migrations remain deployable to
standard PostgreSQL without the `pgmq` extension. Production startup fails
closed with a safe configuration error when the required extension or queue is
absent; it does not create infrastructure implicitly.

The relay claims pending or expired processing intents with PostgreSQL time,
`FOR UPDATE SKIP LOCKED`, bounded batches, and an unguessable lease token. It
publishes outside the claim transaction and marks an intent delivered only when
the same unexpired lease still owns it. A crash after `pgmq.send` and before the
delivered transition may enqueue duplicates; consumers must converge by intent
UUID. Transient failures return the intent to delayed pending state with bounded
backoff. Exhausted or structurally invalid work becomes visible blocked state,
never silent success.

### At-least-once consumption

Consumers use a bounded `pgmq.read` visibility timeout and validate the complete
message before database work. A consumer fetches trusted intent/run/batch data
by intent UUID and uses a durable receipt unique by intent, projector name, and
projector version.

Projection publication and receipt creation commit in one transaction. A queue
message is archived only after that transaction commits or the exact receipt is
already present. A crash before commit leaves no partial projection. A crash
after commit but before archive causes a harmless replay that observes the
receipt and archives the duplicate message.

Malformed messages, missing ownership, unsupported intent kinds, unsupported
schema versions, and projection invariant violations produce bounded safe error
state. They never copy the queue body, raw event, credential, or connection
value into logs or diagnostics.

### Deterministic per-run rebuild

The initial projector is named `core` and has an explicit integer version. For
each applicable intent, it locks the server-owned run row, loads the complete
current raw event set in canonical sequence order through bounded keyset pages,
validates it, and computes a new projection snapshot with deterministic pure
logic. The worker enforces documented per-run event and projected-child limits;
exceeding a limit preserves raw evidence and produces visible safe failure
rather than unbounded memory use or a partial projection.

All current core projection rows for that run are replaced and the run
projection, source fingerprint, processing state, and consumer receipt are
published in one transaction. PostgreSQL MVCC ensures readers see either the
previous complete snapshot or the new complete snapshot, never a partially
rebuilt mix.

The source fingerprint contains at least the raw event count and maximum
sequence. Event count prevents a later lower-sequence arrival from appearing
current merely because the maximum did not change. A projection is current only
when its projector name/version and source fingerprint match the raw run state.
An exact batch containing no new events may create a receipt without changing
projection semantics.

Changing projector behavior requires a new projector version and replay from
raw evidence. It does not silently reinterpret a row labeled with an older
version. BBX-009 exposes an injected rebuild service for deterministic replay;
an operator-facing bulk rebuild command and old-version retention policy may be
added later.

### Core projection vocabulary

The first core snapshot contains tenant- and run-owned projections for:

- run lifecycle, duration, adapter/provider, observed outcome, and evidence
  completeness;
- commands and tool calls paired by canonical operation UUID;
- explicit test-run events only;
- Git snapshot and diff metadata plus artifact references, without downloading
  artifact bytes;
- errors with canonical evidence linkage;
- individual usage observations and conservative reported-token aggregates.

Every projected fact retains the canonical source event identity and sequence
needed to navigate back to evidence. Operation projections retain both start
and finish event references when present. Missing halves remain incomplete.
Multiple conflicting starts, finishes, run terminals, or reused operation IDs
become explicit projection conflicts rather than last-write-wins data.

No command name or exit code is treated as proof of a test. No missing token
measurement is treated as zero, and total tokens or cost are not invented.
Git file paths and attribution are not projected until the verified file-list
artifact is processed by the later artifact-backed slice.

### Processing and presentation state

Persist projector state separately from run evidence outcome. The core
processing lifecycle is `pending`, `processing`, `retrying`, `ready`, or
`failed`, with bounded attempts, lease identity/expiry, safe error code,
projector version, source fingerprint, and completion time.

Query services compute freshness against current raw state. A missing, older,
or fingerprint-mismatched snapshot is `processing`/stale even if its last build
was ready. A current projection with missing terminal evidence, open operations,
or projection conflicts is `incomplete`, not failed processing.

BBX-009 does not assign `PASS` or `REVIEW`; those require later deterministic
findings. It exposes processing state, evidence completeness, and the observed
run outcome separately so later presentation cannot conflate pipeline health,
agent exit, and code quality.

### Query boundary

Expose framework-independent, tenant-scoped database query functions for a
bounded run list and one run detail view. Queries require trusted
`organizationId` plus repository/run identity, use stable cursor pagination,
and never reveal another tenant's existence.

The query result distinguishes current, stale, incomplete, and failed
processing; returns conservative aggregates; and retains canonical event and
artifact identities for later evidence navigation. HTTP routes and dashboard UI
remain later tasks.

### Runtime and shutdown

The worker owns independently injectable relay and consumer loops with bounded
polling, batch size, concurrency, visibility timeout, retry delay, and shutdown
deadline. Imports and construction perform no I/O. `start()` validates
configuration and opens owned resources; `stop()` stops new claims, awaits
bounded in-flight work, releases or lets leases/visibility expire safely, closes
owned clients once, and remains idempotent.

## Delivery Slices

BBX-009 is delivered as two independently reviewed slices:

1. **BBX-009A — Processing Relay and Core Query Projections:** private `pgmq`
   relay/consumer, durable receipts and processing state, raw-event core
   projector, tenant-scoped query functions, and worker runtime.
2. **BBX-009B — Verified Artifact and File Projections:** an atomic
   artifact-verified processing trigger, bounded storage-reader/integrity
   boundary, versioned Git file-list parsing, file-change projections, and
   unified artifact-dependent freshness.

BBX-010 starts only after BBX-009B because sensitive-area and test/change rules
need trusted file projection.

## Consequences

### Positive

- Ingestion remains fast and independent of queue or projector availability.
- Duplicate publication, delivery, and worker crashes converge safely.
- Query rows can evolve and rebuild without weakening immutable evidence.
- Readers never observe a partially rebuilt run.
- Processing failure, incomplete evidence, agent outcome, and later quality
  verdicts remain distinct.
- Core PostgreSQL remains portable even though production uses Supabase Queues.

### Negative

- A full per-run rebuild does more work than an incremental projector, although
  it is simpler and safer at v0.1 scale.
- The outbox and queue intentionally provide at-least-once rather than exactly-
  once end-to-end delivery.
- Queue-enabled integration tests require a `pgmq`-capable PostgreSQL service in
  addition to ordinary migration coverage.
- Artifact-backed file projections require a second slice before findings can
  consume file paths.

## Alternatives Considered

### Project inside the ingestion transaction

Rejected because processing latency/failure would control evidence acceptance
and projector changes would expand the critical transaction.

### Consume processing intents directly without `pgmq`

Rejected because ADR-0004 already selected the outbox relay and queue handoff,
and bypassing it would leave the production queue/recovery boundary untested.

### Treat queue delivery as exactly once

Rejected because a crash between queue send/read and durable acknowledgement
can repeat a message. Correctness comes from receipts and idempotent rebuilds.

### Incrementally mutate projections event by event

Rejected for v0.1 because out-of-order batches, late lower sequences, projector
version changes, and interrupted operation pairs make incremental correctness
substantially harder to prove.

### Put `CREATE EXTENSION pgmq` in Prisma migrations

Rejected because raw persistence and query projections must remain portable to
standard PostgreSQL. Queue provisioning is infrastructure setup.

### Parse unverified Git artifacts during core projection

Rejected because the batch may arrive before artifact verification and no
artifact-completion intent currently exists. File projection belongs to
BBX-009B.

## Follow-up

- BBX-009A implements relay, consumer, core projections, and query state.
- BBX-009B adds verified artifact-backed file projections.
- BBX-010 consumes only current compatible projections and returns `unknown`
  when required projection evidence is missing or stale.
- A later operations task may add bulk replay UI, projection-version retention,
  and dead-letter administration.

## References

- [Supabase Queues](https://supabase.com/docs/guides/queues)
- [Supabase PGMQ API](https://supabase.com/docs/guides/queues/pgmq)
- [Architecture overview](../overview.md)
- [Canonical Evidence Model](../evidence-model.md)
- [ADR-0003](ADR-0003-durable-evidence-persistence.md)
- [ADR-0004](ADR-0004-transactional-processing-outbox.md)
- [v0.1 delivery sequence](../v0.1-delivery-sequence.md)
