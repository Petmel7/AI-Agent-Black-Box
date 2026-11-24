# Evidence Export V1 Operations

## Purpose and boundary

The dashboard can download one private run through:

```text
GET /repositories/{repository-uuid}/runs/{run-uuid}/export
```

The route is dynamic, same-origin, authenticated by the existing dashboard
HTTP Basic and trusted-proxy boundary, and tenant-scoped only by the server's
configured `DASHBOARD_ORGANIZATION_ID`. It accepts no organization selector,
cursor, storage capability, signing authority, or request-controlled filename.
It performs one repeatable-read database snapshot and does not read object
storage, create a row or object, enqueue work, trigger replay, or mutate
evidence.

The response uses:

- `Content-Type: application/vnd.ai-agent-black-box.evidence-export.v1+json`;
- `Content-Disposition: attachment` with
  `blackbox-evidence-{canonical-run-uuid}.v1.json`;
- the exact canonical byte length;
- a strong entity tag whose value is the lowercase SHA-256 of the body;
- `Cache-Control: no-store`; and
- `X-Content-Type-Options: nosniff`.

The UUID-derived filename and every response header are independent of evidence
text. Wrong-tenant, wrong-repository, and missing-run reads share the same
generic unavailable response. An oversized snapshot returns the generic
`Export too large` response and stable internal `export_too_large` code. Other
safe source/configuration failures expose no database, tenant, storage, or
credential detail.

## Bundle semantics

Export V1 is a deterministic public JSON contract. Repeating the export for the
same current run snapshot produces byte-identical output and digest even when
database pages or row-return order differ. Every included collection is
complete within the public limits; there is no partial export.

Database assembly maps bounded pages into the snapshot under one cumulative,
conservative 16 MiB budget. It rejects with `export_too_large` as soon as the
remaining bundle cannot fit, before retaining or requesting the complete
oversized dataset. The final canonical encoder still performs the exact byte
count and is authoritative; the query budget never truncates or substitutes
evidence.

The bundle includes:

- immutable versioned canonical events and server receipt timestamps;
- artifact declarations, event/pointer relationships, and safe verification
  metadata;
- current compatible core and files projections when available;
- the complete compatible deterministic findings catalog and immutable
  references when available;
- the complete compatible structured summary claim/support graph when
  available;
- raw processing currentness plus separate child, findings, summary, and
  presentation outcomes; and
- explicit missing, processing, stale, incomplete, failed, omitted,
  unavailable, and source-truncation facts.

Stale or incompatible derived rows are never mixed into a bundle. Their section
is `unavailable` with a stable reason while immutable events remain exportable.
An observed `unknown`, empty collection, numeric zero, `PASS`, missing section,
and export failure are distinct values.

Artifact bytes, base64 content, bucket/object names, signed URLs, database IDs,
organization identity, credentials, connection strings, cursor material,
provider-native data outside accepted canonical evidence, and hidden reasoning
are excluded.

The export is evidence plus compatible derived-state context. It is not a
signature, server attestation, correctness certificate, task-completion proof,
merge approval, policy decision, compliance/SIEM export, or full artifact
archive.

## Local use

Start the dashboard using the existing instructions in
`docs/operations/dashboard.md`. For authorized loopback development, let curl
prompt for the token so the credential does not enter the URL:

```text
curl --user blackbox \
  --output blackbox-evidence-<run-uuid>.v1.json \
  http://127.0.0.1:<port>/repositories/<repository-uuid>/runs/<run-uuid>/export
```

Production use requires the ADR-0013 trusted HTTPS terminator. Do not place the
dashboard token in a URL, JavaScript storage, log, evidence payload, or checked-in
command file.

Consumers should parse with `parseEvidenceExportV1`, retain the exact bytes, and
compare SHA-256 with the response entity tag. A successful parse proves only
that the bytes satisfy Export V1 and its internal integrity/compatibility rules;
it does not establish who produced them.
