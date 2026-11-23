# BBX-013B: v0.1 End-to-End Hardening

- **Status:** Proposed
- **Owner:** Implementation Chat
- **Review:** Review Chat
- **Depends on:** BBX-013A completed at a committed reviewed baseline
- **Delivery risk:** High
- **Execution profile:** High
- **Risk triggers:** cross-process lifecycle, restart recovery, local durability,
  artifact integrity, idempotency, duplicate delivery, queue processing,
  PostgreSQL/PGMQ/storage infrastructure, browser authentication, export
  integrity, secret handling, and exact cleanup ownership
- **Architecture:** Accepted ADR-0014; accepted ADR-0001 through ADR-0013 remain
  unchanged

## Goal

Prove the complete supported v0.1 journey from a locally spooled Codex-compatible
run through upload-failure restart recovery, duplicate-free ingestion,
processing, private review, and independently validated Export V1 output.

## Context

Earlier tasks test each boundary independently. BBX-013A adds the last product
surface, Export V1. The remaining delivery risk is whether the accepted
contracts compose under real process, retry, database, queue, storage, Web, and
browser lifecycles without identity drift, duplicate evidence, secret leakage,
or unowned resources.

## In Scope

- One deterministic full-system acceptance harness over production entrypoints
  and supported public boundaries.
- A controlled first artifact-upload failure, collector process restart, and
  explicit bounded retry from the same retained SQLite spool.
- Intentional identical batch/artifact delivery replay and exact duplicate-free
  database assertions.
- Real relay/worker processing through current core, files, findings, and
  summary projections.
- Authenticated production Web review and Export V1 download/independent parse.
- Cross-process readiness, deadlines, output ownership, sanitized diagnostics,
  failure propagation, and exact cleanup for the new full-system harness.
- Only narrow product fixes required to satisfy already accepted contracts.

## Out of Scope

- New product semantics, export format changes, new events, new queues, new
  processing intents, schema redesign, alternate agent adapters, or additional
  dashboard features.
- Automatic deletion/retention of acknowledged spool data, background collector
  daemon, byte-resume credential persistence, or silent retry loops.
- Real external Codex, Supabase cloud, public internet, GitHub/PR/CI product
  integration, compliance/SIEM export, accounts/RBAC/SSO, policy, or LLM calls.
- Replacing accepted process-ownership architecture merely to make a test pass.
- Broad flake suppression, arbitrary sleeps, retries that hide first failure,
  timeout inflation without phase evidence, or process/prefix/shared-root cleanup.

## Architecture Constraints

- Implement only after BBX-013A is Done and ADR-0014 is Accepted.
- Exercise production CLI, ingestion, database/queue, worker, Web launcher,
  dashboard authentication, and export parser boundaries. Fixtures may replace
  only external Codex, object-storage, and trusted-proxy behavior at explicit
  existing ports.
- Use a fresh isolated PostgreSQL 16/PGMQ database and test-owned storage
  fixture. Never access a developer/shared database, default PostgreSQL port, or
  production credential.
- Create one high-entropy run identity and exact test-owned directories, ports,
  credentials, container, and process records. Cleanup targets only those exact
  validated resources.
- Preserve the wrapped child outcome when delivery fails. Restart uses a fresh
  collector process and the original spool; it does not rewrite IDs or payloads.
- The duplicate proof resends identical persisted bytes/identities through the
  real idempotency boundary. It must not insert duplicate rows directly.
- Wait on observable bounded state transitions, not arbitrary sleeps. Every
  phase has one absolute deadline with cleanup reserve and sanitized progress.
- Production defects may be fixed only within accepted contracts and with
  focused mutation/regression proof. If success requires a new trust/process
  boundary, schema meaning, export version, dependency, or ADR change, stop and
  return to architecture.
- Do not weaken BBX-012C delegated Playwright ownership or broaden repository
  cleanup authority. The top-level harness owns only its direct processes and
  exact resources; Playwright/CI retains browser-descendant ownership.

## Required Changes

### Deterministic journey fixture

