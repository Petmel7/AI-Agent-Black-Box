# Canonical Evidence Model

**Status:** Accepted for v0.1

**Last updated:** 2026-09-22

## Purpose

The canonical evidence model is the stable boundary among the local collector,
agent adapters, ingestion API, workers, exports, and the dashboard. It describes
observable evidence without embedding Codex transport details, database records,
storage URLs, or derived findings.

The v0.1 contract must answer what was observed and what was unavailable. It must
not imply that an event was verified merely because it was accepted by the
ingestion service.

## Design Principles

- Evidence describes observable actions and outcomes, not hidden reasoning.
- The local collector assigns stable run, event, artifact, and operation IDs.
- Raw events are immutable and safe to retry.
- Missing information remains explicitly unavailable; producers do not invent it.
- Ordering does not depend on wall-clock precision.
- Large or sensitive content is represented by bounded excerpts and artifact
  references rather than unbounded inline payloads.
- Provider-native identifiers and trace context are retained as correlation
  metadata without becoming canonical identity.
- Tenant identity and server receipt time come from the trusted ingestion
  boundary, not from an uploaded event.
- Derived projections, findings, summaries, policy results, and storage locations
  are not raw evidence events.

## Trust Boundaries

### Collector-authored fields

The collector is responsible for:

- `runId`;
- `eventId`;
- per-run `sequence`;
- `observedAt`;
- source and correlation metadata;
- the event `kind` and its payload;
- artifact identifiers, byte lengths, media types, and hashes after local
  redaction.

These values are untrusted input to ingestion and must be validated.

### Server-authored fields

The ingestion and persistence layers add:

- `organizationId`, derived from authenticated credentials;
- `receivedAt`, captured from the server clock;
- persistence identity and ingestion status;
- storage keys or signed download information;
- server-computed integrity or conflict metadata when required.

The upload contract does not accept `organizationId`, `receivedAt`, storage URLs,
or verification state from the collector. This prevents a client from asserting
tenant ownership or server observations.

## Identity and Idempotency

- `runId`, `eventId`, `batchId`, `artifactId`, and operation IDs are UUIDs.
- `eventId` is globally unique and remains unchanged across spool retries.
- `batchId` is globally unique and remains unchanged when the same batch is
  retried.
- `sequence` is a non-negative safe integer assigned monotonically within one
  run. Gaps are allowed; duplicate sequence values within a run are not.
- Event ordering uses `sequence`. Timestamps are descriptive evidence and never
  the sole ordering key.
- Reusing an ID with identical canonical content is a duplicate. Reusing it with
  different content is an integrity conflict, not an update.

## Time Model

Every event contains:

- `observedAt`: required UTC RFC 3339 timestamp recorded by the collector when it
  accepted the observation;
- `occurredAt`: optional UTC RFC 3339 timestamp supplied by the originating source
  when that source exposes one.

The server later adds `receivedAt`. A producer must omit `occurredAt` when it is
not available rather than substituting another clock value. Durations are
non-negative integer milliseconds and are independent of timestamp subtraction.

## Event Envelope

The version 1 event envelope is conceptually:

```json
{
  "schemaVersion": 1,
  "eventId": "uuid",
  "runId": "uuid",
  "sequence": 0,
  "kind": "command.finished",
  "observedAt": "2026-09-22T12:00:00.000Z",
  "occurredAt": "2026-09-22T11:59:59.500Z",
  "source": {
    "component": "agent-adapter",
    "provider": "codex",
    "nativeEventId": "optional-provider-id"
  },
  "correlation": {
    "parentEventId": "optional-uuid",
    "traceId": "optional-w3c-trace-id",
    "spanId": "optional-w3c-span-id"
  },
  "payload": {}
}
```

The implementation uses a strict Zod discriminated union keyed by `kind`. Unknown
envelope or payload properties are rejected in version 1. This makes accepted
evidence auditable and prevents silent retention of unbounded or sensitive data.

The shape borrows the identity, source, type, and time separation used by
CloudEvents, but AI Agent Black Box v0.1 does not claim CloudEvents compliance.
Provider trace and span identifiers follow OpenTelemetry/W3C formats when they
are available.

## Source and Correlation

`source.component` is one of:

- `collector`;
- `agent-adapter`;
- `git`;
- `process`;
- `test-parser`.

`source.provider` is an optional bounded lowercase identifier such as `codex`.
Provider-native session and event identifiers are optional bounded strings.

Correlation metadata may contain `parentEventId`, W3C-compatible `traceId`, and
`spanId`. Correlation values help connect observations but do not replace
canonical IDs or prove causality.

## Version 1 Event Kinds

The initial closed set is:

- `run.started`;
- `run.finished`;
- `tool.call.started`;
- `tool.call.finished`;
- `command.started`;
- `command.finished`;
- `test.run.finished`;
- `git.snapshot.captured`;
- `git.diff.captured`;
- `error.observed`;
- `usage.observed`.

Started and finished events share a stable operation ID. A started operation may
legitimately have no finished event when collection is interrupted. Consumers
must represent that state as incomplete rather than manufacturing an outcome.

### Run lifecycle

`run.started` identifies the adapter/provider and may include a bounded,
explicitly captured task description. `run.finished` records one of `succeeded`,
`failed`, `cancelled`, or `unknown`, plus an observed duration when available.
These values describe the agent process outcome, not code quality or policy.

### Tool calls

Tool-call events use a stable `toolCallId`, bounded tool name, explicit outcome,
and content-capture references for input and output. Provider-specific raw
payloads must be externalized as artifacts rather than placed in arbitrary JSON
properties.

### Commands

Command events use a stable `commandId`. A finished command may contain exit
code, termination signal, duration, and bounded stdout/stderr captures. Command
text and working directories use the content-capture contract because they may
contain secrets or local paths.

### Tests

`test.run.finished` references the originating `commandId` when known. It records
the observed framework, outcome, available counts, duration, and an optional
report artifact. A successful command exit does not automatically imply passing
tests.

### Git evidence

`git.snapshot.captured` records `before`, `after`, or `checkpoint`, the observed
HEAD commit when available, dirty-state metadata, and an optional status
artifact. `git.diff.captured` links two snapshots and records available summary
counts plus artifact references for the full diff and file list.

Git paths and diff bodies may contain sensitive information and are not
unbounded inline fields.

### Errors

`error.observed` records a stable error ID, bounded machine-readable category and
code, explicit retryability when known, a safe message capture, and an optional
related operation or event ID. It preserves observable failures without accepting
arbitrary exception objects.

### Usage

`usage.observed` records provider/model metadata and token measurements only when
reported by the source. Each unavailable measurement carries an explicit reason.
Cost is excluded from the version 1 event union until an authoritative-versus-
estimated money contract is designed.

## Content Capture

Potentially sensitive text uses a discriminated union:

- `omitted`: content was intentionally not collected;
- `unavailable`: the source did not expose it or collection failed, with a stable
  reason;
- `captured`: contains a bounded excerpt, an optional artifact reference for full
  redacted content, and an explicit truncation flag.

`captured` content records whether redaction was applied and the redaction ruleset
version when known. It never contains credentials, raw authorization headers, or
hidden chain-of-thought.

## Artifact Reference

An artifact reference contains:

- `artifactId`;
- a bounded artifact kind;
- media type;
- byte length of the post-redaction bytes;
- lowercase SHA-256 of those exact bytes;
- redaction state;
- optional compression and character encoding metadata.

It does not contain a bucket name, object key, public URL, signed URL, or local
absolute path. Storage location is server-owned metadata. Integrity always refers
to the post-redaction bytes that may be uploaded and exported.

## Evidence Reference

Derived records use an evidence reference rather than copying evidence:

- an event reference contains `eventId` and an optional RFC 6901 JSON Pointer;
- an artifact reference contains `artifactId`, its SHA-256, and an optional
  bounded byte or line range.

The referenced event or artifact must belong to the same run. That cross-record
invariant is enforced by persistence or analysis code, not by standalone Zod
parsing.

## Batch Contract

An upload batch contains:

- `schemaVersion: 1`;
- `batchId`;
- `runId`;
- collector `sentAt` timestamp;
- one to 500 events.

All events must match the batch `runId`; event IDs and sequence values must be
unique inside the batch. A batch is an upload unit, not an ordering or transaction
boundary for the run.

## Compatibility Rules

- Version 1 schemas are strict.
- Adding an optional enum value, event kind, required field, or changing field
  meaning requires a new schema version because older strict consumers cannot
  safely interpret it.
- Documentation-only clarification and validation bug fixes that do not change
  accepted wire values may remain in the same version.
- Ingestion routes by `schemaVersion` and never silently coerces unknown versions.
- Raw accepted versioned events remain readable after newer versions ship.
- Database schema versions and evidence schema versions are independent.

## Deliberate Exclusions from BBX-002

- HTTP request and response contracts beyond the in-memory batch schema.
- Database and Prisma models.
- Storage upload protocols.
- Codex OTel or hook mapping.
- Git capture algorithms.
- Redaction implementation.
- Deterministic findings and run presentation states.
- Summary claims, policies, and LLM payloads.
- Canonical JSON byte serialization and server-side content hashing.

These are owned by later tasks. BBX-002 defines the typed vocabulary they share.
