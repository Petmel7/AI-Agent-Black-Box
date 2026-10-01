# BBX-008: Codex Adapter and Wrapped Run

- **Status:** Done
- **Owner:** Implementation Chat
- **Review:** Review Chat
- **Depends on:** BBX-007 completed at `6fb7cdde8140b9b12e9f8f46f98ab10e306747ee`
- **Architecture:** Accepted ADR-0002, ADR-0006, ADR-0007, ADR-0008, and ADR-0009

## Goal

Add the first supported Codex execution path by wrapping a fresh
`codex exec --json` run, mapping documented provider observations to immutable
canonical evidence, and composing them with the existing run, Git, recovery,
and delivery lifecycle without changing the Codex outcome.

## Context

Use the canonical v1 contracts in `packages/contracts`, the collector and
redaction boundary from BBX-006A, bounded delivery from BBX-006B, wrapped process
lifecycle from BBX-006C, and Git capture from BBX-007. ADR-0009 defines the
provider transport, mapping, privacy, compatibility, and lifecycle decisions.

## In Scope

- A dedicated `blackbox codex -- <codex-exec-arguments...>` command for one
  fresh local non-interactive Codex session.
- Direct shell-free launch of the installed `codex` executable as
  `codex exec --json`.
- Bounded streaming JSONL framing, validation, passthrough, and adapter state.
- Canonical command, tool-call, error, and usage observations supported by
  documented provider facts.
- Bounded best-effort Git checkpoints after validated completed file changes.
- Exact composition with existing run identity, Git finalization, child result,
  local spool, and optional run-scoped delivery.
- Deterministic fixtures and local fake-child/temporary-repository tests; no
  live Codex account or network call is required.

## Out of Scope

- Interactive Codex TUI, desktop app, cloud tasks, `exec resume`, `exec review`,
  or importing earlier sessions.
- Automatic OTel, `notify`, hook, plugin, SDK, app-server, config, auth, or
  rollout-file integration.
- Capturing reasoning, hidden chain-of-thought, raw JSONL, raw provider payloads,
  credentials, or auth files.
- Inferring tests from command names or exit codes; test correlation and query
  projections remain BBX-009 work.
- New canonical event kinds/schema versions, database migrations, backend
  projections, findings, summaries, dashboard, or other agent providers.
- Installing, authenticating, upgrading, or pinning the user's Codex CLI.

## Required Changes

### CLI and launch contract

- Add `blackbox codex -- <codex-exec-arguments...>` without changing the public
  behavior of `blackbox run`, `status`, or `retry`.
- Allow the documented Codex prompt forms: one argument, the `-` stdin sentinel,
  or omitted prompt with instructions read from inherited stdin. Preserve
  argument boundaries and do not invoke a shell.
- Prepend exactly `exec --json`. Reject a user-supplied JSON mode, `resume`,
  `review`, `--cd`/`-C`, `--add-dir`, or another option that can detach Codex
  execution from the repository captured by Black Box. Do not silently rewrite
  user-selected model, profile, sandbox, approval, ephemeral, output-schema, or
  output-last-message options.
- Resolve and launch `codex` through the normal executable lookup. Missing or
  unlaunchable Codex follows the existing pre-/post-spawn failure semantics and
  safe errors. Do not inspect or mutate Codex authentication/configuration.
- Keep `BLACKBOX_RUN_ID` as the collector-owned correlation value and preserve
  the existing child-environment filtering.

### JSONL transport

- Add a CLI-local adapter with explicit bounds for line bytes, buffered bytes,
  accepted observations, native identities, and in-memory operations.
- Incrementally handle arbitrary chunk splits, multiple lines per chunk, CRLF,
  UTF-8 boundaries, a final unterminated line, stdout backpressure, early pipe
  close, child error, and signal close.
- Forward original stdout bytes in order without persisting or rewriting them.
  Continue draining/forwarding after adapter degradation. Stdin and stderr keep
  the existing child-facing behavior.
- Validate provider envelopes and only the native fields consumed by a mapping.
  Ignore unknown properties. Malformed/excessive JSON, conflicting identities,
  impossible lifecycle transitions, multiple threads, and unsupported kinds
  create at most bounded safe diagnostics/evidence and never leak raw content.
- Never persist a raw JSONL line or reasoning item, including with
  `provider-payload` capture enabled.

### Identity and canonical mapping

- Bind the first valid `thread.started.thread_id` to the already-created run.
  Apply it as bounded `source.nativeSessionId` on mapped adapter events. Retain
  bounded item IDs as `source.nativeEventId` where available; generate all
  canonical event and operation UUIDs locally.
