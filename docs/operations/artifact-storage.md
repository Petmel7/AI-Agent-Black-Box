# Private artifact storage

BBX-005 uses a private Supabase Storage bucket for direct resumable uploads.
Only server processes hold the service-role credential and server-owned object
keys. Ingestion verifies completion; the worker independently re-reads verified
Git file lists before projection. Do not make the bucket public and do not add a
public read policy.

## Runtime configuration

- `SUPABASE_URL`: HTTPS project URL.
- `SUPABASE_SERVICE_ROLE_KEY`: server-only service-role key.
- `ARTIFACT_STORAGE_BUCKET`: existing private bucket name.
- `ARTIFACT_MAX_BYTES`: optional deployment limit from 1 through `50000000`;
  defaults to `50000000`.
- `WORKER_STORAGE_CONNECT_TIMEOUT_MS` and
  `WORKER_STORAGE_INACTIVITY_TIMEOUT_MS`: worker read bounds.
- `INGEST_ARTIFACT_VERIFICATION_CONNECT_TIMEOUT_MS`,
  `INGEST_ARTIFACT_VERIFICATION_INACTIVITY_TIMEOUT_MS`, and
  `INGEST_ARTIFACT_VERIFICATION_ATTEMPT_TIMEOUT_MS`: ingestion verification
  header, body inactivity, and absolute attempt bounds. The verification lease
  must exceed the absolute attempt timeout.

Missing or invalid storage configuration fails closed during ingestion process
composition. Imports and adapter construction do not contact Supabase. Never
place the service-role key in collector configuration, logs, traces, evidence,
HTTP responses, or committed files.

## Required bucket behavior

- Keep the bucket private.
- Create the signed upload token through `/storage/v1/object/upload/sign/...`,
  then create the provider TUS session server-side through
  `/storage/v1/upload/resumable/sign` with `x-signature`, the declared upload
  length and media type, server-owned bucket/object metadata, and
  `x-upsert: false`.
- Treat the signed token's validated `exp` claim as the capability expiry. The
  persisted attempt expiry and collector response must use that exact value.
- Reject every redirect on requests carrying the service role or signed upload
  capability. The authenticated read adapter uses manual redirect handling so
  redirect status is deterministic and rejects the response before reading its
  body. Never forward `Authorization`, `apikey`, or `x-signature` to a redirected
  origin.
- Permit the server service role to create signed upload capabilities, read
  private objects for verification, and delete rejected objects best-effort.
- Do not expose storage paths through dashboard, export, or status responses.
- Worker reads use only the selected verified upload attempt's server-owned
  identity, share cancellation with shutdown, and verify exact declared length
  and lowercase SHA-256 before parsing. Provider/network failures are retryable;
  integrity, encoding, media-type, compression, and schema failures are terminal.
- The worker enforces a true request-headers deadline plus body inactivity and
  overall attempt deadlines. A first artifact failure cancels sibling reads and
  waits for their cleanup before the attempt transitions.
- Ingestion completion uses the same bounded authenticated reader. Client
  disconnect, service shutdown, header timeout, stalled body, or overall timeout
  cancels and destroys the active request/stream, releases the verification
  lease, and preserves retryability.

The deterministic repository gate uses fake storage and does not need these
values. Live provider contract testing is optional and outside BBX-005.
