# ADR-0013: Dashboard Read Boundary and Presentation Semantics

- **Status:** Accepted
- **Date:** 2026-10-15
- **Decision owners:** Project architecture

## Context

BBX-009 through BBX-011 provide tenant-scoped, repeatable-read query functions
for current run, file, finding, and structured-summary projections. The v0.1
product journey now needs a private browser dashboard that renders those views
and lets a developer navigate from a finding or summary claim to its supporting
evidence.

The current Web application is only a Next.js placeholder. It has no dashboard
access boundary, trusted organization composition, presentation-state contract,
global run-list query, chronological evidence timeline, or evidence-reference
resolver. Adding those concerns changes the browser/server trust boundary and
the user-visible meaning of evidence. This meets the ADR criteria in
`docs/architecture/overview.md`.

## Decision

### Read-only private dashboard

The v0.1 dashboard is a read-only Next.js App Router application. It may read
through framework-independent functions exported by `@blackbox/database`, but
it must not run projectors, enqueue processing, mutate evidence, trigger replay,
or perform another long-running operation.

Database construction, storage reads, and queries execute only on the server.
`DATABASE_URL`, tenant identity, credentials, Prisma types that expose
persistence internals, and storage configuration must not enter a client
component, serialized client prop, browser bundle, URL, log, or error response.

### Single-workspace access boundary

The Web composition root obtains the trusted tenant from a required
`DASHBOARD_ORGANIZATION_ID`. Organization identity is never accepted from a
route, query parameter, form field, cookie, or client-provided header.

Every dashboard request is protected by a separate v0.1 access credential. The
server compares the presented secret in constant time with the lowercase
SHA-256 digest in `DASHBOARD_ACCESS_TOKEN_SHA256`. The dashboard credential is
not the ingestion credential and must not be reused for collector delivery.
Browser-native HTTP Basic authentication is the v0.1 mechanism: the username is
fixed and non-identifying, the token is the password, and an unauthorized
request receives a generic challenge without tenant or run information.

Basic authentication is permitted only over HTTPS, except for explicit
loopback development. The credential must not be placed in a URL, JavaScript
storage, application log, rendered page, or analytics payload. Invalid or
missing configuration fails closed. v0.1 adds no user table, account flow,
session store, RBAC, SSO, invitation, or Supabase Auth dependency.

### Presentation state is derived, not persisted

The dashboard derives exactly one convenience state for each run while still
showing observed child outcome and every projector state separately. The state
is not stored and is not a configurable policy decision.

The precedence is:

1. `FAILED` when current core evidence reports an observed child outcome of
   `failed` or `cancelled`.
2. `PROCESSING` when no failed child outcome is known and required current
   projection work is pending.
3. `INCOMPLETE` when processing failed, a required projection is stale or
   incomplete, summary availability is not current after processing settles,
   or the current summary outcome is `unknown`.
4. `REVIEW` when the current compatible summary outcome is `review`.
5. `PASS` when the current compatible summary outcome is `pass` and none of the
   earlier conditions applies.

`PASS` means only that the current versioned deterministic catalog is fully
clear. It does not claim correctness, task completion, test sufficiency, merge
safety, or policy approval. `FAILED` describes the observed wrapped-process
outcome, not a finding verdict. Projector failures remain visible independently
and normally produce `INCOMPLETE`.

The mapping is a pure exhaustive function over the public query model and is
covered by a complete precedence table.

### Dashboard read model

BBX-012 adds only the missing bounded read functions needed by the UI:

- a tenant-wide, optionally repository-filtered run list with repository ID and
  a stable snapshot-bound cursor;
- a canonical event timeline ordered by sequence and event identity;
- a tenant-, repository-, and run-scoped evidence resolver for canonical event,
  artifact-pointer, file-entry, and current finding references.

Existing run-detail, file, finding, summary-claim, and summary-support queries
remain the source of projection semantics. Dashboard functions must preserve
wrong-tenant/missing-resource indistinguishability, bounded limits, strict
cursor decoding, deterministic ordering, current-snapshot identity, and
repeatable-read consistency.

The evidence view may expose the already validated and locally redacted
canonical event JSON, immutable timestamps and identifiers, exact evidence
links, verified artifact metadata, matching projected file information, and a
bounded server-read preview of a verified text or JSON artifact. Preview reads
reuse `@blackbox/artifact-storage`, require the exact current same-run declared
artifact and winning verified upload, enforce length/hash integrity, strict
UTF-8 and binary detection, an allowlisted media type, cancellation, inactivity
and overall deadlines, and a small configured byte ceiling. Oversized, binary,
missing, rejected, expired, mismatched, or provider-unavailable content produces
safe metadata plus an explicit unavailable reason.

