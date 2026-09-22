# ADR-0003: Durable Evidence Persistence and Identity Constraints

- **Status:** Accepted
- **Date:** 2026-09-22

## Context

ADR-0002 defines collector-owned run, batch, event, operation, and artifact
identifiers at the wire boundary. The ingestion service must treat those values
as untrusted canonical identifiers, attach trusted organization and receipt
context, persist evidence without mutation, and distinguish an exact retry from
conflicting identifier reuse.

These guarantees cannot live only in Fastify handlers. Concurrent requests,
future import paths, worker bugs, or administrative code could otherwise create
duplicate sequence positions, move evidence between tenants or runs, or rewrite
the raw record on which findings and summaries depend.

At the same time, the relational schema must not become the public evidence
contract. Database migrations, query projections, storage locations, and
provider details evolve for different reasons than the versioned wire schema.

## Decision

Use PostgreSQL as the durable source of truth for accepted raw evidence and
enforce stable identity, ownership, ordering, and immutability at the database
boundary.

### Separate database identity from canonical identity

Every persisted entity receives a server-owned database UUID. Collector-owned
UUIDs are stored in explicitly named canonical identifier columns and never used
as authorization or tenant identity.

Every tenant-owned table carries `organization_id`. Repository and run ownership
is established from trusted server context, not from the uploaded envelope.
Constraints must prevent a child record from referencing a repository, run,
batch, event, or artifact owned by a different organization.

### Persist delivery receipts separately from raw events

An accepted batch is a delivery receipt, while an evidence event is an immutable
domain record. Store batches, events, and their ordered membership separately so
that:

- retrying a batch does not duplicate raw events;
- a later batch may safely contain an already-seen identical event;
- conflicting reuse can be diagnosed without overwriting the original record;
- delivery history does not become the canonical event timeline.

The event's collector-assigned `sequence` remains the authoritative per-run
order. Batch position records transport order only.

### Preserve the accepted versioned objects

Store the validated versioned batch and event objects as PostgreSQL `jsonb` in
addition to scalar columns required for identity, ownership, ordering, time, and
indexing. JSON object key order and transport whitespace are not evidence
semantics.

The ingestion application later compares a duplicate identifier with the
stored validated `jsonb` value. Equal content is an idempotent retry. Unequal
content is an integrity conflict. The database never resolves a conflict with
an upsert that updates raw evidence.

This decision does not define a canonical JSON byte serialization or a public
content fingerprint. Such a protocol requires a separate decision if later
needed for signing or export integrity.

### Make raw records append-only

Accepted batch receipts, raw evidence events, batch membership, and declared
artifact identity/integrity metadata are append-only. The initial migration uses
database constraints and migration-owned SQL where Prisma cannot express the
invariant. Application-facing code exposes no update or delete operation for
these records.

Corrections, processing state, storage state, projections, analyzer results,
summaries, and accepted-risk decisions live in separate records. They do not
rewrite raw evidence.

### Enforce durable uniqueness and same-run ownership

The persistence layer enforces at least:

- canonical run identity is unique within an organization;
- canonical batch identity is unique within an organization;
- canonical event identity is unique within an organization;
- event sequence is unique within a run;
- canonical artifact identity is unique within an organization;
- batch membership has one event per position and no repeated event;
- batch, event, and artifact relationships cannot cross organization or run
  ownership;
- schema versions and non-negative safe-integer fields remain within supported
  durable bounds.

### Keep raw storage separate from projections

The first migration stores only the minimum ownership hierarchy and raw evidence
foundation. Query projections, findings, summaries, processing state, queue
state, object-storage locations, retention, and analytics are added by their
own tasks and remain rebuildable or independently mutable as appropriate.

## Relational Responsibilities

The initial persistence model contains these concepts:

- `organization`: trusted tenant root, even while v0.1 has one workspace;
- `repository`: server-owned repository identity within an organization;
- `run`: server record bound to one organization and repository plus one
  collector-owned canonical run UUID;
- `evidence_batch`: immutable accepted delivery receipt with server receipt time;
- `evidence_event`: immutable canonical event with indexed envelope fields and
  the complete validated JSON object;
- `evidence_batch_event`: ordered delivery membership;
- `artifact_declaration`: immutable post-redaction identity and integrity
  metadata declared by canonical events;
- `evidence_event_artifact`: same-run linkage from an event to the artifact
  reference location inside that event.

Exact table and column names may follow repository conventions, but these
responsibilities and trust boundaries are invariant.

## Transaction Boundary

This ADR defines durable constraints, not the complete ingestion algorithm.
BBX-004 must persist a new batch, new events, membership, artifact declarations,
and durable processing intent in one retry-safe transaction. It must map unique
constraint races to either an exact retry or an explicit conflict after reading
the winning immutable record.

## Migration and Test Strategy

- Prisma owns the schema, generated client, and checked-in migrations.
- Migration SQL remains authoritative for PostgreSQL constraints, indexes, and
  append-only guards that Prisma cannot represent.
- Database integration tests run against real PostgreSQL from a clean migration,
  not SQLite or mocks.
- CI provisions an ephemeral PostgreSQL service and executes the migration and
  constraint suite.
- Supabase-specific clients, RLS policies, queues, and storage APIs are not part
  of the core database package in this decision.

## Consequences

### Positive

- Evidence identity and ordering survive application bugs and concurrency.
- An uploaded UUID cannot become a trusted tenant or database identifier.
- Exact retries can be distinguished from conflicting reuse without rewriting
  the original event.
- Delivery history and canonical timeline remain separate.
- Raw evidence stays portable across standard PostgreSQL deployments.
- Later projections and analyzers can be rebuilt from immutable source records.

### Negative

- The schema contains deliberate identity duplication and composite ownership
  constraints.
- Some invariants require hand-reviewed SQL in Prisma migrations.
- Append-only guards make test cleanup and administrative repair more deliberate;
  tests should use ephemeral databases or transaction rollback.
- `jsonb` semantic equality is suitable for retry comparison but is not a signed
  canonical byte representation.

## Alternatives Considered

### Use collector UUIDs as database primary keys

Rejected because untrusted wire identity would be confused with server-owned
persistence and authorization identity, especially across future tenants.

### Store each batch as one JSON document only

Rejected because cross-batch event uniqueness, per-run ordering, artifact
ownership, and evidence queries would be weak or expensive to enforce.

### Upsert events on identifier conflict

Rejected because an update can silently replace the evidence behind an existing
finding or summary. Conflicting reuse must be visible.

### Normalize every payload field into relational columns

Rejected because it duplicates the versioned canonical schema, expands the
first migration substantially, and couples raw storage to current projections.

### Test against SQLite or mocked Prisma calls

Rejected because PostgreSQL `jsonb`, composite constraints, transaction races,
and append-only migration SQL are the behavior under review.

## Follow-up Work

- BBX-003 implements and verifies this persistence foundation.
- BBX-004 defines the ingestion transaction, exact-retry/conflict responses,
  authentication context, and durable processing-intent handoff.
- BBX-005 defines artifact-byte upload, hash verification, and storage state.
- A future data-lifecycle decision defines retention, repair authorization,
  partitioning, and archival without weakening raw-evidence integrity.

## References

- [Architecture overview](../overview.md)
- [Canonical Evidence Model](../evidence-model.md)
- [ADR-0001](ADR-0001-modular-monolith.md)
- [ADR-0002](ADR-0002-canonical-evidence-envelope.md)
- [v0.1 delivery sequence](../v0.1-delivery-sequence.md)
