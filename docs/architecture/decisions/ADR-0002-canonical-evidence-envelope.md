# ADR-0002: Canonical, Versioned Evidence Envelope

- **Status:** Accepted
- **Date:** 2026-09-22
- **Decision owners:** Project architecture

## Context

The collector, Codex adapter, ingestion service, worker, dashboard, and export
flow need one evidence vocabulary. Provider telemetry is incomplete and can
arrive with retries, duplicate delivery, clock skew, missing timestamps, large
outputs, and sensitive content. Database records and provider-native payloads are
both unsuitable as the public contract: the first couples the domain to storage,
and the second couples it to one agent.

The contract must preserve evidence provenance and uncertainty while allowing
idempotent ingestion and later deterministic analysis.

## Decision

Adopt a project-owned JSON evidence envelope implemented as strict Zod schemas in
`@blackbox/contracts`.

The envelope has an integer `schemaVersion`, canonical UUID identities, a
collector-assigned per-run `sequence`, source and optional trace correlation,
collector observation time, optional source occurrence time, a closed `kind`
discriminant, and a kind-specific payload.

Use a closed version 1 event union for run lifecycle, tool calls, commands,
observed tests, Git snapshots and diffs, errors, and usage. Use stable operation
IDs to correlate started and finished events.

The collector assigns canonical identity and order. The ingestion server derives
tenant identity from authentication and adds receipt time. Client payloads cannot
assert `organizationId`, `receivedAt`, storage location, or verification state.

Full or sensitive content is omitted, represented by bounded redacted excerpts,
or externalized through content-addressed artifact references. Artifact hashes
cover the exact post-redaction bytes. Derived findings and summaries reference
events or artifacts instead of copying or mutating them.

The envelope is influenced by CloudEvents identity/source/type/time separation,
but it is not a CloudEvents implementation. Optional OpenTelemetry trace and span
IDs retain provider correlation without becoming canonical event identity.

## Versioning and Compatibility

Version 1 objects reject unknown properties and unknown event kinds. Any wire
change that older strict consumers cannot interpret safely requires a new integer
schema version. Ingestion selects a parser by version and rejects unsupported
versions without coercion.

Evidence schema versions are independent of database migrations, API route
versions, adapter versions, and analyzer versions.

## Ordering and Duplicate Delivery

Per-run `sequence` is the authoritative event order. Timestamps do not determine
order. Gaps are allowed. Duplicate event or batch IDs with identical canonical
content are idempotent retries; conflicting reuse is an integrity error.

The batch contract validates same-run membership and uniqueness inside a batch.
Cross-batch uniqueness, ownership, same-run references, and conflict detection
are enforced by later ingestion and persistence tasks.

## Alternatives Considered

### Store provider payloads as the canonical model

Rejected because it binds the product to Codex, makes multi-agent normalization
harder, and leaves core invariants implicit. Provider-native payloads may still be
retained as optional artifacts when permitted.

### Adopt CloudEvents unchanged

Rejected for v0.1 because Black Box needs run-local ordering, content capture,
artifact integrity, operation correlation, and strict evidence kinds that are not
defined by CloudEvents. Reusing its concepts without claiming compliance keeps
the contract smaller and avoids an unused protocol dependency.

### Use timestamps as the timeline order

Rejected because provider clocks, collector clocks, timestamp precision, and
concurrent observations can disagree. A collector-assigned sequence is explicit
and deterministic.

### Put organization identity in collector events

Rejected because organization ownership is an authentication result. Trusting a
client-provided tenant identifier creates misattribution risk.

### Allow arbitrary metadata maps

Rejected because they weaken runtime validation, allow accidental secret capture,
and make compatibility unknowable. New canonical data requires an explicit field
and version decision; provider-native data may be an artifact.

### Inline all outputs

Rejected because command logs, diffs, and reports are unbounded and may be
sensitive. Bounded captures plus hashed artifacts preserve evidence without
inflating the event log.

## Consequences

### Positive

- Collector, ingestion, workers, exports, and UI share one runtime-validated
  vocabulary.
- Retry and ordering semantics are explicit before persistence is implemented.
- Provider correlation is preserved without provider lock-in.
- Tenant ownership and server receipt time stay inside the trusted boundary.
- Large evidence has stable integrity metadata without storage coupling.
- Unsupported or unavailable data remains visible rather than fabricated.

### Negative

- Strict schemas require deliberate version evolution.
- Producers must assign stable IDs and sequence values before upload.
- Some invariants require database or run-level validation beyond Zod.
- The first schema includes several event variants and needs substantial contract
  tests.

## Follow-up Work

- BBX-003 defines persistence and cross-record constraints.
- The ingestion task defines conflict responses and supported-version negotiation.
- The collector task defines sequence allocation, spooling, redaction, and
  artifact creation.
- The Codex adapter task maps documented provider telemetry into these contracts.
- The analyzer task defines findings and evidence-reference validation.

## References

- [Canonical Evidence Model](../evidence-model.md)
- [CloudEvents specification](https://github.com/cloudevents/spec/blob/main/cloudevents/spec.md)
- [OpenTelemetry tracing specification](https://opentelemetry.io/docs/specs/otel/trace/api/)
- [RFC 6901 JSON Pointer](https://www.rfc-editor.org/rfc/rfc6901)
