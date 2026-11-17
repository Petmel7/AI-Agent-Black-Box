# BBX-012C: Deterministic Web E2E Lifecycle

- **Status:** Approved
- **Owner:** Implementation Chat
- **Review:** Review Chat
- **Depends on:** BBX-012B is Done; the Option R recovery remains the
  implementation starting state
- **Delivery risk:** High
- **Execution profile:** High
- **Risk triggers:** cross-platform process-group and process-tree ownership,
  concurrent test isolation, bounded forced teardown, hook-deadline races,
  preservation of primary and cleanup outcomes, and a deliberately dirty
  recovery baseline
- **Architecture:** Option S is the selected task-level architecture. No new ADR
  is required because it simplifies the internal test-harness lifecycle without
  changing a product, trust, durable-data, infrastructure, or public-contract
  boundary. If the required guarantee needs a guardian, Job Object, native
  helper, registry, or broader supervisor, implementation must stop and return
  to architecture.

## Goal

Replace the invalidated multi-group lifecycle correction with one deterministic,
parent-owned process lifecycle for each Web E2E run. Exactly one detached
ownership root may exist; every descendant remains non-detached in that root's
process group or tree; and the test parent retains the real root `ChildProcess`
handle through bounded cleanup and exact absence verification.

This task stabilizes test infrastructure only. It adds no product capability
and does not change dashboard, evidence, authentication, persistence, or runtime
contracts.

## Context

Independent review invalidated the prior narrow BBX-012C implementation:

1. `afterEach` had a 10-second hook deadline while cleanup could consume a
   10-second cooperative wait, another 5 seconds after fallback, and 10 seconds
   of resource verification.
2. Nested detached processes created multiple process groups, so forced
   fallback owned only part of the descendant tree.
3. Cleanup failure could overwrite the primary child or test outcome.
4. A forced fallback could be reported as successful ordinary cleanup.

Review independently reproduced focused, complete-harness, and full-Web
failures with leaked processes and listeners. The prior diagnosis gate and its
synthetic expectation that detached descendants recover autonomously are no
longer valid acceptance contracts.

At this amendment checkpoint, the repository is on `main` at
`a23832d95b91ac5e877162654384002276a120a8`. `HEAD` contains the previously
Approved task. The index is empty, there are no untracked files, and exactly 36
intentional unstaged paths exist under `apps/web/**`. The failed four-file
BBX-012C delta is:

- `apps/web/test/e2e-controller.mjs`
- `apps/web/test/e2e-harness.test.ts`
- `apps/web/test/e2e-playwright-owner.mjs`
- `apps/web/test/e2e-server.mjs`

Hashing their patch from recovery reference
`8f61b75aaaa858d3a2a62959e7f26fdc1cf62f04` with
`git diff <reference> -- <the four paths> | git hash-object --stdin` yields
`4d4788506f45911a179071e2bc38b761809a9070`.

Before Option S implementation begins, those four files must be restored to the
Option R recovery content and the reset must be proved. The effective
`apps/web` tree must equal `8f61b75aaaa858d3a2a62959e7f26fdc1cf62f04`
except for `fileParallelism: false` in `apps/web/vitest.config.ts`; the 36-path
recovery patch fingerprint must be
`32b44cec3227725c28d48dd5f1a59d614f45d9c8`; and `apps/cli` must remain
identical to `1c263cc49ee687cfb15404736968488ecb2865c4`.

The 36 Web paths are pre-existing recovery and failed-implementation state, not
part of this specification amendment. Approval must commit only the unchanged
task specification. Implementation must report the reset proof separately from
the Option S delta and must not stage, commit, or accidentally revert the
recovery paths.

## In Scope

- Prove and perform the exact four-file reset to the Option R recovery state
  before changing lifecycle behavior.
- Establish exactly one detached ownership root per E2E run and retain its real
  `ChildProcess` handle in the test parent.
- Make every nested controller, owner, Playwright fixture, server worker,
  application, and test descendant non-detached so it inherits the same owned
  process group or tree.
