# BBX-012C: Deterministic Web E2E Lifecycle

- **Status:** Approved
- **Owner:** Implementation Chat
- **Review:** Review Chat
- **Depends on:** BBX-012B is Done; the Option R/product recovery state remains
  the implementation starting point
- **Delivery risk:** High
- **Execution profile:** High
- **Risk triggers:** concurrent production test-entrypoint isolation,
  cross-platform direct-child lifecycle behavior, delegated third-party process
  ownership, immutable terminal-result attribution, bounded shutdown phases,
  exact run-owned resource cleanup, and a deliberately dirty recovery baseline
- **Architecture:** Option D, Delegated Playwright Ownership, is the confirmed
  task-level architecture. No new ADR is required because this narrows an
  internal test-harness guarantee without changing a product, trust,
  durable-data, dependency, infrastructure, or public-contract boundary. If
  implementation requires dependency patching, a native or autonomous
  supervisor, descendant-PID authority, or another prohibited boundary, it must
  stop and return to architecture. A new ADR is required only if the returned
  design changes a boundary that meets the decision criteria in
  `docs/architecture/overview.md`.

## Goal

Make the ordinary Web `test:e2e` entrypoint deterministic and safe for
concurrent runs while stating an ownership guarantee the repository can
truthfully enforce with pinned Playwright 1.51.1.

The repository owns retained handles to its direct launcher/controller
children, a high-entropy run identity, parent-authorized per-run listeners,
exact run-owned output/report/result paths, and an immutable terminal protocol.
Playwright owns the browser and Web-server descendants it creates, including
process groups intentionally detached by its internals. Hosted CI or the
containing operating-system job owns residual cleanup beyond those boundaries.

Repository cleanup must fail visibly when direct-child shutdown or observable
port/path convergence fails. It must not claim to have forcibly owned, targeted,
or cleaned Playwright-created descendants.

This task changes test infrastructure only. It adds no product capability and
does not change dashboard, evidence, authentication, persistence, or runtime
contracts.

## Context

Independent review proved the prior Option S architecture impossible with
pinned Playwright 1.51.1:

1. The real `test:e2e` command has no test parent retaining an ownership-root
   handle for the complete Playwright process topology.
2. Playwright's Linux process launcher intentionally creates detached
   Web-server and browser process groups. Repository code therefore cannot
   truthfully place every Playwright descendant in one repository-owned group
   or tree without patching the dependency, intercepting process creation, or
   adding a broader supervisor.
3. The prior seven-second cleanup claim included filesystem and operating-system
   calls that repository JavaScript cannot cancel absolutely.
4. Ordinary concurrent `test:e2e` commands used the same fixed listener ports.
5. A duplicate or conflicting terminal message could erase the first valid
   primary outcome instead of reporting an independent protocol failure.

Option D delegates third-party descendant ownership to Playwright and the
containing CI/job boundary while retaining exact repository authority over
direct children, configuration, paths, and protocol facts.

At this amendment checkpoint, the required repository state is `main` at
`7f7f40e5ee3990cdce9862fd655e2f4ff45243be`. The index is empty, there are no
untracked files, and exactly 36 intentional unstaged paths exist under
`apps/web/**`. The current Option S delta consists of these eight files:

- `apps/web/test/e2e-harness.test.ts`
- `apps/web/test/e2e-controller.mjs`
- `apps/web/test/e2e-playwright-owner.mjs`
- `apps/web/test/e2e-process-control.mjs`
- `apps/web/test/e2e-server.mjs`
- `apps/web/test/e2e-server-worker.mjs`
- `apps/web/test/e2e-controller-fixture.mjs`
- `apps/web/test/e2e-fixture-app.mjs`

Hashing their patch from recovery reference
`8f61b75aaaa858d3a2a62959e7f26fdc1cf62f04` with
`git diff <reference> -- <the eight paths> | git hash-object --stdin` yields
`03e205ad26a733a41a31c8723bdd95ff3531dfab`. Hashing the complete current Web
working patch with `git diff -- apps/web | git hash-object --stdin` yields
`30682c6ea5603d06e952b1881cfbc0ea82050aaf`.

