# ADR-0012: Versioned Evidence-Backed Summaries

- **Status:** Accepted
- **Date:** 2026-10-13
- **Decision owners:** Project architecture

## Context

BBX-010 publishes a complete current deterministic findings catalog with
validated evidence references, but it does not provide the concise run-level
account required by the v0.1 product journey. A summary must remain useful when
evidence is incomplete, must not turn a successful process exit or passing test
into a correctness claim, and must preserve navigation to the facts or findings
that support each material statement.

This decision introduces a new durable derived projection, claim identity,
support relationships, replay semantics, and an additional queue-message
completion gate. It changes consistency and evidence-integrity guarantees and
therefore meets the ADR criteria in `docs/architecture/overview.md`.

## Decision

### Deterministic structured summary for v0.1

Create a pure versioned `@blackbox/summaries` package. It accepts one bounded
typed snapshot assembled from current `core`, `files`, and `findings`
projections and returns a deterministic structured summary. It performs no I/O,
uses no clock or randomness, reads no provider-native payload or artifact bytes,
and cannot mutate raw evidence or upstream projections.

The first summary version is template-driven and does not call an LLM or another
model provider. This still satisfies the v0.1 evidence-backed-summary outcome:
it produces concise, ordered claims while keeping claim meaning, omissions, and
support selection reproducible. Model-generated narrative, prompt versioning,
model provenance, and provider privacy policy require a later explicit decision.

The summary generator, output format, and template catalog have explicit integer
versions. Changing claim meaning, ordering, support selection, safe wording, or
truncation requires the applicable version bump and replay.

### Claim classes and conservative meaning

The structured summary contains bounded ordered sections and claims. Every
claim is exactly one of:

- `observation`: a fact directly represented by immutable canonical evidence,
  such as an observed child outcome or explicit test result;
- `deterministic_assessment`: a statement derived from one current versioned
  deterministic finding;
- `limitation`: an explicit statement that a conclusion is unavailable because
  evidence or deterministic coverage is incomplete.

V1 emits no free-form model inference. Claim class is durable and visible so a
future inference class cannot be confused with observations or deterministic
analysis.

Summary wording is selected from bounded safe templates over already-redacted
values and bounded numeric aggregates. It must not claim causality, task
completion, correctness, test relevance, merge safety, or policy approval
unless a future canonical contract proves that meaning. A deterministic `pass`
means only that the current findings catalog is fully clear; it does not mean
the code is correct.

Unsupported positive claims are omitted. Missing, stale, ambiguous, or
insufficient evidence is represented by a limitation claim and an `unknown`
summary outcome rather than optimistic language. The run-level summary outcome
is `review`, `pass`, or `unknown` and mirrors the current deterministic findings
outcome; processing state and observed process outcome remain separate.

### Material claims require typed support

Every persisted claim is material and has at least one ordered typed support:

- an immutable evidence event, optionally with its declared artifact and
  validated RFC 6901 pointer; or
- one exact current finding result, including its stable result key, rule
  identity/version, and findings source fingerprint.

Evidence support uses the same tenant, run, artifact-declaration, and pointer
integrity guarantees as deterministic findings. A finding support must resolve
to the current complete findings snapshot for the same organization and run.
Mutable core/file projection rows are never sole support targets.

Observation claims terminate at immutable evidence. Deterministic assessments
and limitations may reference findings; triggered finding navigation continues
from the finding to its immutable evidence. Support count, claim count, text,
sections, and safe parameters are bounded with explicit deterministic
truncation.

### Identity and atomic invalidation

The summary key is an organization-scoped deterministic SHA-256 value over the
canonical run identity, generator/format/template versions, and exact source
fingerprint. Claim keys are deterministically derived from that summary key and
stable claim identity. Exact replay converges to identical keys; changed input
or versions produce a new snapshot identity.

Persist one current summary run projection with ordered claims and ordered
supports. Summary rows are replaceable derived state. Raw evidence, artifacts,
core/files projections, and findings are not rewritten by summary generation.