- Implement one monotonic cleanup budget that covers cooperative shutdown,
  bounded forced fallback, and exact absence verification and is strictly
  smaller than the Vitest hook timeout.
- Preserve the primary child or test outcome independently from cleanup outcome
  and forced-fallback use.
- Preserve exact run-ID output ownership and concurrent-run isolation.
- Replace detached-descendant autonomous-recovery scenarios with deterministic
  parent-owned forced-teardown coverage.

Implementation edits are limited to the smallest necessary subset of these
restored baseline harness files:

- `apps/web/test/e2e-harness.test.ts`
- `apps/web/test/e2e-controller.mjs`
- `apps/web/test/e2e-playwright-owner.mjs`
- `apps/web/test/e2e-process-control.mjs`
- `apps/web/test/e2e-server.mjs`
- `apps/web/test/e2e-server-worker.mjs`
- existing controller and server fixture files, only when required for focused
  regression coverage
- `apps/web/vitest.config.ts`, only to preserve the existing
  `fileParallelism: false`

Any required edit outside this set, any new helper file, or any broader
ownership mechanism is an explicit scope stop and returns the task to
architecture before that file or mechanism is introduced.

## Out of Scope

- Product routes, dashboard UI, authentication, queries, database code,
  migrations, schemas, contracts, dependencies, or the lockfile.
- Changes to `apps/cli`, `apps/web/next-env.d.ts`, BBX-012B status, another task,
  an ADR, or accepted product or architecture documents.
- Linux guardians or subreapers.
- Windows Job Objects or native supervisors.
- Resource or PID registries, preload or spawn guards, PowerShell or native
  ownership helpers, and `/proc` ownership parsers.
- PID reconstruction, process-name matching, broad process enumeration as a
  cleanup target source, PID-prefix cleanup, sibling cleanup, or shared-parent
  deletion.
- Timeout increases, arbitrary sleeps, or retries as correctness mechanisms.
- Restoring any removed experimental supervisor file or recreating it under a
  different name.
- Committing, pushing, hosted-CI finalization, or marking this task Approved or
  Done as part of implementation.

## Architecture Constraints

### Single ownership root

- Exactly one detached ownership root may exist for each E2E run. The test
  parent creates it and retains the actual `ChildProcess` handle until cleanup
  and verification finish.
- Every process launched below that root is non-detached and inherits the same
  root process group on POSIX or descendant tree on Windows. Nested detached
  descendants and additional ownership roots are forbidden.
- Each launched process has one explicit direct owner. Ownership and cleanup
  authority cannot be reconstructed from a PID file, process name, path prefix,
  system-wide scan, or registry.
- POSIX forced fallback may target only the retained ownership-root PGID.
  Windows forced fallback may target only the retained ownership-root process
  tree. Cleanup cannot target a sibling or another run.
- Assertions may inspect exact current-run handles, PIDs, ports, and paths.
  Bounded broad observation may be recorded as diagnostic evidence only; it
  cannot discover cleanup targets or make cleanup correct.

### One bounded cleanup lifecycle

- `afterEach` declares one explicit monotonic cleanup budget and a separate
  Vitest hook timeout. The cleanup budget must be strictly smaller than the
  hook timeout, and a test must enforce that invariant.
- The single budget includes, in order, cooperative shutdown, bounded forced
  fallback when needed, and exact absence verification. Phase limits derive
  from one absolute monotonic deadline; they are not additive waits that can
  exceed the hook.
- The hook awaits final convergence and cannot return, pass, or throw a terminal
  result while cleanup is still pending.
- Cleanup is idempotent. All callers for one run converge on the same promise,
  outcome, deadline, and exact resource set.
- Successful completion requires verified absence of the exact owned process
  tree, listeners, and run-ID output paths. An already-absent resource is a
  converged result, not an error and not authority to broaden the target.

### Outcome integrity

- The primary child or test outcome becomes immutable once observed. Cleanup
  cannot replace, erase, or convert it.
- Cleanup outcome and forced-fallback use are transmitted separately from the
  primary outcome. Callers and failure messages must preserve both when both
  fail.
