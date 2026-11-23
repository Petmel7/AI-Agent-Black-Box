# BBX-013A: Versioned Evidence Export

- **Status:** Approved
- **Owner:** Implementation Chat
- **Review:** Review Chat
- **Depends on:** BBX-012B and BBX-012C completed at committed baseline
  `c2173da8c114fb0dd0a33539d23e1023ba96f6c4`
- **Delivery risk:** High
- **Execution profile:** High
- **Risk triggers:** public versioned contract, private evidence disclosure,
  tenant isolation, authentication, deterministic byte serialization,
  repeatable-read consistency, untrusted JSON download, bounds, and
  cross-package Web/database behavior
- **Architecture:** Accepted ADR-0014; accepted ADR-0001 through ADR-0013 remain
  unchanged

## Goal

Export one private run as a deterministic, versioned JSON evidence bundle that
preserves immutable evidence, current derived-state compatibility, and explicit
limitations without exposing tenant authority, credentials, persistence
internals, or artifact bytes.

## Context

BBX-002 through BBX-011 provide versioned canonical evidence, verified artifact
metadata, replayable projections, deterministic findings, and structured
summary supports. BBX-012A/B provide the authenticated tenant-safe dashboard
read boundary and evidence navigation. ADR-0014 defines the remaining export
format and delivery boundary.

## In Scope

- Pure Export V1 schemas, canonical byte encoding, parsing, and integrity hash.
- One tenant-scoped repeatable-read query that assembles a complete bounded run
  snapshot without browser cursors or internal database identifiers.
- Dynamic authenticated same-origin JSON attachment route and a dashboard
  export affordance.
- Exact event, artifact metadata, projection, findings, summary, support, state,
  compatibility, and limitation representation required by ADR-0014.
- Format, snapshot, tenant, security, determinism, route, and browser coverage.
- Export format and operations documentation.

## Out of Scope

- Artifact bytes, base64 content, public or signed storage URLs, unrestricted
  downloads, stored export objects, export jobs, progress UI, retention, or
  export deletion.
- New evidence event kinds, collector behavior, ingestion behavior, workers,
  queues, replay, projection semantics, analyzer/summary semantics, or database
  mutation.
- SIEM/compliance formats, SARIF export, CSV/PDF, signing/attestation, encryption,
  public sharing, email, GitHub/PR behavior, policy, or multi-run export.
- Accounts, sessions, RBAC, SSO, configurable tenant selection, or a new
  authentication mechanism.
- The restart/duplicate-delivery complete-system proof owned by BBX-013B.

## Architecture Constraints

- Accept ADR-0014 before implementation. Do not invent a different export
  lifecycle inside the route.
- Build a pure `@blackbox/export` package with no framework, database, storage,
  filesystem, network, clock, or randomness dependency.
- Treat Export V1 as a strict public contract. Unknown versions and properties
  fail closed; compatibility changes require a new export format version.
- Generate exact canonical bytes deterministically. Do not include an export
  timestamp, request ID, random bundle ID, database row ID, or nondeterministic
  object/row order.
- Select all database-backed sections inside one tenant-scoped repeatable-read
  snapshot. Do not page through public dashboard URLs or mix snapshots.
- Preserve raw canonical event meaning and current projection/findings/summary
  semantics. The exporter does not reinterpret provider-native payloads or
  upgrade incomplete evidence.
- Export artifact declarations and verification metadata only. Do not read or
  serialize object bytes, object keys, buckets, capabilities, or signed URLs.
- Reuse ADR-0013 configured organization, Basic authentication, trusted-proxy,
  generic miss, dynamic rendering, and server-only secret boundaries.
- Buffer only inside a named V1 total-byte ceiling. A collection or byte limit
  produces a stable safe unavailable result, never a partial or silently
  truncated export.
- No new schema or migration is expected. If a durable export record, new trust
  boundary, storage write, processing intent, or changed evidence meaning is
  required, stop and return to architecture.

## Required Changes

### Export V1 package

- Add strict named schemas and TypeScript types for bundle identity, immutable
  events, artifact metadata, processing/projection snapshots, file entries,
  findings and references, summary claims/supports, independent outcomes, and
  explicit unavailable states.
- Define stable ordering for every array and reject duplicate or out-of-order
  canonical identities.
- Define named per-collection and total canonical-byte limits. Validate counts,
  safe integers, UUIDs, digests, versions, reason codes, and bounded strings.
- Implement canonical UTF-8 serialization with deterministic key ordering and
  no insignificant whitespace, plus SHA-256 over the exact emitted bytes.
- Parse and validate exported bytes independently of the builder. Byte-equivalent
  input snapshots must produce byte-identical output and digest.

### Snapshot query and composition

- Add a framework-independent database query keyed by trusted organization,
  repository UUID, and canonical run UUID.
- Read the complete bounded raw event set, safe receipt metadata, artifact
  declarations/verification metadata, current processing states, compatible
  core/files projection, complete current findings catalog/references, and
  complete current summary claims/support graph in one repeatable-read snapshot.
- Recompute currentness using existing projector, finding, and summary version
  and fingerprint rules. Represent unavailable/stale/incomplete/failed sections
  explicitly; never attach incompatible rows.
- Return no Prisma types, internal IDs, organization ID, storage locations,
  credentials, cursor material, or unvalidated JSON.
- Make wrong-tenant, wrong-repository, and missing-run results
  indistinguishable. Limit failures expose only a stable safe code.

### Authenticated download and dashboard

- Add canonical private route
  `/repositories/[repositoryId]/runs/[runId]/export`.
- Require the existing dashboard authentication and trusted transport boundary;
  inject organization identity only from server configuration.
