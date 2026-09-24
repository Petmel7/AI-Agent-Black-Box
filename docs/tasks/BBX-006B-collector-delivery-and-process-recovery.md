# BBX-006B: Collector Delivery and Process Recovery

- **Status:** Draft
- **Owner:** Implementation Chat
- **Review:** Review Chat
- **Depends on:** BBX-006A completed and committed
- **Architecture:** Accepted ADR-0006 and ADR-0007

## Goal

Connect the BBX-006A spool to the BBX-004/005 APIs with bounded retry and signed
TUS delivery, then add a generic wrapped-process lifecycle that proves backend
failure cannot replace the child outcome and leaves recoverable visible work.

## Context

This task begins only after BBX-006A independently proves local identity,
redaction, stable batching/artifacts, leases, and status. It must consume those
boundaries rather than bypassing SQLite invariants or reconstructing canonical
content.

## In Scope

- `blackbox run [options] -- <command> [arguments...]`.
- `blackbox retry [--run <run-id>]` and delivery-aware status integration.
- Strict BBX-004 evidence-batch HTTP client and retry classification.
- Strict BBX-005 signed TUS session/chunk/completion client.
- Bounded drain scheduling, backoff, leases, crash recovery, and safe diagnostics.
- Child exit/signal preservation and backend-outage isolation.
- Local fake HTTP/TUS integration tests; no external service dependency.

## Out of Scope

- Changes to the canonical evidence contract or BBX-004/005 server behavior.
- Git capture/attribution and Codex telemetry mapping.
- Background daemons, scheduled retry, cleanup/retention, spool encryption,
  arbitrary redactors, PostgreSQL/Supabase, dashboard, or analysis.

## Process Lifecycle

- Validate configuration, open/migrate the spool, and commit run identity before
  child launch. Failure here prevents launch.
- Spawn with an argument array and `shell: false`; never rebuild shell text.
- Inherit stdio by default and forward supported termination signals.
- Record collector-owned lifecycle observations through the BBX-006A session.
  Codex-specific observations remain BBX-008.
- After launch, collector/network/storage failures emit one safe warning, retain
  recoverable state, and never replace a valid child exit status.
- Perform only a bounded best-effort drain during lifecycle boundaries. A
  collector crash leaves canonical evidence incomplete; recovery marks local
  operational state interrupted without fabricating `run.finished`.

## Remote Configuration and Security

- Read server URL, repository UUID, API token, timeouts, retry/drain limits, and
  collector-only settings at the CLI composition root.
- Require HTTPS except explicit localhost development/test URLs.
- Keep bearer and signed upload tokens in memory only and out of the child
  environment additions, SQLite, files, logs, status, and errors.
- Disable redirects on every secret-bearing request and validate all route IDs,
  response schemas, and response identity before transition.
- Missing remote configuration permits explicit offline capture but never a
  false delivered result.

## Evidence Delivery

- Claim stable serialized batches through BBX-006A leases and send their exact
  stored bodies.
- Mark delivered only after a strict matching `accepted` or `already_accepted`
  result.
- Treat ambiguous network failure as retry of the identical batch.
- Apply ADR-0006 retry/block classification, bounded exponential backoff/jitter,
  and bounded `Retry-After`.
- Rebatch after explicit `413` only; use new batch IDs while preserving immutable
  events and mark the rejected batch superseded atomically.
- A drain invocation has bounded attempts and elapsed time. Remaining work stays
  durable and visible.

## Artifact Delivery

- Start only after an accepted batch has declared the artifact.
- Validate signed-session, completion, and status responses and their IDs.
- Keep TUS Location/token in memory, disable redirects, use explicit timeout,
  required chunk size/headers, and reconcile offsets for same-process retry.
- After restart/expiry, request a fresh session and restart transfer safely when
  exact offset recovery is unavailable; never persist the capability.
