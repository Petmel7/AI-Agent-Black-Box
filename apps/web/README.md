# Web dashboard boundary

The Web application is a private, read-only Next.js boundary. BBX-012A adds
authentication, trusted tenant composition, bounded dashboard queries, and
verified evidence previews. BBX-012B provides the visual run list, run detail,
and exact evidence navigation experience.

## Supported routes

- `/` redirects an authenticated request to `/runs`.
- `/runs` lists the configured tenant's runs and accepts only a repository UUID
  filter and the signed run cursor.
- `/repositories/<repository UUID>/runs/<run UUID>` presents the independent
  run, projector, finding, summary, and evidence states.
- `/repositories/<repository UUID>/runs/<run UUID>/evidence` resolves one
  allowlisted same-run event, artifact, file, or finding-reference locator.

All routes are dynamic and non-cacheable. Child collection URLs contain only
dashboard-signed, tenant/repository/run/collection/snapshot-bound cursors;
legacy projection positions are never URL authority. Browser history is the
supported previous-page control. A malformed, rotated, wrong-scope, or replaced
cursor displays a safe restart state instead of silently mixing snapshots.

## Required server configuration

- `DATABASE_URL`: server-only PostgreSQL connection used by the dashboard.
- `DASHBOARD_ORGANIZATION_ID`: the only organization the process may read.
- `DASHBOARD_ACCESS_TOKEN_SHA256`: lowercase SHA-256 of the dashboard password.
  It must not equal `INGEST_BEARER_TOKEN_SHA256`.
- `DASHBOARD_CURSOR_SIGNING_KEY`: canonical unpadded base64url for exactly 32
  random bytes, dedicated to dashboard cursor HMAC-SHA-256 authentication.
- `DASHBOARD_TRUSTED_PROXY_TOKEN_SHA256`: lowercase SHA-256 of the separate
  high-entropy token injected by the trusted TLS terminator. Store the raw token
  only at the terminator.
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and
  `ARTIFACT_STORAGE_BUCKET`: private server-side evidence storage access.
  The service-role key keeps its provider-issued format but must be distinct
  from the dashboard, ingestion, cursor, and proxy credentials.
- `DASHBOARD_PREVIEW_MAX_BYTES` and the three
  `DASHBOARD_PREVIEW_*_TIMEOUT_MS` values: strict preview resource ceilings.

Never prefix these variables with `NEXT_PUBLIC_`. They must not be passed to a
client component, page prop, URL, log, analytics event, snapshot, or error.

## Access behavior

Every dashboard page and route uses browser-native HTTP Basic authentication.
The fixed username is `blackbox`; the password is the token whose digest is
configured above. The Web process never trusts its URL, `Host`, `Forwarded`, or
an `X-Forwarded-*` header as transport proof. The TLS terminator must remove all
client-supplied `Forwarded`, `X-Forwarded-*`, and `X-Blackbox-Proxy-Token`
headers, then inject exactly `X-Forwarded-Proto: https` and one
`X-Blackbox-Proxy-Token` containing its separate raw token. The proxy-to-Web hop
must use a private or loopback binding that browsers cannot reach directly.
The application rejects missing, duplicated, comma-list, malformed, or invalid
proof/protocol values and removes proof, forwarding, and Basic authorization
headers before application route logic. It repeats sanitation after framework
header normalization.

The supported `pnpm --filter @blackbox/web dev` and
`pnpm --filter @blackbox/web start` commands use the repository launcher. It
requires `DASHBOARD_SERVER_BIND_HOST`, accepts only an explicit private IP or
the exact loopback values `127.0.0.1` and `::1`, and supplies that validated
value to Next itself. Any caller-provided `--hostname`/`-H` option is rejected,
including one that happens to repeat the configured value. This avoids a
second command-line authority and works identically on Windows and POSIX.

Plain HTTP is accepted only when all of the following are true:

- `NODE_ENV` is not `production`;
- `DASHBOARD_ALLOW_INSECURE_LOOPBACK=true`;
- `DASHBOARD_SERVER_BIND_HOST` is exactly `127.0.0.1` or `::1`; and
- the supported launcher starts Next with that exact loopback hostname.

`Host`, URL, and forwarding-header spoofing never creates loopback authority.
Invalid or missing required configuration fails closed in Next instrumentation
before the server becomes ready; protected requests also retain a generic
fail-closed guard.

Generate a proxy token and digest with
`node -e "const c=require('node:crypto'),t=c.randomBytes(32).toString('base64url'); console.log(t); console.log(c.createHash('sha256').update(t).digest('hex'))"`;
store the first line only at the terminator and configure the second on Web.

The browser cannot select an organization. Repository UUID is the v0.1 fallback
label because no trusted repository display-name metadata exists yet. Missing
and wrong-tenant records are indistinguishable, and malformed, wrong-scope, or
stale cursors fail visibly instead of moving to a different snapshot.
Rotating `DASHBOARD_CURSOR_SIGNING_KEY` intentionally invalidates all existing
cursors, so open pages must restart pagination. Rotation does not rewrite data.
Generate a key with a cryptographically secure 32-byte source, for example
`node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`.

The derived presentation state keeps process outcome, each projector state and
error, deterministic findings outcome, summary processing, and summary
availability separate. `FAILED` means only that the wrapped process was
observed as failed or cancelled. A projector failure is `INCOMPLETE`, not
`FAILED`. `PASS` means only that the current versioned deterministic catalog is
fully clear; it does not assert correctness, task completion, test sufficiency,
merge safety, or policy approval.

Evidence is rendered only as inert text or structured data. The server may
return a small allowlisted text/JSON preview after exact length and SHA-256
verification, strict UTF-8 and binary checks, and deadline/cancellation bounds.
Storage keys and public or signed artifact capabilities are never returned.

The UI labels `PASS`, `REVIEW`, `FAILED`, `INCOMPLETE`, and `PROCESSING` only
through the accepted presentation mapper. Those labels do not replace the
separately displayed process outcome, projector freshness, deterministic
finding outcome, or summary availability. Null values are shown as
`Unavailable`; absent tests and usage never become zero or success. Long
structured values and projection previews are visibly truncated.

## Browser validation

`pnpm --filter @blackbox/web test:e2e` runs Chromium only against a production
build through the standard listener launcher and a test-owned loopback trusted
proxy. It intentionally requires an already authorized, empty PostgreSQL 16
database with all migrations deployed, deterministic fixtures created through
the supported ingestion/processing boundaries, and test-owned local artifact
storage. The runner requires the private dashboard variables plus
`BBX_E2E_DASHBOARD_TOKEN`, `BBX_E2E_TRUSTED_PROXY_TOKEN`,
`BBX_E2E_REPOSITORY_ID`, `BBX_E2E_RUN_ID`,
`BBX_E2E_HIDDEN_REPOSITORY_ID`, and `BBX_E2E_SECRET_SENTINEL`. The proxy strips
browser forwarding/proof headers and injects its own proof; these E2E variables
are internal test controls and are not production configuration.

Install the exactly locked Chromium binary with Playwright's browser installer
only after the installation and network access are explicitly authorized. The
test command does not provision Docker, contact an external service, or
download a browser. Its owning orchestration must remove the isolated database,
storage fixture, browser/server processes, ports, and temporary credentials in
a `finally` path.

Replay, mutation, unrestricted downloads, export, public artifacts, accounts,
RBAC, SSO, and external-provider integrations are unavailable in this slice.
