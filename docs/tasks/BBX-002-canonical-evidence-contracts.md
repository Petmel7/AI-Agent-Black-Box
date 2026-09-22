# BBX-002: Canonical Evidence Contracts

- **Status:** Done
- **Owner:** Implementation Chat
- **Review:** Review Chat
- **Architecture:** [ADR-0001](../architecture/decisions/ADR-0001-modular-monolith.md), [ADR-0002](../architecture/decisions/ADR-0002-canonical-evidence-envelope.md)

## Goal

Implement the version 1 canonical evidence vocabulary as strict runtime-validated
TypeScript contracts so later collector, ingestion, persistence, analysis, export,
and dashboard tasks share one stable boundary.

## Context

BBX-001 established `@blackbox/contracts` with Zod and a health contract. The next
vertical dependency is the evidence contract itself. Implementing database,
collector, or ingestion behavior before this vocabulary is fixed would duplicate
identity, ordering, availability, and artifact semantics across processes.

The governing semantic design is the Canonical Evidence Model and ADR-0002.

## In Scope

- Add modular schemas and inferred types under
  `packages/contracts/src/evidence/` for:
  - canonical UUID identifiers;
  - UTC timestamps and non-negative durations;
  - source and optional trace correlation;
  - explicit availability and bounded content capture;
  - artifact references and SHA-256 integrity metadata;
  - evidence references using optional RFC 6901 JSON Pointers;
  - the version 1 evidence event envelope;
  - all version 1 event payload kinds from the Canonical Evidence Model;
  - upload batches containing one to 500 events.
- Export the public evidence API from `@blackbox/contracts` without breaking the
  existing health contract.
- Use strict Zod objects and a discriminated union keyed by `kind`.
- Add cross-field batch validation for matching `runId`, unique `eventId`, and
  unique `sequence` within a batch.
- Add bounded strings, arrays, excerpts, and numeric values appropriate to an
  untrusted wire contract.
- Document exported constants where their values are protocol limits.

## Required Version 1 Event Kinds

- `run.started`
- `run.finished`
- `tool.call.started`
- `tool.call.finished`
- `command.started`
- `command.finished`
- `test.run.finished`
- `git.snapshot.captured`
- `git.diff.captured`
- `error.observed`
- `usage.observed`

## Required Semantic Rules

- `schemaVersion` is the literal integer `1`.
- IDs generated and owned by Black Box are UUIDs.
- `sequence` is a non-negative safe integer and is the authoritative per-run
  order.
- `observedAt` is required UTC RFC 3339; `occurredAt` is optional and must never be
  invented by the schema.
- Client event and batch schemas do not accept organization IDs, server receipt
  timestamps, storage locations, verification flags, or database IDs.
- Started and finished operation payloads share explicit operation IDs.
- Outcomes and unavailable reasons are closed enums; unsupported values fail
  validation.
- Potentially sensitive text uses the explicit content-capture union and cannot
  appear as arbitrary unbounded metadata.
- Artifact SHA-256 values are lowercase 64-character hexadecimal strings and
  describe post-redaction bytes.
- Unknown properties and event kinds fail validation.
- Provider-native payloads are not accepted as arbitrary JSON fields.
- Test outcome is explicit and is not inferred from command exit status.
- Run completion describes process outcome, not quality, policy, or verification.
- Cost is not included in schema version 1.

## Suggested Module Shape

The exact internal file split may vary while preserving a small public API:

```text
packages/contracts/src/evidence/
  primitives.ts
  source.ts
  content.ts
  artifact.ts
  reference.ts
  events.ts
  batch.ts
  index.ts
```

Do not create a new workspace package for this task.

## Out of Scope

- Database or Prisma models and migrations.
- HTTP routes, authentication, or ingestion responses.
- Storage clients, object keys, signed URLs, or upload protocols.
- Canonical JSON serialization or server-computed content hashes.
- Codex OTel/hook adapters and provider mapping.
- Collector execution, Git capture, redaction logic, SQLite spooling, or retries.
- Projections, deterministic findings, policies, summaries, or dashboard UI.
- Export bundle schema beyond event, artifact, reference, and batch primitives.
- CloudEvents protocol compliance.

## Architecture Constraints

- Follow ADR-0001 and ADR-0002.
- Keep the contracts package independent of application and infrastructure code.
- Use Zod as the runtime source of truth and infer TypeScript types from schemas.
- Avoid `any`, arbitrary metadata records, framework request objects, storage
  clients, and database-specific types.
- Keep full event parsing deterministic and free of I/O.
- Preserve the existing `HealthResponseSchema` public export.

## Acceptance Criteria

- Every required event kind has a strict payload schema and inferred TypeScript
  type.
- A single exported `EvidenceEventSchema` parses the full discriminated union and
  narrows payload types from `kind`.