- Provide a minimal Codex-compatible JSONL child that generates a real supported
  wrapped run with canonical command/test/usage and Git before/after evidence.
- Create a temporary Git repository and deterministic changed files without
  modifying the project checkout.
- Use content containing safe secret/XSS/path sentinels to prove local redaction,
  inert rendering, and export exclusion.
- Use the real CLI configuration/composition and retained SQLite spool. Do not
  build database fixtures that bypass collector or ingestion for the primary
  run.

### Failure, restart, and duplicate proof

- Make the first authorized artifact transfer fail after durable local capture
  and before server verification, then let the original collector process exit.
- Assert the wrapped outcome remains primary, the spool retains pending work,
  no credential/capability is persisted, and the backend has no falsely verified
  artifact.
- Start a fresh CLI process over the same spool and run one bounded explicit
  retry against healthy ingestion/storage fixtures.
- Capture the exact accepted batch body and artifact identity, replay them
  through the real server boundaries, and assert accepted/already-accepted or
  verified idempotent results without conflicts.
- Assert exact canonical run, event, sequence, batch receipt, artifact
  declaration/upload, processing-intent, and application-receipt counts before
  and after duplicate delivery.

### Processing and review proof

- Run the real relay and worker against PGMQ until the exact run reaches current
  compatible core, files, findings, and summary state and the exact queue
  message is archived.
- Assert projector versions/fingerprints, receipt idempotency, artifact hash and
  file-list integrity, finding references, summary support graph, and explicit
  presentation state.
- Start the production Web build/launcher with isolated dashboard/proxy/cursor
  credentials and test-owned loopback listeners.
- Through Chromium, authenticate at the real proxy boundary, find the exact run,
  inspect its independent states, follow representative finding/summary evidence,
  and download its Export V1 bundle.
- Independently parse the downloaded bytes with `@blackbox/export`; compare
  canonical identities, counts, hashes, references, fingerprints, outcomes, and
  support graph against server-side persisted truth.

### Harness lifecycle and diagnostics

- Allocate exact collision-resistant output/spool/storage paths and loopback
  ports using the accepted production allocation boundaries.
- Emit sanitized phase/result records with no raw credentials, signed cursors,
  database URL, storage key, evidence body, or authorization header.
- Propagate independently: primary journey result, child/process outcomes,
  cleanup result, and timeout/watchdog result. Cleanup failure cannot turn a
  product failure into success or erase the primary cause.
- On every success/failure path, stop direct owned services, verify exact
  listener/process absence, remove only exact current-run paths, remove the
  exact test container, and preserve unrelated resources and shared roots.

### Documentation

- Document one authorized local acceptance command, required infrastructure,
  sanitized configuration, phase deadlines, failure interpretation, and exact
  cleanup audit.
- Record that the journey is a v0.1 acceptance proof, not a background daemon,
  performance benchmark, compliance certification, or production deployment
  recipe.

## Acceptance Criteria

- The primary run originates in the supported CLI boundary and uses one stable
  run/event/artifact identity set across failure, restart, and retries.
- The first artifact upload fails visibly; a fresh collector process recovers
  from the retained spool and completes delivery without stored credentials or
  fabricated evidence.
- Replaying the exact accepted batch and artifact work produces no duplicate
  canonical events, sequences, declarations, verified uploads, intents,
  projections, findings, claims/supports, or receipts.
- The real worker reaches one current compatible core/files/findings/summary
  state and archives only after mandatory processing succeeds.
- The authenticated browser can review the run and its evidence, and the
  downloaded Export V1 independently validates and exactly matches persisted
  identities, counts, hashes, current fingerprints, findings, and support graph.
- Secret, credential, connection, storage-key, raw unredacted, and hostile HTML
  sentinels do not appear in logs, browser output, URLs, export bytes, or retained
  test artifacts.
- A failure in any phase is nonzero, retains the primary cause, and still
  performs exact bounded cleanup. No owned process, listener, container,
  database credential, spool/output directory, `.next` child, browser report,
  or test result remains afterward.
- Concurrent or repeated fresh lifecycles use distinct resources and cannot
  remove or signal one another. The required gate passes from fresh processes
  without retries masking failures.
