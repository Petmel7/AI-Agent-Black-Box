# BBX-012C: Deterministic Web E2E Lifecycle

- **Status:** Approved
- **Owner:** Implementation Chat
- **Review:** Review Chat
- **Depends on:** BBX-012B is Done; the Option R recovery remains the
  implementation starting state
- **Delivery risk:** High
- **Execution profile:** High
- **Risk triggers:** cross-platform process and listener ownership, concurrent
  test isolation, watchdog and teardown races, terminal-result protocol
  integrity, cleanup after partial failure, and a deliberately dirty recovery
  baseline
- **Architecture:** No new ADR is required for a narrow lifecycle or teardown
  correction inside the restored test harness. A solution that needs a broader
  process, trust, infrastructure, or platform ownership boundary must stop and
  request an architecture decision.

## Goal

Produce the smallest deterministic, baseline-compatible lifecycle correction
that makes the restored Web E2E harness reliably terminate and clean its owned
controller, owner, child processes, listeners, and exact output paths on
success, failure, watchdog expiry, protocol failure, and test teardown.

This task stabilizes test infrastructure only. It adds no product capability
and does not change dashboard, evidence, authentication, persistence, or
runtime contracts.

## Context

Independent review showed that file serialization alone is insufficient. Two
fresh serialized Web runs each failed 6 of 238 tests in
`apps/web/test/e2e-harness.test.ts` and left 17 Node processes. One run also
left seven listeners. The failures were observed after restoring the Option R
baseline and retaining `fileParallelism: false`.

At proposal time, the repository is based on
`99aac9f992c24bbc1824c5fae24422afa56077a3` with exactly 36 intentional
unstaged paths under `apps/web/**`, no staged paths, and no other untracked
paths. The effective `apps/web` tree equals product baseline
`8f61b75aaaa858d3a2a62959e7f26fdc1cf62f04` except for
`fileParallelism: false` in `apps/web/vitest.config.ts`. `apps/cli` remains
identical to `1c263cc49ee687cfb15404736968488ecb2865c4`.

Those existing changes are the Option R recovery, not BBX-012C implementation
work. Approval must commit only the unchanged task specification. Implementation
must treat the effective Option R tree as its starting state, must not revert it
to the current `HEAD` versions, and must distinguish the narrow BBX-012C delta
from the pre-existing recovery in its report.

The removed 39-path Linux guardian, Windows Job, preload, and resource-registry
experiment is intentionally not part of the baseline and is not a source to
restore selectively.

## In Scope

- Reproduce and classify the process-heavy harness failure before changing
  behavior.
- Correct only the demonstrated narrow lifecycle, terminal-protocol, or
  teardown defect inside the restored Web E2E harness.
- Make ownership, terminal-result ordering, cleanup convergence, and teardown
  assertions deterministic for success and every existing failure path.
- Preserve concurrent-run isolation for processes, listeners, and exact output
  paths.
- Add or strengthen focused regression fixtures and assertions needed to prove
  the correction, without weakening existing scenarios.

Implementation edits are limited to the restored baseline harness files that
directly participate in the demonstrated defect, normally a subset of:

- `apps/web/test/e2e-harness.test.ts`
- `apps/web/test/e2e-controller.mjs`
- `apps/web/test/e2e-playwright-owner.mjs`
- `apps/web/test/e2e-process-control.mjs`
- `apps/web/test/e2e-server.mjs`
- `apps/web/test/e2e-server-worker.mjs`
- existing E2E fixture files, only when required for regression coverage
- `apps/web/vitest.config.ts`, only to preserve the existing
  `fileParallelism: false`

Any required edit outside this set is an explicit scope stop and returns the
task to architecture review before that file is changed.

## Out of Scope

- Product routes, dashboard UI, authentication, queries, database code,
  migrations, schemas, contracts, dependencies, or the lockfile.
- Browser-journey expansion, PostgreSQL, Docker, PGMQ, collector, ingestion,
  worker, summary, finding, or export behavior.
- Changes to `apps/cli`, `next-env.d.ts`, BBX-012B status, another task, an ADR,
  or accepted product or architecture documents.
- Restoring any removed guardian, native supervisor, Windows Job, preload or
  spawn guard, generalized resource registry, `/proc` parser, or multi-layer
  ownership architecture.
