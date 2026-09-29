# BBX-006C: Wrapped Process and Recovery

- **Status:** Approved
- **Owner:** Implementation Chat
- **Review:** Review Chat
- **Depends on:** BBX-006B completed at `9c1d60bc71ea8eeac6e58801330631361e6bda56`
- **Architecture:** Accepted ADR-0006 and ADR-0007

## Goal

Implement the `blackbox run -- <command> [arguments...]` lifecycle around the
completed collector and delivery boundaries while proving that configuration,
capture, delivery, and recovery failures after child launch cannot replace the
child's exit or supported signal outcome.

## Context

BBX-006A owns durable run identity, redacted observations, run leases, immutable
events, batching, and interrupted recovery. BBX-006B owns one finite,
run-filtered `DeliveryCoordinator.drain(runId)` operation and explicit offline
behavior. This task composes those public boundaries; it must not bypass the
spool, duplicate delivery logic, or introduce Codex telemetry behavior reserved
for BBX-008.

The current session lease defaults to 30 seconds and exposes no renewal method.
Long-lived child processes therefore require a narrow, ownership-checked lease
heartbeat boundary. The current CLI also returns only an exit code; signal
termination requires an explicit reusable-runner result and a bin-level host
termination boundary.

## Architecture Decision

No new ADR is required. ADR-0006 already fixes durable pre-launch identity,
post-launch isolation, signal forwarding, interrupted recovery, and bounded
lifecycle delivery. ADR-0007 already fixes pre-launch validation and fail-closed
capture. This task adds no process boundary, durable store, canonical schema,
provider lock-in, or new consistency guarantee beyond those decisions.

If implementation requires process-tree supervision, a background daemon,
persisted signal intent, a canonical event-contract change, or provider-specific
launch behavior, stop and request a new architecture decision.

## In Scope

- Strict `blackbox run -- <command> [arguments...]` CLI parsing.
- Direct child spawning with exact argument-array, working-directory,
  environment, stdio, exit, error, and supported-signal handling.
- Durable run creation and `run.started` before spawn, run-lease heartbeat while
  the child is active, and one terminal `run.finished` when ownership permits.
- One optional bounded, run-scoped BBX-006B drain after a normally observed
  child exit.
- Safe post-launch degradation, interrupted-run recovery, and content-free
  warning behavior.
- Deterministic unit, temporary-spool, and isolated subprocess tests on the
  repository's supported platforms.

## Out of Scope

- Codex executable discovery, installation, authentication, hooks, OTel,
  telemetry parsing, provider-native IDs, or adapter mapping; BBX-008 owns them.
- Git snapshots, status, diffs, or attribution; BBX-007 owns them.
- Command/tool/test events, stdout/stderr capture, shell emulation, terminal
  multiplexing, live streaming, process-tree/job-object supervision, or PTY
  behavior.
- New canonical event kinds or changes to BBX-004/005/006B protocols.
- Background delivery, scheduled retry, automatic cleanup/retention, spool
  encryption, Docker, PostgreSQL/Supabase, dashboard, or analysis behavior.

## CLI and Spawn Boundary

- Accept exactly `blackbox run -- <command> [arguments...]`. Require the
  delimiter and a non-empty command. Reject collector options before the
  delimiter until a later approved task defines them.
- Parse global help/version only before selecting `run`; child arguments such as
  `--help`, `--version`, spaces, quotes, glob characters, pipes, redirects,
  command substitutions, and shell metacharacters must pass unchanged.
- Spawn the command directly with an argument array and `shell: false`. Never
  concatenate, quote, escape, or reinterpret a shell command string.
- Use the caller's current working directory and inherited stdin/stdout/stderr.
  The collector does not read, capture, prefix, buffer, or transform child
  stdio in this task.
- Do not call `process.exit()` or send a signal from reusable modules. Return a
  strict internal termination result to the executable boundary, which alone
  applies the final exit code or supported signal after cleanup.
- Existing `status`, `retry`, help, and version behavior remains compatible and
  does not inherit `run` parsing rules accidentally.

## Child Environment and Secret Isolation

- Construct a copied child environment. Remove collector-control variables with
  a case-insensitive `BLACKBOX_` prefix, then inject only the canonical
  `BLACKBOX_RUN_ID` needed by BBX-007/008 correlation.
- Never expose `BLACKBOX_API_TOKEN`, redaction literals, literal-file paths,
  spool paths, delivery limits, signed capabilities, or internal lease tokens
  to the child.
- Preserve non-collector environment variables exactly, including Windows
  case-insensitive key semantics. Reject ambiguous duplicate keys rather than
  selecting a secret-bearing value unpredictably.
- Do not print the complete environment, command, arguments, working directory,
  raw spawn error, or credential-bearing configuration.

## Initialization and Run Evidence