- Mark verified only from the server result. Integrity rejection remains blocked
  with immutable local bytes/declaration retained.

## Retry and Status Behavior

- `retry` performs one bounded drain and reports safe counts/results; it is not a
  daemon and never loops forever.
- Human/JSON status distinguishes retry-delayed, leased, delivered/verified, and
  blocked work plus next retry and safe error code without content/secrets.
- Concurrent drainers and stale owners converge through BBX-006A lease tokens;
  remote idempotency is not a substitute for local ownership checks.

## Required Tests

- Local fake ingestion server: disconnect after commit, exact retry,
  accepted/already-accepted, malformed/mismatched success, redirects, timeout,
  Retry-After, retryable/blocking responses, and explicit `413` rebatching.
- Local fake TUS server: session authorization, chunks/offset, interruption and
  same-process resume, restart with fresh session, expiry, completion retry,
  integrity rejection, redirect blocking, and no capability persistence.
- Concurrent drainers, stale lease owner, process crash, and restart converge
  without false acknowledgement or mutated canonical content.
- `run` preserves zero/non-zero child exit, arguments with spaces/metacharacters,
  stdio, and supported signals.
- Backend outage, malformed response, timeout, and collector failure after launch
  do not prevent child completion or replace its exit code.
- Initialization failure prevents launch; offline/pending/blocked state and safe
  warning remain visible.
- Complete spool/files/log/status/request scan contains no token or secret
  sentinel outside its intentionally redacted request body.

## Acceptance Criteria

- Stable batches/artifacts interoperate with BBX-004/005 without regenerating
  canonical identity or trusting unvalidated responses.
- Retry, timeout, redirect, `413`, concurrency, and stale-owner behavior preserve
  recoverable state and never record false delivery.
- API and signed capability secrets are memory-only and never forwarded on
  redirect or exposed in durable/diagnostic surfaces.
- Backend/storage failure cannot replace the child exit status or silently erase
  work.
- Restart after simulated batch and artifact upload failures eventually delivers
  without duplicate canonical evidence.
- No captured repository file is modified by collector operation.

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

Tests may use ephemeral localhost ports and unique temporary directories. They
must not start Docker, access PostgreSQL/Supabase or external networks, or
install global services without explicit user authorization.

## Deliverables

- Ingestion and TUS clients, retry classifier/scheduler, delivery coordinator,
  process runner, `run`/`retry` CLI commands, and delivery-aware status.
- Updated configuration examples, CLI/root docs, and offline recovery runbook.
- Required local HTTP/TUS, process, crash, concurrency, and secret-leak tests.

## Referenced Documents

- `AGENTS.md`
- `docs/product/v0.1-scope.md`
- `docs/architecture/overview.md`
- `docs/architecture/v0.1-delivery-sequence.md`
- `docs/architecture/evidence-model.md`
- `docs/architecture/decisions/ADR-0002-canonical-evidence-envelope.md`
- `docs/architecture/decisions/ADR-0005-artifact-upload-and-integrity.md`
- `docs/architecture/decisions/ADR-0006-local-spool-and-delivery-state.md`
- `docs/architecture/decisions/ADR-0007-collector-redaction-and-bounded-capture.md`
- `docs/tasks/BBX-006A-local-spool-and-redaction-foundation.md`
- `docs/review-guidelines.md`

## Risks

- Process/signal semantics differ across Windows and POSIX systems.
- Fake HTTP/TUS services cannot prove hosted-provider behavior.
- Incorrect retry classification could create hot loops or strand work.
- Restarting an artifact upload may resend up to the complete bounded artifact.
- A child may terminate while final evidence remains pending; status must not
  imply remote completion.

## Open Questions

1. Confirm memory-only signed capability state and restart-from-zero artifact
   behavior after collector restart.
2. Confirm no background daemon in v0.1.
3. Confirm BBX-006B begins only after BBX-006A is independently reviewed,
   committed, pushed, and green in hosted CI.
