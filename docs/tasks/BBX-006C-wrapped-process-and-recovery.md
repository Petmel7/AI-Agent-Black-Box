# BBX-006C: Wrapped Process and Recovery

- **Status:** Draft
- **Owner:** Implementation Chat
- **Review:** Review Chat
- **Depends on:** BBX-006B completed and committed
- **Architecture:** Accepted ADR-0006 and ADR-0007

## Goal

Add the generic `blackbox run -- <command>` lifecycle on top of the completed
collector and delivery boundaries while proving that collector or backend
failure after launch cannot replace the wrapped process outcome.

## Intended Scope

- Strict CLI argument boundary and `shell: false` argument-array spawning.
- Durable run creation before launch, collector-owned lifecycle observations,
  stdio inheritance, supported signal forwarding, and exact child exit/signal
  propagation.
- Bounded best-effort delivery at lifecycle boundaries through BBX-006B.
- Safe warning, interrupted-run recovery, and retained pending/blocked work when
  capture or delivery fails after launch.
- Cross-platform deterministic process tests for zero/non-zero exits, signals,
  metacharacter arguments, initialization failure, collector failure, and
  backend outage.

## Explicit Boundaries

- No Codex-specific launch, hooks, telemetry, or provider mapping; BBX-008 owns
  those integrations.
- No Git capture; BBX-007 owns it.
- No fabricated `run.finished` after collector crash.
- No background daemon or deletion of unacknowledged evidence.

## Architecture Decision

No new ADR is currently required because ADR-0006 already defines process
isolation and recovery semantics. This task must return to `Proposed` with full
acceptance criteria only after BBX-006B fixes the concrete delivery-coordinator
boundary it will consume.

## Referenced Documents

- `AGENTS.md`
- `docs/product/v0.1-scope.md`
- `docs/architecture/overview.md`
- `docs/architecture/v0.1-delivery-sequence.md`
- `docs/architecture/decisions/ADR-0006-local-spool-and-delivery-state.md`
- `docs/architecture/decisions/ADR-0007-collector-redaction-and-bounded-capture.md`
- `docs/tasks/BBX-006A-local-spool-and-redaction-foundation.md`
- `docs/tasks/BBX-006B-collector-delivery-and-process-recovery.md`

## Risks

- Windows and POSIX exit/signal behavior differs materially.
- A collector failure after launch can leave incomplete canonical evidence;
  recovery must expose uncertainty without changing the child outcome.

## Open Questions

- Finalize the delivery coordinator's public result and cancellation boundary
  after BBX-006B implementation.