- Before spawn: validate local/redaction/delivery configuration, open and migrate
  the spool, create the durable run UUID, and commit exactly one `run.started`.
  Any failure before these steps complete prevents child launch and returns a
  collector failure.
- BBX-006C does not add provider selection. Use the existing v0.1 Codex
  run-start identity and do not accept provider/adapter values from CLI input.
  BBX-008 may later replace the composition boundary with documented Codex
  telemetry without changing the run ID.
- Start duration measurement from the successful child `spawn` observation,
  using a monotonic clock. Do not infer duration from wall-clock timestamps.
- Map a normal exit code `0` to `succeeded`, a normal non-zero exit to `failed`,
  and an observed signal termination to `cancelled`. Persist a non-negative
  bounded `durationMs` when the terminal event can be written.
- A spawn error means no child outcome exists. Attempt to record a failed
  terminal observation and close the run when ownership is still valid, then
  return the documented collector/launch failure code.
- Commit at most one terminal event. Close the run only after that event is
  durable. Never manufacture `run.finished` after a collector crash or after
  run ownership is lost.

## Run Lease and Failure Isolation

- Add the minimum safe `CollectorSession` API needed to create a bounded run
  lease and renew it with the existing owner token. Do not expose `LocalSpool`,
  the token, arbitrary event insertion, or caller-selected timestamps.
- Renew well before expiry while the child is active. Heartbeat interval and
  lease duration must be bounded, validated, dependency-injectable for tests,
  and related by an enforced invariant that tolerates the configured SQLite
  busy timeout plus a transition margin.
- Serialize heartbeat, terminal observation, close, and disposal so a late
  timer cannot write after terminal state or resource disposal. Remove all
  timers and listeners on every exit path.
- A renewal/capture/close failure after spawn emits at most one stable safe
  warning, stops further canonical writes when ownership is uncertain, leaves
  existing evidence untouched, and continues waiting for the child.
- If terminal evidence cannot be committed, dispose without closing the run.
  Lease expiry and existing recovery must mark it `interrupted`; do not replace
  uncertainty with a fabricated terminal outcome.
- Backend offline state, delivery failure, blocked work, timeout, or BBX-006B
  bounds never changes the child termination result.

## Signal and Termination Semantics

- Forward only the platform-supported set: `SIGINT` and `SIGTERM` everywhere
  Node supports them, plus `SIGHUP` on POSIX and `SIGBREAK` on Windows. Forward
  to the direct child only; process-tree supervision is out of scope.
- Install handlers only for the active child lifecycle and restore/remove them
  deterministically. Do not leak listeners across repeated programmatic runs.
- A forwarded signal is an observation/request, not proof of child termination.
  Wait for the child's actual `close` result and derive evidence from that
  result. A child that exits normally after handling a signal keeps its actual
  normal exit code.
- When the child actually terminates by a supported signal, finish local
  evidence cleanup without starting remote delivery, then have the executable
  boundary reproduce the same signal where the host supports it. On platforms
  where Node cannot reproduce that signal, return a documented non-zero
  fallback without claiming exact signal equivalence.
- Repeated signals must not duplicate terminal evidence, disposal, warnings, or
  delivery. They may be forwarded while the child remains active.

## Lifecycle Delivery

- Do not make network access a precondition for spawn. Delivery configuration
  may be explicitly offline.
- After a normally observed exit and durable run closure, open the BBX-006B work
  facade and perform at most one configured `drain(runId)` when remote delivery
  is configured.
- Do not perform a remote drain after actual signal termination. Retained local
  work remains available to `blackbox retry` so signal propagation is not
  delayed by network timeout.
- Drain only the completed run. Never deliver unrelated runs or replace the
  child exit code with the drain's `0`/`1`/`2` CLI semantics.
- Delivery exceptions and non-empty remaining work emit at most the same
  content-free degradation warning and remain visible through `status`/`retry`.
  Do not print `DeliveryDrainResult` during `run`.

## Exit and Output Contract

- For a normally closed child, return its exact integer exit code after bounded
  lifecycle work, including non-zero codes. Collector degradation after spawn
  cannot replace it.
- When initialization or spawn fails before a child outcome exists, return `1`.
  The same numeric value may also be the exact exit code of a successfully
  spawned child; do not reserve or reinterpret any child exit code.
- Child stdio remains byte-for-byte inherited. Collector routine output must not
  contaminate stdout. Emit at most one post-launch warning to stderr using a
  stable safe code and bounded text with no raw cause.
- The run ID is communicated to the child through `BLACKBOX_RUN_ID`; this task
  does not add routine run metadata to stdout.

## Required Tests

- Strict parsing: missing delimiter/command, unknown collector options, and
  child `--help`/`--version` plus spaces, empty arguments, quotes, Unicode, and
  shell metacharacters pass exactly without shell execution or injection.