- Make native item processing idempotent in memory: exact repeated lifecycle
  observations do not duplicate canonical evidence, and conflicting reuse does
  not rewrite earlier evidence.
- Map supported command-execution starts/completions to
  `command.started`/`command.finished`. Preserve only validated status, exit,
  signal, and duration facts actually supplied by Codex. Use existing capture
  classes for command, cwd, stdout, and stderr; otherwise record omitted or
  unavailable content.
- Map supported MCP-call and web-search starts/completions to
  `tool.call.started`/`tool.call.finished` with stable operation linkage and
  existing tool input/output capture semantics.
- Treat a supported completed file-change item as a metadata-only provider tool
  observation and a checkpoint request. Git evidence and attribution remain
  governed by ADR-0008.
- Map provider `error` and `turn.failed` observations to `error.observed` with
  stable collector codes, retryability only when exposed, message capture under
  the `provider-payload` opt-in, and related operation/event IDs only when valid.
- Map `turn.completed.usage` to `usage.observed`. Record reported input, output,
  cached-input, and reasoning token counts exactly; mark missing measurements
  unavailable and do not invent total tokens or cost. Record model metadata only
  when the same provider observation supplies it.
- Do not persist agent-message, plan-update, or reasoning content. Do not emit
  `test.run.finished` in this task.
- Use provider timestamps as `occurredAt` only when supplied and valid. Preserve
  collector sequence/`observedAt` as canonical ordering.

### Collector ownership and checkpoints

- Extend `CollectorSession` through narrow adapter-owned operations. Public
  callers must not be able to append arbitrary canonical events, claim provider
  identity/redaction, inject captures/artifact references, or forge operation
  state.
- Route every opted-in content field through the existing bounded redaction
  pipeline before persistence. Metadata-only remains the default. Task
  description remains omitted in BBX-008; never infer it by logging the process
  argument vector or stdin.
- Coalesce file-change checkpoint requests, prohibit overlap, cap successful
  checkpoints per run, and keep JSONL draining independent of synchronous Git
  work. Complete or safely abandon pending adapter/checkpoint work before final
  Git capture.
- Checkpoint failure is visible and bounded but cannot disable later event
  mapping, prevent Codex completion, or fabricate causality.

### Lifecycle, durability, and documentation

- Preserve the ADR-0009 order from durable `run.started` through mapped events,
  optional checkpoints, actual close and full stdout drain, final Git evidence,
  `run.finished`, close, and optional delivery.
- Before-spawn failures retain existing collector failure semantics. After
  spawn, adapter/parser/stdout/checkpoint/spool/delivery failures never replace
  the actual Codex exit or supported-signal result, duplicate terminal evidence,
  leak listeners/handles, or enable signal-path delivery.
- Each mapped event and its redacted artifacts commit atomically under current
  run ownership. Capacity or ownership failure degrades visibly and never falls
  back to raw persistence.
- Document the supported command, argument restrictions, passthrough behavior,
  mapped/unmapped events, capture classes, privacy guarantees, bounds, failure
  behavior, recovery, and compatibility policy.

## Acceptance Criteria

- The dedicated command launches exactly one direct `codex exec --json` child
  in the captured repository with exact allowed arguments and canonical run ID;
  prohibited subcommands/root-changing/duplicate-JSON arguments fail before run
  creation or child launch as specified.
- Documented sample JSONL plus supported command, MCP, web-search, file-change,
  error, failed-turn, and usage fixtures produce valid canonical v1 events with
  correct source/session/item identity, stable operation linkage, ordering, and
  explicit unavailable fields.
- Arbitrarily chunked valid JSONL yields identical canonical semantics and
  byte-identical stdout. Backpressure cannot reorder or drop output.
- Duplicate native events do not duplicate evidence. Conflicts, out-of-order
  transitions, unknown kinds, malformed UTF-8/JSON, oversized lines, event-count
  exhaustion, missing thread binding, and premature pipe closure yield bounded
  degradation without fabricated evidence or changed child outcome.
- Reasoning, raw JSONL, prompts/stdin, credentials, unselected content, sentinel
  secrets, and private absolute paths are absent from SQLite/WAL/SHM, artifacts,
  batches, diagnostics, warnings, and collector-authored output.
- Opted-in command/tool/output/error content is bounded and redacted before any
  durable write; omitted/unavailable defaults are accurate.
- Usage records contain only provider-reported measurements; missing values and
  cost are not calculated or guessed.
