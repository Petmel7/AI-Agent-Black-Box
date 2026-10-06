# ADR-0011: Versioned Deterministic Findings

- **Status:** Accepted
- **Date:** 2026-10-06
- **Decision owners:** Project architecture

## Context

BBX-009 publishes replayable `core` and `files` projections, but it deliberately
does not interpret those facts as code-quality findings. BBX-010 must introduce
stable rule identity, explicit uncertainty, evidence navigation, retry-safe
publication, and analyzer versioning without turning missing evidence into a
pass or confusing processing failure with run quality.

This decision adds durable derived records and defines new consistency,
idempotency, and evidence-integrity guarantees. It therefore meets the ADR
criteria in `docs/architecture/overview.md`.

## Decision

### Pure versioned analyzer

Create `@blackbox/analyzers` as a framework- and database-independent package.
It accepts a bounded typed snapshot assembled from current `core` and `files`
projections and returns deterministic rule evaluations. It performs no I/O,
reads no provider-native payload, uses no clock or randomness, and cannot write
raw evidence.

The analyzer has a stable name and integer version. Every rule has a stable
identifier and integer version. Changing rule meaning, severity, path
classification, subject identity, or evidence selection requires the relevant
version bump and replay. Catalog order and output order are deterministic.

### Result semantics

Each catalog rule produces exactly one aggregate evaluation per run:

- `triggered`: at least one supported risk condition is proven;
- `clear`: the required evidence is complete and no condition is present;
- `unknown`: no condition is proven and required evidence is unavailable,
  stale, ambiguous, or semantically insufficient.

Every result also reports `complete` or `partial` coverage. A proven condition
remains `triggered` when other subjects are unknown, but its coverage is
`partial`. `clear` requires complete coverage. Numeric confidence is not used;
uncertainty is represented only through outcome, coverage, and stable reason
codes.

Severity is the versioned catalog value `low`, `medium`, `high`, or `critical`.
It describes deterministic review priority, not code-review priority, agent
outcome, policy, or merge authority. V1 produces no configurable verdict and no
`critical` rule.

The run-level deterministic outcome is:

- `review` when at least one rule is triggered;
- `pass` only when every rule is clear with complete coverage;
- `unknown` otherwise.

Processing state, agent/process outcome, evidence completeness, and this
deterministic outcome remain separate fields.

### V1 rule catalog

| Stable rule ID                                | Severity | V1 evidence behavior                                                                                                                          |
| --------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `bbx.sensitive-area-change`                   | high     | Classifies redacted file paths using a fixed versioned category catalog.                                                                      |
| `bbx.production-change-without-test-evidence` | high     | Uses deterministic production/test path classification and explicit test observations without claiming semantic relevance that is not proven. |
| `bbx.tests-not-after-last-code-change`        | high     | Returns `unknown` until evidence links a code-change state to test execution time. Event arrival order alone is insufficient.                 |
| `bbx.final-tree-differs-from-tested-state`    | high     | Returns `unknown` until a tested Git state is explicitly linked to the test observation.                                                      |
| `bbx.repeated-failed-command`                 | medium   | Detects at least two distinct failed command operations with the same available post-redaction command identity.                              |
| `bbx.lockfile-without-manifest`               | medium   | Uses a fixed versioned lockfile-to-manifest map over supported unambiguous file paths.                                                        |
| `bbx.test-removal-or-weakening`               | high     | Proves recognized test-file deletion; a content modification without diff semantics is `unknown`, not weakening.                              |
| `bbx.out-of-scope-change`                     | high     | Returns `unknown` until canonical declared-scope evidence exists.                                                                             |
| `bbx.success-claim-without-test-evidence`     | high     | Returns `unknown` until an explicit success-claim contract exists. Process exit success is not such a claim.                                  |

Rules consume Git attribution exactly as defined by ADR-0008. `pre-existing`
entries are not attributed to the run. `mixed-or-uncertain`, unavailable,
redacted, or display-ambiguous paths preserve uncertainty and never become a
causal claim.

