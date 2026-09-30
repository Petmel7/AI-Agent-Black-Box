# ADR-0009: Codex Exec JSONL Adapter Boundary

- **Status:** Accepted
- **Date:** 2026-09-30
- **Decision owners:** Project architecture

## Context

AI Agent Black Box v0.1 supports one provider, Codex, and must connect provider
observations to the collector-owned run without depending on undocumented local
files or preventing the agent from completing when telemetry degrades.

Codex documents `codex exec --json` as a stable non-interactive command whose
standard output is a JSON Lines event stream. Documented event families include
`thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `item.*`, and
`error`; documented item families include command executions, file changes, MCP
tool calls, web searches, messages, reasoning, and plan updates.

Codex also exposes user-level OpenTelemetry and notification configuration, and
other Codex surfaces expose hooks, the SDK, and app-server protocols. Those
alternatives either require machine-local configuration, cover a different
lifecycle, or introduce a larger and less stable integration boundary than the
first local end-to-end slice needs.

The choice is provider-specific, changes the wrapped-process stdio boundary,
and defines which provider claims may become canonical evidence. It therefore
meets the ADR criteria in `docs/architecture/overview.md`.

## Decision

### Supported surface

Use a fresh, non-interactive `codex exec --json` invocation as the only Codex
telemetry transport for v0.1. Add a dedicated Black Box command that launches
the installed `codex` executable directly, prepends `exec --json`, and passes a
validated argument vector without a shell.

The adapter supports one fresh Codex exec session in the repository captured by
the surrounding Black Box run. Resuming an earlier Codex session, changing the
Codex working root independently of the captured repository, or supplying a
second JSON-output flag is rejected before run creation. Codex authentication,
model selection, sandboxing, approvals, and user configuration remain owned by
Codex; Black Box does not read or persist Codex credentials or auth files.

The generic `blackbox run -- <command>` boundary remains available and retains
its inherited-stdio behavior. It does not gain implicit Codex parsing.

### Stream boundary and child isolation

For the dedicated Codex command, stdin and stderr remain attached to the child
according to the existing wrapped-process contract. Stdout is a pipe because it
is the documented JSONL transport. The collector incrementally validates the
stream and forwards the original bytes to the caller with backpressure; it does
not rewrite, prefix, reorder, or persist the raw stream.

Line size, buffered bytes, event count, parse work, and adapter state are
bounded. Split lines, multiple lines per chunk, CRLF, and a final unterminated
line are handled explicitly. A malformed, excessive, duplicate, conflicting,
or unsupported observation degrades adapter evidence visibly but the collector
continues draining the pipe and waits for the child's actual close. Adapter,
stdout, capture, checkpoint, or delivery failure never replaces the Codex exit
or supported-signal result.

The raw JSONL transport is untrusted provider input. It is never inserted into
canonical payloads, diagnostics, logs, or artifacts, including when the
`provider-payload` capture class is enabled. This avoids retaining reasoning or
other provider fields that the canonical schema does not permit.

### Identity and state machine

Black Box creates the canonical `runId` before Codex starts and passes it only
through the existing `BLACKBOX_RUN_ID` child environment variable. The adapter
binds the first valid `thread.started.thread_id` to that run in memory and uses
it as `source.nativeSessionId` on later mapped events. Provider item IDs may be
retained as bounded `source.nativeEventId` values, but canonical event and
operation UUIDs remain collector-owned.

The adapter maintains a bounded per-run state machine. A native item identity
maps to at most one canonical operation identity. Exact duplicate observations
are ignored; conflicting reuse, impossible transitions, a second thread, or
events before the thread binding produce safe collection degradation rather
than rewritten or fabricated evidence. Missing starts or finishes remain
incomplete unless the provider observation itself safely supplies the terminal
fact.

Provider timestamps are used as `occurredAt` only when the documented event
supplies a valid timestamp. `observedAt` and canonical sequence remain
collector-owned and define accepted ordering.

### Canonical mapping

Map only validated, observable provider facts:

- command execution items map to `command.started` and `command.finished`;
- MCP tool-call and web-search items map to `tool.call.started` and
  `tool.call.finished` when stable identity and lifecycle fields are present;
- completed file-change items may map to a metadata-only tool operation and
  request a bounded Git checkpoint, but the checkpoint remains temporal Git
  evidence rather than proof that Codex caused a change;
- provider `error` and `turn.failed` observations map to `error.observed` with
  safe bounded codes and content-capture semantics;
- `turn.completed.usage` maps reported token measurements to
  `usage.observed`; unavailable measurements remain explicitly unavailable and
  totals are not invented by arithmetic;
- agent messages and plan updates are not canonical v1 event kinds and are not
  persisted in BBX-008;
- reasoning items are ignored and never captured or persisted.

Command text, working directories, stdout, stderr, and tool input/output use the
corresponding existing capture classes. Provider error messages use the
`provider-payload` class, but the containing raw provider object is never
persisted. Task description remains omitted in BBX-008 rather than being
inferred from process arguments or stdin. Metadata-only remains the default.
Provider status never becomes a test result, and a successful command never
becomes `test.run.finished` without independent test evidence.

Unknown event or item kinds are forward-compatible transport input but are not
silently reinterpreted. The adapter records one bounded, content-free
unsupported-observation diagnostic when ownership permits and continues the
run. Adding a new canonical mapping requires documented provider semantics and
tests; changing the canonical wire contract requires its own schema decision.

### Git checkpoints and lifecycle ordering

The adapter may request a checkpoint only after a validated completed
file-change item. Requests are coalesced and capped per run. Checkpoint capture
must not block JSONL draining, cannot overlap another Git capture, and remains
best-effort within the existing Git bounds. Failure omits that checkpoint and
does not disable later provider evidence or replace the child result.

The composed ordering is:

```text
run.started
→ before Git snapshot
→ codex spawn
→ mapped Codex observations and optional checkpoints
→ actual codex close and complete stdout drain
→ after Git snapshot and comparison
→ run.finished and close
→ optional run-scoped delivery
```

All adapter observations must be durable before final Git evidence and terminal
run closure. Existing signal-path delivery restrictions remain unchanged.

### Compatibility boundary

The adapter validates only fields it consumes and discards unknown properties;
it does not persist arbitrary provider objects. Compatibility is capability- and
shape-based around the documented JSONL families rather than tied to one Codex
patch release. Fixtures cover the documented sample plus the supported native
item shapes. A provider change that removes or changes required semantics yields
explicit unavailable/degraded evidence, not guessed compatibility.

## Consequences

### Positive

- The first Codex path uses a documented stable command and requires no global
  telemetry configuration or local receiver service.
- Canonical identities, redaction, durability, Git evidence, and child outcome
  remain collector-owned.
- Raw prompts, reasoning, and provider payloads stay out of the spool by
  default and by construction.
- Unknown future events can pass through stdout without being misrepresented as
  evidence.

### Negative

- v0.1 records non-interactive Codex exec runs, not the interactive TUI,
  desktop app, cloud tasks, or previously started sessions.
- The adapter must pipe stdout and implement bounded JSONL framing and
  backpressure safely.
- Some useful provider observations remain unavailable until their documented
  semantics can be mapped without changing the canonical schema.
- Checkpoints are best-effort and temporal; they do not establish causality.

## Alternatives Considered

### Configure Codex OpenTelemetry automatically

Rejected for v0.1. Telemetry routing is machine-local user configuration and is
ignored in project-local config. Mutating it would cross a user configuration
boundary, require a receiver/exporter lifecycle, and risk interfering with the
developer's existing telemetry policy.

### Use `notify` or lifecycle hooks

Rejected as the primary transport. Notifications do not provide the complete
documented exec event stream, and hooks add trust/install/configuration concerns
that are unnecessary for a wrapped non-interactive run.

### Read Codex rollout/session files

Rejected because their local format and location are not the approved telemetry
contract, may contain prompts or reasoning, and would couple evidence to
undocumented storage internals.

### Integrate the Codex SDK or app server

Deferred. These surfaces would make Black Box an orchestration client rather
than a wrapper and materially enlarge authentication, protocol, and lifecycle
scope.

### Parse human-readable terminal output

Rejected because it is presentation output, not a stable machine contract.

## Follow-up

BBX-008 implements this adapter and closes the first local Codex recording
path. BBX-009 builds replayable projections from canonical evidence only. A
future adapter task may evaluate OTel, hooks, interactive sessions, or another
Codex surface through a separate decision.

## References

- [Codex non-interactive mode](https://developers.openai.com/codex/noninteractive)
- [Codex CLI reference](https://developers.openai.com/codex/cli/reference)
- [Codex configuration reference](https://developers.openai.com/codex/config-reference)
- [v0.1 product scope](../../product/v0.1-scope.md)
- [Canonical Evidence Model](../evidence-model.md)
- [ADR-0006](ADR-0006-local-spool-and-delivery-state.md)
- [ADR-0007](ADR-0007-collector-redaction-and-bounded-capture.md)
- [ADR-0008](ADR-0008-local-git-evidence-and-attribution.md)