Before Option D implementation, only the eight Option S files must be restored
to their Option R/product-baseline bytes and the mandatory reset gate below must
pass. After that reset, the effective `apps/web` tree must equal recovery
reference `8f61b75aaaa858d3a2a62959e7f26fdc1cf62f04` except for
`fileParallelism: false` in `apps/web/vitest.config.ts`; the remaining recovery
patch fingerprint must be `32b44cec3227725c28d48dd5f1a59d614f45d9c8`;
and `apps/cli` must remain identical to
`1c263cc49ee687cfb15404736968488ecb2865c4`.

The 36 Web paths are pre-existing recovery and failed-implementation state, not
part of this specification amendment. Approval must commit only this unchanged
task specification. Implementation must report the reset proof separately from
the Option D delta and must not stage, commit, or accidentally revert the
recovery paths.

## In Scope

- Prove and perform the exact eight-file reset to the Option R/product recovery
  state before changing lifecycle behavior.
- Give every repository-created launcher/controller process an explicit direct
  owner that retains its real `ChildProcess` handle through shutdown and exit.
- Generate and validate a high-entropy per-run identity and exact per-run
  output, report, and result paths at the production entrypoint.
- Allocate parent-authorized per-run loopback ports for the real production
  `test:e2e` path and propagate them through the controller, Playwright config,
  trusted proxy, E2E server, and application launcher.
- Exercise two simultaneous local invocations of the real production
  `e2e-controller` entrypoint using the same production run-identity,
  port-allocation, path-allocation, validation, and environment-propagation
  code. They must select distinct ports and exact run-owned paths without
  cross-cleanup.
- Permit an explicitly authenticated internal no-browser fixture mode only
  after the production configuration has been established and validated. The
  fixture may replace only the final Playwright/browser execution, must consume
  the exact parent-generated configuration without choosing, replacing, or
  normalizing its identity, ports, or paths, and must remain unavailable without
  the exact internal test marker.
- Prove statically and through regression coverage that the ordinary
  real-browser path uses the identical production allocation, validation, and
  propagation code before Playwright launch.
- Preserve the first valid terminal result immutably and report duplicate,
  conflicting, malformed, or missing terminal behavior as a separate protocol
  outcome.
- Preserve primary outcome, cleanup outcome, protocol outcome, and
  forced-direct-child fallback as separate facts.
- Use cooperative direct-child shutdown for ordinary completion, failure, and
  catchable `SIGINT`/`SIGTERM`, with a bounded forced fallback only against the
  retained direct child when cooperation does not converge.
- Verify exact run-owned paths and allocated listeners after direct-child exit.
  Remaining observable resources fail cleanup without authorizing descendant
  inspection or signaling.
- Use monotonic bounded waits for repository-controlled protocol, process, and
  verification phases without claiming that all filesystem or OS calls are
  cancellable.
- Replace Option S topology and autonomous-recovery assertions with deterministic
  delegated-ownership, production-entrypoint, protocol-integrity, and
  concurrent-isolation coverage.

Implementation edits are limited to the smallest necessary subset of:

- `apps/web/package.json`, only if the `test:e2e` script entrypoint must change;
  dependencies and every other script remain byte-for-byte unchanged
- `apps/web/playwright.config.mjs`
- `apps/web/test/e2e-controller.mjs`
- `apps/web/test/e2e-playwright-owner.mjs`
- `apps/web/test/e2e-process-control.mjs`
- `apps/web/test/e2e-server.mjs`
- `apps/web/test/e2e-server-worker.mjs`
- `apps/web/test/e2e-harness.test.ts`
- existing E2E fixture files, only when required for focused regression
  coverage
- `apps/web/vitest.config.ts`, only to preserve the existing
  `fileParallelism: false`

Any required additional file, new helper, dependency, lockfile change,
platform ownership mechanism, or edit outside this set is an explicit scope
stop and returns the task to architecture before it is introduced.

## Out of Scope

- Product routes, dashboard UI, authentication, queries, database code,
  migrations, schemas, contracts, dependencies, or lockfile changes.
- Changes to `apps/cli`, `apps/web/next-env.d.ts`, BBX-012B status, another task,
  an ADR, or accepted product or architecture documents.
- Patching or editing Playwright or any file under `node_modules`.
- `NODE_OPTIONS`, preload interception, spawn interception, or tampering with
  Playwright's process launcher.