- Return canonical bytes with an allowlisted versioned JSON media type,
  `Content-Disposition: attachment` using a fixed UUID-derived filename,
  exact `Content-Length`, SHA-256 entity tag, `Cache-Control: no-store`, and
  content-sniffing protection.
- Keep the route dynamic and server-only. Production build/static rendering
  must not access the database or generate an export.
- Add an accessible export action to run detail without placing tenant,
  credential, storage, or signing authority in client state.
- Show generic safe unavailable/too-large behavior without leaking whether a
  hidden run exists.

### Documentation

- Document Export V1 semantics, format/version compatibility, deterministic
  bytes and digest, bounds, unavailable states, artifact-byte exclusion,
  authentication, safe filename, and local usage.
- State that the bundle is evidence plus derived-state context, not a signature,
  correctness certificate, merge approval, compliance export, or full artifact
  archive.

## Acceptance Criteria

- The same current run snapshot produces byte-identical validated Export V1
  bytes and SHA-256 across repeated generation, database return-order
  permutations, and query page-size variations.
- Every array is complete within V1 bounds, deterministic, duplicate-free, and
  ordered by its documented stable identity. Exceeding any bound fails the
  whole export safely.
- Immutable events and artifact hashes/references match persisted canonical
  data exactly. Artifact bytes and storage capabilities never enter the bundle.
- Current compatible findings and summary support graph are complete; stale or
  incompatible derived state is represented as unavailable rather than mixed
  into the bundle.
- Missing, processing, failed, incomplete, unknown, omitted, and source-truncated
  evidence remain distinguishable from empty, zero, success, `PASS`, or export
  truncation.
- The bundle and response contain no organization ID, internal database ID,
  object key, credential, connection string, cursor key, signed capability,
  unredacted secret sentinel, or hidden reasoning.
- Unauthenticated, invalid-credential, wrong-tenant, wrong-repository, and
  missing-run requests disclose no private metadata and preserve ADR-0013
  transport and generic-miss behavior.
- The download filename, headers, media type, content length, entity tag, and
  body are deterministic and cannot be influenced by evidence text.
- Private pages/routes remain dynamic and `no-store`; build performs no database
  or storage access.
- Existing evidence, artifact, projection, findings, summary, dashboard, queue,
  worker, ingestion, and collector behavior remains unchanged.

## Required Tests

- Pure schema/builder/parser tests for every section, stable order, duplicate
  rejection, strict versions, bounds, safe integers, canonical bytes, digest,
  permutations, and byte-level round trip.
- Negative pure tests for unknown fields/versions, malformed identifiers,
  incompatible supports, duplicate keys, missing required availability facts,
  forbidden internal fields, and over-limit collections/bytes.
- PostgreSQL integration tests from a fresh migrated database for complete,
  processing, stale, failed, incomplete, and missing sections; late events;
  repeatable-read consistency; tenant/repository isolation; complete support
  traversal; and adversarial row order.
- Route tests for authentication, trusted proxy proof, generic misses, safe
  errors, headers, deterministic filename, length/hash equality, `no-store`,
  build isolation, and secret/storage sentinel absence.
- Browser coverage for downloading one complete fixture, independently parsing
  it, matching visible run identity/outcomes, and rejecting unauthenticated or
  hidden-tenant export attempts.
- Regression tests for the existing dashboard queries, evidence navigation,
  production build, and Web server lifecycle.

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

Using an explicitly authorized isolated PostgreSQL 16 database, deploy every
migration from empty state and run the complete database integration suite plus
the export browser journey. Docker, database, browser installation, dependency
installation, or network access requires its applicable authorization. PGMQ is
not required unless the implementation unexpectedly changes processing/queue
surfaces.

## Deliverables

- Accepted ADR-0014 Export V1 implementation.
- Pure `@blackbox/export` contract, canonical encoder/parser, limits, and docs.
- Tenant-safe repeatable-read export query.
- Authenticated deterministic download route and accessible dashboard action.
- Focused high-risk format, tenant, secret, consistency, route, and browser
  tests plus operations documentation.

## Referenced Decisions and Documents

- `docs/product/v0.1-scope.md`
- `docs/architecture/overview.md`
- `docs/architecture/evidence-model.md`
- `docs/architecture/v0.1-delivery-sequence.md`
- `docs/architecture/decisions/ADR-0003-durable-evidence-persistence.md`
- `docs/architecture/decisions/ADR-0005-artifact-upload-and-integrity.md`
- `docs/architecture/decisions/ADR-0010-replayable-projections-and-processing-state.md`
- `docs/architecture/decisions/ADR-0011-versioned-deterministic-findings.md`
- `docs/architecture/decisions/ADR-0012-versioned-evidence-backed-summaries.md`
- `docs/architecture/decisions/ADR-0013-dashboard-read-boundary-and-presentation-semantics.md`
- `docs/architecture/decisions/ADR-0014-versioned-evidence-export.md`
- `docs/review-guidelines.md`

## Risks

- A bundle can become a new secret-exfiltration path; strict allowlisted schemas,
  tenant injection, forbidden-field/sentinel tests, and independent parsing
  mitigate it.
- Inconsistent queries can mix evidence and projections; one repeatable-read
  snapshot plus compatibility rechecks mitigate it.
- Canonical encoding errors can create unstable hashes or incompatible exports;
  permutation, byte fixture, and independent parser tests mitigate it.
- Large runs can exhaust memory; named collection/byte ceilings and whole-export
  failure prevent unbounded buffering and misleading partial output.
- A download can activate untrusted content in a browser; inert JSON media,
  attachment disposition, no sniffing, fixed filename, and no artifact bytes
  reduce that risk.

## Open Questions

None after ADR-0014 is accepted.
