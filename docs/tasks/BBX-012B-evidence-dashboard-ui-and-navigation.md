# BBX-012B: Evidence Dashboard UI and Navigation

- **Status:** Draft
- **Owner:** Implementation Chat
- **Review:** Review Chat
- **Depends on:** BBX-012A completed at a committed baseline
- **Delivery risk:** High
- **Execution profile:** High
- **Risk triggers:** private evidence rendering, authentication-regression risk,
  user-visible verdict semantics, untrusted content/XSS, snapshot pagination,
  evidence-link integrity, accessibility, and critical browser workflow
- **Architecture:** Accepted ADR-0013; accepted ADR-0001 through ADR-0012
  remain unchanged

## Goal

Build the first useful private evidence dashboard over the accepted BBX-012A
read boundary: a run list and one evidence-rich run-detail screen with direct,
safe navigation from findings and summary claims to their support.

## Context

BBX-012A must first provide authenticated server composition, the presentation
state contract, tenant-wide run and timeline queries, and exact evidence
resolution. Refine this draft against the completed 012A public types before
approval; do not duplicate query or security semantics inside components.

## In Scope

- Authenticated run-list and repository/run-detail routes.
- Overview, structured summary, findings, changed files, timeline, commands,
  tests, errors, usage, and evidence-detail views.
- Direct navigation from every finding reference and summary support.
- Bounded server-driven pagination with visible stale/replaced-cursor behavior.
- Responsive, keyboard-accessible, high-contrast presentation and explicit
  loading/empty/processing/incomplete/failed/unavailable/truncated states.
- Focused component/route tests and critical Playwright user journeys.

## Out of Scope

- Changes to ADR-0013 access semantics or BBX-012A query contracts except a
  separately approved defect correction.
- Database schema/migrations, new projections, workers, queues, ingestion,
  collector behavior, replay or mutation controls.
- Signed or unrestricted artifact downloads, binary/active-content rendering,
  live terminal streaming, Markdown/HTML evidence rendering, export,
  GitHub/PR/CI behavior, policy, LLM calls, accounts, RBAC, SSO, notifications,
  or BBX-013 behavior.
- Invented repository names, task completion claims, numeric quality scores, or
  statements that passing tests prove correctness.

## Architecture Constraints

- Implement only after BBX-012A is Done and ADR-0013 is Accepted.
- Fetch evidence in server components or protected same-origin handlers through
  BBX-012A functions. Client components receive only bounded view models.
- Never import Prisma, database configuration, credentials, or storage
  capabilities into client code.
- Preserve the ADR-0013 presentation mapping and separately render exact child,
  processing, findings, and summary states.
- Render evidence as escaped text/structured values. Do not use
  `dangerouslySetInnerHTML`, evidence-derived URLs, executable content, or
  unbounded DOM output.
- Preserve snapshot-bound cursors and fail visibly on stale replacement instead
  of silently restarting or mixing pages.

## Required Changes

### Routes and layout

- Replace the placeholder home page with an authenticated redirect or run-list
  entry point.
- Add a tenant-wide run list with repository UUID, presentation state, creation
  time, duration, files changed, observed tests, findings, tokens, and explicit
  unavailable values.
- Add canonical repository/run routes using validated UUID segments and generic
  not-found behavior.
- Provide stable page metadata, skip navigation, semantic landmarks, focus
  management, and a compact responsive layout.

### Run detail

- Render the presentation badge with its bounded explanation plus independent
  observed outcome and projector/freshness diagnostics.
- Render structured summary claims by section/class with truncation and support
  counts; do not rewrite claim text or semantics.
- Render deterministic findings with severity, outcome, coverage, reason codes,
  truncation, and ordered evidence references.
- Render changed-file entries, Git snapshot/diff metadata, commands, explicit
  test observations, tools, errors, usage, and the canonical event timeline.
- Represent missing evidence as unavailable/unknown, never as zero, success, or
  an empty completed section.

### Evidence navigation

- Make each supported finding reference and summary support navigable to a
  stable same-run evidence target.
- Resolve event, finding, artifact pointer, and file entry through BBX-012A; show
  canonical IDs, sequence, timestamps, type, safe structured data, and exact
  locator context.
- Render only BBX-012A's bounded verified text/JSON artifact preview as escaped
  text. Show explicit binary, oversized, unsupported, unavailable, and integrity
  failure states without receiving storage keys or partial bytes.
- Preserve back navigation and visible focus on the referenced item. A missing,
  stale, or incompatible target renders a safe explicit state.

### Pagination and states