- Linux guardians, subreapers, cgroups, `/proc` ownership parsers, or autonomous
  recovery processes.
- Windows Job Objects, PowerShell/native supervisors, platform binaries, or
  other native ownership helpers.
- PID or resource registries.
- Broad process enumeration as cleanup authority; process-name killing;
  reconstructed descendant-PID or PGID targeting; prefix cleanup; sibling
  cleanup; shared-parent deletion; or signaling Playwright-created
  grandchildren.
- Synthetic claims that repository cleanup succeeds after uncatchable
  destruction of the final repository owner.
- Timeout increases, sleeps, or retries as the sole correction.
- Restoring a removed experimental supervisor file or recreating it under
  another name.
- Local Chromium or Playwright Web-server journeys, Docker, PostgreSQL, or
  network access for the implementation handoff unless a later isolated browser
  gate is explicitly authorized. Fixture-backed invocations of the real
  production controller remain in scope because they replace only the final
  browser execution after production configuration and validation.
- Committing, pushing, hosted-CI finalization, or marking this task Approved or
  Done as part of implementation.

## Architecture Constraints

### Delegated ownership boundary

- Repository ownership is limited to direct launcher/controller processes
  reachable through retained `ChildProcess` handles, run identity,
  parent-authorized listener configuration, exact run-owned paths, the terminal
  protocol, and repository-created server/controller processes that remain
  direct children of an explicit repository owner.
- Playwright owns Chromium processes, Playwright-created Web-server descendants,
  any process groups detached by pinned Playwright internals, and their normal
  cleanup during ordinary Playwright shutdown.
- Hosted CI or the containing OS job owns residual cleanup after uncatchable
  destruction of the final repository owner, Playwright internal cleanup
  failure, or detached third-party descendants that cannot be targeted exactly
  through a retained repository handle.
- Repository code may request cooperative shutdown from its direct Playwright
  CLI child and may apply forced fallback only to that exact retained direct
  child. It must not inspect or signal third-party descendant PIDs or PGIDs as
  cleanup authority and must not represent direct-child termination as proof
  that third-party descendants were forcibly cleaned.
- Repository-created controller/server children follow the same retained-handle
  rule. Each child has one explicit direct owner; ownership cannot be
  reconstructed from a PID file, process name, system-wide scan, path prefix,
  shared parent, or registry.
- Assertions may observe only current-run direct handles, allocated ports, and
  exact paths for correctness. Broader diagnostics may be recorded only when
  they do not discover or expand cleanup targets.

### Run identity, listeners, and paths

- The production entrypoint generates a cryptographically strong, high-entropy
  run identity and validates every trusted child handoff. A child cannot select
  or broaden its own cleanup root.
- The production parent authorizes one exact app port and one exact trusted
  proxy port for each run. Both are valid loopback listener ports, distinct
  within the run, and not fixed to the historical `43121`/`43122` defaults.
- Port allocation must be safe for simultaneous production-controller
  invocations: two runs cannot intentionally receive the same port, and a
  detected reservation or bind collision fails visibly rather than silently
  falling back to a shared default. Local deterministic proof uses the bounded
  fixture-backed production path. If reliable concurrent allocation requires a
  prohibited mechanism, implementation stops and returns to architecture.
- The controller propagates the validated port pair through the production
  owner, `playwright.config.mjs`, Playwright Web-server environment, trusted
  proxy, E2E server worker, and application launcher. No layer may replace the
  pair with fixed defaults.
- Output, HTML report, and terminal-result locations are exact children of one
  parent-generated run root derived from the high-entropy identity. Every layer
  validates the exact expected paths before creation, use, removal, or absence
  checks.
- A run may remove only its exact validated files and directories. Prefix
  matching, shared-parent removal, guessed paths, and cleanup of another run's
  resources are forbidden.
- Production configuration, allocation, and validation complete before any
  test-only launch selection. An exact authenticated internal marker may select
  a no-browser fixture only at the final Playwright/browser launch seam. Missing
  or invalid marker values cannot select the fixture.
- The fixture consumes the exact already-validated parent-generated identity,
  ports, output path, report path, result path, and child environment. It cannot
  choose, replace, normalize, or bypass validation of those values.
- Two simultaneous local fixture-backed invocations of the production
  `e2e-controller` entrypoint must have distinct run identities, port pairs,
  output paths, report paths, and result paths.
