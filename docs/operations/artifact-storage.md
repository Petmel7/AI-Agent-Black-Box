# Private artifact storage

BBX-005 uses a private Supabase Storage bucket for direct resumable uploads. The
ingestion process alone holds the service-role credential and server-owned
object keys. Do not make the bucket public and do not add a public read policy.

## Runtime configuration

- `SUPABASE_URL`: HTTPS project URL.
- `SUPABASE_SERVICE_ROLE_KEY`: server-only service-role key.
- `ARTIFACT_STORAGE_BUCKET`: existing private bucket name.
- `ARTIFACT_MAX_BYTES`: optional deployment limit from 1 through `50000000`;
  defaults to `50000000`.

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
- Reject redirects on every request carrying the service role or signed upload
  capability. Never forward `Authorization`, `apikey`, or `x-signature` to a
  redirected origin.
- Permit the server service role to create signed upload capabilities, read
  private objects for verification, and delete rejected objects best-effort.
- Do not expose storage paths through dashboard, export, or status responses.

The deterministic repository gate uses fake storage and does not need these
values. Live provider contract testing is optional and outside BBX-005.