- A single exported `EvidenceBatchSchema` validates all required batch invariants.
- Artifact and evidence references validate identity, integrity, and locator
  syntax without exposing storage locations.
- Explicit omitted, unavailable, and captured content states are distinguishable.
- Unsupported schema versions, kinds, enum values, unknown properties, malformed
  UUIDs, timestamps, trace IDs, span IDs, hashes, negative values, unsafe integer
  values, oversized collections, duplicate IDs/sequences, and mismatched run IDs
  are rejected.
- Valid examples for all event kinds survive JSON serialization and reparsing.
- Existing health-contract consumers continue to build and test.
- No application behavior, dependencies, lockfile, database, HTTP, collector, or
  adapter code changes are introduced.
- Root format, lint, typecheck, test, and build commands pass.

## Required Tests

- At least one valid parse test for each event kind.
- Discriminated-union narrowing is proven by compile-time type checking or focused
  type-safe usage in tests.
- Strict rejection tests for unknown envelope and payload keys.
- Boundary tests for sequence, duration, counters, excerpt length, artifact byte
  length, and batch size.
- Invalid UUID, UTC timestamp, SHA-256, trace ID, span ID, JSON Pointer, enum, and
  schema-version tests.
- Content-capture tests for omitted, unavailable, and captured states.
- Batch tests for duplicate event IDs, duplicate sequence values, mismatched run
  IDs, empty batches, and batches over 500 events.
- JSON round-trip tests for representative events and a batch.
- Regression tests for the existing health contract.

## Validation Commands

```text
pnpm format:check
pnpm lint --force
pnpm typecheck --force
pnpm test --force
pnpm build --force
git diff --check
git status --short --untracked-files=all
```

## Deliverables

- Version 1 Zod evidence schemas and inferred TypeScript types.
- Public exports from `@blackbox/contracts`.
- Comprehensive contract tests.
- No unrelated changes.
- Completion report mapping acceptance criteria to files and test evidence.

## Referenced Documents

- [`AGENTS.md`](../../AGENTS.md)
- [v0.1 scope](../product/v0.1-scope.md)
- [Architecture overview](../architecture/overview.md)
- [Canonical Evidence Model](../architecture/evidence-model.md)
- [ADR-0001](../architecture/decisions/ADR-0001-modular-monolith.md)
- [ADR-0002](../architecture/decisions/ADR-0002-canonical-evidence-envelope.md)
- [Review guidelines](../review-guidelines.md)

## Risks

- Over-modeling provider details would make the canonical layer Codex-specific.
- Under-bounded content would create ingestion and secret-exposure risk.
- Type-level convenience can diverge from runtime validation if schemas are not
  the source of truth.
- Cross-event invariants cannot all be proven by parsing one batch; later
  persistence and analyzer tasks must enforce run-wide ownership and uniqueness.
- Strict versioning increases migration work but prevents silent reinterpretation
  of historical evidence.

## Open Questions

None after ADR-0002 is accepted. If implementation requires changing an event
kind, trust boundary, identity rule, ordering rule, or versioning rule, return the
task to architecture instead of improvising.

## Implementation Prompt

```text
Implement BBX-002 exactly as specified in docs/tasks/BBX-002-canonical-evidence-contracts.md.

Read AGENTS.md, the Canonical Evidence Model, ADR-0001, ADR-0002, and the review guidelines before editing. Implement only pure contracts and tests in @blackbox/contracts. Preserve the existing health contract and do not add infrastructure, application behavior, provider adapters, or dependencies unless the approved task is first amended.

Use strict Zod schemas as the runtime source of truth and infer TypeScript types. Run every required validation command with Turbo cache bypassed where specified. If a semantic rule is ambiguous or conflicts with the ADR, stop and report the exact issue instead of choosing a new protocol rule.

At completion, report acceptance-criteria status, changed files, exact validation results, deviations, and residual risks. Do not commit or push before independent review.
```

## Review Prompt

```text
Review BBX-002 against AGENTS.md, docs/tasks/BBX-002-canonical-evidence-contracts.md, the Canonical Evidence Model, and ADR-0002.

Do not modify files. Inspect the complete diff and independently exercise the contract boundaries. Prioritize evidence misattribution, ambiguous unavailable states, unsafe unbounded content, weak identifiers or hashes, broken discriminated-union narrowing, schema/version compatibility mistakes, batch idempotency gaps, unknown-key acceptance, provider or infrastructure coupling, and missing negative tests.

Report actionable findings first with priority, exact file/line, concrete invalid or misinterpreted payload, impact, and smallest safe correction. Then provide an acceptance-criteria matrix, commands executed, residual risks, and a verdict of PASS, PASS WITH FINDINGS, or REQUEST CHANGES.
```
