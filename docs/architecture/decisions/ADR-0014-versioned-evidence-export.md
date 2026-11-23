# ADR-0014: Versioned Evidence Export and v0.1 Completion Boundary

- **Status:** Accepted
- **Date:** 2026-11-23
- **Decision owners:** Project architecture

## Context

The v0.1 product journey can record a Codex run, deliver immutable evidence,
build replayable projections, produce deterministic findings and an
evidence-backed summary, and render those results in a private dashboard. The
remaining product requirement is to export one run as a versioned JSON evidence
bundle and prove the complete restart-safe journey.

An export is a new public data contract and a new path by which private evidence
leaves the server. Its format, snapshot semantics, bounds, tenant authority,
artifact treatment, and compatibility rules must not be implicit in a Web
route. This changes a security and compatibility boundary and therefore meets
the ADR criteria in `docs/architecture/overview.md`.

The architecture overview lists export bundles among objects that may be stored
when they are independently downloadable. Persisting generated exports would,
however, require a new durable export lifecycle, authorization model, retention
policy, and worker/control-plane write path. None is required by the v0.1
product scope.

## Decision

### Export V1 is a deterministic read model

Define a strict `evidence-export` format version 1 in a pure package. The same
current run snapshot produces byte-identical UTF-8 JSON regardless of query
page size or database row-return order. Generation uses no clock, randomness,
database identity, storage location, or Web request metadata.

The canonical byte encoding has one documented implementation-independent rule
set: object keys are ordered deterministically, arrays use their contract order,
numbers are bounded safe integers, and no insignificant whitespace is emitted.
The SHA-256 of those exact bytes is the response entity tag. This is an
integrity and replay identity, not a signature or proof of server identity.

The bundle contains:

- its export format version and canonical repository/run identities;
- immutable canonical events in sequence and event-ID order, including safe
  server-authored receipt metadata;
- artifact declarations plus verification/integrity metadata;
- current compatible core and file projection data and their version,
  fingerprint, completeness, and processing states;
- the complete current deterministic findings catalog and ordered immutable
  evidence references when available;
- the complete current structured summary, ordered claims, and ordered typed
  support graph when available;
- independent child, processing, findings, summary, and derived presentation
  outcomes; and
- explicit unavailable, stale, incomplete, failed, and source-truncation facts.

The bundle omits organization identity, database IDs, object keys, upload or
download capabilities, credentials, connection information, dashboard cursor
state, provider-native payloads outside accepted canonical evidence, and hidden
reasoning. Existing redacted bounded canonical event content is not expanded or
reinterpreted.

### Artifact bytes are excluded from V1

Export V1 includes the canonical artifact declaration, exact post-redaction
length and SHA-256, redaction/compression/encoding metadata, and server
verification state. It does not include artifact bytes, signed storage URLs, or
public download capabilities.

This satisfies the v0.1 requirement to include hashes and references while
keeping the export deterministic, bounded, and inert. A future format may embed
or package verified artifact bytes only after defining content bounds,
active-content handling, storage lifecycle, and compatibility semantics in a
new decision.

### Snapshot and completeness semantics

One tenant-scoped repeatable-read transaction selects the immutable evidence,
artifact metadata, current processing state, and compatible projection graphs.
The exporter must not assemble independent pages from different snapshots.

Export-specific limits are named, versioned constants. The exporter returns a
complete valid bundle or a stable safe `export_too_large`/unavailable result; it
never silently drops rows or changes snapshot. Existing source-level truncation
or omission already represented by canonical evidence or projections remains
visible as data and does not masquerade as export completeness.

Stale, incomplete, failed, or still-processing runs may be exported if their
exact states and unavailable sections are represented by the V1 schema. The
final v0.1 acceptance journey additionally proves export after compatible core,
files, findings, and summary processing completes.

### Private authenticated download

The existing dashboard server exposes a dynamic `no-store` authenticated GET
route scoped by configured organization, repository UUID, and canonical run
UUID. It reuses ADR-0013 authentication, trusted-proxy, tenant-injection, and
wrong-tenant/missing-resource indistinguishability.

The route buffers only within the V1 total-byte ceiling, validates the complete
bundle, emits the canonical bytes as a JSON attachment with a fixed UUID-derived
filename, exact content length, and SHA-256 entity tag, and never queries during
build or static rendering. It creates no database row or storage object and
does not enqueue processing, trigger replay, or mutate evidence.

The dashboard may offer an export link, but browser code receives neither
tenant authority nor storage or signing credentials. Export is unavailable
when configuration is invalid and uses generic authenticated error responses
that contain no hidden-resource or internal-storage detail.