- The ordinary real-browser path must reach Playwright launch through the
  identical production configuration/allocation implementation used before the
  fixture seam; the test-only branch cannot provide a parallel allocator or
  validator.

### Terminal and outcome integrity

- The first valid terminal result is immutable once accepted. A later duplicate
  or conflicting terminal result cannot clear, replace, or reinterpret it.
- Duplicate, conflicting, malformed, missing, or unacknowledged terminal
  behavior is recorded as a separate protocol failure. Protocol failure affects
  terminal success but not the already-observed primary or cleanup facts.
- Primary outcome, cleanup outcome, protocol outcome, and
  forced-direct-child-fallback use remain separate through the owner,
  controller, result path, logs, and test boundary.
- A nonzero or signaled primary result remains observable when cleanup and/or
  protocol also fails. Cleanup or protocol failure cannot convert it to a
  generic replacement outcome.
- Forced direct-child fallback is immutable, separately reported, and makes
  cleanup non-clean even if the direct child later exits and observable ports
  and paths converge.
- Terminal success requires a successful primary result, successful protocol,
  cooperative direct-child shutdown without forced fallback, and successful
  exact port/path verification.

### Bounded repository lifecycle

- Ordinary completion, primary failure, controller failure, and catchable
  `SIGINT`/`SIGTERM` request cooperative shutdown from the exact direct child
  and await that child.
- Cleanup is idempotent per repository-owned process: all callers converge on
  the same promise and preserve the same recorded outcomes.
- Repository-controlled protocol waits, direct-child exit waits, forced
  fallback waits, and observable verification phases use monotonic deadlines
  with explicit bounds.
- The task does not claim an absolute total upper bound for uncancellable
  filesystem or operating-system calls. The Vitest hook timeout remains a
  safety limit, not proof that every OS operation is cancellable.
- After direct Playwright CLI exit, repository code may remove only its exact
  validated run-owned paths and must verify those paths are absent and its
  allocated ports are free. If an exact path or port remains observable,
  cleanup fails visibly without inspecting, signaling, or broadening authority
  to an unowned descendant.
- Uncatchable destruction of the final repository owner is outside the
  repository cleanup guarantee. Tests must state this boundary and must not
  assert autonomous or exact third-party cleanup success.

## Required Changes

### Mandatory reset-to-recovery gate

Before editing lifecycle behavior:

1. Confirm branch `main`, the reported commit containing this unchanged
   `Approved` task as the implementation baseline, an empty index, no untracked
   files, and exactly 36 unstaged `apps/web/**` paths. That baseline must
   descend from amendment checkpoint
   `7f7f40e5ee3990cdce9862fd655e2f4ff45243be` without changing the 36 Web paths.
2. Recompute the eight-file Option S fingerprint against
   `8f61b75aaaa858d3a2a62959e7f26fdc1cf62f04`. Stop if it is not
   `03e205ad26a733a41a31c8723bdd95ff3531dfab`.
3. Restore only the eight named Option S files to their Option R/product-baseline
   bytes. Do not broadly restore, reset, delete, or stage the Web tree.
4. Before any Option D edit, prove and record all of the following:
   - the effective `apps/web` tree equals
     `8f61b75aaaa858d3a2a62959e7f26fdc1cf62f04` except for exactly
     `fileParallelism: false` in `apps/web/vitest.config.ts`;
   - `git diff -- apps/web | git hash-object --stdin` yields recovery
     fingerprint `32b44cec3227725c28d48dd5f1a59d614f45d9c8`;
   - `apps/cli` is identical to
     `1c263cc49ee687cfb15404736968488ecb2865c4`;
   - the index remains empty, no untracked files exist, and the same 36 recovery
     paths remain unstaged.

If any proof fails, stop before implementation and report the exact mismatch.
Do not approximate, broadly reset, or repair an unknown baseline.

### Production run configuration

- Make the ordinary `test:e2e` entrypoint generate one validated high-entropy
  run identity, exact output/report/result paths, and one parent-authorized
  loopback app/proxy port pair.
- Propagate that exact immutable configuration through the production
  controller and owner into Playwright configuration, the trusted proxy, E2E
  server, worker, and application process.
