# AI Agent Black Box

## Project Purpose

AI Agent Black Box is an evidence and quality layer for AI-generated code. It records what a coding agent did, connects the run to the resulting Git change, verifies the available test evidence, detects deterministic risks, and produces an evidence-backed summary.

The current product phase is v0.1, Evidence Recorder. Codex is the only supported agent in this phase. Do not implement later-roadmap capabilities unless an approved task explicitly requires them.

## Source of Truth

- Product scope: `docs/product/v0.1-scope.md`
- System architecture: `docs/architecture/overview.md`
- Accepted architecture decisions: `docs/architecture/decisions/`
- Task specifications: `docs/tasks/`
- Review criteria: `docs/review-guidelines.md`

Before implementing a task, read this file, the task specification, and only the architecture documents referenced by that task. A task is ready for implementation only when its `Status` is `Approved`.

If documents conflict, use this precedence order:

1. The current approved task specification for task-specific behavior.
2. Accepted ADRs for architecture decisions.
3. The architecture overview.
4. The product scope.

Do not silently resolve a conflict that changes product scope or an accepted architecture decision. Report it and request an architecture decision.

## Technology Baseline

- TypeScript across application code.
- `pnpm` workspaces with Turborepo.
- Next.js App Router for the dashboard and control plane.
- Node.js with Fastify for machine-facing ingestion.
- A separate Node.js process for asynchronous workers.
- A Node.js TypeScript CLI for the local collector.
- PostgreSQL through Supabase.
- Prisma for relational application data and migrations.
- Supabase Storage for large artifacts.
- Supabase Queues / `pgmq` for background jobs.
- Zod for runtime validation and shared contracts.
- Vitest for unit and integration tests.
- Playwright for critical end-to-end UI flows when those flows exist.

Use the versions committed in the lockfile. Do not upgrade dependencies or add production dependencies outside the scope of an approved task.

## Architecture Boundaries

- Treat the repository as a modular monolith with separate `web`, `ingest`, `worker`, and `cli` process entrypoints.
- Keep reusable domain logic in packages that do not depend on framework request objects.
- Next.js owns the human-facing dashboard and control-plane operations. It must not execute long-running analysis jobs.
- The ingestion service authenticates, validates, deduplicates, persists, and enqueues work. It must return without waiting for analysis or LLM calls.
- Workers own deterministic analysis, correlation, policy evaluation, and summaries.
- The local collector owns Git snapshots, local redaction, buffering, batching, and retry behavior.
- Raw evidence events are append-only. Corrections create new records or projections; they do not rewrite evidence.
- Store large diffs, logs, reports, and other artifacts in object storage. Store metadata and content hashes in PostgreSQL.
- External payloads must be runtime-validated at the boundary.
- Event ingestion and background jobs must be idempotent and safe to retry.
- Deterministic findings and LLM-generated claims must remain distinguishable.
- A finding cannot be marked verified without references to concrete evidence.
- Do not store hidden chain-of-thought. Store observable actions, outcomes, permitted summaries, and reasoning summaries only when explicitly available and allowed.
- Supabase is infrastructure, not the domain layer. Keep domain packages portable to standard PostgreSQL and S3-compatible storage.

## Code Standards

- Prefer small, cohesive modules with explicit public APIs.
- Use strict TypeScript. Do not introduce `any` without a documented boundary reason.
- Prefer named domain types over unstructured objects passed across package boundaries.
- Validate untrusted input once at the boundary and pass typed values internally.
- Keep side effects at process and infrastructure boundaries; keep analyzers deterministic where practical.
- Use structured errors with stable machine-readable codes at service boundaries.
- Do not swallow errors. Add context and preserve the original cause.
- Avoid speculative abstractions. Extract shared code only when there is a real shared contract.
- Do not mix unrelated refactoring with task work.
- Comments should explain constraints or intent, not restate the code.

## Database and Evidence Rules

- Every tenant-owned record must be designed to support an `organization_id`, even while v0.1 operates as a single workspace.
- Use migrations for schema changes. Never rely on manual production database changes.
- Use database constraints for invariants that must survive application bugs.
- Store UTC timestamps and preserve both event occurrence time and server receipt time when relevant.
- Use stable event identifiers and uniqueness constraints for ingestion deduplication.
- Never use mutable display names as identifiers.
- Never log credentials, raw authorization headers, or unredacted secrets.
- Preserve artifact hashes so integrity can be checked independently of storage location.

## Testing and Verification

- Add or update tests for every behavior change.
- Prefer unit tests for deterministic analyzers and contract validation.
- Use integration tests for database boundaries, queue behavior, ingestion idempotency, and HTTP contracts.
- Use end-to-end tests only for critical user journeys.
- A passing command is evidence only for the exact revision and state on which it ran.
- Do not claim a check passed unless it was executed successfully in the current environment.
- Once the bootstrap task exists, the standard repository checks are `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`.

## Change Discipline

- Inspect the repository and relevant instructions before editing.
- Preserve user changes and unrelated work already present in the worktree.
- Keep changes within the approved task scope.
- Do not change an accepted ADR as an implementation shortcut.
- If implementation reveals a missing architecture decision, document the decision request instead of silently choosing a new direction.
- Update documentation in the same change when a public contract, architecture boundary, or development command changes.
- Do not commit generated output, credentials, local databases, coverage output, or build artifacts.

## Definition of Done

A task is complete only when:

- All acceptance criteria are satisfied.
- Relevant tests were added or updated and pass.
- Lint, type checking, tests, and build pass when those commands exist.
- External inputs have runtime validation.
- Database changes include migrations and constraints where applicable.
- Failure paths and retry behavior were considered.
- Documentation reflects changed contracts or architecture.
- The final diff contains no unrelated changes.
- The implementation report lists changed files, commands executed, deviations, and residual risks.

## Code Review Rules

Prioritize findings in this order:

1. Incorrect behavior, regressions, or data loss.
2. Corruption, mutation, misattribution, or unverifiable evidence.
3. Authentication, authorization, tenant isolation, and secret exposure.
4. Missing idempotency, unsafe retries, race conditions, and partial failures.
5. Contract incompatibility and migration risk.
6. Missing tests for changed behavior.
7. Material maintainability problems that make future correctness harder.

Every finding must identify a concrete failure scenario and point to the relevant code or missing evidence. Do not report formatting issues already enforced by automated tooling. Reviewers do not modify code unless the user explicitly asks for fixes.
