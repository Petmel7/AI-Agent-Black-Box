# BBX-010: Deterministic Findings

- **Status:** Approved
- **Owner:** Implementation Chat
- **Review:** Review Chat
- **Depends on:** BBX-009B completed at `63fcfa8b490f732de3b42730c035c36817225418`
- **Delivery risk:** High
- **Execution profile:** High
- **Risk triggers:** evidence integrity, durable migrations, tenant isolation, analyzer identity/versioning, at-least-once retries, concurrent projection publication, and false pass/review outcomes
- **Architecture:** Accepted ADR-0011; ADR-0001 through ADR-0010 remain unchanged

## Goal

Implement the first replayable deterministic findings catalog over current
`core` and verified `files` projections, with explicit uncertainty, immutable
evidence references, tenant-safe queries, and retry-safe worker orchestration.

## Context

Use ADR-0011 for finding semantics and identity, ADR-0010 for processing and
query consistency, and ADR-0008 for Git attribution. BBX-009A/B already provide
the trusted projection inputs. This task must not reinterpret raw provider data
or introduce configurable policy.

## In Scope

- A pure versioned `@blackbox/analyzers` package and V1 rule catalog.
- Durable findings projections, rule results, evidence references, processing
  state, migration constraints, replay, and application receipts.
- Findings execution after successful core/files processing on the existing
  queue lifecycle.
- Tenant-safe run-list/detail findings state and cursor-paged finding queries.
- Deterministic unit, PostgreSQL, real `pgmq`, concurrency, crash-window,
  replay, freshness, and worker-lifecycle coverage.

## Out of Scope

- Reading or interpreting Git patch text, test-report artifacts, prompts, or raw
  command output beyond existing redacted projections.
- Configurable YAML policies, accepted risk, suppression, merge blocking,
  remediation, or repository-specific rule configuration.
- LLM summaries, explanation generation, dashboard/HTTP routes, export, GitHub
  CI evidence, or BBX-011+ behavior.
- New canonical evidence event kinds, new queue infrastructure, or a new
  processing-intent kind.
- Causal agent-authorship claims, inferred test relevance, inferred tested-tree
  identity, or treating process exit success as an agent success claim.

## Required Changes

### Analyzer package and catalog

- Add `@blackbox/analyzers` with no framework, database, storage, network, clock,
  or randomness dependency.
- Define strict bounded input/output schemas, stable catalog/rule versions, safe
  reason codes, deterministic result/evidence ordering, and the identity formula
  from ADR-0011.
- Implement all nine V1 rule IDs in ADR-0011. Rules that cannot be supported by
  current evidence must return `unknown`; do not omit them or weaken their names.
- Use fixed versioned path classification for sensitive areas, production code,
  tests, lockfiles, and corresponding manifests. Normalize only separators and
  ASCII case for classification; retain the already-redacted display value.
- Apply aggregate precedence: proven match → `triggered`; otherwise incomplete
  evidence → `unknown`; otherwise `clear`. Mark triggered results `partial` when
  other relevant subjects remain unknown.
- Require evidence references for every triggered result. Enforce deterministic
  caps and explicit truncation rather than unbounded matches or references.

### V1 rule boundaries

- Sensitive-area evaluation covers fixed categories for authentication and
  authorization, payments, infrastructure/deployment, migrations, secret/config
  material, and dependency manifests.
- Production-without-test evaluation may clear only from a deterministic related
  test-file relation. A successful test observation without proven relevance
  makes the result `unknown`, not clear. No successful tests and no related test
  change may trigger it when production changes are otherwise complete.
- Repeated failed commands require at least two distinct command operations with
  the same available post-redaction command identity. Unavailable or conflicting
  command identity contributes uncertainty.
- Lockfile evaluation uses a documented fixed ecosystem map and never treats an
  unrelated manifest as correspondence.
- Test removal is triggered only by a recognized test-file deletion. A modified
  test file without patch semantics is `unknown` for weakening; rename is not
  removal.
- Tested-state timing, out-of-scope changes, and explicit success-claim rules
  remain `unknown` until their missing canonical evidence exists.
- `pre-existing` file changes do not trigger run-attributed rules.
  `mixed-or-uncertain` can support a temporal risk but must retain partial
  coverage and non-causal wording. Unavailable or display-ambiguous paths never
  become a conclusive clear result.

### Persistence and integrity

- Add current findings run, rule-result, and ordered evidence-reference models.
  Every tenant-owned relation includes organization and run ownership.
- Enforce one complete result for every catalog rule, valid outcome/coverage and
  severity combinations, bounded counts, unique stable result keys, ordered
  reference identity, and same-run event/artifact ownership with database
  constraints where practical.
- An event-only or event-plus-artifact reference is valid; a projection-only
  reference is not. File references retain source event, file-list artifact,
  ordinal, opaque entry ID, and validated artifact pointer.
- Explanations are deterministic bounded templates over safe/redacted values.
  Never persist raw paths, credentials, authorization data, prompts, or newly
  extracted command content.
- Findings remain replaceable derived projections. Raw batches, events,
  declarations, uploads, core rows, and file rows are not mutated by analysis.

### Processing and replay

- Reuse the existing processing state, lease/deadline, failure, receipt, retry,
  visibility, poison, and shutdown guarantees for projector `findings` version 1.
- After core or files returns `applied` or `already_applied`, process findings
  before archiving that exact queue message. A crash at either boundary must
  converge on redelivery without duplicate results or references.
- Build the dependency fingerprint from catalog version and exact core/files
  versions, fingerprints, and completeness markers under the shared run-source
  lock. Recheck it at publication.