- Remove reliance on fixed `43121`/`43122` defaults in the real entrypoint. A
  missing, malformed, mismatched, duplicated, or colliding child configuration
  must fail visibly.
- Keep each run's output, report, and result cleanup exact. Concurrent runs must
  not share or remove one another's paths.

### Direct-child lifecycle and delegated cleanup

- Retain each repository direct child's real `ChildProcess` handle until its
  exit has been observed and the owner's terminal facts are fixed.
- Route ordinary completion, failure, `SIGINT`, and `SIGTERM` through
  cooperative requests to the exact direct child and await the same idempotent
  cleanup promise.
- When bounded cooperation does not converge, target only the retained direct
  child for forced fallback and record that fallback as a separate non-clean
  fact. Do not signal a Playwright-created grandchild or process group.
- After direct-child exit, verify only the run's authorized ports and exact
  paths. Report cleanup failure if they remain observable; do not discover an
  unowned process as a new cleanup target.
- Preserve the CI/job residual boundary for uncatchable final-owner destruction
  and Playwright internal cleanup failure.

### Terminal protocol

- Accept and freeze the first valid terminal result. Keep it available even if
  another terminal message, IPC failure, cleanup failure, or forced fallback is
  observed later.
- Record duplicate or conflicting terminal results as protocol failure with
  enough bounded diagnostics to distinguish the condition without overwriting
  the first result.
- Carry primary, cleanup, protocol, and forced-direct-child facts independently
  through the production controller and final result.
- Compute terminal success only from all four facts. Preserve all failures when
  more than one fact is unsuccessful.

### Regression proof

- Cover the real production `e2e-controller` entrypoint, not a fixture-only
  launcher. Locally, the exact authenticated internal marker may replace only
  the final Playwright/browser execution after the production run identity,
  ports, paths, validation, and child environment have been established.
- Prove two simultaneous local fixture-backed invocations of that production
  entrypoint receive distinct identities, ports, output roots, report paths,
  and result paths and cannot cross-clean.
- Prove the fixture cannot select, replace, normalize, or bypass validation of
  the parent-generated configuration and is unavailable without the exact
  internal test marker.
- Add static and regression coverage proving the ordinary real-browser branch
  shares the same allocation, validation, and environment-propagation path and
  diverges only at the final Playwright/browser launch seam.
- Adapt existing success, nonzero child exit, signal, IPC disconnect, watchdog,
  startup failure, cleanup-hook, already-absent, and concurrent-run scenarios to
  the delegated boundary where still applicable.
- Replace all one-process-group/tree, exact-grandchild cleanup, and autonomous
  detached-descendant recovery expectations with direct-child and observable
  port/path assertions.
- Demonstrate regression sensitivity against the vulnerable baseline or a
  temporary local mutation. Observe the expected failure, revert the mutation
  completely, and rerun on the final state without leaving mutation artifacts.

## Acceptance Criteria

- The reset-to-recovery evidence proves the expected eight-file input
  fingerprint, effective Web tree, 36-path recovery fingerprint, unchanged CLI
  tree, empty index, and absence of untracked files before Option D edits.
- The ordinary production `test:e2e` entrypoint generates a high-entropy run
  identity, two parent-authorized per-run listener ports, and exact output,
  report, and result paths. It does not rely on fixed `43121`/`43122` defaults.
- Production run identity, port allocation, path allocation, validation, and
  environment propagation complete before any internal fixture selection. The
  ordinary real-browser path carries that exact configuration to Playwright
  config, the trusted proxy, E2E server path, and application launcher without a
  layer silently replacing it.
- An explicitly authenticated internal no-browser fixture mode can be selected
  only by the exact internal test marker and only at the final
  Playwright/browser launch seam. Without that marker it is unavailable.
- The internal fixture consumes the exact parent-generated production
  configuration. It cannot choose, replace, normalize, or bypass validation of
  the run identity, ports, output path, report path, result path, or propagated
  environment.
- Two simultaneous local fixture-backed invocations of the real production
  `e2e-controller` entrypoint receive distinct run identities, app ports, proxy
  ports, output roots, report paths, and result paths and do not signal, close,
  overwrite, or delete one another's resources.
- Static and regression coverage proves that the ordinary real-browser branch
  uses the identical configuration/allocation/validation implementation before
  Playwright launch and does not contain a parallel production configuration
  path.