- Initialization: invalid config, migration/open failure, and durable-run/start
  failure prove the child marker is never created.
- Process outcomes: real isolated children exit with `0`, representative
  non-zero values, spawn error, and supported signals; the executable boundary
  preserves each supported outcome under platform-specific assertions.
- Stdio/cwd/environment: inherited streams work, cwd is unchanged, non-collector
  environment survives, `BLACKBOX_RUN_ID` matches the durable run, and all
  case variants of collector secrets/configuration are absent.
- Lease: a child outlives the initial lease, heartbeat contention remains safe,
  terminal write races with the heartbeat, renewal failure preserves the child
  outcome, and no timer/listener/file descriptor survives completion.
- Failure injection after spawn covers run-start follow-up, terminal append,
  close, batch preparation, configured/offline drain, delivery throw/timeout,
  and warning failure without replacing the child outcome or duplicating work.
- Crash recovery: abrupt collector termination produces no fabricated terminal
  event; after lease expiry, recovery marks the run interrupted and retained
  events remain batchable/retryable.
- Signal tests run the built CLI in an isolated subprocess, verify forwarding
  and listener cleanup, and avoid signaling the test runner or unrelated
  processes.
- Complete stdout/stderr, child environment, SQLite/WAL/SHM, artifact, and
  request-sentinel scan contains no collector credential, capability, lease
  token, raw error, or private path beyond explicitly permitted redacted data.
- A no-op child proves collector-created files remain outside the captured
  repository. Any source-tree mutation must come only from the child fixture.

## Acceptance Criteria

- Durable run identity and `run.started` exist before the child starts, and a
  long child retains valid ownership through a bounded heartbeat.
- Exact argument, cwd, environment, stdio, exit code, and supported signal
  semantics are preserved without invoking a shell.
- Collector or backend failure after spawn cannot replace the child result,
  fabricate terminal evidence, delete retained work, or expose secrets.
- A successful terminal observation is unique, includes monotonic duration,
  and is followed by a legal run close; otherwise the run becomes visibly
  interrupted after lease recovery.
- Normal completion may perform one bounded run-scoped delivery drain; signal
  completion and offline mode remain recoverable without network dependence.
- No collector operation modifies the captured repository, and BBX-007/008
  responsibilities remain unimplemented.

## Validation

```text
pnpm install --frozen-lockfile
pnpm --filter @blackbox/cli test
pnpm format:check
pnpm lint --force
pnpm typecheck --force
pnpm test --force
pnpm build --force
git diff --check
git status --short --untracked-files=all
```

Tests may use isolated child processes, ephemeral loopback ports, and unique
temporary directories. They must not invoke a real Codex installation, start
Docker, access PostgreSQL/Supabase or an external network, install global
services, or signal any unrelated process without explicit user authorization.

## Deliverables

- Reusable process-runner and executable termination boundary.
- Strict `blackbox run -- ...` CLI composition.
- Safe child-environment builder and signal-forwarding lifecycle.
- Minimal run-lease heartbeat extension to `CollectorSession`/spool boundary.
- Run-finished duration support and bounded run-scoped delivery composition.
- Updated CLI/root documentation, environment guidance, and recovery runbook.
- Deterministic process, signal, lease, recovery, isolation, and secret tests.

## Referenced Documents

- `AGENTS.md`
- `docs/product/v0.1-scope.md`
- `docs/architecture/overview.md`
- `docs/architecture/v0.1-delivery-sequence.md`
- `docs/architecture/evidence-model.md`
- `docs/architecture/decisions/ADR-0002-canonical-evidence-envelope.md`
- `docs/architecture/decisions/ADR-0006-local-spool-and-delivery-state.md`
- `docs/architecture/decisions/ADR-0007-collector-redaction-and-bounded-capture.md`
- `docs/tasks/BBX-006A-local-spool-and-redaction-foundation.md`
- `docs/tasks/BBX-006B-collector-delivery-and-process-recovery.md`
- `docs/review-guidelines.md`

## Risks

- Windows and POSIX signal and environment semantics differ materially.
- Direct-child forwarding does not control descendants that outlive the child.
- Synchronous SQLite contention can delay a heartbeat; renewal must retain a
  sufficient invariant margin without blocking the child lifecycle indefinitely.
- A hard collector kill can leave the child running and the run incomplete;
  v0.1 exposes interruption but does not provide a supervisor daemon.
- The bounded post-exit drain intentionally delays normal CLI return, but never
  changes the child's result.

## Open Questions

None. Approval confirms direct-child-only supervision, current v0.1 Codex
run-start identity, collector-variable filtering, no remote drain after signal
termination, and platform-specific fallback where exact signal reproduction is
unsupported.
