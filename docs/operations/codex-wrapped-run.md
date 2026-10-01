# Codex wrapped runs

`blackbox codex` records one fresh, local, non-interactive Codex session through
the documented JSONL transport:

```sh
blackbox codex -- "implement the requested change"
blackbox codex -- -
blackbox codex --
```

The second form asks Codex to read instructions from inherited stdin. The third
uses Codex's omitted-prompt stdin behavior. Black Box launches the installed
`codex` executable directly, with no shell, as `codex exec --json` followed by
the exact allowed argument vector. It does not install Codex or inspect or
change Codex authentication and configuration.

## Argument boundary

The `--` delimiter is required. Black Box rejects `resume` and `review` only in
the Codex exec subcommand position. It also rejects another `--json`,
`--cd`/`-C`, and `--add-dir` before it creates a run. These forms could select
another transport or detach execution from the Git worktree being recorded.
The reserved words remain valid as option values or prompt content. Model,
profile, sandbox, approval, ephemeral, output-schema, and output-last-message
selections pass through unchanged.

The generic `blackbox run -- <command>` command remains unchanged and does not
parse Codex output.

## Transport and mapped evidence

Codex stdin and stderr retain the wrapped-process behavior. JSONL stdout is
piped only so the adapter can validate it; the original bytes are forwarded in
order with backpressure and are never rewritten or stored by Black Box. The
adapter handles split UTF-8, split lines, multiple lines per chunk, CRLF, and a
final line without a newline.

After the first valid `thread.started`, its bounded `thread_id` becomes the
native session correlation value. Bounded item IDs become native event
correlation values. Black Box always creates the canonical event and operation
UUIDs itself. `turn.started` opens one bounded turn lifecycle and
`turn.completed` or `turn.failed` closes it. Exact anonymous replays deduplicate
within that turn; identical anonymous observations in a later valid turn remain
distinct evidence. Native-ID replay and conflict protection remains run-global.
Missing, repeated, or conflicting turn transitions produce safe diagnostics.
Supported observations are:

- command execution starts and completions → `command.started` and
  `command.finished`;
- MCP-call and web-search starts and completions → `tool.call.started` and
  `tool.call.finished`;
- completed file changes → a metadata-only `file-change` tool operation and a
  best-effort Git checkpoint request;
- provider errors and failed turns → `error.observed`;
- reported turn usage → `usage.observed`.

Agent messages, plans, and reasoning are not persisted. Command success is not
treated as test evidence, and this adapter never emits `test.run.finished`.
Unknown provider properties are discarded. Unknown kinds produce a bounded,
content-free diagnostic and are not guessed into canonical evidence.

Usage records contain only measurements supplied by the same observation.
Missing input, output, cached-input, and reasoning token values are marked
`not-reported`; total tokens and cost are never calculated.

## Capture and privacy

Collection remains metadata-only by default. `command`, `working-directory`,
`stdout`, `stderr`, `tool-input`, `tool-output`, and `provider-payload` must be
selected independently through `BLACKBOX_CAPTURE_CLASSES`. Error message text
uses `provider-payload`. Every selected value crosses the existing strict
UTF-8, byte-bound, path reduction, and `collector-redaction-v1` boundary before
an event commit. Missing provider content is recorded as unavailable rather
than invented.

Raw JSONL objects and lines are never durable, even with `provider-payload`
enabled. Prompts and stdin are not task-description evidence. Reasoning,
credentials, authorization material, Codex auth/config files, and unselected
content are never captured. The spool remains unencrypted at rest; the local
threat-model limitations in the collector README still apply.

## Bounds and failure behavior

The adapter accepts at most 1,000,000 bytes per line, 2,000,000 buffered bytes,
10,000 observations, 5,000 native identities, 2,000 operations, and eight safe
adapter diagnostics. It records at most eight successful Git checkpoints per
run and separately permits at most eight failed checkpoint attempts. A failed
attempt is visible but does not consume the successful-checkpoint allowance, so
a later request can succeed until the failure limit is reached. File-change
requests are coalesced, Git captures run off the JSONL-draining event loop and
never overlap. The worker applies the same collector redaction before path
collision grouping and public manifest serialization. The owning collector
accepts only nonce-bound, structurally validated, bounded checkpoint manifests;
malformed worker output is discarded before persistence. Checkpoint evidence
remains temporal rather than causal. The final before/after Git comparison is
authoritative.

Malformed or oversized JSONL, invalid UTF-8, lifecycle conflicts, duplicate
identity conflicts, missing thread binding, premature stdout closure, capture
or checkpoint failure, spool pressure, and stdout forwarding failure degrade
collection visibly and within bounds. Draining continues. After the child has
spawned, none of these failures—and no optional delivery failure—replaces its
actual exit code or supported signal result. Exact duplicate native
observations do not create duplicate evidence.

Local lifecycle order is `run.started`, before snapshot, spawn, mapped events
and checkpoints, actual close plus complete stdout drain, final Git evidence,
`run.finished`, run close, and optional run-scoped delivery. Signal completion
still skips remote delivery. Incomplete operations remain incomplete after a
crash; recovery never fabricates finishes. Use `blackbox status` and
`blackbox retry` as described in
[local spool recovery](local-spool-recovery.md).

Compatibility is based on the documented event families and the validated
fields consumed by each mapping, not a particular Codex patch version. A shape
change that removes required semantics produces unavailable or degraded
evidence. Supporting another provider shape or canonical mapping requires a
separate approved change.