- Use bounded URL-safe cursor parameters without exposing tenant identity or
  internal database IDs.
- Support complete traversal for runs, timeline, files, findings, summary
  claims/supports, and projected child collections.
- Surface processing, stale, failed, incomplete, empty, truncated, unauthorized,
  not-found, and invalid-cursor states without leaking hidden resources.

### Testing and documentation

- Add reusable deterministic UI fixtures shaped exactly like BBX-012A outputs.
- Add critical browser coverage for authentication, list-to-detail navigation,
  state labels, finding/claim support navigation, pagination, stale cursors,
  keyboard operation, and secret/XSS sentinels.
- Document local startup, required private configuration, supported routes,
  state meanings, and excluded artifact/export behavior.

## Acceptance Criteria

- An authenticated developer can traverse the run list, open a run, understand
  its independent outcomes/states, inspect all required v0.1 sections, and
  navigate every available finding/claim support to the exact evidence view.
- `PASS`, `REVIEW`, `FAILED`, `INCOMPLETE`, and `PROCESSING` render only from the
  accepted mapper and include wording that does not overstate evidence.
- Unknown, null, incomplete, stale, failed, and truncated values are visibly
  distinct and never converted to success or zero.
- Pagination returns every item once in deterministic order; stale cursors fail
  visibly and never mix snapshots.
- Wrong-tenant and missing routes are indistinguishable, and no credential,
  organization ID authority, database value, storage key, or internal ID enters
  client output.
- Evidence cannot inject markup, script, style, link destinations, or executable
  content.
- Artifact preview content remains bounded, escaped, non-executable, and absent
  for binary, oversized, unsupported, or unverifiable artifacts.
- Layout and navigation work at narrow and desktop widths with keyboard-only
  operation, visible focus, semantic headings, and accessible names.
- No persistence, projection, queue, worker, ingestion, collector, export,
  GitHub, policy, LLM, or artifact-byte behavior changes.

## Required Tests

- Unit tests for view-model formatting, unavailable values, state wording,
  bounds, and route/cursor construction.
- Route/server tests for auth enforcement, validated identifiers, generic
  not-found behavior, safe errors, and absence of server secrets in serialized
  output.
- Component tests for every presentation state, projector diagnostics, summary
  class, finding outcome/severity, truncation, empty sections, and hostile text.
- Pagination tests for every displayed collection, including terminal, malformed,
  stale, replacement, and back-navigation behavior.
- Playwright tests over an isolated seeded PostgreSQL database for login
  challenge, run-list/detail journey, support-to-evidence navigation, keyboard
  operation, responsive layout, and wrong-tenant/nonexistent routes.
- Existing database query, Web health, and production-build regressions.

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
pnpm --filter @blackbox/web test:e2e
git diff --check
git status --short --untracked-files=all
```

Run browser tests against explicitly authorized isolated local infrastructure
with production-like authentication and no external service. Do not install
dependencies, download browser binaries, start Docker, use a database, or access
a network without the applicable authorization.

## Deliverables

- Authenticated evidence-dashboard run list and run-detail routes.
- Accessible reusable components for states, summaries, findings, evidence,
  files, timeline, commands, tests, errors, and usage.
- Stable evidence navigation and bounded pagination.
- Unit, route, component, browser, security, and regression coverage.
- Updated Web and operations documentation, including verified-preview limits.

## Referenced Decisions and Documents

- `docs/product/v0.1-scope.md`
- `docs/architecture/overview.md`
- `docs/architecture/v0.1-delivery-sequence.md`
- `docs/architecture/decisions/ADR-0012-versioned-evidence-backed-summaries.md`
- `docs/architecture/decisions/ADR-0013-dashboard-read-boundary-and-presentation-semantics.md`
- `docs/tasks/BBX-012A-dashboard-read-boundary-and-presentation-contract.md`
- `docs/review-guidelines.md`

## Risks

- UI wording can overstate deterministic evidence; fixed mapper output and
  explicit bounded explanations mitigate it.
- Rendering private or hostile evidence can leak or execute content; server-only
  DTOs, escaped text, output bounds, and XSS sentinels are mandatory.
- Independent collection pagination can mix snapshots; accepted snapshot-bound
  cursors and explicit stale handling prevent silent mixing.
- The first critical browser journey adds test/runtime complexity; focused
  Playwright coverage is justified and must remain isolated and deterministic.

## Open Questions

- Confirm the exact BBX-012A exported view-model and error names before moving
  this draft to `Proposed`.
- Confirm the checked-in Playwright/browser runtime strategy before approval.
