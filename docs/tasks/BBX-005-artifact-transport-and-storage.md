# BBX-005: Artifact Transport and Storage

- **Status:** Approved
- **Owner:** Implementation Chat
- **Review:** Review Chat
- **Architecture:** ADR-0001 through ADR-0004, plus proposed ADR-0005

## Goal

Implement an authenticated, retry-safe path that issues a direct private
artifact upload capability and verifies the resulting stored bytes against the
immutable canonical declaration before recording the artifact as verified.

## Context

Artifact declarations are already persisted by BBX-004, but their bytes and
storage state are deliberately absent. ADR-0005 must be accepted with this task
because it defines the upload trust boundary, object identity, integrity proof,
retry behavior, and initial payload limit.

## In Scope

- Versioned runtime-validated upload-session, completion, and status contracts.
- Authenticated repository-scoped Fastify routes using the BBX-004 tenant and
  repository visibility rules.
- Server-owned private object keys and short-lived signed TUS upload
  capabilities for Supabase Storage.
- A framework-independent artifact transport service and injected storage port.
- Streaming server-side SHA-256 and byte-length verification.
- Durable, tenant-owned upload-attempt state and database constraints.
- Exact retry, concurrency, expiry, rejection, and recovery behavior.
- Deterministic fake-storage tests plus isolated PostgreSQL integration tests.
- Runtime and operator documentation for the private bucket and configuration.

## Required HTTP Contract

Add these repository-scoped version 1 routes:

```text
POST /v1/repositories/:repositoryId/artifacts/:artifactId/uploads
POST /v1/repositories/:repositoryId/artifacts/:artifactId/uploads/:uploadId/complete
GET  /v1/repositories/:repositoryId/artifacts/:artifactId/storage
```

- Apply the existing generic bearer-token authentication and hidden-resource
  behavior. Organization identity comes only from trusted authentication.
- Validate every route parameter and response through strict shared contracts.
- Session creation returns one of `upload_authorized`, `already_authorized`, or
  `already_verified`. An authorized response contains a server upload ID, closed
  protocol value `tus`, provider endpoint, capability token, expiry, required
  chunk size when applicable, and the effective maximum byte limit.
- Treat the capability token as a secret. Never persist or log the token or a
  complete signed URL.
- Completion returns `verified` only after stored-byte verification. An exact
  retry returns the original verified result. A currently owned verification
  lease returns a stable retryable outcome rather than starting conflicting
  mutation.
- The status endpoint exposes only safe states and verification metadata. It
  never returns bucket, object key, service credentials, capability tokens, or
  provider-internal errors.
- Use stable safe error codes for undeclared artifact, ownership hiding,
  declaration too large, expired upload, storage unavailable, integrity
  mismatch, illegal state, validation failure, and unsupported media type.
- Do not echo raw evidence, artifact bytes, credentials, configuration values,
  object keys, or signed capabilities in responses or logs.

## Required Semantics

### Authorization and identity

- Upload only an artifact declaration accepted for a run in the authenticated
  organization and requested repository.
- Never accept bucket, object key, storage URL, organization ID, run ID, hash,
  length, media type, or verification state as trusted completion input.
- Generate an opaque fresh server-owned object key for every new attempt. Use a
  private bucket and disable overwrite/upsert.

### Attempts and retries

- Store mutable upload attempts separately from append-only
  `ArtifactDeclaration` records.
- Implement the ADR-0005 closed states and legal transitions with database
  constraints or migration-owned SQL where Prisma is insufficient.
- Enforce trusted organization/run/declaration ownership, unique object keys,
  and at most one verified attempt per declaration.
- Repeated session creation reuses the same safe unexpired attempt, returns the
  verified result, or creates a new attempt only after expiry or rejection.
- Never reuse the object key of an expired or rejected attempt.
- Signed capability material is created on demand and is not durable state.

### Verification

- Acquire a bounded verification lease before reading storage. A crashed or
  expired verifier must be recoverable by a later completion retry.
- Read only the server-owned object resolved from the attempt. Stream through
  SHA-256 and byte counting without buffering the whole artifact.
- Compare the observations to the declaration's exact `sha256` and
  `byteLength`. Enforce a default ceiling of 50,000,000 bytes before capability
  issuance and while streaming.
- Atomically record the observed length, hash, verification timestamp, and
  terminal state only when the caller still owns the lease.
- Integrity mismatch rejects the attempt and returns a stable non-retryable
  result for that upload; storage unavailability releases or expires the lease
  and remains retryable.
- Concurrent completion calls may duplicate a safe object read but converge to
  one durable verified result. They must not verify different objects for one
  declaration.
- Best-effort deletion of rejected bytes must not hide the durable rejected
  result or change the HTTP outcome.

### Storage boundary

- Define the smallest application-facing storage port needed to issue a
  capability, open a readable byte stream, and delete an object best-effort.
- Keep Supabase SDK types, service-role credentials, bucket names, provider
  paths, and TUS mechanics in the ingest infrastructure adapter.
- Construction and imports remain lazy; they perform no network or database
  connection.
- Provider configuration fails closed with a safe startup/configuration error.
- The deterministic test gate must not contact Supabase or require its
  credentials.

## Database Changes

- Add a checked-in migration and Prisma representation for artifact upload
  attempts and verification leases/results.
- Preserve all ADR-0003 append-only guards and ownership invariants.
- Use UTC timestamps and server UUIDs. Store safe error codes, not provider
  payloads or secrets.
- Prevent parent deletion from bypassing evidence retention and prevent direct
  illegal terminal-state rewrites.
- Prove migration deployment from a fresh isolated PostgreSQL schema and show no
  unintended Prisma/schema drift.