- File-change bursts coalesce within the documented cap, do not stall JSONL
  draining, and produce either valid checkpoint evidence or explicit safe
  absence. Final before/after evidence remains authoritative and uncertainty
  aware.
- Normal, non-zero, signal, spawn-error, parser-degradation, checkpoint-failure,
  spool-failure, stdout-failure, offline, and delivery-failure paths preserve
  the existing wrapped lifecycle, exact child outcome, cleanup, and recovery.
- Existing generic run, status, retry, Git, delivery, redaction, sealing,
  concurrency, and public-surface behavior remains compatible.
- No dependency, lockfile, canonical contract, Prisma migration, backend, OTel,
  hook, SDK/app-server, BBX-009, or later-roadmap change is present.

## Required Tests

- Unit tests for strict provider shapes, JSONL framing, UTF-8/chunk boundaries,
  bounds, mapping, operation state, duplicates/conflicts, safe diagnostics,
  usage unavailability, and argument validation.
- Fake-child integration tests for stdout byte preservation/backpressure,
  stderr/stdin behavior, close/error/signal races, malformed and partial streams,
  parser degradation, resource cleanup, and real exit preservation.
- Collector integration tests for atomic mapped events/artifacts, sequence and
  native correlation, redaction/capture classes, quota/lease failures, restart-
  visible incomplete operations, batching, and exact delivery retries.
- Temporary-repository tests for coalesced checkpoints, file-change races,
  checkpoint failure, final Git ordering, and no collector repository mutation.
- Security tests scanning every durable and collector-authored output surface for
  prompt, reasoning, credential, sentinel, raw JSONL, and private-path leakage.
- Public-surface tests proving callers cannot inject provider events, native
  identity, canonical payloads, operation IDs, content captures, redaction
  claims, timestamps, or checkpoints with arbitrary Git bytes.
- Compatibility fixtures include the official documented JSONL example and
  supported additional item shapes without making a live Codex/network call.

## Validation

Run focused CLI checks while editing. This task changes an evidence-integrity,
provider-input, streaming, redaction, concurrency, and process-lifecycle
boundary, so run the full deterministic local gate once on the final state:

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

PostgreSQL/Supabase, Docker, external network, a live Codex account, and hosted
Git provider access are not required. Do not install dependencies or access a
network without separate explicit authorization. Use the installed Codex CLI
only for a credential-free `--version`/`exec --help` compatibility observation
when available; do not treat that observation as a live adapter test.

## Deliverables

- CLI-local Codex JSONL adapter and provider-state mapper.
- Dedicated wrapped Codex command composed with the existing collector
  lifecycle.
- Narrow CollectorSession operations and bounded checkpoint scheduling.
- Codex adapter/operator documentation and deterministic fixtures.
- Focused and final validation evidence in the compact implementation report.

## Referenced Decisions and Documents

- `AGENTS.md`
- `docs/product/v0.1-scope.md`
- `docs/architecture/overview.md`
- `docs/architecture/evidence-model.md`
- `docs/architecture/v0.1-delivery-sequence.md`
- `docs/architecture/decisions/ADR-0002-canonical-evidence-envelope.md`
- `docs/architecture/decisions/ADR-0006-local-spool-and-delivery-state.md`
- `docs/architecture/decisions/ADR-0007-collector-redaction-and-bounded-capture.md`
- `docs/architecture/decisions/ADR-0008-local-git-evidence-and-attribution.md`
- `docs/architecture/decisions/ADR-0009-codex-exec-jsonl-adapter.md`
- `docs/tasks/BBX-006C-wrapped-process-and-recovery.md`
- `docs/tasks/BBX-007-git-before-after-evidence.md`
- `docs/review-guidelines.md`

## Risks

- Provider JSON shapes can evolve while the documented event families remain;
  shape-based compatibility must fail explicitly rather than guess.
- Piping stdout introduces backpressure, close-order, and resource-lifecycle
  races absent from the generic inherited-stdio path.
- Provider output can be adversarial, extremely large, malformed, or contain
  secrets and reasoning that must never reach durable storage.
- Synchronous local Git capture can contend with continued provider activity;
  checkpoint scheduling must remain bounded and non-authoritative.
- A collector crash can leave started provider operations without finishes;
  consumers must keep them incomplete rather than invent outcomes.

## Open Questions

None. Supporting resumed/interactive/cloud Codex runs, OTel/hooks, raw provider
payload retention, inferred tests, or a new canonical mapping requires a later
approved task and, where applicable, a new or amended architecture decision.