Finding replacement atomically invalidates the prior summary before replacing
the finding rows it references. Readers therefore see a complete compatible old
summary, no current summary while rebuilding, or a complete compatible new
summary—never claims that point at a partially replaced or incompatible
findings catalog.

### Replayable processing and queue ordering

The summary source fingerprint covers generator/format/template versions and
the exact current core, files, and findings projector versions, fingerprints,
completeness markers, and findings catalog/analyzer versions. Publication takes
the shared run-source lock, rechecks all dependencies, and atomically replaces
the complete summary, claims, supports, processing state, and application
receipt.

Reuse ADR-0010 processing state, leases, deadlines, failures, receipts, retry,
visibility, poison, cancellation, and shutdown guarantees for projector
`summary` version 1. Exact replay is `already_applied`; changed source or summary
version rebuilds safely. Stale core or stale findings cannot publish a summary.
Current incomplete evidence and `unknown` findings publish a conservative
summary with explicit limitations.

The existing `bbx_processing_v1` queue and opaque
`{ schemaVersion, intentId }` payload remain unchanged. For supported core or
file work, the worker executes:

```text
core/files → findings → summary → archive exact queue message
```

Summary processing is mandatory in production dispatch. A crash after findings
publication or summary publication but before archive converges on redelivery
through projector receipts. No new queue or processing-intent kind is added.

### Query boundary

Framework-independent tenant-scoped queries expose summary processing
freshness, outcome, format/generator versions, bounded section/claim counts,
truncation, and stable cursor-paged claims with ordered supports. Run list,
detail, findings, and summary reads use one repeatable-read snapshot and
recompute freshness against current upstream projections.

HTTP routes, dashboard rendering, export format, and signed evidence navigation
remain later tasks.

## Consequences

### Positive

- Summary claims are reproducible, reviewable, and linked to concrete support.
- Missing evidence produces visible limitations instead of plausible prose.
- Exact replay and upstream changes have explicit atomic semantics.
- v0.1 gains a useful summary without adding model cost, privacy exposure, or
  nondeterministic provider behavior.
- The dashboard can later render claims without inventing presentation facts.

### Negative

- Template-driven prose is less flexible than an LLM-generated narrative.
- Summary adds another durable projection lifecycle and archive gate.
- Hard finding-support integrity requires coordinated summary invalidation when
  findings are replaced.
- More derived state increases migration and concurrency-test surface.

## Alternatives Considered

### Generate an LLM narrative in v0.1

Rejected because it would introduce provider/network dependencies, prompt and
model provenance, nondeterministic replay, privacy review, and unsupported-claim
validation before the deterministic product path is proven.

### Store one unstructured Markdown summary

Rejected because material claims, claim classes, support integrity, truncation,
and stable evidence navigation could not be enforced reliably.

### Build summary text only at query time

Rejected because versioned replay, processing failure, auditability, and exact
source compatibility would be implicit rather than durable and testable.

### Reference only mutable projection rows

Rejected because replacement could leave unverifiable or misleading claims.
Observations terminate at immutable evidence, while assessments reference the
exact compatible findings snapshot.

### Add a dedicated summary queue

Rejected because the existing intent lifecycle already triggers processing
after every relevant core/files update and provides the required at-least-once
recovery boundary.

## Follow-up

- BBX-011 implements this decision.
- BBX-012 renders the structured summary and evidence navigation in the run
  dashboard without changing claim semantics.
- BBX-013 includes the versioned summary and support graph in the export bundle.
- Any future model-generated narrative requires a separate decision for model
  provenance, privacy, prompt/version identity, unsupported-claim handling, and
  replay semantics.

## References

- [v0.1 product scope](../../product/v0.1-scope.md)
- [Architecture overview](../overview.md)
- [v0.1 delivery sequence](../v0.1-delivery-sequence.md)
- [ADR-0010](ADR-0010-replayable-projections-and-processing-state.md)
- [ADR-0011](ADR-0011-versioned-deterministic-findings.md)
