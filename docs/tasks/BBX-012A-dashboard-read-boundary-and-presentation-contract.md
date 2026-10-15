# BBX-012A: Dashboard Read Boundary and Presentation Contract

- **Status:** Approved
- **Owner:** Implementation Chat
- **Review:** Review Chat
- **Depends on:** BBX-011 completed at
  `b0ee19c71950dbc405175fa5cd9b9860d0d7de5b`
- **Delivery risk:** High
- **Execution profile:** High
- **Risk triggers:** browser/server trust boundary, private evidence exposure,
  authentication, tenant isolation, cursor integrity, repeatable-read queries,
  user-visible verdict semantics, and cross-package Web/database behavior
- **Architecture:** Accepted ADR-0013; accepted ADR-0001 through ADR-0012
  remain unchanged

## Goal

Establish the fail-closed read and access boundary that BBX-012B can use to
render a private v0.1 evidence dashboard without inventing evidence, leaking
tenant data, or conflating process, processing, and deterministic outcomes.

## Context

BBX-009 through BBX-011 expose current tenant-safe run, file, finding, and
summary queries. The Web application is still a placeholder and lacks trusted
organization composition, dashboard authentication, presentation-state
semantics, a tenant-wide run list, a chronological timeline, and exact evidence
resolution. ADR-0013 defines the required boundary.

## In Scope

- Server-only Web database composition and strict dashboard configuration.
- Separate single-workspace dashboard authentication from ADR-0013.
- A pure exhaustive `PASS | REVIEW | FAILED | INCOMPLETE | PROCESSING` mapper.
- Tenant-wide run-list, canonical timeline, and evidence-resolution queries.
- Bounded integrity-checked previews for supported verified text/JSON evidence
  artifacts.
- Bounded runtime validation, stable cursors, repeatable-read consistency, and
  safe error/not-found behavior.
- Minimal authenticated route composition needed to prove the boundary; no
  polished dashboard UI.
- Configuration and operations documentation plus high-risk tests.

## Out of Scope

- Run-list/detail visual design, dashboard navigation components, charts, or
  browser UX beyond the minimal boundary fixture.
- Evidence mutation, replay buttons, queue work, worker changes, or control-plane
  writes.
- New projection tables, schema migrations, repository display-name metadata,
  signed downloads, browser-direct storage, binary/active-content rendering, or
  public storage capabilities.
- Export, GitHub/PR/CI behavior, configurable policy, LLM calls, notifications,
  accounts, teams, RBAC, SSO, or BBX-013 behavior.

## Architecture Constraints

- Follow ADR-0013 without weakening its access or presentation semantics.
- Keep Prisma, `DATABASE_URL`, organization identity, access credentials, and
  storage configuration in server-only modules.
- Derive `organizationId` only from validated server configuration. Browser
  input must never select a tenant.
- Use a dashboard credential distinct from ingestion and compare its configured
  SHA-256 digest in constant time. Fail closed on missing or invalid config.
- Preserve current BBX-009–011 query semantics; do not reinterpret raw evidence
  or persist presentation state.
- Wrong-tenant and missing resources must remain indistinguishable.
- Return bounded view models with canonical IDs, never internal database IDs,
  storage keys, credentials, or provider-native payloads.
- Reuse `@blackbox/artifact-storage` for any preview. Require a verified exact
  artifact identity and enforce byte, hash, media, UTF-8, deadline, inactivity,
  and cancellation bounds before returning escaped content.
- Treat all evidence text as untrusted data. This task must not add HTML,
  Markdown, URL, or artifact-content interpretation.

## Required Changes

### Server composition and access

- Add required `DASHBOARD_ORGANIZATION_ID` and
  `DASHBOARD_ACCESS_TOKEN_SHA256` configuration with strict UUID/digest parsing.
- Add server-only database lifecycle composition using explicit `DATABASE_URL`
  and deterministic disposal in tests.
- Protect every dashboard page and route with the ADR-0013 HTTP Basic boundary.
  Use a generic unauthorized response/challenge and allow plaintext HTTP only on
  explicit loopback development.
- Ensure credentials and configuration values cannot enter page props, client
  modules, URLs, logs, thrown messages, or snapshots.

### Presentation contract

- Implement a pure named presentation mapper using ADR-0013 precedence.
- Keep observed child outcome, each projector state/error, findings outcome,
  summary processing state, and summary availability visible as independent
  typed fields.
- Document the bounded meaning of `PASS` and the distinction between `FAILED`
  and processing failure.

### Query boundary

- Add a bounded tenant-wide run list, optionally filtered by repository ID,
  returning repository ID and the existing run-list evidence/processing fields.
  Use stable newest-first pagination and bind the cursor to its query scope.
- Add a bounded canonical timeline ordered by event sequence and canonical event
  ID. Return validated locally redacted canonical event data and immutable
  metadata without storage internals.
- Add an evidence resolver scoped by organization, repository, canonical run,
  and canonical evidence identity. Resolve exact event, declared artifact
  pointer, file entry, and current finding references without crossing runs or
  snapshots.
- Resolve supported artifact evidence through the winning verified upload and
  return only a small allowlisted text/JSON preview after exact integrity checks.
  Unsupported or failed reads return safe metadata and a stable unavailable
  reason; they never fall back to unverified content.
