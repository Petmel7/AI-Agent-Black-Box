# Private dashboard operations

BBX-012A establishes the read-only application boundary and BBX-012B presents
that boundary as an authenticated run list, evidence-rich run detail, and exact
evidence view. Neither slice adds replay, evidence mutation, export, or public
artifact access.

## Configuration and startup

Set the dashboard variables documented in `.env.example` only in the Web server
environment. Use a dedicated least-privilege database identity where available,
a private storage bucket, and dashboard, cursor, proxy, storage service-role,
and ingestion credentials distinct from one another. The storage credential is
hashed in memory for separation checks without changing its provider-issued
format. Configuration is validated before evidence is served. Missing values,
malformed UUIDs/digests/keys/URLs/bounds, credential reuse, production loopback
mode, or a non-loopback development bind prevent Next server readiness.
Protected requests retain a generic fail-closed guard if runtime configuration
later becomes invalid.

### Trusted TLS termination

Set `DASHBOARD_SERVER_BIND_HOST` to an explicit private IP or loopback address
that browsers cannot reach directly. The standard Web `dev` and `start` scripts
invoke a dependency-free launcher that validates this value and passes the
exact value to Next as its hostname. The launcher rejects public, wildcard,
hostname, missing, and caller-supplied `--hostname`/`-H` alternatives rather
than allowing command-line precedence to change the listener. The trusted
terminator must perform these steps in order:

1. Remove every client-supplied `Forwarded`, `X-Forwarded-*`, and
   `X-Blackbox-Proxy-Token` header.
2. Terminate TLS and inject exactly `X-Forwarded-Proto: https`.
3. Inject one `X-Blackbox-Proxy-Token` containing a separate high-entropy raw
   token whose lowercase SHA-256 is configured in
   `DASHBOARD_TRUSTED_PROXY_TOKEN_SHA256`.
4. Forward only over the private proxy-to-Web binding.

The Web process does not accept URL protocol or forwarding headers without the
valid proof. Duplicated, comma-list, malformed, conflicting, missing, or invalid
values fail closed. It removes the proof, forwarding headers, and Basic
authorization before route logic and re-sanitizes after Next header
normalization. Never log or snapshot the raw proxy token or its digest.

Generate a separate proxy token and its Web-side digest from a secure random
32-byte value. The first line belongs only in the terminator secret store; the
second is `DASHBOARD_TRUSTED_PROXY_TOKEN_SHA256`:

```text
node -e "const c=require('node:crypto'),t=c.randomBytes(32).toString('base64url'); console.log(t); console.log(c.createHash('sha256').update(t).digest('hex'))"
```

For local development only, set `DASHBOARD_ALLOW_INSECURE_LOOPBACK=true` and
`DASHBOARD_SERVER_BIND_HOST=127.0.0.1` (or `::1`), then use the standard Web
`dev` script. Do not add a hostname argument; every such override is rejected.
Production and the `start` command reject insecure-loopback mode. `Host`, URL,
forwarding headers, environment declarations outside the launcher, and caller
CLI values do not prove loopback binding.

### Cursor signing

Generate `DASHBOARD_CURSOR_SIGNING_KEY` from exactly 32 random bytes and encode
it as canonical unpadded base64url. For example:

```text
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

The key is dedicated to cursor HMAC-SHA-256 and must not be derived from an
organization UUID, dashboard password, ingestion token, or proxy token. Keep it
only in the Web server secret store. Rotation immediately invalidates every
outstanding run-list and timeline cursor; users must restart pagination. Stored
evidence and projections are unaffected.

## Read and preview limits

- Run pages are bounded to 100 entries and use tenant/filter/snapshot-bound
  opaque cursors.
- Timeline pages are bounded to 200 canonical events and are ordered by
  sequence then canonical event UUID. A late event makes an old cursor stale.
- Evidence locators prove configured-tenant, repository, run, event, declared
  artifact pointer, file entry, and current finding ownership as applicable.
- Artifact previews default to 65,536 bytes and may not exceed 262,144 bytes.
  Only uncompressed `text/plain` and `application/json` UTF-8 content is
  eligible. Exact declared and observed length/SHA-256 checks happen before any
  content is returned.
- Missing, unsupported, oversized, binary, invalid, timed-out, cancelled, or
  provider-failed previews return a stable unavailable reason and no partial
  bytes.
- Files, findings, summary claims/supports, and projected child collections use
  independent bounded pages. Their browser cursors are signed with the
  dashboard key and bind the configured organization, repository, run,
  collection, exact projection snapshot, and continuation position. Summary
  support cursors also bind the selected claim. Replaced snapshots fail visibly.

## Evidence presentation

The canonical private routes are `/runs`,
`/repositories/<repository UUID>/runs/<run UUID>`, and the nested `/evidence`
route. Repository UUID remains the v0.1 display fallback; the browser cannot
select an organization. Missing and wrong-tenant resources use the same generic
not-found behavior. All private pages force dynamic, no-store rendering, so a
production build neither queries the database nor pre-renders evidence.

Evidence values, claim text, finding explanations, paths, captures, and artifact
previews are untrusted. They are emitted only through escaped React text or
bounded structured `<pre>` output. Evidence-derived HTML, Markdown, links, CSS,
and scripts are never activated. Verified previews remain limited to the
BBX-012A allowlist and integrity checks; binary, oversized, unsupported,
unavailable, or unverifiable artifacts expose no bytes and have no download
capability.

The presentation badge is not a policy or correctness verdict. Operators must
read it alongside the observed process outcome, individual projector states,
finding coverage/outcome, summary state, explicit test-observation state, and
unavailable/truncated markers.

Do not log authorization headers, raw credentials, database URLs, service-role
keys, storage keys, or evidence content. Safe errors contain no tenant, run,
repository, count, or provider body. Repository UUID is the display fallback.

## Deliberately unavailable

There are no unrestricted or browser-direct artifact downloads, signed URLs,
replay controls, writes, exports, notifications, accounts, RBAC, SSO, policy,
LLM calls, GitHub/PR integration, or public evidence endpoints.
