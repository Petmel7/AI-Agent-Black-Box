# BBX-012B: Evidence Dashboard UI and Navigation

- **Status:** Approved
- **Owner:** Implementation Chat
- **Review:** Review Chat
- **Depends on:** BBX-012A completed at committed baseline
  `f117faeb0208b88b8e5cb0e240a35d30c9761f9d`
- **Delivery risk:** High
- **Execution profile:** High
- **Risk triggers:** private evidence rendering, authentication-regression risk,
  server/client data boundaries, user-visible verdict semantics, untrusted
  content/XSS, signed snapshot pagination, evidence-link integrity,
  accessibility, browser-test infrastructure, and critical browser workflow
- **Architecture:** Accepted ADR-0013; accepted ADR-0001 through ADR-0012
  remain unchanged

## Goal

Build the first useful private evidence dashboard over the accepted BBX-012A
read boundary: a run list and one evidence-rich run-detail screen with direct,
safe navigation from findings and summary claims to their support.

## Context

BBX-012A provides authenticated server composition, the presentation-state
contract, signed tenant-wide run and timeline queries, and exact evidence
resolution. Its committed Web runtime exposes `listRuns`, `listTimeline`, and
`resolveEvidence`. The database package also exposes the existing run-detail,
file, finding, summary-claim, and summary-support read models.

BBX-012B may add server-only dashboard wrappers needed to compose those models
safely, but it must not change their domain meaning. Legacy projection cursors
must not be exposed directly in browser URLs. Browser-visible continuation
state is authenticated with the dedicated dashboard cursor authority and bound
to the exact tenant, repository, run, collection, snapshot, and position.

## In Scope

- Authenticated run-list and repository/run-detail routes.
- Overview, structured summary, findings, changed files, timeline, commands,
  tests, errors, usage, and evidence-detail views.
- Direct navigation from every finding reference and summary support.
- Bounded server-driven pagination with visible stale/replaced-cursor behavior.
- Responsive, keyboard-accessible, high-contrast presentation and explicit
  loading/empty/processing/incomplete/failed/unavailable/truncated states.
- Additive dashboard-detail read wrappers and nullable run-list metrics needed
  by these views.
- Focused component/route tests and critical Playwright user journeys.

## Out of Scope

- Reinterpretation or weakening of ADR-0013 or BBX-012A query, authentication,
  tenant, evidence, cursor, or presentation semantics.
- Database schema/migrations, new projections, workers, queues, ingestion,
  collector behavior, replay or mutation controls.
- Signed or unrestricted artifact downloads, binary/active-content rendering,
  live terminal streaming, Markdown/HTML evidence rendering, export,
  GitHub/PR/CI behavior, policy, LLM calls, accounts, RBAC, SSO, notifications,
  or BBX-013 behavior.
- Invented repository names, task completion claims, numeric quality scores, or
  statements that passing tests prove correctness.

Additive dashboard-specific read wrappers, authenticated child cursors, and
nullable run-list test/token aggregates are explicitly in scope. If they
require schema changes, a new trust boundary, or changed query meaning, stop
and return to architecture review.

## Architecture Constraints

- Implement only after BBX-012A is Done and ADR-0013 is Accepted.
- Fetch evidence in server components or protected same-origin handlers through
  BBX-012A functions. Client components receive only bounded view models.
- Never import Prisma, database configuration, credentials, or storage
  capabilities into client code.
- Inject the configured organization inside the server runtime; callers cannot
  provide or override it.
- Preserve the ADR-0013 presentation mapping and separately render exact child,
  processing, findings, and summary states.
- Render evidence as escaped text/structured values. Do not use
  `dangerouslySetInnerHTML`, evidence-derived URLs, executable content, or
  unbounded DOM output.
- Preserve snapshot-bound cursors and fail visibly on stale replacement instead
  of silently restarting or mixing pages.
- Never expose unsigned legacy projection cursors in browser URLs. Bind every
  browser cursor to organization, repository, run, collection, exact snapshot,
  and continuation position using the dedicated dashboard HMAC key.