- Any forced fallback makes cleanup non-clean even if the exact resources later
  converge. Convergence after force is reported distinctly from ordinary clean
  cooperative shutdown.
- Terminal success requires primary success, cooperative cleanup without forced
  fallback, and verified exact absence.

### Guarantee boundary

- The repository harness guarantees convergence only while the test parent or
  its CI job remains able to use the retained ownership-root handle and exact
  process group or tree.
- Hard-kill of the sole ownership root when no test parent or CI job remains is
  explicitly outside the repository harness guarantee. Hosted CI or job
  isolation owns cleanup after uncatchable destruction of the final owner.
- The implementation and tests must not reintroduce an autonomous guardian to
  extend this boundary.

## Required Changes

### Mandatory reset-to-recovery gate

Before editing lifecycle behavior:

1. Confirm the branch, approved-baseline commit, empty index, absence of
   untracked files, and exactly 36 unstaged `apps/web/**` paths.
2. Recompute the four-file failed-implementation fingerprint against
   `8f61b75aaaa858d3a2a62959e7f26fdc1cf62f04`. Stop if it is not
   `4d4788506f45911a179071e2bc38b761809a9070`.
3. Restore only the four named failed-implementation files to their Option R
   recovery bytes. Do not broadly restore, delete, or stage the Web tree.
4. Before any Option S edit, prove all of the following and record the evidence:
   - the effective `apps/web` tree equals
     `8f61b75aaaa858d3a2a62959e7f26fdc1cf62f04` except for exactly
     `fileParallelism: false` in `apps/web/vitest.config.ts`;
   - `git diff -- apps/web | git hash-object --stdin` yields the recovery
     fingerprint `32b44cec3227725c28d48dd5f1a59d614f45d9c8`;
   - `apps/cli` is identical to
     `1c263cc49ee687cfb15404736968488ecb2865c4`;
   - the index remains empty, no untracked files exist, and the same 36 recovery
     paths remain unstaged.

If any proof fails, stop before implementation and return to architecture with
the exact mismatch. Do not approximate or repair an unknown baseline.

### Option S lifecycle

- Launch one detached ownership root from the test parent and retain its real
  handle for the whole run.
- Remove every nested `detached` launch in the controller, owner, Playwright,
  server, worker, application, and fixture chain so all descendants inherit the
  root group or tree.
- Route cooperative shutdown through the existing explicit owner chain. Use
  forced fallback only when cooperative shutdown fails to converge within its
  share of the single deadline.
- On POSIX, force only the retained root PGID. On Windows, force only the
  retained root process tree. Await exit and exact resource absence within the
  same overall budget.
- Make cleanup requests from test completion, primary failure, watchdog,
  protocol failure, external teardown, and `afterEach` converge on one cleanup
  promise and one final cleanup result.
- Preserve exact run-ID output directories and delete or verify only those
  current-run paths. Do not delete shared parents, reports, results, or output
  owned by a concurrent run.
- Carry primary outcome, cleanup outcome, and forced-fallback use as separate
  terminal facts through the controller and test boundary.

### Regression proof

- Preserve the existing success, child-failure, signal, IPC disconnect,
  watchdog, startup-failure, cleanup-hook, and concurrent-run scenarios unless
  this task explicitly replaces their invalid detached-descendant assumption.
- Replace synthetic “controller dies but detached descendants autonomously
  recover” coverage with parent-owned forced teardown of the single root and
  exact verification of the inherited tree.
- Add deterministic coverage for cooperative cleanup and forced fallback. The
  forced case must prove both eventual convergence and a non-clean cleanup
  result.
- Inject a primary failure and a cleanup failure in the same run and prove that
  both outcomes remain observable and correctly attributed.
- Prove the hook budget covers cooperative shutdown, bounded force, and exact
  verification without returning while cleanup is pending.
- Prove concurrent runs retain distinct root handles, process trees, listeners,
  and run-ID outputs and cannot clean one another.
- Demonstrate regression sensitivity against the vulnerable baseline or a
  temporary local mutation that reintroduces the defect. Observe the expected
  failure, revert the mutation completely, and rerun on the final state. Do not
  leave mutation artifacts.