- Adding a native dependency, PowerShell supervisor, preload hook, or
  platform-specific binary.
- Timeout increases, sleeps, retries, broad process enumeration, process-name
  killing, PID-prefix cleanup, or shared-directory deletion as a correctness
  mechanism.
- Committing, pushing, hosted-CI finalization, or marking this task Approved or
  Done as part of implementation.

## Architecture Constraints

- Preserve the Option R rollback and `fileParallelism: false`. Do not restore
  or imitate the removed supervisor stack under different names.
- Prefer fewer ownership hops and simpler lifecycle topology over another
  supervisory layer.
- Every launched process has exactly one explicit owner. The owner retains the
  exact child handle or identity needed to await termination; ownership must
  not be reconstructed from process names, PID prefixes, or system-wide scans.
- Every listener and generated path has one explicit current-run owner. Cleanup
  targets exact owned handles and paths and cannot affect a concurrent run.
- Cleanup is idempotent and awaited before terminal success or failure is
  emitted. Repeated cleanup requests converge on the same promise and outcome.
- The primary child/protocol failure and any cleanup failure remain separately
  observable. Cleanup must not erase, replace, or falsely convert the primary
  outcome; terminal success requires both primary success and completed exact
  cleanup.
- Failed tests and `afterEach` teardown await cleanup and surface cleanup
  failure. Teardown must not swallow a non-converged process, listener, or path.
- Assertions may verify exact known process IDs, handles, ports, and paths.
  Broad enumeration may be used only as bounded diagnostic evidence, never to
  discover cleanup targets or make the implementation correct.
- Sanitized phase evidence is test-only, bounded, and monotonic. It must not
  contain credentials, environment secrets, tenant data, database values, or
  unbounded child output.
- Exact cross-platform ownership must be achieved by a small change compatible
  with the restored baseline. If that is not possible, implementation stops
  and requests an architecture decision instead of approximating ownership.

## Required Changes

### Diagnosis gate

Before changing lifecycle behavior, run the affected process-heavy file in a
fresh process and capture enough sanitized monotonic phase evidence to identify:

- each direct launch and its explicit owner;
- readiness, terminal-result, IPC disconnect, signal, and exit ordering;
- watchdog start and expiry;
- cleanup request, cleanup completion, and teardown-hook completion;
- the exact known process IDs, listeners, and output paths that should converge.

Diagnostic instrumentation may touch only the allowed test-harness files. It
must be reverted unless it is necessary, bounded regression observability in
the final design. Do not change production code to diagnose this task.

Record exactly one primary classification in the implementation report and
apply its required action:

| Classification                                       | Required evidence and action                                                                                                                                                                                                                               |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Deadline-only contention**                         | Lifecycle and protocol ordering are correct and exact cleanup converges, but the test deadline expires under serialized load. Stop without increasing timeouts, adding sleeps, or retrying. Report the evidence and return to architecture.                |
| **Lifecycle/protocol completion defect**             | A direct owner fails to complete, acknowledge, or await an existing terminal/cleanup transition. Proceed only when the correction is narrow, deterministic, and contained in the allowed files.                                                            |
| **Detached-descendant ownership loss**               | A launched descendant can outlive the only component able to identify and await it. Proceed only if simplifying the restored topology establishes exact cross-platform ownership without a new layer; otherwise stop and request an architecture decision. |
| **Teardown-hook defect**                             | The test hook loses a direct handle, fails to await cleanup, or hides cleanup failure. Proceed with the smallest hook/fixture correction in the allowed files.                                                                                             |
| **Platform behavior requiring broader architecture** | Exact ownership depends on a native supervisor, Job object, `/proc`, preload interception, platform binary, or another new boundary. Stop and request an architecture decision.                                                                            |

An unreproduced, mixed, or inconclusive result is also a stop. Only a
demonstrated narrow lifecycle/protocol or teardown defect may proceed directly
to implementation.

### Lifecycle and cleanup correction

- Correct the demonstrated defect at its existing owner instead of adding a
  parallel owner or fallback supervisor.
- Establish one unambiguous terminal sequence for success, child failure,
  signal, watchdog expiry, malformed or missing terminal protocol, IPC
  disconnect, and external test teardown.
