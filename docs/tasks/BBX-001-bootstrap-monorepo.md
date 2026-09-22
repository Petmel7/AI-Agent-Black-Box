# BBX-001: Bootstrap the TypeScript Monorepo

- **Status:** Done
- **Owner:** Implementation Chat
- **Review:** Review Chat
- **Architecture:** [ADR-0001](../architecture/decisions/ADR-0001-modular-monolith.md)

## Goal

Create the minimal, production-oriented TypeScript monorepo foundation for AI Agent Black Box so subsequent v0.1 tasks can add evidence contracts and product behavior without restructuring the repository.

## Context

The repository currently contains architecture documentation and no application code. ADR-0001 selects a modular monolith with separate process entrypoints for the web dashboard, ingestion API, background worker, and local collector CLI.

This task establishes build, test, lint, and package boundaries. It does not implement evidence recording.

## In Scope

- Configure a `pnpm` workspace and Turborepo.
- Establish strict shared TypeScript configuration.
- Establish shared lint and formatting configuration.
- Create four application workspaces:
  - `apps/web`
  - `apps/ingest`
  - `apps/worker`
  - `apps/cli`
- Create three initial shared packages:
  - `packages/contracts`
  - `packages/database`
  - `packages/config`
- Add root scripts for lint, type checking, tests, build, formatting check, and development.
- Add a CI workflow that installs with the frozen lockfile and runs the standard validation commands.
- Add repository-level environment documentation and safe example environment files.
- Add basic health or startup behavior sufficient to prove every application builds and the shared contract package can be consumed.
- Add minimal automated tests for the created executable boundaries.
- Update architecture documentation only if the implemented structure differs for a justified reason.

## Out of Scope

- Canonical evidence event schemas.
- Codex telemetry integration.
- Git snapshot implementation.
- SQLite spool implementation.
- Supabase project provisioning.
- Production database models or migrations beyond what is strictly necessary to validate the database package scaffold.
- Queue or object-storage integration.
- Authentication.
- Dashboard product screens or a component design system.
- Deterministic analyzer rules.
- LLM integration.
- Docker production images.
- Deployment configuration.
- GitHub App functionality.

## Required Repository Shape

```text
apps/
  web/
  ingest/
  worker/
  cli/
packages/
  contracts/
  database/
  config/
docs/
```

Do not create empty future packages such as `analyzers`, `git`, or `redaction` in this task.

## Application Requirements

### `apps/web`

- Use Next.js App Router with TypeScript.
- Provide a minimal page identifying the project and indicating that v0.1 is under construction.
- Provide a lightweight health endpoint suitable for deployment checks.
- Do not add authentication, dashboard navigation, charts, or a UI component library in this task.

### `apps/ingest`

- Use Node.js, Fastify, TypeScript, and Zod.
- Export an application factory so integration tests can use Fastify injection without binding a network port.
- Provide `GET /health` returning a runtime-validated shared response contract.
- Keep server startup separate from application construction.
- Do not add evidence ingestion endpoints in this task.

### `apps/worker`

- Provide a minimal typed worker entrypoint and a testable startup boundary.
- It must start and stop cleanly without a queue connection.
- Do not implement polling, scheduled work, or fake analysis jobs.

### `apps/cli`

- Produce an executable `blackbox` binary.
- Support `blackbox --help` and `blackbox --version` with successful exit status.
- Keep command parsing separate from process startup so it is testable without spawning where practical.
- Do not execute Codex or inspect Git in this task.

## Shared Package Requirements

### `packages/contracts`

- Export a Zod schema and inferred type for the shared health response used by both `web` and `ingest`.
- Establish package exports that work in development, tests, and production builds.
- Do not define speculative evidence schemas.

### `packages/database`

- Establish the Prisma package boundary and documented environment variable names.
- Ensure generation and builds do not require live production credentials.
- Do not add domain models before their owning task defines them.
- Keep direct and pooled connection concerns documented for later deployment configuration.

### `packages/config`

- Own reusable TypeScript and lint configuration.
- Avoid circular dependencies or runtime code.

## Tooling Requirements

- Use a current stable Node.js LTS version supported by all selected dependencies and declare it in repository metadata.
- Use `pnpm` and commit the lockfile.
- Enable strict TypeScript settings.
- Use one root command for each standard validation operation:
  - `pnpm lint`
  - `pnpm typecheck`
  - `pnpm test`
  - `pnpm build`
  - `pnpm format:check`
