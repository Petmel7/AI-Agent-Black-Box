# BBX-006B: Collector Delivery and Retry

- **Status:** Done
- **Owner:** Implementation Chat
- **Review:** Review Chat
- **Depends on:** BBX-006A completed at `5fd400960a2cd4012e0bf5960f40538728fb5d42`
- **Architecture:** Accepted ADR-0005, ADR-0006, and ADR-0007

## Goal

Connect the durable BBX-006A work spool to the BBX-004 evidence-ingestion and
BBX-005 artifact-upload APIs through strict HTTP/TUS clients, lease-safe bounded
drains, persisted retry scheduling, and an explicit `blackbox retry` command.

## Context

BBX-006A supplies immutable serialized batches, redacted artifact bytes,
delivery work state, and lease-checked transitions. This task must use and, only
where delivery requires it, narrowly extend that public facade. It must not
reconstruct canonical evidence, bypass SQLite invariants, or turn remote
idempotency into a substitute for local ownership.

The former Draft also included wrapped-process behavior. That is now BBX-006C
so network/capability security and process/exit semantics can be reviewed
independently.

## Architecture Decision

No new ADR is required. This task implements the already accepted transport,
integrity, retry, capability, and local delivery-state decisions in ADR-0005
and ADR-0006 while preserving ADR-0007's redaction boundary. Any implementation
need to persist a signed capability, change canonical evidence, or alter the
accepted retry/state model must stop for a new architecture decision.

## In Scope

- Strict BBX-004 evidence-batch HTTP client.
- Strict BBX-005 upload-session, TUS transfer, completion, and storage-status
  clients.
- Minimal typed additions to `CollectorWorkSpool` required for safe artifact
  delivery and upload-attempt replacement.
- Bounded delivery coordinator, retry classification, backoff/jitter,
  `Retry-After`, lease recovery, and safe aggregate results.
- `blackbox retry [--run <run-id>] [--json]` and delivery-aware documentation.
- Local fake HTTP and TUS integration tests using ephemeral loopback ports.

## Out of Scope

- `blackbox run`, child-process launch, stdio, signal, or exit-code behavior;
  BBX-006C owns them.
- Changes to canonical evidence or BBX-004/005 server behavior.
- Git capture, Codex telemetry, provider adapters, or synthetic observations.
- Background daemons, scheduled retry, automatic cleanup/retention, spool
  encryption, PostgreSQL/Supabase access, dashboard, projections, or analysis.
- Live provider validation or any external network dependency.

## Configuration and Security

- Add explicit collector configuration for ingestion base URL, repository UUID,
  API bearer token, request timeout, drain bounds, and retry bounds. Inject
  clock, sleep, and randomness through internal test seams rather than public
  environment configuration.
- Require an absolute HTTPS base URL. Permit plain HTTP only for loopback hosts
  used by local development/tests. Reject credentials, fragments, and
  non-HTTP(S) schemes in the URL.
- Validate all configuration before opening delivery work. Missing remote
  configuration is an explicit offline state, not successful delivery.
- Treat the API token and TUS capability as in-memory credentials. Include the
  API token in the collector redactor's in-memory credential literals whenever
  collector capture is composed in the same process.
- Never persist or print bearer headers, capability tokens, signed endpoints,
  raw remote bodies, local artifact paths, or raw network errors.
- Use `redirect: 'error'` for every secret-bearing request. Do not forward
  credentials across redirects or origins.
- Bound response bodies before parsing and use explicit connect/request/overall
  timeouts with cancellation. Validate media type and strict shared response
  schemas before any spool transition.
- Use the Node 24 HTTP/fetch surface already available to the CLI. Do not add a
  production transport dependency unless implementation exposes a missing
  architecture decision.

## BBX-006A Public-Boundary Compatibility

- Continue to claim exact stored batch bodies through `CollectorWorkSpool`.
- Replace the artifact claim's caller-consumable relative path with a typed,
  immutable declaration and a spool-owned, lease-bound streaming reader. Do not
  expose `LocalSpool`, an absolute path, arbitrary path selection, or a method
  that can persist caller-supplied bytes or canonical content.
- Before opening artifact bytes, verify the active lease and re-check the stored
  byte length and SHA-256. Missing/corrupt bytes become visible blocked work and
  are never uploaded.
- An artifact becomes claimable only after at least one delivered batch contains
  the event that immutably declares it. A declaration in a pending, leased,
  blocked, or superseded-only batch is not sufficient.
- Support the same validated remote upload ID and a fresh validated replacement
  upload ID after server-reported expiry/rejection without weakening stale-lease
  protection. Signed capability state remains memory-only.
- Preserve strict, copied response persistence and exact lease-token/expiry
  checks for release, block, supersede, bind, and acknowledge operations.

## Evidence-Batch Delivery

- POST the exact claimed body to
  `/v1/repositories/{repositoryId}/evidence-batches` with JSON media type and
  bearer authentication.
- Mark delivered only after a strict matching `accepted` or
  `already_accepted` response whose batch and run IDs match the claim.
- An ambiguous disconnect or timeout retries the identical stored batch; it
  never regenerates an ID or body.
- Treat an explicit, strictly parsed `payload_too_large` response as the only
  rebatching trigger. Derive the local rejection identity from the claimed
  batch, atomically supersede it, and create strictly smaller stable batches.
  If one event cannot be reduced below the server limit, block visibly.
- Preserve per-run sequence scheduling. Later batches must not pass an earlier
  non-delivered/non-superseded batch.

## Artifact Delivery

- Request a session only after the accepted batch precondition is durable.
  Validate artifact/upload identity, protocol, endpoint, expiry, chunk size,
  and maximum bytes before binding the attempt. Reject zero chunk size, expired
  capability, or a maximum below the immutable declaration.