- Every repository launcher/controller direct child has one explicit owner that
  retains and awaits its real `ChildProcess` handle.
- Playwright-created browser and Web-server descendants, including detached
  process groups, are explicitly Playwright-owned. Repository code does not
  inspect or signal their PIDs or PGIDs as cleanup authority and does not claim
  forced cleanup of those descendants.
- Ordinary completion, failure, `SIGINT`, and `SIGTERM` request cooperative
  shutdown from the exact direct child and await it.
- A forced fallback targets only the retained direct child, remains separately
  observable, and makes cleanup non-clean even if later verification converges.
- After direct-child exit, exact run-owned paths are absent and allocated ports
  are free. Any remaining observable path or port causes a visible cleanup
  failure without expanding cleanup authority.
- The first valid terminal result remains immutable after duplicate,
  conflicting, malformed, missing, IPC, or cleanup events.
- A duplicate or conflicting terminal result is a separate protocol failure and
  cannot erase or replace the first primary result.
- Primary outcome, cleanup outcome, protocol outcome, and forced-direct-child
  fallback are separately represented. A nonzero primary plus cleanup and/or
  protocol failure preserves every outcome.
- Repository-controlled waits use monotonic bounded phases. No contract claims
  an absolute upper bound for uncancellable filesystem or OS operations, and
  the Vitest hook timeout is only a safety limit.
- Uncatchable final-owner destruction is documented and tested as outside the
  repository cleanup guarantee; it is never asserted as successful exact
  repository cleanup.
- Vulnerable-baseline or mutation proof demonstrates that the regression tests
  fail for the invalid behavior and pass on the final implementation.
- Three independent fresh-process executions of
  `apps/web/test/e2e-harness.test.ts` pass.
- Two independent executions of `pnpm --filter @blackbox/web test` pass. The
  second starts from the exact postcondition produced by the first, not from
  broad deletion, arbitrary delay, or retry.
- Validation runs on Node `>=24 <25` and exact pnpm `11.19.0`.
- Web lint, standalone Web typecheck, pinned repository Prettier, and
  `git diff --check` pass on the final implementation state.
- `apps/web/next-env.d.ts` remains unchanged and
  `apps/web/vitest.config.ts` retains `fileParallelism: false` without a timeout
  increase.
- The final direct-child, listener, and run-owned-path audit finds no unresolved
  repository-owned child, allocated listener, or exact current-run path and
  makes no claim about forcibly targeting third-party descendants.
- Local fixture-backed evidence is limited to production configuration,
  repository-owned direct-child behavior, protocol, listener, and exact-path
  contracts. It does not claim to validate Chromium, Playwright-created
  Web-server processes, or other Playwright-owned descendants.
- No product, dependency, lockfile, task-status, ADR, new-helper, native
  boundary, or out-of-scope file change is present.
- Actual Chromium/Web-server lifecycle validation for the ordinary
  `pnpm --filter @blackbox/web test:e2e` command is deferred to a separately
  authorized browser gate or hosted CI. Hosted Linux CI remains the final
  authority for the real Playwright lifecycle and containing-job residual
  cleanup boundary.

## Required Tests

- Production-entrypoint configuration coverage invoking the real production
  `e2e-controller` and proving it generates and propagates a unique run
  identity, distinct app/proxy ports, and exact output/report/result paths
  before the final launch seam.
- Two concurrent local fixture-backed invocations of the real production
  controller proving distinct identities, ports, output roots, report paths,
  and result paths with no cross-cleanup.
- Fixture-boundary coverage proving the no-browser fixture is unavailable
  without the exact authenticated internal test marker, replaces only the final
  Playwright/browser execution, receives the exact already-validated production
  configuration, and cannot choose, replace, normalize, or bypass validation
  of any identity, port, path, or environment value.
- Static and regression coverage proving the ordinary real-browser path uses
  the identical production run-identity, port-allocation, path-allocation,
  validation, and environment-propagation code before Playwright launch.
- First-valid-terminal immutability after a duplicate result and after a
  conflicting result.
- Separate protocol-failure reporting for duplicate, conflicting, malformed,
  missing, or unacknowledged terminal behavior as applicable.
- Combined-outcome coverage in which a nonzero primary result and cleanup and/or
  protocol failure remain independently observable.
