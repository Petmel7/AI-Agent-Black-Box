# Architecture Overview

**Status:** Initial architecture for v0.1

**Last updated:** 2026-09-21

## Architectural Style

AI Agent Black Box starts as a modular monolith in a TypeScript monorepo. It has separate process entrypoints for different runtime characteristics while sharing domain packages, contracts, one PostgreSQL database, and one artifact store.

This design keeps v0.1 operationally small without coupling telemetry ingestion or background analysis to the Next.js request lifecycle.

The governing decision is [ADR-0001](decisions/ADR-0001-modular-monolith.md).

## System Context

```text
Codex
  │
  │ OTel / hooks
  ▼
Local Collector CLI
  ├─ Git baseline and final snapshot
  ├─ secret redaction
  ├─ local SQLite spool
  └─ batching and retries
          │
          │ HTTPS
          ▼
Node.js Ingestion API
  ├─ authentication
  ├─ validation
  ├─ deduplication
  ├─ evidence persistence
  └─ job enqueue
          │
    ┌─────┼──────────────┐
    ▼     ▼              ▼
Postgres  Object storage Queue
    │                    │
    │                    ▼
    │               Node.js Worker
    │                 ├─ projections
    │                 ├─ deterministic analysis
    │                 ├─ test correlation
    │                 └─ evidence-backed summary
    │                    │
    └────────────────────┘
              │
              ▼
       Next.js Dashboard
```

## Process Boundaries

### Web

The Next.js application owns human-facing behavior:

- Run list and run details.
- Evidence navigation.
- Workspace and repository settings introduced within the current product scope.
- Control-plane mutations.
- Signed artifact download requests.

The web process may query application projections directly through the shared database package. It does not receive high-volume telemetry and does not execute long-running analysis.

### Ingestion

The Fastify service owns machine-facing write traffic:

- API-token authentication.
- Request size and rate limits.
- Versioned payload validation.
- Idempotent event and batch persistence.
- Artifact upload coordination.
- Analysis job creation.

The ingestion request completes after durable persistence and enqueue. It does not wait for projections, analyzers, or an LLM.

### Worker

The worker consumes durable jobs and owns derived data:

- Normalize provider-specific observations.
- Build or rebuild query projections.
- Correlate commands, file states, and tests.
- Run deterministic findings.
- Generate evidence-backed summaries.
- Record processing failures and retry state.

All jobs must be idempotent. A job may be replayed when analyzer logic changes.

### CLI and Local Collector

The CLI is the trust boundary closest to the developer's repository:

- Start and identify a run.
- Capture Git state before and after the agent.
- Receive documented Codex events.
- Apply local redaction policy.
- Bound or externalize large outputs.
- Persist undelivered batches in SQLite.
- Retry delivery without duplicating events.

The collector must not require the cloud service to remain available while Codex works.

## Logical Modules

The initial repository should establish these boundaries:

```text
apps/
  web/       Next.js dashboard and control plane
  ingest/    Fastify machine API
  worker/    background job consumer
  cli/       local collector entrypoint

packages/
  contracts/ shared runtime-validated API contracts
  database/  Prisma schema, migrations, and database access
  config/    shared TypeScript, lint, and test configuration
```

Add domain packages such as `event-schema`, `analyzers`, `git`, and `redaction` only when their owning task defines a real public contract. Do not create empty packages solely to mirror the eventual architecture.

## Storage Model

### PostgreSQL

PostgreSQL stores:

- Workspace and repository metadata.
- Runs and current processing state.
- Append-only evidence event metadata and bounded payloads.
- Commands, tests, file-change, and finding projections.
- Artifact metadata and hashes.
- Job and processing metadata when provided by the selected queue implementation.

The raw evidence log is append-only. Query-oriented tables are rebuildable projections, not substitutes for raw evidence.

### Object storage

Object storage holds potentially large or independently downloadable artifacts:

- Full diffs.
- Long command output.
- Test, coverage, and SARIF reports.
- Export bundles.
- Future media artifacts.

PostgreSQL stores the object key, size, media type, redaction status, and content hash.

### Local SQLite spool

SQLite on the developer machine stores undelivered run batches and delivery state. It is not the canonical cloud database and must not contain secrets that should have been removed by the collector.

## Evidence Processing Model

The system uses append-only evidence with asynchronous projections rather than full application-wide event sourcing.

```text
provider event
    ↓
canonical evidence event
    ↓
immutable persistence
    ↓
query projections
    ↓
deterministic findings
    ↓
summary grounded in evidence and findings
```

Reprocessing may create a new analyzer result version. It must not mutate the evidence that produced an earlier result.

## Trust and Privacy Boundaries

- The local collector is the preferred location for secret and content redaction.
- Raw prompt content and full command output are disabled by default unless a user opts in.
- Authentication tokens never enter evidence payloads.
- Artifact access is server-authorized and time-limited.
- Evidence, inference, and user decisions remain distinct record types.
- Provider-reported facts and Black Box estimates must be labeled separately.

## v0.1 Deployment Shape

```text
Vercel
  └─ web

Long-running Node.js host
  ├─ ingest
  └─ worker

Supabase
  ├─ PostgreSQL
  ├─ Storage
  └─ Queues / pgmq

Developer machine
  └─ CLI and local SQLite spool
```

The exact hosting vendor for long-running Node.js processes is intentionally not an architecture invariant.

## Scaling Seams

The following changes are allowed later without changing the core domain contracts:

- Run more ingestion instances behind a load balancer.
- Run more workers with queue-controlled concurrency.
- Partition high-volume evidence tables.
- Move analytical event queries to ClickHouse while PostgreSQL remains the source of truth for application state.
- Replace Supabase Storage with another S3-compatible service.
- Replace `pgmq` with a dedicated broker when throughput or independent consumers justify it.
- Split a module into a service only after load, security, or ownership requires independent deployment.

## Architecture Decision Process

Create an ADR when a decision:

- Changes a process or trust boundary.
- Introduces a new durable data store or infrastructure dependency.
- Changes the canonical evidence contract.
- Creates provider lock-in in a domain package.
- Changes consistency, idempotency, retention, or security guarantees.
- Is expensive to reverse.

Do not create ADRs for local implementation details that are easy to change and do not affect a public contract.
