# ADR-0004: Transactional Processing Outbox and At-Least-Once Handoff

- **Status:** Accepted
- **Date:** 2026-09-23
- **Decision owners:** Project architecture

## Context

BBX-004 must accept an evidence batch durably and ensure that accepted evidence
can later be processed. Persisting evidence and publishing a queue message as
two unrelated operations creates a dual-write failure: evidence may commit
without work being queued, or work may be visible before its evidence commits.

The HTTP request must not wait for analysis, and a temporary queue outage must
not turn a durably accepted batch into lost work. Raw evidence remains portable
to standard PostgreSQL, while Supabase Queues / `pgmq` remains an infrastructure
choice rather than a domain requirement.

## Decision

Use a PostgreSQL transactional outbox for processing intent.

### Atomic acceptance

The ingestion transaction writes the accepted batch, any new immutable events,
memberships, artifact declarations and links, and exactly one durable processing
intent for the accepted batch. The transaction commits all of them or none of
them.

An HTTP success means evidence and its processing intent are committed. It does
not mean projection, analysis, queue delivery, or artifact-byte upload has
completed.

### Intent identity and ownership

Each intent has a server-owned UUID, trusted `organization_id`, `run_id`, and
`batch_id`, plus a closed intent kind. A uniqueness constraint permits one
initial processing intent per accepted batch and kind. Exact batch retries reuse
the committed result and never create duplicate intent rows.

Processing intent is mutable operational state, not raw evidence. Its delivery
attempt, lease, and completion metadata may evolve without modifying the batch
or events that caused it.

### Queue handoff

A later relay reads committed pending intents and publishes them to `pgmq`. The
relay uses the intent UUID as the stable idempotency key and records delivery
progress only after publish succeeds.

The handoff is at-least-once. A crash between publish and recording delivery may
produce duplicate queue messages, so consumers must deduplicate or claim work by
intent UUID. Neither queue ordering nor queue message identity becomes evidence
ordering or canonical evidence identity.

BBX-004 creates and proves the atomic pending intent but does not implement the
relay, queue provisioning, or worker. Until the relay exists, pending intent is
visible durable work rather than silently lost work.

### Recovery

Queue state is not the source of truth for acceptance. Missing queue messages
can be reconstructed from pending intents. Relay retries use bounded leases and
record safe error metadata without payloads, credentials, or raw authorization
headers. Permanent-failure and operator recovery behavior belongs to the worker
delivery task.

## Consequences

### Positive

- Evidence and the obligation to process it cannot diverge at commit time.
- Queue outages do not block or erase accepted evidence.
- Exact retries do not create duplicate processing obligations.
- Raw persistence remains portable to standard PostgreSQL.
- `pgmq` can be replaced without changing the ingestion contract.

### Negative

- Processing requires a later relay and may be delayed after HTTP acceptance.
- At-least-once delivery requires idempotent consumers.
- Operational intent state and retry observability add another durable model.

## Alternatives Considered

### Publish after commit without an outbox

Rejected because a process crash or queue outage can leave accepted evidence
without recoverable processing work.

### Publish before committing evidence

Rejected because a worker may observe missing or rolled-back evidence.

### Call `pgmq` inside the evidence transaction

Rejected for the initial boundary because it makes successful ingestion depend
on extension availability and couples core acceptance to one queue
implementation. A later deployment may optimize the relay while preserving the
outbox guarantee.

### Use the queue as the only processing-intent record

Rejected because queue retention and delivery state are not the durable evidence
acceptance boundary and would weaken portable recovery.

## Follow-up Work

- BBX-004 implements atomic creation and exact-retry behavior for pending
  processing intents.
- BBX-009 implements relay/consumer behavior, leases, retries, idempotent
  projections, and processing-state visibility.

## References

- [Architecture overview](../overview.md)
- [v0.1 delivery sequence](../v0.1-delivery-sequence.md)
- [ADR-0002](ADR-0002-canonical-evidence-envelope.md)
- [ADR-0003](ADR-0003-durable-evidence-persistence.md)