- Cooperative direct-child shutdown coverage that exits without forced fallback
  and reports clean repository cleanup.
- Forced-direct-child fallback coverage that reports non-clean cleanup without
  claiming that Playwright-owned descendants were targeted or forcibly cleaned.
- Observable remaining-port and remaining-path cases that fail visibly after
  direct-child exit without signaling or discovering an unowned descendant.
- Catchable `SIGINT` and `SIGTERM` coverage for cooperative direct-child
  shutdown and outcome preservation.
- An explicit negative assertion that uncatchable final-owner destruction is
  not repository cleanup success and has no autonomous-recovery guarantee.
- Concurrent-run path coverage proving one run cannot remove another run's
  output, report, or result path.
- Existing success, nonzero child exit, already-absent resource, material
  cleanup failure, IPC disconnect, watchdog, external teardown, and server
  startup-failure coverage adapted where compatible with Option D.
- Vulnerable-baseline or temporary-mutation proof demonstrating regression
  sensitivity, followed by a clean final-state rerun.
- Three separate fresh Vitest processes for the focused harness file and two
  separate complete Web test invocations.

## Validation

Run focused checks while editing. On the final implementation state, verify the
toolchain, run the focused harness in three independent processes, run the
complete Web suite twice, and run the static gates:

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

Record that Node satisfies `>=24 <25` and pnpm is exactly `11.19.0`. For each
local fixture-backed production-controller invocation, record the direct child
and its exit, authenticated marker use, authorized port pair, exact
output/report/result paths, primary outcome, cleanup outcome, protocol outcome,
forced-direct-child fallback, and any residual observation. Before the next
independent invocation, verify the prior run's repository-owned direct child is
exited, its allocated ports are free, and its exact paths are absent. Do not use
broad deletion, arbitrary sleep, retry, descendant-PID targeting, or process
enumeration to establish the postcondition.

The deterministic local concurrency gate must invoke the real production
`e2e-controller` entrypoint. The invocation may carry the exact authenticated
internal test marker, but the controller may act on it only after exercising the
production run-identity, port-allocation, path-allocation, validation, and
environment-propagation code; the fixture may replace only the final
Playwright/browser execution. Record that this evidence does not validate
Playwright-owned browser or Web-server descendants.

Audit the final implementation for exact direct-child handles, listener
propagation, and run-owned path validation. Confirm that no code treats a
Playwright-created descendant PID or PGID as cleanup authority and that no
fixed `43121`/`43122` production fallback remains. Also prove that fixture
selection occurs only at the final launch seam, requires the exact internal test
marker, cannot modify production configuration, and shares all pre-launch
allocation and validation code with the ordinary real-browser branch.

Do not require local Chromium/Web-server journeys, Docker, PostgreSQL, or
network access for the implementation handoff. Actual lifecycle validation of
the ordinary `pnpm --filter @blackbox/web test:e2e` command is deferred to a
separately authorized browser gate or hosted CI. The local no-browser fixture
must not be reported as evidence about Playwright-owned descendants. Hosted
Linux CI is the final authority for the real Playwright lifecycle. A local pass
does not authorize push or substitute for independent review and hosted-CI
gates.

## Deliverables

- Recorded eight-file reset-to-recovery proof, distinct from the Option D
  implementation delta.
- The smallest allowed-file Option D implementation for production per-run
  configuration, retained direct-child lifecycle, delegated Playwright
  ownership, exact path/listener verification, and immutable terminal facts.
- Deterministic fixture-backed production-entrypoint, concurrent-isolation,
  fixture-boundary, real-browser shared-configuration, terminal-protocol,
  cooperative-shutdown, forced-fallback, residual-resource, signal, and
  combined-outcome regressions.
- Vulnerable-baseline or mutation evidence showing that the tests detect the
  invalid behavior.
- A compact implementation report listing changed files, exact commands and
  results, acceptance status, deviations, and residual risks, while separating
  pre-existing recovery state, the mandatory reset, and final Option D changes.

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

- Concurrent port selection can contain a reservation-to-bind race. The
  production allocator, collision handling, and simultaneous-entrypoint test
  must prove the achievable contract; needing a prohibited supervisor or
  dependency patch is a stop condition.