The evidence view must not expose database IDs, object-storage keys, service
credentials, unverified bytes, or a public download capability. Browser-direct
storage access, signed URLs, and unrestricted artifact downloads remain outside
BBX-012.

Repository UUID is the v0.1 repository label when no trusted display metadata
exists. BBX-012 does not invent a repository name or add a metadata migration.

### Safe rendering and navigation

Routes use canonical UUIDs and opaque snapshot-bound cursors. External route,
query, cursor, and pagination inputs are strictly bounded and runtime-validated.
Evidence navigation uses stable canonical identifiers and same-run ownership;
it never uses mutable text or an internal database ID as authority.

Evidence values render as escaped text or structured data. The dashboard must
not use `dangerouslySetInnerHTML`, interpret evidence as Markdown/HTML, execute
artifact content, or construct a URL from evidence. Long values are visibly
bounded or collapsed without changing the stored evidence.

Pages distinguish loading, empty, processing, stale, failed, incomplete,
truncated, unauthorized, not-found, and unavailable evidence states. A stale
cursor or replaced summary fails visibly instead of continuing into another
snapshot.

### Delivery slices

BBX-012 is delivered as two independently reviewed slices:

1. **BBX-012A — Dashboard Read Boundary and Presentation Contract:** access
   boundary, server-only composition, pure presentation mapping, missing query
   functions, evidence resolution, and integration tests.
2. **BBX-012B — Evidence Dashboard UI and Navigation:** accessible run list and
   run-detail UI over the accepted 012A boundary, including direct evidence
   navigation and critical browser coverage.

BBX-012A must be complete before BBX-012B is approved for implementation.

## Consequences

### Positive

- Browser access to private evidence has one explicit fail-closed boundary.
- Tenant identity cannot be selected or forged by the browser.
- UI labels cannot silently collapse process failure, processing health,
  evidence completeness, and deterministic assessment.
- Dashboard pages consume stable bounded view models rather than Prisma or
  provider-native records.
- Evidence links can show bounded integrity-checked content without exposing
  storage capabilities.

### Negative

- Browser-native Basic authentication is intentionally minimal and less polished
  than a user-account login flow.
- The Web process needs direct server-side database connectivity.
- Repository labels remain UUIDs in v0.1.
- Large, binary, unsupported, or unverifiable artifact content is not rendered
  in the first dashboard.
- Two delivery slices add an approval and review boundary before the UI is
  complete.

## Alternatives Considered

### Leave access control to deployment configuration

Rejected because an accidentally public deployment could expose private
evidence without an application-level failure boundary.

### Reuse the ingestion bearer token

Rejected because browser access and machine ingestion are different trust
boundaries. Credential reuse would broaden the impact of either disclosure.

### Add user accounts or Supabase Auth in v0.1

Rejected because accounts, teams, RBAC, and SSO are outside v0.1 and would make
the dashboard depend on an unapproved identity system.

### Persist one presentation status

Rejected because it would duplicate derived state, become stale, and obscure
the independent child-outcome, processing, findings, and summary dimensions.

### Query Prisma directly from React components

Rejected because framework code would own tenant and evidence semantics, and
client/server boundaries could accidentally serialize persistence internals or
credentials.

### Expose signed URLs or browser-direct artifact downloads

Rejected for BBX-012 because it would add transferable storage capabilities,
content-disposition and active-content handling, and expiry/revocation concerns.
The server instead reads only a bounded allowlisted preview through the existing
integrity-verifying storage boundary. BBX-013 may include artifact content in
the versioned export under its own bounds.

## Follow-up

- BBX-012A implements the read and access boundary.
- BBX-012B implements the evidence dashboard UI and browser navigation.
- BBX-013 exports the versioned evidence bundle and proves the complete v0.1
  journey.
- A future account or session model requires a separate architecture decision.

## References

- [v0.1 product scope](../../product/v0.1-scope.md)
- [Architecture overview](../overview.md)
- [v0.1 delivery sequence](../v0.1-delivery-sequence.md)
- [ADR-0010](ADR-0010-replayable-projections-and-processing-state.md)
- [ADR-0011](ADR-0011-versioned-deterministic-findings.md)
- [ADR-0012](ADR-0012-versioned-evidence-backed-summaries.md)
