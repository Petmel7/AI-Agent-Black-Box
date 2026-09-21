# ADR-0001: TypeScript Modular Monolith with Separate Runtime Processes

- **Status:** Accepted
- **Date:** 2026-09-21
- **Decision owners:** Project architecture

## Context

AI Agent Black Box must support four materially different workloads:

1. A human-facing dashboard and control plane.
2. Bursty, machine-facing telemetry ingestion.
3. Retryable asynchronous analysis and LLM work.
4. A local collector operating beside a developer's Git repository.

A single Next.js deployment would be fast to scaffold, but it would couple telemetry throughput and background processing to a framework and request lifecycle optimized for the web application. Starting with independent microservices would create deployment, contract, and observability overhead before the product schema and workloads are proven.

The team is initially small, the v0.1 scope supports one agent and one workspace, and shared TypeScript contracts are valuable while the domain model is evolving.

## Decision

Use a TypeScript monorepo organized as a modular monolith with four process entrypoints:

- `apps/web`: Next.js App Router dashboard and control plane.
- `apps/ingest`: Node.js Fastify ingestion API.
- `apps/worker`: Node.js background worker.
- `apps/cli`: Node.js TypeScript local collector CLI.

Use shared packages for contracts, database access, and configuration. Use one PostgreSQL database and one object-storage service. The ingestion and worker processes may be deployed separately from the web process, but they remain part of one codebase and one product release.

The initial infrastructure choices are:

- Supabase PostgreSQL.
- Prisma for relational access and migrations.
- Supabase Storage for large artifacts.
- Supabase Queues / `pgmq` for durable background jobs.

Keep core domain contracts independent of Supabase-specific client APIs.

## Architectural Constraints

- Machine ingestion is not implemented through Next.js Route Handlers.
- Long-running analysis does not execute in the web or ingestion request lifecycle.
- Shared packages do not import application entrypoints.
- Framework request and response objects do not cross into domain packages.
- Cross-process communication uses versioned contracts or durable storage, not imports that assume a shared process.
- Separate deployment must not require separate repositories.
- The architecture may evolve toward services only when an observed scaling, isolation, or ownership need justifies it.

## Consequences

### Positive

- The project keeps one language, repository, dependency graph, and CI pipeline.
- Web, ingestion, worker, and CLI code can evolve with shared contracts.
- Telemetry and analysis are not limited by the Next.js runtime lifecycle.
- Processes can scale independently without adopting microservice governance.
- Early refactoring remains practical while the canonical evidence model is being proven.
- Supabase accelerates v0.1 without becoming the domain abstraction.

### Negative

- There are multiple process entrypoints to run locally and deploy.
- Database access by more than one process requires clear ownership and migration discipline.
- Shared packages can become a coupling mechanism if their public APIs are not controlled.
- A monorepo build pipeline and shared configuration are required from the first implementation task.

### Risks and mitigations

- **Risk:** Business logic spreads across applications.

  **Mitigation:** Keep domain logic in cohesive packages and application code focused on transport and composition.

- **Risk:** The worker and ingestion service use incompatible payload assumptions.

  **Mitigation:** Use versioned Zod contracts and compatibility tests.

- **Risk:** The project prematurely imitates microservices inside one repository.

  **Mitigation:** Do not add network boundaries between internal modules without a separate ADR.

- **Risk:** Supabase features leak into the core domain.

  **Mitigation:** Access storage, queues, and database through narrow infrastructure adapters.

## Alternatives Considered

### Next.js-only application

Rejected as the target architecture because telemetry ingestion and long-running workers have different scaling, reliability, and lifecycle requirements from the dashboard. Next.js remains appropriate for the dashboard and control plane.

### React SPA plus a single Node.js backend

Rejected because a standalone SPA adds a deployment and client-side data-fetching layer without a clear v0.1 benefit. Next.js provides React, routing, server rendering, and server-side control-plane behavior.

### Independent microservices

Rejected for v0.1 because the operational and contract-management cost is not justified by current scale or team structure.

### Supabase-only backend logic

Rejected because extensive database functions, triggers, or provider-specific edge functions would make domain behavior harder to test and migrate.

## Revisit When

- A process requires independent release cadence or ownership.
- Ingestion or analysis load cannot be handled by independent instances of the current processes.
- Security requirements demand stronger network or data isolation.
- A new event store or broker becomes necessary.
- Multiple products require independently versioned public services.