## Out of Scope

- Collector-side upload/resume implementation or SQLite spool state.
- Git capture, Codex integration, projections, findings, summaries, or UI.
- Public downloads, dashboard download authorization, export bundles, CDN
  behavior, or artifact rendering.
- Cross-artifact or cross-tenant content deduplication.
- Background verification, `pgmq`, outbox relay, worker consumption, automated
  orphan cleanup, retention, or garbage-collection policy.
- Trusting object metadata as evidence that redaction occurred.
- Changing the canonical evidence schemas or append-only declarations.
- Requiring Docker or live Supabase access in the standard test gate.

## Required Tests

### HTTP and security

- Authentication, hidden cross-tenant/repository/artifact behavior, strict
  route parsing, and safe error mapping match BBX-004 conventions.
- Upload responses contain only the documented capability fields; logs and
  errors contain no bearer token, storage credential, capability token, signed
  URL, object key, or connection value.
- A client cannot select a path, complete another attempt, or verify an artifact
  through another repository or organization.

### Application and storage adapter

- Session creation covers first issue, exact retry, expiry, rejection, verified
  declaration, declaration over limit, and provider failure.
- Verification accepts exact bytes, including chunked streams, and rejects one
  byte changed, truncated, extended, missing, and over-limit objects.
- Hash and length cover compressed transport bytes exactly when compression is
  declared.
- Provider ETag and client/provider checksum claims cannot bypass streaming
  verification.
- Storage calls use only server-owned keys, no overwrite, and best-effort
  rejected-object cleanup.
- Import/construction is side-effect free and owned resources dispose cleanly.

### PostgreSQL and concurrency

- Fresh migration creates all ownership, uniqueness, state, lease, and partial
  verified-object constraints.
- Declaration rows and raw references remain unchanged across every upload
  outcome.
- Concurrent session creation converges on one usable attempt; a fresh key is
  created only after expiry/rejection.
- Concurrent completion and expired-lease recovery converge on one verified
  result and cannot create two verified attempts.
- Integrity rejection, storage failure, and injected transaction failure leave
  no falsely verified or partially committed state.

## Acceptance Criteria

- Only an authenticated owner can obtain a short-lived capability for an
  already-declared artifact in the requested repository.
- Artifact bytes travel directly to private storage under a server-owned,
  non-overwritable object key.
- `verified` means the service streamed the stored bytes and independently
  matched both declared SHA-256 and byte length.
- Exact retries and concurrency are safe; a declaration has at most one verified
  object and rejected/expired attempts never overwrite it.
- Canonical declarations remain append-only and contain no storage location or
  verification claim.
- The implementation is provider-portable at the application boundary and
  Supabase-specific only in infrastructure composition.
- No secrets or signed capabilities are persisted or emitted.
- Required high-risk validation passes on the final state without mandatory
  Docker or live Supabase access.

## Validation

This task changes authentication-adjacent authorization, migrations, tenant
isolation, evidence integrity, concurrency, and dependencies. Run the full
deterministic gate plus real isolated PostgreSQL integration tests:

```text
pnpm install --frozen-lockfile
pnpm --filter @blackbox/database db:generate
pnpm --filter @blackbox/database db:validate
pnpm --filter @blackbox/database db:migrate:deploy
pnpm --filter @blackbox/database test:integration
pnpm --filter @blackbox/ingest test
pnpm format:check
pnpm lint --force
pnpm typecheck --force
pnpm test --force
pnpm build --force
git diff --check
git status --short --untracked-files=all
```

Database commands require the explicit isolated `TEST_DATABASE_URL`. Do not
start Docker, access live Supabase, install dependencies, or use network access
without the task scope and explicit user authorization.

## Deliverables

- Accepted ADR-0005.
- Shared upload/status HTTP contracts.
- Authenticated Fastify upload coordination routes.
- Framework-independent artifact transport and verification service.
- Supabase Storage TUS capability adapter behind an injected storage port.
- Prisma schema, migration, and database integration tests.
- Focused HTTP, integrity, retry, concurrency, and secret-leakage tests.
- Updated runtime configuration, environment example, and operator docs.

## Referenced Documents

- `AGENTS.md`
- `docs/product/v0.1-scope.md`
- `docs/architecture/overview.md`
- `docs/architecture/v0.1-delivery-sequence.md`
- `docs/architecture/evidence-model.md`
- `docs/architecture/decisions/ADR-0001-modular-monolith.md`
- `docs/architecture/decisions/ADR-0002-canonical-evidence-envelope.md`
- `docs/architecture/decisions/ADR-0003-durable-evidence-persistence.md`
- `docs/architecture/decisions/ADR-0004-transactional-processing-outbox.md`
- `docs/architecture/decisions/ADR-0005-artifact-upload-and-integrity.md`
- `docs/review-guidelines.md`

## Risks

- Capability or object-key leakage would bypass the intended authorization
  boundary even though the bucket is private.
- A verification lease bug could strand attempts or allow inconsistent terminal
  state under concurrency.
- Synchronous verification adds bounded latency and storage egress to the
  completion request.
- Provider behavior can drift from the adapter assumptions without an optional
  live contract test.
- Abandoned private objects remain until a later cleanup policy is implemented.

## Open Questions

1. Confirm signed TUS as the only v0.1 upload protocol; defer presigned PUT and
   multipart S3 variants.
2. Confirm synchronous streaming verification for the 50,000,000-byte v0.1
   bound; defer durable asynchronous verification to later worker work.
3. Confirm fresh object identity per attempt, with no overwrite and no
   cross-artifact hash deduplication.
4. Confirm that automated orphan cleanup and retention are explicitly deferred,
   while rejected-object deletion remains best-effort.