- No unsupported provider, policy, GitHub, account, compliance, retention, or
  post-v0.1 behavior is introduced.

## Required Tests

- Focused fixture tests for deterministic Codex JSONL, Git evidence, redaction,
  upload failure, retained spool state, restart, exact replay, and sanitized
  diagnostics.
- PostgreSQL/PGMQ integration assertions for all pre/post-duplicate counts,
  tenant ownership, queue archive ordering, receipts, projection compatibility,
  and support integrity.
- Browser assertions for real authentication, exact run selection, evidence
  navigation, inert sentinel rendering, export download, independent parsing,
  and hidden-tenant/missing-resource behavior.
- Failure-injection cases at initial upload, retry response, ingestion
  acknowledgement, worker processing, Web readiness, export download, and
  cleanup, each proving primary/cleanup outcome separation.
- At least two fresh-process complete journey runs on the final state. Hosted
  Linux CI is authoritative for Linux process behavior; supported Windows local
  validation must remain deterministic without weakening platform-specific
  ownership.
- Regression gates for CLI, ingestion, worker, database, Web, production build,
  BBX-012C lifecycle, and Export V1.

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
<the BBX-013B complete v0.1 journey command, twice from fresh processes>
git diff --check
git status --short --untracked-files=all
```

Use the CI-pinned PostgreSQL 16/PGMQ image on an explicitly authorized isolated
non-5432 loopback port, deploy all migrations from empty state, and provision
the exact queue idempotently. Use only cached/pinned dependencies and browser
revision unless installation or network access is separately authorized. Never
start Docker, use a database, or launch browser infrastructure without the
applicable authorization.

## Deliverables

- Deterministic complete v0.1 acceptance harness and fixtures.
- Restart/upload-failure, duplicate-delivery, processing, browser-review, and
  Export V1 proof.
- Narrow accepted-contract fixes discovered by the journey, each with focused
  regression/mutation evidence.
- Operations documentation and exact cleanup audit.

## Referenced Decisions and Documents

- `docs/product/v0.1-scope.md`
- `docs/architecture/overview.md`
- `docs/architecture/evidence-model.md`
- `docs/architecture/v0.1-delivery-sequence.md`
- `docs/architecture/decisions/ADR-0005-artifact-upload-and-integrity.md`
- `docs/architecture/decisions/ADR-0006-local-spool-and-delivery-state.md`
- `docs/architecture/decisions/ADR-0007-collector-redaction-and-bounded-capture.md`
- `docs/architecture/decisions/ADR-0008-local-git-evidence-and-attribution.md`
- `docs/architecture/decisions/ADR-0009-codex-exec-jsonl-adapter.md`
- `docs/architecture/decisions/ADR-0010-replayable-projections-and-processing-state.md`
- `docs/architecture/decisions/ADR-0011-versioned-deterministic-findings.md`
- `docs/architecture/decisions/ADR-0012-versioned-evidence-backed-summaries.md`
- `docs/architecture/decisions/ADR-0013-dashboard-read-boundary-and-presentation-semantics.md`
- `docs/architecture/decisions/ADR-0014-versioned-evidence-export.md`
- `docs/tasks/BBX-013A-versioned-evidence-export.md`
- `docs/review-guidelines.md`

## Risks

- A full-system harness can accidentally test fixtures instead of production
  boundaries; explicit seam inventory and persisted-truth assertions mitigate
  this.
- Retry orchestration can create false duplicate confidence; the test replays
  exact persisted identities and asserts database/receipt counts.
- Cross-process cleanup can damage unrelated resources; high-entropy exact
  ownership, retained handles, and post-cleanup absence/isolation checks are
  mandatory.
- Infrastructure contention can look like a product defect; monotonic phase
  evidence and one absolute deadline per phase support classification without
  silent retries.
- The journey is expensive and may become flaky; deterministic fixtures,
  serialized infrastructure ownership, fresh-process repetition, and hosted
  Linux confirmation are required.

## Open Questions

None after BBX-013A is complete and ADR-0014 is accepted.