- Publish the complete findings snapshot, references, processing state, and
  receipt atomically. Concurrent intents for one run must converge on the newest
  dependency fingerprint without stale-owner publication.
- Stale core is retryable and cannot publish. Missing/stale/incomplete files may
  publish explicit `unknown` results, and a later files intent must replace them.
- Provide an injected bounded replay operation. Exact replay is
  `already_applied`; changed source or analyzer version rebuilds safely.

### Query boundary

- Extend framework-independent run list/detail queries with findings processing
  freshness, deterministic outcome, coverage, and conservative severity/unknown
  counts while preserving existing processing and agent outcome fields.
- Add tenant-scoped stable cursor pagination for rule results and their ordered
  evidence references. Cross-tenant lookup must not disclose existence.
- Use one repeatable-read snapshot for run/detail/findings views and recompute
  currentness against both dependency projections; never expose a partially
  replaced catalog.

## Acceptance Criteria

- All nine ADR-0011 rules exist with stable ID/version, deterministic severity,
  safe explanation, and `triggered`, `clear`, or `unknown` behavior.
- Missing, stale, ambiguous, or insufficient evidence never produces `pass`.
- Triggered findings have concrete immutable evidence references and never rely
  solely on projection row IDs.
- Repeated, concurrent, late-source, and crash-window processing converges to one
  complete current catalog for the newest fingerprint.
- Analyzer/version changes and exact replay have explicit non-destructive
  semantics; raw evidence and upstream projections remain unchanged.
- Tenant ownership and same-run evidence constraints survive application bugs.
- Queries distinguish processing failure, evidence incompleteness, observed run
  outcome, and deterministic `pass`, `review`, or `unknown`.
- The existing queue payload and infrastructure remain unchanged.
- No configurable policy, LLM, UI, HTTP, GitHub, export, or BBX-011+ behavior is
  introduced.

## Required Tests

- Pure table-driven tests for every rule: trigger, clear, unknown, partial
  coverage, deterministic ordering, identity, caps, truncation, and input
  permutation.
- Negative tests for ambiguous/redacted/unavailable paths, pre-existing versus
  mixed attribution, unsupported command identity, lockfile ecosystem mismatch,
  test rename versus deletion, and absence of claim/scope/tested-tree evidence.
- Fresh PostgreSQL migration and constraints, tenant isolation, evidence-reference
  ownership, atomic replacement, exact replay, version/fingerprint change,
  stale-owner rejection, late lower-sequence inputs, and snapshot-consistent
  pagination.
- Concurrent core/files/findings interleavings and fault injection before
  publication, after dependency publication, after findings commit, and before
  queue archive.
- Real `pgmq` duplicate delivery, visibility retry, poison convergence, receipt
  idempotency, and queue archive behavior with the unchanged opaque payload.
- Worker startup, configuration ordering, deadlines, cancellation, and bounded
  in-flight shutdown.

## Validation

Run focused checks while editing, then on the final state:

```text
pnpm install --frozen-lockfile
pnpm --filter @blackbox/database run db:generate
pnpm --filter @blackbox/database run db:validate
pnpm format:check
pnpm lint --force
pnpm typecheck --force
pnpm test --force
pnpm build --force
git diff --check
git status --short --untracked-files=all
```

Using the CI-pinned PostgreSQL 16/PGMQ service on an explicitly authorized
isolated non-5432 database, deploy every migration from empty state, provision
the queue twice, and run the complete PostgreSQL and real-PGMQ suites. Do not
start Docker, use a database, install dependencies, or access a network without
the applicable authorization.

## Deliverables

- Accepted ADR-0011 implementation.
- `@blackbox/analyzers` V1 catalog with fixtures and documentation.
- Database migration, findings processor/replay, worker orchestration, and
  tenant-safe query functions.
- Focused, high-risk integration, queue, and lifecycle tests plus operations
  documentation for replay and safe failure states.

## References

- `docs/product/v0.1-scope.md`
- `docs/architecture/v0.1-delivery-sequence.md`
- `docs/architecture/decisions/ADR-0008-local-git-evidence-and-attribution.md`
- `docs/architecture/decisions/ADR-0010-replayable-projections-and-processing-state.md`
- `docs/architecture/decisions/ADR-0011-versioned-deterministic-findings.md`
- `docs/review-guidelines.md`

## Risks

- Path heuristics can overstate semantic relation; V1 uses fixed classifiers and
  `unknown` instead of inferred relevance.
- Concurrent projection changes can publish stale findings; the shared run lock,
  dependency fingerprint, receipt, and final freshness check mitigate this.
- Unbounded matches could create storage or UI pressure; aggregate results and
  deterministic caps bound the catalog.
- New rules may be mistaken for policy decisions; task naming, query fields, and
  non-configurable outcomes keep analysis separate from policy.

## Open Questions

None.

## Implementation Prompt

```text
$bbx-implement docs/tasks/BBX-010-deterministic-findings.md
Implement the Approved task and Accepted ADR-0011 against the committed baseline. Preserve raw evidence and upstream projections, use the unchanged private queue payload, run the required high-risk validation, and stop uncommitted for independent review.
```

## Review Prompt

```text
$bbx-review docs/tasks/BBX-010-deterministic-findings.md
Independently review the complete diff against its committed baseline. Verify rule semantics and unknown outcomes, immutable evidence references, tenant constraints, source-fingerprint freshness, replay/concurrency/crash convergence, queue orchestration, and the complete high-risk validation. Do not edit or finalize.
```