- Prefer React Server Components and server-only modules. Client components
  receive only minimal serializable view models.
- Make every private route and handler dynamic and `no-store`; builds must not
  query the database or pre-render private evidence.
- No new ADR is required: this task implements Accepted ADR-0013 without
  changing its process, trust, or durable-data boundaries.

## Required Changes

### Routes and layout

- Use these canonical private routes:
  - `/` redirects authenticated users to `/runs`;
  - `/runs` lists runs;
  - `/repositories/[repositoryId]/runs/[runId]` shows run detail;
  - `/repositories/[repositoryId]/runs/[runId]/evidence` resolves one
    allowlisted evidence locator.
- Strictly validate UUID path segments and bounded allowlisted query values.
- Add a tenant-wide run list with repository UUID, presentation state, creation
  time, duration, files changed, command/tool counts, test-observation state,
  nullable test counts, findings, nullable token aggregates, and explicit
  unavailable values.
- Use generic not-found/error behavior that does not reveal cross-tenant or
  missing-resource distinctions.
- Provide stable page metadata, skip navigation, semantic landmarks, focus
  management, and a compact responsive layout.

### Server read facade and pagination

- Extend the server-only dashboard runtime with explicit allowlisted methods
  for run detail, files, findings, summary claims, and summary supports in
  addition to runs, timeline, and evidence.
- Reuse the existing database read models and their field meanings.
- Add dashboard-specific database wrappers only where needed to prove a stable
  snapshot or authenticated continuation for a browser-visible collection.
- Sign browser cursors with the BBX-012A dashboard cursor key. Rotation,
  malformed input, wrong scope, and replaced snapshots fail visibly; the UI
  must not silently restart and mix snapshots.
- Provide bounded server-driven pagination for runs, timeline, files, findings,
  summary claims, summary supports, and projected child collections. Browser
  history provides backward traversal.

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
- Show the overall presentation state separately from child, processing,
  projector, findings, and summary states.
- Page all bounded child collections instead of treating the first page as
  complete.

### Evidence navigation

- Make each supported finding reference and summary support navigable to a
  stable same-run evidence target.
- Resolve event, finding, artifact pointer, and file entry through BBX-012A; show
  canonical IDs, sequence, timestamps, type, safe structured data, and exact
  locator context.
- Render only BBX-012A's bounded verified text/JSON artifact preview as escaped
  text. Show explicit binary, oversized, unsupported, unavailable, and integrity
  failure states without receiving storage keys or partial bytes.
- Do not use `dangerouslySetInnerHTML` or activate evidence-derived HTML,
  Markdown, links, or scripts.
- Preserve back navigation and visible focus on the referenced item. A missing,
  stale, or incompatible target renders a safe explicit state.

### Pagination and states

- Use bounded URL-safe cursor parameters without exposing tenant identity or
  internal database IDs.
- Allowlist query names and values exactly; reject duplicates, malformed
  encodings, oversized values, and unknown authority-bearing fields.
- Support complete traversal for runs, timeline, files, findings, summary
  claims/supports, and projected child collections.
- Surface processing, stale, failed, incomplete, empty, truncated, unauthorized,
  not-found, and invalid-cursor states without leaking hidden resources.

### Testing and documentation

- Add reusable deterministic UI fixtures shaped exactly like BBX-012A outputs.
- Add exact pinned `@playwright/test` as a Web development dependency, its
  lockfile update, Chromium-only configuration, and a `test:e2e` script. Do not
  commit browser binaries.
- Run browser tests against a production Web build/start through the standard
  listener launcher, a fresh isolated PostgreSQL 16 database, deterministic
  evidence fixtures, and test-owned local storage/proxy infrastructure.
- Exercise the real authenticated boundary. The local trusted TLS/proxy harness
  strips inbound forwarding/proof headers and injects its own proof; browser
  code never receives proxy, cursor, database, or storage credentials.
- Shape fixtures through supported persistence, processing, and query
  boundaries rather than inventing browser-only DTOs.