## Acceptance Criteria

- The reset-to-recovery evidence proves the expected four-file input
  fingerprint, effective Web tree, 36-path recovery fingerprint, unchanged CLI
  tree, empty index, and absence of untracked files before Option S edits.
- Each E2E run has exactly one detached ownership root, one retained real root
  handle in the test parent, and one inherited process group or tree.
- No nested controller, owner, Playwright fixture, server worker, application,
  fixture, or test descendant is detached.
- POSIX fallback targets only the retained root PGID; Windows fallback targets
  only the retained root process tree. No PID reconstruction, name matching,
  broad enumeration, prefix cleanup, or sibling cleanup participates in
  correctness.
- `afterEach` has one explicit monotonic cleanup budget strictly smaller than
  its declared Vitest hook timeout. Cooperative shutdown, bounded force, and
  exact absence verification complete within that one budget.
- The hook awaits the shared cleanup promise through final convergence and
  never returns with cleanup pending.
- Cleanup is idempotent, and every caller converges on the same promise and
  outcome.
- Primary outcome is immutable. Primary outcome, cleanup outcome, and
  forced-fallback use are all preserved and separately observable, including an
  injected primary-plus-cleanup failure.
- Forced fallback is always reported distinctly and makes cleanup non-clean
  even after the exact resources converge.
- Exact run-ID output paths remain required. Successful completion proves
  absence of the exact process tree, listeners, and output.
- Concurrent runs cannot close, signal, delete, or otherwise affect one
  another's process tree, listeners, outputs, reports, or test results.
- Parent-owned forced-teardown coverage replaces the invalid autonomous
  detached-descendant recovery requirement.
- Vulnerable-baseline or mutation proof demonstrates that the regression fails
  for the invalid behavior and passes on the final implementation.
- Three independent fresh-process executions of
  `apps/web/test/e2e-harness.test.ts` pass.
- Two independent executions of `pnpm --filter @blackbox/web test` pass. The
  second begins from the clean exact postcondition produced by the first, not
  by broad deletion, arbitrary delay, or retry.
- Validation runs on Node `>=24 <25` and exact pnpm `11.19.0`.
- Web lint, standalone Web typecheck, pinned repository Prettier, and
  `git diff --check` pass on the final implementation state.
- `apps/web/next-env.d.ts` remains unchanged and
  `apps/web/vitest.config.ts` retains `fileParallelism: false` without a timeout
  increase.
- No owned process, listener, run output, Playwright report, or test-results
  path remains after the affected runs.
- No product, dependency, lockfile, task-status, ADR, native boundary, helper,
  or out-of-scope file changes.
- Hosted Linux CI remains the final platform authority for POSIX group behavior
  and repository-level isolation does not claim to survive destruction of the
  final owner or CI job.

## Required Tests

- A topology regression proving one retained detached root and non-detached
  inherited descendants through the controller, owner, Playwright, server,
  worker, application, and fixture path.
- Deterministic cooperative-cleanup coverage that completes without force and
  reports a clean cleanup result.
- Deterministic forced-fallback coverage that targets only the retained root,
  converges exactly, and reports cleanup as non-clean.
- Hook-budget coverage proving the single monotonic deadline is below the hook
  timeout and contains all cleanup phases.
- Primary-plus-cleanup failure injection proving neither outcome overwrites the
  other.
- Existing success, nonzero child exit, signal, already-absent resource,
  material cleanup failure, IPC disconnect, watchdog, external teardown,
  server startup failure, and concurrent-run coverage adapted to the Option S
  ownership contract.
- Exact postcondition checks for each current-run root/process tree, listener,
  output, report, and test-result path after success and failure.
- Concurrent-run isolation coverage and vulnerable-baseline or mutation proof.
- Three separate fresh Vitest processes for the focused harness file and two
  separate complete Web test invocations.

## Validation Commands

Run focused checks while editing. On the final implementation state, verify the
toolchain, run the focused file in three independent fresh processes, and run
the complete Web suite twice in independent invocations:

```text
node --version
pnpm --version
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

Record that Node satisfies `>=24 <25` and pnpm is exactly `11.19.0`. Before and
after each process-heavy or complete Web invocation, verify absence of that
invocation's exact owned root/tree, listeners, run-ID outputs, Playwright
report, and test-results paths. Record command, exit result, test counts,
cleanup outcome, forced-fallback use, convergence evidence, and warnings. A
broad deletion, retry, or arbitrary sleep cannot establish the clean starting
state for a later run.

Hosted Linux CI is the final authority for live POSIX process-group behavior.
A local pass does not authorize push or substitute for independent review and
hosted-CI gates.

## Deliverables

- Recorded reset-to-recovery proof that is distinct from the Option S delta.
- The smallest allowed-file Option S single-root lifecycle implementation.
- Deterministic cooperative, forced-fallback, combined-failure, budget,
  postcondition, and concurrent-isolation regressions.
- Vulnerable-baseline or mutation evidence that the regression detects the
  invalid behavior.
- A compact implementation report listing changed files, exact commands and
  results, acceptance status, deviations, and residual risks, while separating
  pre-existing recovery, removed failed delta, and final Option S changes.

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

- Windows process-tree and POSIX process-group behavior differ. Exact root
  targeting, platform-specific assertions, and hosted Linux CI reduce but do
  not eliminate platform variance.
- A phase-local wait can silently exceed the hook deadline when composed with
  later phases. One absolute monotonic cleanup budget and an enforced
  budget-versus-hook invariant prevent additive deadline drift.
- Forced convergence can be mistaken for clean cleanup. The forced-fallback
  fact is immutable and independently reported.
- Cleanup failure can obscure the primary outcome. Separate immutable outcome
  channels and combined-failure tests prevent replacement.
- A shared path or broad kill can damage a concurrent run. Retained root
  handles and exact run-ID resources are mandatory.
- The dirty recovery state can obscure scope. Fingerprints, the mandatory reset
  gate, and a report that separates recovery from Option S mitigate
  misattribution.
- Destruction of the final owner cannot be solved within Option S. CI/job
  isolation, not a repository guardian, owns that residual boundary.

## Open Questions

None before approval. If the single retained ownership root cannot satisfy the
acceptance criteria without a guardian, Job Object, native helper, registry, or
broader supervisor, implementation must stop and return to architecture. It
must not approximate the guarantee.

## Implementation Prompt

Use only after this unchanged amended task is `Approved` and tracked in the
reported baseline commit. Replace `<APPROVED_BASELINE_SHA>` with that reported
commit:

```text
$bbx-implement implement the Approved Option S task in docs/tasks/BBX-012C-deterministic-web-e2e-lifecycle.md against baseline <APPROVED_BASELINE_SHA> in the saved project checkout. Before any lifecycle edit, verify the failed four-file fingerprint and complete the mandatory reset-to-recovery proof exactly as specified; stop on any mismatch. Then implement only the single retained ownership-root design within the allowed files, run the complete task validation and regression-sensitivity proof, separate recovery/reset/Option S changes in the compact report, and stop ready for independent review without staging, committing, pushing, or finalizing. If the guarantee requires a prohibited supervisor or broader boundary, stop and return to architecture.
```

## Review Prompt

Use after implementation and replace `<APPROVED_BASELINE_SHA>` with the same
reported baseline commit:

```text
$bbx-review independently review the Option S implementation against docs/tasks/BBX-012C-deterministic-web-e2e-lifecycle.md and baseline <APPROVED_BASELINE_SHA> in the saved project checkout. Verify the complete diff, mandatory reset-to-recovery evidence and fingerprints, the single retained ownership root with no detached descendants, one bounded cleanup deadline, exact platform fallback targeting, immutable primary and separate cleanup/forced outcomes, regression sensitivity, exact convergence and concurrent isolation, scope, and all required validation. Do not edit files. Report the compact review result with PASS or NEEDS FIXES and stop without committing, pushing, or finalizing.
```
