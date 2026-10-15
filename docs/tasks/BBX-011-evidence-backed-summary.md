# BBX-011: Evidence-Backed Summary

- **Status:** Done
- **Owner:** Implementation Chat
- **Review:** Review Chat
- **Depends on:** BBX-010 completed at `c7fff7abac306b94c11407859be4affd0bbca42c`
- **Delivery risk:** High
- **Execution profile:** High
- **Risk triggers:** evidence integrity, durable migrations, tenant isolation,
  summary/finding identity, at-least-once retries, concurrent projection
  publication, claim wording, and false pass/completion implications
- **Architecture:** Accepted ADR-0012; ADR-0001 through ADR-0011 remain unchanged

## Goal

Implement a replayable structured v0.1 summary whose material claims are
classified, conservatively worded, and linked to immutable evidence or the exact
current deterministic findings that support them.

## Context

Use ADR-0010 for projection/queue guarantees, ADR-0011 for deterministic outcome
and evidence references, and proposed ADR-0012 for summary semantics. BBX-010
provides the first trustworthy findings boundary. BBX-011 must not add UI or use
a model provider to fill gaps in evidence.

## In Scope

- A pure versioned `@blackbox/summaries` package and deterministic V1 template
  catalog.
- Structured observation, deterministic-assessment, and limitation claims.
- Durable summary projection, ordered claims, typed supports, processing state,
  replay, and application receipts.
- Mandatory worker ordering from findings through summary before queue archive.
- Tenant-safe summary freshness and cursor-paged query functions.
- Unit, PostgreSQL, real-`pgmq`, concurrency, crash-window, replay, and worker
  lifecycle coverage.

## Out of Scope

- LLM/model calls, free-form generated narrative, prompts, model provenance,
  embeddings, confidence scores, or hidden reasoning.
- Dashboard/HTTP routes, export bundles, GitHub/PR behavior, notifications, or
  signed artifact-download UI.
- Configurable policy, accepted risk, suppression, merge blocking, remediation,
  or repository-specific summary templates.
- New canonical event kinds, a new queue, or a new processing-intent kind.
- New interpretation of raw provider payloads or direct artifact-byte reads.
- Claims that the agent completed the task, tests prove correctness, code is
  merge-safe, or the agent caused a Git change without canonical proof.

## Architecture Constraints

- Accept ADR-0012 before implementation. Do not silently replace its structured
  deterministic summary with model-generated prose.
- Consume only current compatible `core`, `files`, and `findings` projections;
  never provider-native payloads.
- Preserve raw evidence and every upstream projection.
- Keep processing state, observed child outcome, deterministic outcome, and
  summary availability separate.
- Every persisted claim is material and must have typed ordered support.
- Observation support terminates at immutable canonical evidence. Finding
  support resolves to the exact current same-tenant, same-run result and source
  fingerprint.
- Use bounded safe templates and already-redacted values only. Never persist raw
  paths, prompts, credentials, authorization data, or command output.

## Required Changes

### Pure summary package

- Add `@blackbox/summaries` with no framework, database, storage, network,
  filesystem, clock, or randomness dependency.
- Define strict bounded input/output schemas; stable generator, format, template,
  section, and claim identities; deterministic ordering; caps; and explicit
  truncation.
- Produce only `observation`, `deterministic_assessment`, and `limitation`
  claims. V1 must not emit an inference or accept free-form generated text.
- Cover at least observed run outcome, Git-change availability/counts, explicit
  test observations, deterministic findings, and evidence/coverage limitations
  without claiming causality, task completion, correctness, or policy approval.
- Set summary outcome to `review`, `pass`, or `unknown` from the exact current
  deterministic findings outcome. `pass` wording must state its bounded meaning.
- Omit unsupported positive claims and emit deterministic limitations for
  missing, stale, ambiguous, or incomplete required evidence.

### Durable identity and support integrity

- Add one current summary run projection, ordered claims, and ordered typed
  supports with organization/run ownership on every tenant-owned relation.
- Derive organization-scoped summary and claim keys according to ADR-0012.
- Enforce version/range/count/text bounds, valid claim-class/support-kind
  combinations, unique ordering/identity, and complete snapshot ownership with
  database constraints where practical.
- Reuse exact event/artifact/pointer integrity for evidence supports. Finding
  supports must match the same organization/run and current findings result key,
  rule identity/version, and findings source fingerprint.
- Require at least one support for every claim. Mutable core/file projection IDs
  are not valid sole support.
- Atomically invalidate the current summary before findings replacement can
  delete or change rows referenced by it. Never expose a partially invalidated
  summary/support graph.

### Processing and replay

- Add projector `summary` version 1 using ADR-0010 lease, deadline, failure,
  receipt, retry, visibility, poison, cancellation, and shutdown behavior.
- Build the source fingerprint from summary versions and exact current core,
  files, and findings versions, fingerprints, completeness, and analyzer/catalog
  identity under the shared run-source lock; recheck before publication.
- Publish the complete summary, claims, supports, processing state, and receipt
  atomically. Concurrent or late intents must converge to the newest compatible
  fingerprint without stale-owner publication.