- Add critical browser coverage for the authentication challenge,
  list-to-detail navigation, state labels, finding/claim support navigation,
  pagination, stale cursors, keyboard/focus operation, representative responsive
  layouts, wrong-tenant/missing resources, and secret/XSS sentinels.
- Document local startup, required private configuration, supported routes,
  browser installation, deterministic test infrastructure, state meanings, and
  excluded artifact/export behavior.
- Clean up test servers, browsers, database resources, temporary credentials,
  and generated output even on failure.

## Acceptance Criteria

- An authenticated developer can traverse the run list, open a run, understand
  its independent outcomes/states, inspect all required v0.1 sections, and
  navigate every available finding/claim support to the exact evidence view.
- `PASS`, `REVIEW`, `FAILED`, `INCOMPLETE`, and `PROCESSING` render only from the
  accepted mapper and include wording that does not overstate evidence.
- Unknown, null, incomplete, stale, failed, and truncated values are visibly
  distinct and never converted to success or zero.
- Run-list test/token metrics are nullable and never synthesized from absence.
- Pagination returns every item once in deterministic order; every
  browser-visible cursor is signed, snapshot-bound, and collection-scoped;
  stale cursors fail visibly and never mix snapshots.
- Legacy unsigned child cursors never appear in browser URLs or serialized
  client view models.
- Wrong-tenant and missing routes are indistinguishable, and no credential,
  organization ID authority, database value, storage key, or internal ID enters
  client output.
- Evidence cannot inject markup, script, style, link destinations, or executable
  content.
- Artifact preview content remains bounded, escaped, non-executable, and absent
  for binary, oversized, unsupported, or unverifiable artifacts.
- Layout and navigation work at narrow and desktop widths with keyboard-only
  operation, visible focus, semantic headings, and accessible names.
- Private pages are dynamic and non-cacheable, and production builds do not
  access the database or pre-render private evidence.
- No persistence, projection, queue, worker, ingestion, collector, export,
  GitHub, policy, LLM, or artifact-byte behavior changes.

## Required Tests

- Unit tests for view-model formatting, unavailable values, state wording,
  bounds, and route/cursor construction.
- Server-runtime tests for organization injection, allowlisted inputs, signed
  child-cursor scope, key rotation, and snapshot replacement.
- Route/server tests for auth enforcement, validated identifiers, generic
  not-found behavior, safe errors, and absence of server secrets in serialized
  output.
- Component tests for every presentation state, projector diagnostics, summary
  class, finding outcome/severity, truncation, empty sections, and hostile text.
- Pagination tests for every displayed collection, including stable multi-page
  traversal, exact replay, terminal cursors, collection binding, malformed,
  stale/replaced snapshots, and back-navigation behavior.
- Playwright tests over an isolated seeded PostgreSQL database and trusted local
  proxy for the authentication challenge, run-list/detail journey, every
  presentation-state family, support-to-evidence navigation, stale pagination,
  keyboard/focus behavior, responsive layout, XSS/secret sentinels, and
  indistinguishable wrong-tenant/nonexistent routes.
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

Use PostgreSQL 16 from an empty database and apply all checked-in migrations.
Playwright browser installation/download requires explicit authorization when
the exact locked browser is unavailable. PGMQ validation is unnecessary unless
queue behavior changes.

## Deliverables

- Authenticated evidence-dashboard run list and run-detail routes.
- Server-only dashboard detail facade and signed child-cursor support.
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
- Direct exposure of older child cursors can create a tamperable browser
  authority; all browser continuation state is reissued by the dashboard.
- The first critical browser journey adds test/runtime complexity; focused
  Playwright coverage is justified and must remain isolated and deterministic.
- Browser-test proxy or fixture shortcuts can accidentally bypass the production
  authentication boundary; E2E uses the real launcher and trusted proof flow.

## Open Questions

None. The committed BBX-012A APIs and existing database read models are the
integration baseline. Playwright uses a pinned Web development dependency,
Chromium only, no committed browser binary, deterministic local
PostgreSQL/storage/proxy fixtures, and explicit authorization for installation
or infrastructure access.