- Ensure a fresh checkout can discover setup requirements from the root README.
- Ignore secrets, local databases, build output, coverage output, editor state, and framework caches.

## Architecture Constraints

- Follow [ADR-0001](../architecture/decisions/ADR-0001-modular-monolith.md).
- Do not route machine ingestion through Next.js.
- Do not introduce network calls between the local application workspaces.
- Applications may compose shared packages; shared packages must not import applications.
- Avoid placeholder abstractions that have no behavior or consumer.
- Do not introduce Supabase-specific runtime clients until a task requires them.
- Do not add production dependencies without using them in this task.

## Acceptance Criteria

- A clean checkout can install dependencies with the committed package manager metadata and lockfile.
- All required applications and shared packages exist at the specified paths.
- `apps/ingest` responds successfully to an injected `GET /health` request using the shared Zod contract.
- `apps/worker` has a test proving clean startup and shutdown behavior.
- `apps/cli` exposes working `--help` and `--version` behavior.
- `apps/web` builds successfully and exposes its health endpoint.
- At least two different applications successfully consume a shared workspace package, proving workspace resolution.
- Strict TypeScript compilation succeeds across all workspaces.
- Root lint, typecheck, test, build, and formatting-check commands succeed.
- CI runs the same validation commands with a frozen lockfile.
- No command requires real Supabase, database, queue, storage, or LLM credentials.
- The repository README explains prerequisites, installation, development commands, validation commands, and workspace layout.
- No out-of-scope product behavior is introduced.

## Required Tests

- Shared health contract accepts the expected payload and rejects an invalid payload.
- Fastify health route integration test using injection.
- Worker lifecycle unit test.
- CLI help and version tests.
- Web health handler test if practical within the selected Next.js test setup; otherwise the successful production build is the required verification and the limitation must be documented.

## Validation Commands

The implementation must run and report:

```text
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

If the package manager supports a lockfile-only or frozen-install verification appropriate to the environment, include it in CI.

## Deliverables

- Monorepo configuration.
- Four buildable application workspaces.
- Three initial shared packages.
- Lockfile and runtime/package-manager declarations.
- Root README and safe environment examples.
- Automated tests described above.
- CI validation workflow.
- Implementation completion report.

## Referenced Documents

- [`AGENTS.md`](../../AGENTS.md)
- [v0.1 scope](../product/v0.1-scope.md)
- [Architecture overview](../architecture/overview.md)
- [ADR-0001](../architecture/decisions/ADR-0001-modular-monolith.md)
- [Review guidelines](../review-guidelines.md)

## Risks

- Framework scaffolding can introduce unnecessary dependencies or default files. Remove unused scaffolding and explain retained defaults.
- Incompatible ESM/CJS assumptions can break cross-package builds. Choose one coherent module strategy and prove package consumption in tests and builds.
- Tooling can become more complex than the application foundation. Prefer minimal shared configuration with explicit behavior.
- Prisma generation can accidentally require credentials during CI. Keep bootstrap generation independent of a live database.

## Open Questions

None. Package versions and exact compatible configuration should be resolved during implementation using current stable releases, recorded in the lockfile, and verified by the required commands.

## Implementation Prompt

```text
Implement BBX-001 as specified in docs/tasks/BBX-001-bootstrap-monorepo.md.

Read the repository AGENTS.md and the documents referenced by the task before editing. Stay within the approved scope. Inspect the repository first, then create the minimal monorepo foundation described by the task.

Use current stable, mutually compatible dependency versions and commit the pnpm lockfile. Do not add product behavior or future packages. Run every required validation command.

If the specification conflicts with an accepted ADR or cannot be implemented without changing scope, stop and report the exact conflict instead of silently changing the architecture.

At completion, report acceptance-criteria status, changed files, validation commands and results, deviations, and residual risks.
```

## Review Prompt

```text
Review the implementation of BBX-001 against the base branch, AGENTS.md, docs/tasks/BBX-001-bootstrap-monorepo.md, and ADR-0001.

Do not modify files. Inspect the complete diff and the reported validation results. Prioritize broken workspace boundaries, incorrect build or package resolution, unsafe environment handling, missing validation, CI drift, unused dependencies, and acceptance criteria that are not actually satisfied.

Report only actionable findings with priority, precise file and line, concrete failure scenario, impact, and the smallest safe correction. Then list residual risks and validation gaps. If there are no actionable findings, say so explicitly.
```