### Complete v0.1 journey

The final hardening slice proves one real supported journey through the existing
boundaries:

```text
Codex-compatible wrapped run
  → local redacted SQLite spool
  → artifact upload attempt fails
  → collector process ends with retained work
  → fresh collector retry after restart
  → verified artifact plus idempotent evidence ingestion
  → duplicate delivery converges without duplicate evidence
  → relay and worker build current core/files/findings/summary
  → authenticated dashboard review
  → authenticated Export V1 download and independent validation
```

The proof uses production entrypoints and supported public boundaries wherever
the behavior under test is production behavior. Test fixtures may replace
external Codex, object-storage, and trusted-proxy services at their existing
ports, but may not bypass spool state transitions, ingestion validation,
artifact verification, queue/worker processing, dashboard authorization, or
the export parser.

The journey asserts stable canonical identities and exact database counts
before and after an intentional duplicate retry. It verifies bundle references
against persisted immutable evidence and current projection fingerprints, and
checks that secret sentinels, credentials, storage keys, and unredacted input do
not appear in the bytes.

BBX-013 does not add automatic acknowledged-spool deletion. Retention remains a
separate operator and architecture concern under ADR-0006.

### Delivery slices

BBX-013 is delivered as two independently reviewed slices:

1. **BBX-013A — Versioned Evidence Export:** pure V1 contract/canonical encoder,
   tenant-safe snapshot query, authenticated download, dashboard affordance,
   and format/security tests.
2. **BBX-013B — v0.1 End-to-End Hardening:** the restart, duplicate-delivery,
   processing, review, and export proof plus only narrow fixes required to make
   already accepted production contracts deterministic.

BBX-013B starts only after BBX-013A is complete.

## Consequences

### Positive

- Exported bytes have a strict versioned contract and reproducible integrity
  identity.
- The export preserves missing and incomplete evidence instead of inventing a
  successful narrative.
- No new durable export job, retention lifecycle, storage capability, or public
  artifact-download boundary is introduced.
- Tenant and credential boundaries remain the already reviewed dashboard
  boundary.
- The final journey validates retry and duplicate behavior through production
  seams rather than browser-only fixtures.

### Negative

- Export V1 is not self-contained for large artifact bodies; consumers need the
  recorded hashes and references rather than embedded bytes.
- On-demand generation repeats database reads and canonical encoding for each
  download.
- Runs above the explicit V1 bounds cannot be exported until a future streaming
  or durable export lifecycle is designed.
- The final journey is infrastructure-heavy and requires exact process,
  database, queue, storage-fixture, browser, and cleanup ownership.

## Alternatives Considered

### Persist every export in object storage

Rejected for v0.1 because it requires a durable export job, mutation API,
retention rules, authorization/revocation, and cleanup semantics beyond the
single-run JSON requirement.

### Include verified artifact bytes in JSON

Rejected for V1 because base64 expansion, active or binary content, aggregate
size, partial availability, and storage-read failure would dominate the first
format. Hashes and references satisfy the accepted product scope.

### Export only the dashboard view model

Rejected because presentation data omits immutable canonical evidence and is
not a stable audit contract.

### Let a browser assemble paginated APIs

Rejected because pages can span incompatible snapshots, signed cursors are not
an export format, and client assembly would broaden tenant and secret exposure.

### Combine format implementation and full-system proof in one review

Rejected because a format/security defect and an orchestration defect would be
hard to isolate. Two ordered slices preserve one umbrella outcome with smaller
review boundaries.

## Follow-up

- BBX-013A implements Export V1 and the private download boundary.
- BBX-013B proves the complete v0.1 journey and closes the delivery sequence.
- Embedded artifact content, stored export objects, signed public exports,
  retention, compliance export, and SIEM integration require later scope and
  architecture decisions.

## References

- [v0.1 product scope](../../product/v0.1-scope.md)
- [Architecture overview](../overview.md)
- [Canonical evidence model](../evidence-model.md)
- [v0.1 delivery sequence](../v0.1-delivery-sequence.md)
- [ADR-0006](ADR-0006-local-spool-and-delivery-state.md)
- [ADR-0010](ADR-0010-replayable-projections-and-processing-state.md)
- [ADR-0011](ADR-0011-versioned-deterministic-findings.md)
- [ADR-0012](ADR-0012-versioned-evidence-backed-summaries.md)
- [ADR-0013](ADR-0013-dashboard-read-boundary-and-presentation-semantics.md)