- Await exact descendant and listener termination before an owner reports
  cleanup completion or exits. A watchdog or teardown path may force an exact
  known child to terminate, but it must still await convergence and report a
  cleanup failure when convergence cannot be proved.
- Preserve the primary exit or protocol outcome alongside a distinct cleanup
  outcome. The controller exits successfully only after receiving one valid
  terminal result, observing exact cleanup success, and observing owner exit.
- Give every generated output location a collision-resistant current-run
  identity and delete only the exact owned location. Verify absence after
  cleanup; do not delete shared parents or another run's outputs.
- Ensure a concurrent controller/owner pair remains alive and retains its
  listener and output while the other pair fails or is torn down.

### Regression proof

- Preserve the original controller-exit, watchdog, cleanup-hook, and
  concurrent-owner scenarios and their failure-sensitive assertions.
- Add the smallest regression that deterministically exercises the diagnosed
  race or missed transition on both success and forced-failure paths.
- Assert cleanup convergence after successful execution, primary failure,
  watchdog expiry, protocol failure, and `afterEach` teardown using the exact
  process IDs, ports, handles, and paths learned from the current run.
- Prove the regression is effective either by running it against the vulnerable
  Option R behavior or by applying a temporary local mutation that restores the
  defect, observing the expected failure, reverting the mutation completely,
  and rerunning on the final implementation. Do not leave mutation artifacts.
- Keep test assertions at least as strong as the restored baseline. A passing
  result obtained by removing a scenario, reducing an ownership assertion, or
  suppressing a cleanup error is not acceptance evidence.

## Acceptance Criteria

- The diagnosis report contains sanitized monotonic phase evidence, one primary
  classification, and the resulting proceed/stop decision.
- Only a demonstrated narrow lifecycle/protocol or teardown defect is
  implemented. A broader platform requirement stops for architecture review.
- The original failing controller-exit, watchdog, cleanup-hook, and
  concurrent-owner scenarios pass without weakened assertions.
- Mutation or vulnerable-baseline proof demonstrates that the new regression
  detects the actual defect.
- Each launched process, listener, and output path has one explicit owner;
  cleanup is idempotent, awaited, exact, and convergent on every terminal path.
- Primary and cleanup failures are both observable, and no terminal success is
  reported before exact cleanup and owner exit complete.
- Cleanup convergence is asserted after both successful and failed test
  execution, including `afterEach` cleanup.
- No current-run Node process, listener, owned output, `.next` harness
  directory, Playwright report, or `test-results` directory remains after an
  affected run.
- Concurrent runs cannot delete, close, signal, or terminate one another's
  resources.
- At least three independent fresh-process executions of
  `apps/web/test/e2e-harness.test.ts` pass.
- At least two independent executions of `pnpm --filter @blackbox/web test`
  pass from a clean generated-output state. Cleanup from the first execution,
  not a broad deletion or retry, provides the clean state for the second.
- Web lint, standalone Web typecheck, repository Prettier, and
  `git diff --check` pass on the final implementation state.
- `apps/web/next-env.d.ts` remains unchanged, the Option R rollback remains in
  force, and `apps/web/vitest.config.ts` retains `fileParallelism: false`.
- No product behavior, dependency, lockfile, task status, ADR, or out-of-scope
  file changes.
- Hosted Linux CI remains the final live-platform authority.

## Required Tests

- Focused regression coverage for the exact diagnosed lifecycle or teardown
  defect, including the vulnerable-baseline or mutation failure proof.
- Existing success, nonzero child exit, signal, already-absent resource,
  material cleanup failure, IPC disconnect, watchdog, external controller
  termination, server startup failure, and concurrent-owner scenarios.
- Exact postcondition checks for every known current-run process, listener, and
  generated output after success and failure.
- Teardown-hook coverage that starts a failing scenario and proves `afterEach`
  waits for exact cleanup and exposes non-convergence.
- Three separate fresh Vitest processes for the process-heavy harness file.
- Two separate full Web test invocations from clean generated-output state.

## Validation Commands

Run focused checks while editing. On the final implementation state, run each
of the first command in three independent fresh processes and each full Web
test command in two independent invocations; do not replace these repetitions
with Vitest retry configuration:

```text
pnpm --filter @blackbox/web exec vitest run test/e2e-harness.test.ts
pnpm --filter @blackbox/web exec vitest run test/e2e-harness.test.ts
pnpm --filter @blackbox/web exec vitest run test/e2e-harness.test.ts
pnpm --filter @blackbox/web test
pnpm --filter @blackbox/web test
pnpm --filter @blackbox/web lint
pnpm --filter @blackbox/web typecheck
pnpm format:check
git diff --check
git diff --exit-code -- apps/web/next-env.d.ts
git status --short --untracked-files=all
```

Before and after each process-heavy or full Web invocation, verify absence of
that invocation's exact owned processes, listeners, and generated paths. Record
the command, exit result, test counts, convergence evidence, and any warning.
Do not claim a clean generated-output state if it was obtained through broad
shared-directory deletion.

Hosted Linux CI is the final authority for live Linux process behavior. A local
pass does not authorize push or substitute for the independent review and
hosted-CI gates.

## Deliverables

- The smallest allowed-file lifecycle or teardown correction supported by the
  diagnosis gate.
- Focused deterministic regression coverage and mutation or vulnerable-baseline
  proof.
- Sanitized diagnosis and cleanup-convergence evidence for the required local
  runs.
- A compact implementation report that separates the BBX-012C delta from the
  pre-existing Option R recovery and lists changed files, exact validation,
  acceptance status, deviations, and residual risks.

## Referenced Decisions and Documents

- `AGENTS.md`
- `docs/tasks/README.md`
- `docs/product/v0.1-scope.md`
- `docs/architecture/overview.md`
- `docs/architecture/v0.1-delivery-sequence.md`
- `docs/architecture/decisions/ADR-0012-versioned-evidence-backed-summaries.md`
- `docs/architecture/decisions/ADR-0013-dashboard-read-boundary-and-presentation-semantics.md`
- `docs/tasks/BBX-012B-evidence-dashboard-ui-and-navigation.md`
- `docs/review-guidelines.md`

## Risks

- Node process-tree behavior differs between Windows and Linux. A local fix may
  appear stable while still losing ownership on hosted Linux; exact ownership
  assertions and hosted CI are required.
- Timing changes can hide the race without fixing it. Timeouts, sleeps, and
  retries are prohibited as correctness mechanisms.
- Cleanup can overwrite the primary failure or report success before the owner
  exits. Separate outcomes and an awaited terminal sequence prevent false
  success.
- A shared path or broad kill can damage a concurrent run. Exact per-run
  handles, listeners, and paths are mandatory.
- The dirty Option R starting state can obscure scope. Implementation and
  review must distinguish the pre-existing recovery from the BBX-012C delta and
  must not stage or revert recovery paths accidentally.
- Diagnostic process enumeration can become an implicit ownership mechanism.
  Diagnostics may observe broadly when necessary, but cleanup must operate only
  on exact known ownership.

## Open Questions

None before approval. The diagnosis classifications are explicit stop gates,
not permission to select a broader process architecture during implementation.

## Implementation Prompt

Use only after this unchanged task is `Approved` and tracked in the reported
baseline commit. Replace `<APPROVED_BASELINE_SHA>` with that reported commit:

```text
$bbx-implement implement the Approved task in docs/tasks/BBX-012C-deterministic-web-e2e-lifecycle.md against baseline <APPROVED_BASELINE_SHA> in the saved project checkout. Preserve the pre-existing Option R recovery as the implementation starting state. Run the diagnosis gate first and stop for every required stop classification; implement only a demonstrated narrow defect within the allowed files. Run the complete task validation, separate the BBX-012C delta from recovery changes in the compact report, and stop ready for independent review without committing, pushing, or finalizing.
```

## Review Prompt

Use after implementation and replace `<APPROVED_BASELINE_SHA>` with the same
reported baseline commit:

```text
$bbx-review independently review the implementation against docs/tasks/BBX-012C-deterministic-web-e2e-lifecycle.md and baseline <APPROVED_BASELINE_SHA> in the saved project checkout. Verify the complete diff, preservation of the Option R recovery, diagnosis classification, exact cross-platform ownership, failure observability, mutation or vulnerable-baseline proof, cleanup convergence, concurrent isolation, scope, and all required validation. Do not edit files. Report the compact review result with PASS or NEEDS FIXES and stop without committing, pushing, or finalizing.
```