- Reuse existing file/finding/summary queries rather than duplicating their
  freshness logic.
- Reject malformed, oversized, wrong-scope, stale, and cross-tenant cursors or
  locators with safe stable errors. Do not continue into a different snapshot.

### Documentation

- Update `.env.example`, Web documentation, and operations guidance for the
  read-only dashboard boundary, HTTPS requirement, separate credential, tenant
  and storage configuration, preview bounds, safe errors, and repository-UUID
  fallback label.
- Record that unrestricted downloads, replay, and export remain unavailable.

## Acceptance Criteria

- Missing or invalid dashboard configuration fails before serving evidence.
- Unauthenticated and invalid-credential requests disclose no tenant, run,
  repository, count, or configuration information.
- A valid credential can read only the configured organization; route/query
  values cannot override it.
- The presentation mapper implements every ADR-0013 precedence combination and
  never reports `PASS` for failed/cancelled child outcome, stale/incomplete
  processing, unavailable summary, or `unknown` summary outcome.
- Tenant-wide run pagination is stable, bounded, repository-aware, and rejects a
  cursor reused under a different filter or tenant.
- Timeline pagination is complete and deterministic across equal timestamps,
  late lower-sequence evidence, and concurrent inserts under one repeatable-read
  snapshot.
- Evidence resolution proves same-tenant, same-repository, same-run ownership
  and exact event/artifact/pointer/file/finding linkage.
- A supported verified artifact preview is returned only after exact length/hash
  verification and all content/deadline bounds; every other storage outcome is
  explicit and exposes no partial bytes.
- Returned data contains no internal database ID, storage key, credential,
  connection string, or public artifact capability.
- Existing BBX-009–011 query behavior, raw evidence, projections, schema, queue,
  worker, and collector remain unchanged.

## Required Tests

- Pure table-driven tests for every presentation-state branch and precedence
  collision.
- Configuration and authentication tests for absent/malformed config, valid and
  invalid credentials, constant-time comparison boundary, generic failures,
  loopback HTTP, non-loopback HTTPS, and secret-sentinel non-disclosure.
- Web server/client-boundary tests proving database and credential modules cannot
  be imported or serialized into client components.
- Real PostgreSQL tests for tenant-wide/repository-filtered pagination, stable
  cursors, wrong-filter reuse, tenant isolation, late evidence, repeatable-read
  behavior, exact timeline order, and evidence locator ownership.
- Negative evidence-resolution tests for missing, dangling, mismatched,
  cross-run, cross-repository, cross-tenant, stale finding, and partial artifact
  pointers.
- Storage-reader tests for verified text/JSON success, binary/NUL, invalid UTF-8,
  media rejection, oversize, underflow/overflow, hash mismatch, redirect,
  timeout, inactivity, cancellation, provider failure, and stream cleanup.
- Regression tests for existing run/detail/file/finding/summary query functions.

## Validation

Run focused checks while editing, then once on the final state:

```text
pnpm install --frozen-lockfile
pnpm --filter @blackbox/database run db:generate
pnpm --filter @blackbox/database run db:validate
pnpm format:check
pnpm lint --force
pnpm typecheck --force
pnpm test --force
pnpm build --force
git diff --check
git status --short --untracked-files=all
```

Using an explicitly authorized isolated PostgreSQL 16 database, deploy every
migration from empty state and run the complete database integration suite.
PGMQ/Docker queue tests are required only if the implementation changes their
surface unexpectedly. Do not install dependencies, start Docker, use a database,
or access a network without the applicable authorization.

## Deliverables

- Accepted ADR-0013 implementation.
- Server-only dashboard configuration, authentication, database composition,
  and bounded verified artifact preview composition.
- Pure presentation-state contract.
- Tenant-wide run, timeline, and evidence-resolution queries.
- Focused security, tenant, cursor, consistency, and regression tests.
- Updated configuration and operations documentation.

## Referenced Decisions and Documents

- `docs/product/v0.1-scope.md`
- `docs/architecture/overview.md`
- `docs/architecture/v0.1-delivery-sequence.md`
- `docs/architecture/decisions/ADR-0010-replayable-projections-and-processing-state.md`
- `docs/architecture/decisions/ADR-0011-versioned-deterministic-findings.md`
- `docs/architecture/decisions/ADR-0012-versioned-evidence-backed-summaries.md`
- `docs/architecture/decisions/ADR-0013-dashboard-read-boundary-and-presentation-semantics.md`
- `docs/review-guidelines.md`

## Risks

- A Web import or serialization mistake can disclose database or tenant secrets;
  server-only modules and sentinel tests mitigate it.
- A presentation precedence mistake can show false `PASS`; an exhaustive pure
  truth table and independent XHigh review are required.
- Evidence navigation can become a cross-tenant oracle; every locator includes
  trusted tenant and run ownership, with indistinguishable misses.
- Storage previews place a service credential in the Web server boundary;
  server-only composition, existing integrity readers, strict content limits,
  cancellation, and sentinel tests mitigate disclosure and resource exhaustion.
- Basic authentication depends on HTTPS outside loopback; startup/request guards
  and operations documentation make that boundary explicit.

## Open Questions

None after ADR-0013 is accepted.