- Accept only an absolute HTTPS TUS endpoint, with loopback HTTP allowed in
  tests, and reject userinfo or fragments. Scope the capability to that exact
  origin, send it only as `x-signature`, and never attach the Black Box API
  bearer token to storage-origin requests.
- Send exact immutable redacted bytes with TUS 1.0 headers and the scoped
  capability, using the required bounded chunk size without buffering the
  complete artifact.
- Reconcile offsets only within the same in-memory capability/session. Reject
  invalid, decreasing, out-of-range, or misaligned offsets.
- On restart or capability expiry, query strict Black Box status/session
  endpoints, obtain a safe current or fresh attempt, and restart from zero when
  exact resume is unavailable. Never persist the capability or TUS endpoint.
- Call completion with only the path identifiers and an empty JSON object.
  Mark verified only from a strict matching `verified` or `already_verified`
  result whose upload ID, byte length, and SHA-256 match the local declaration.
- `verification_in_progress` remains retryable. Integrity rejection and other
  non-retryable declaration/ownership/state failures become blocked while
  immutable local bytes remain retained.

## Retry and Drain Semantics

- One drain invocation has explicit maximum attempts, maximum claimed items,
  and maximum elapsed time. It must stop when any bound is reached.
- Network failures, timeouts, `408`, `425`, `429`, and `5xx` are retryable.
  Bound and persist `Retry-After`; otherwise use bounded exponential backoff
  with injected jitter and the durable attempt count.
- Authentication, hidden-not-found/ownership, validation, unsupported-version,
  identity-conflict, and integrity failures are blocked with existing safe
  codes. Malformed or unknown responses fail closed as retryable
  `response-invalid`, never as success.
- Recover expired leases before scheduling. Concurrent drainers and stale
  owners may repeat safe remote operations but converge on one local result.
- Release or block every still-owned claim on every handled path. Process crash
  recovery relies on lease expiry; no finally path may falsely acknowledge.
- Return only bounded aggregate counts and safe codes. Do not return request
  bodies, response bodies, URLs, tokens, paths, or raw errors.

## CLI Behavior

- `blackbox retry` performs exactly one bounded drain and exits; it never becomes
  a daemon or indefinite loop.
- `--run <run-id>` restricts batch preparation/delivery to that run and must not
  cause unrelated artifact work to be delivered. Define artifact-to-run
  filtering within the spool boundary.
- `--json` emits a versioned, strict, content-free result. Human output is
  stable and content-free.
- Exit `0` only when the scoped drain finishes without retained ready,
  retry-delayed, or blocked work. Exit `2` for a valid offline invocation or
  when scoped work remains after a bounded drain. Exit `1` for invalid
  arguments/configuration or a local spool failure. Invalid input fails before
  network access, and no exit path may imply remote success without evidence.
- Existing help, version, and status behavior remains compatible.

## Required Tests

- Fake ingestion server: exact body/header, accepted/already-accepted,
  disconnect after commit, timeout, bounded response, malformed/mismatched
  success, redirects, retryable/blocking statuses, bounded `Retry-After`, and
  explicit `413` split including an unsplittable event.
- Fake TUS server: capability/header isolation, exact bytes, bounded chunks,
  offset validation, interruption and same-process resume, restart/fresh
  session, expiry/rejection replacement, completion retry, verification in
  progress, integrity rejection, and redirect blocking for 301/302/303/307/308.
- Spool integration: accepted-batch artifact gating, run filtering, immutable
  artifact declaration, missing/corrupt bytes, active/stale leases, concurrent
  drainers, attempt replacement, crash recovery, and no false acknowledgement.
- Security scan across SQLite/WAL/SHM, artifact files, stdout/stderr, status,
  diagnostics, errors, and captured fake-server requests proves bearer and
  capability sentinels never appear outside their intended in-memory request
  headers.
- CLI tests cover strict arguments, offline configuration, bounded execution,
  aggregate human/JSON output, exit behavior, and existing command compatibility.

## Acceptance Criteria

- Exact stable batches reach BBX-004 without identity/content regeneration, and
  ambiguous delivery is safely repeatable.
- Only remotely declared artifacts are streamed; exact local bytes reach TUS
  and become verified only from matching BBX-005 evidence.
- Retry, timeout, redirect, `413`, concurrency, restart, and stale-owner paths
  retain recoverable work and never record false delivery.
- API and signed-capability secrets remain memory-only, origin-scoped, and
  absent from all durable and diagnostic surfaces.
- `blackbox retry` is finite, content-free, run-filter-safe, and useful while no
  background service is running.
- The collector never modifies a captured repository file and never deletes
  unacknowledged evidence.

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

Tests may bind ephemeral loopback ports and use unique temporary directories.
They must not start Docker, access PostgreSQL/Supabase or an external network,
or install global services without explicit user authorization.

## Deliverables

- Strict ingestion, Black Box artifact, and TUS clients.
- Retry classifier/backoff and bounded delivery coordinator.
- Minimal safe `CollectorWorkSpool` artifact-delivery extensions.
- `blackbox retry` command and delivery-aware safe output.
- Updated environment example, CLI/root documentation, and recovery runbook.
- Deterministic loopback, concurrency, crash, and secret-sentinel tests.

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

- TUS/provider protocol drift cannot be proven by deterministic fake services.
- Incorrect response classification can hot-loop or strand retained work.
- Capability or redirect mistakes can disclose upload authority.
- Restarting an upload may resend the complete bounded artifact.
- Lease expiry during a slow transfer can cause duplicate transport, while
  server idempotency and local ownership must still prevent false local state.

## Open Questions

None. Approval confirms the split, memory-only capabilities, restart-from-zero
fallback, no background daemon, and loopback-only deterministic validation.