### Stable identity and evidence references

The result key is a deterministic SHA-256 value derived from the canonical run
identity, analyzer name/version, and rule identifier/version. Exact replay
therefore converges to the same identity. V1 permits at most one result per rule
and run.

Triggered results require at least one ordered evidence reference. References
must belong to the same organization and run and terminate at immutable
canonical evidence:

- an evidence event; or
- an evidence event plus its declared artifact and a validated RFC 6901 pointer
  into the verified artifact representation.

A mutable projection row is never the sole evidence target. File references
retain the source event, artifact declaration, file ordinal, and opaque entry
identity. Explanations use bounded safe templates and already-redacted display
values. Reference count, explanation parameters, subjects, and matches are
bounded; deterministic truncation is explicit.

### Replayable publication

Persist a current findings run projection, one result per catalog rule, and
ordered evidence references. These are replaceable derived projections; raw
events and artifacts remain immutable.

The findings source fingerprint covers the analyzer/catalog version and the
exact `core` and `files` dependency versions, fingerprints, and completeness
markers. Publication takes the shared run-source lock, rechecks dependency
freshness, and atomically replaces the complete findings snapshot, evidence
references, processing state, and application receipt. Readers see the prior
complete snapshot or the new complete snapshot, never a partial mix.

The existing `bbx_processing_v1` queue and opaque `{ schemaVersion, intentId }`
payload remain unchanged. After a core or files intent is applied or found
already applied, the worker evaluates findings before archiving that message.
A crash between dependency publication and findings publication leaves the
message retryable; duplicate delivery converges through projector receipts.
Busy, retry, poison, lease, deadline, and shutdown behavior follows ADR-0010.
No new queue or processing-intent kind is introduced.

Missing or stale optional file projections produce current `unknown` rule
results when core evidence is current. A later verified file projection triggers
replacement through its existing artifact intent. Stale core evidence never
produces a new findings snapshot.

### Query boundary

Framework-independent tenant-scoped queries expose findings freshness,
deterministic outcome, coverage, severity counts, unknown reasons, stable
cursor-paged rule results, and ordered evidence references. Run list/detail and
finding-detail reads use one repeatable-read snapshot. HTTP routes and UI remain
later work.

## Consequences

### Positive

- Missing or ambiguous evidence cannot silently become `PASS`.
- Exact replay is deterministic and duplicate queue delivery is harmless.
- Findings navigate to immutable evidence even when projections rebuild.
- Rule changes are explicit version changes rather than silent reinterpretation.
- The first catalog is useful without overstating causality or test relevance.

### Negative

- Several required v0.1 rules remain honestly `unknown` until richer canonical
  scope, claim, diff-semantic, or tested-state evidence exists.
- Aggregate per-rule findings are less granular than one finding per file, but
  bound storage and identity for the first product slice.
- Findings add another projection lifecycle and queue-message completion gate.

## Alternatives Considered

### Emit only triggered findings

Rejected because absence of a row cannot distinguish clear evidence from
missing evidence.

### Use numeric confidence

Rejected because the rules are deterministic and v0.1 has no calibrated model
for probabilistic confidence.

### Infer test timing or task scope from prompts and event order

Rejected because those sources do not prove the tested tree or declared scope.

### Create a dedicated findings queue

Rejected because the existing intent lifecycle already provides an at-least-once
trigger after every relevant core or files update.

## Follow-up

- BBX-010 implements this decision and the V1 catalog.
- BBX-011 may summarize only current findings and their evidence references.
- A later policy task may add repository-owned configuration, accepted risk,
  blocking decisions, and configurable severity without rewriting V1 evidence.

## References

- [v0.1 product scope](../../product/v0.1-scope.md)
- [Architecture overview](../overview.md)
- [v0.1 delivery sequence](../v0.1-delivery-sequence.md)
- [ADR-0008](ADR-0008-local-git-evidence-and-attribution.md)
- [ADR-0010](ADR-0010-replayable-projections-and-processing-state.md)