- Exact replay returns `already_applied`; source or version changes rebuild
  safely. Stale core/findings cannot publish. Current incomplete evidence may
  publish an `unknown` summary with explicit limitation claims.
- Make summary configuration and processing mandatory for supported production
  dispatch. Process `core/files → findings → summary` before archiving the exact
  unchanged queue message.
- Preserve archive-window, duplicate-delivery, failure recovery, poison, and
  bounded shutdown behavior. Do not add a queue or intent kind.

### Query boundary

- Extend framework-independent tenant-scoped run-list/detail queries with
  summary processing freshness, outcome, versions, bounded claim counts, and
  truncation without conflating them with findings or child outcome.
- Add stable cursor pagination for ordered summary claims and supports.
- Use one repeatable-read snapshot for run/detail/findings/summary reads and
  recompute currentness against all dependency projections.
- Cross-tenant lookups must not disclose existence. HTTP and UI remain excluded.

### Documentation and operations

- Document exact replay, changed-source/version rebuild, stale/failed states,
  claim classes, bounded `pass` meaning, and safe operational recovery.
- Update worker configuration examples without exposing credentials or weakening
  the existing queue/database authorization boundary.

## Acceptance Criteria

- Identical current inputs produce byte-equivalent ordered output and identical
  summary/claim keys across input permutations and replay.
- Every claim has the correct class and at least one valid ordered support;
  unsupported claims, dangling findings, partial pointer shapes, and cross-run or
  cross-tenant supports are rejected.
- Observation claims terminate at immutable evidence; deterministic assessments
  and limitations resolve to the exact compatible findings snapshot.
- Missing/incomplete evidence produces `unknown` plus visible limitations and
  never optimistic completion/correctness language.
- `pass` is emitted only for a current fully clear findings catalog and is worded
  as a bounded deterministic result, not merge or correctness approval.
- Finding replacement invalidates the prior summary atomically; queries never
  expose incompatible or partially replaced claims.
- Repeated, concurrent, late-source, replay, crash-window, and poison scenarios
  converge to one complete current summary for the newest fingerprint.
- The existing queue payload/infrastructure and upstream evidence/projections
  remain unchanged.
- No LLM, UI, HTTP, export, policy, GitHub, new event, queue, or intent-kind
  behavior is introduced.

## Required Tests

- Pure table-driven tests for every V1 claim class and section: ordering,
  identity, safe wording, caps, truncation, input permutation, and outcome.
- Negative pure tests for missing/stale/ambiguous evidence, failed or incomplete
  processing, unknown findings, redacted values, unsupported positive claims,
  and forbidden completion/correctness/causality wording.
- Fresh PostgreSQL migration and direct constraint tests for all support shapes,
  ownership, exact finding compatibility, dangling/partial references, required
  support, complete-catalog replacement, and atomic invalidation.
- Exact replay, generator/template/source changes, later valid intents,
  stale-owner rejection, late lower-sequence inputs, concurrent upstream
  replacement, and repeatable-read pagination.
- Fault injection before summary publication, after findings commit, after
  summary commit, and before queue archive.
- Real `pgmq` duplicate delivery, visibility retry, poison convergence, receipt
  idempotency, and exact-message archive only after summary success.
- Worker configuration ordering, deadlines, cancellation, and bounded in-flight
  shutdown with summary processing mandatory.

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
git diff --check
git status --short --untracked-files=all
```

Using the CI-pinned PostgreSQL 16/PGMQ service on an explicitly authorized
isolated non-5432 database, deploy every migration from empty state, provision
the queue twice, and run the complete PostgreSQL and real-PGMQ suites. Do not
start Docker, use a database, install dependencies, or access a network without
the applicable authorization.

## Deliverables

- Accepted ADR-0012 implementation.
- Pure versioned `@blackbox/summaries` package with fixtures/documentation.
- Database migration, summary processor/replay, worker archive gate, and
  tenant-safe query functions.
- Focused high-risk integration, queue, concurrency, crash-window, and lifecycle
  tests plus operations documentation.

## Referenced Decisions and Documents

- `docs/product/v0.1-scope.md`
- `docs/architecture/overview.md`
- `docs/architecture/v0.1-delivery-sequence.md`
- `docs/architecture/decisions/ADR-0010-replayable-projections-and-processing-state.md`
- `docs/architecture/decisions/ADR-0011-versioned-deterministic-findings.md`
- `docs/architecture/decisions/ADR-0012-versioned-evidence-backed-summaries.md`
- `docs/review-guidelines.md`

## Risks

- Summary wording can overstate evidence; fixed claim classes, safe templates,
  forbidden-language tests, and explicit limitations mitigate this.
- Findings replacement can leave dangling or mismatched support; atomic
  invalidation and same-snapshot constraints mitigate it.
- Another projection gate increases retry and poison complexity; the existing
  ADR-0010 lifecycle and real-PGMQ crash tests remain mandatory.
- Template output may feel less fluent than generated prose, but it is auditable
  and avoids adding an unproven model/provider boundary to v0.1.

## Open Questions

None.