- Playwright can leave detached descendants after its direct CLI child exits.
  Option D reports observable residual ports or paths as cleanup failure and
  delegates final residual cleanup to the CI/job boundary instead of making a
  false ownership claim.
- Duplicate terminal messages can obscure a valid primary result. Immutable
  first-valid storage and a separate protocol outcome preserve attribution.
- Forced direct-child exit can be mistaken for clean convergence. The forced
  fact is immutable and always makes repository cleanup non-clean.
- Filesystem and OS operations can outlive JavaScript timing assumptions.
  Monotonic phase bounds and a separate Vitest safety timeout avoid presenting
  a hook deadline as an absolute cancellation guarantee.
- Shared ports or paths can make concurrent runs interfere. Parent-authorized
  per-run configuration, high-entropy identity, exact validation, and
  fixture-backed production-controller concurrency tests are mandatory.
- A no-browser fixture can accidentally become a parallel configuration path or
  mask production drift. Selecting it only after production configuration,
  requiring the exact internal marker, forbidding fixture mutation, and testing
  the shared real-browser pre-launch path mitigate that risk.
- Local fixture coverage cannot validate Playwright's actual browser or
  Web-server descendant lifecycle. That residual platform risk remains assigned
  to the separately authorized browser gate or hosted Linux CI and must be
  reported without overstating local evidence.
- The dirty recovery state can obscure scope. Exact fingerprints, the mandatory
  reset gate, and separate reporting of recovery/reset/Option D changes prevent
  silent misattribution.

## Open Questions

None before approval. If reliable concurrent port allocation or the required
direct-child lifecycle needs Playwright patching, preload interception, a
guardian, native supervision, descendant-PID authority, a registry, or another
prohibited boundary, implementation must stop and return to architecture. It
must not approximate the guarantee or silently restore Option S claims.

## Implementation Prompt

Use only after this unchanged amended task is `Approved` and tracked in the
reported baseline commit. Replace `<APPROVED_BASELINE_SHA>` with that reported
commit:

```text
$bbx-implement implement the Approved Option D task in docs/tasks/BBX-012C-deterministic-web-e2e-lifecycle.md against baseline <APPROVED_BASELINE_SHA> in the saved project checkout. Before any implementation edit, verify the Option S eight-file fingerprint and complete the mandatory reset-to-recovery proof exactly as specified; stop on any mismatch. Implement only the delegated Playwright ownership design within the allowed files, including production per-run ports and exact paths, retained direct-child lifecycle, immutable first-valid terminal result with separate protocol failure, and an exact-marker internal no-browser fixture that is selectable only at the final launch seam after the real production controller has completed the shared allocation, validation, and propagation path. Prove concurrent fixture-backed production-controller isolation and statically prove the real-browser branch uses the identical pre-launch code; do not claim local validation of Playwright-owned descendants, which is deferred to an authorized browser gate or hosted CI. Run the required focused, mutation-sensitivity, and final validation evidence, separate recovery/reset/Option D changes in the compact report, and stop ready for independent review without staging, committing, pushing, or finalizing. Return to architecture if any prohibited ownership mechanism is required.
```

## Review Prompt

Use after implementation and replace `<APPROVED_BASELINE_SHA>` with the same
reported baseline commit:

```text
$bbx-review independently review the Option D implementation against docs/tasks/BBX-012C-deterministic-web-e2e-lifecycle.md and baseline <APPROVED_BASELINE_SHA> in the saved project checkout. Verify the complete diff and reset evidence; the delegated repository/Playwright/CI ownership boundary; production per-run identity, ports, and exact paths; retained direct-child-only lifecycle; immutable first-valid terminal result and separate outcome facts; and residual-resource failure without descendant targeting. Verify that concurrent local tests invoke the real production controller, the exact-marker no-browser fixture can replace only the final launch and cannot alter or bypass production configuration, and static/regression evidence proves the ordinary real-browser path uses the identical pre-launch allocation, validation, and propagation code. Ensure local fixture evidence does not claim validation of Playwright-owned descendants and that actual browser lifecycle validation is deferred to an authorized gate or hosted CI. Verify regression sensitivity, scope, and all required validation. Do not edit files. Report the compact review result with PASS or NEEDS FIXES and stop without committing, pushing, or finalizing.
```
