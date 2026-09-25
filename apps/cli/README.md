# Local collector foundation

The BBX-006A collector owns a versioned SQLite spool and adjacent immutable
artifact files. It works without a backend. Network delivery, TUS, retry policy,
and wrapped-process behavior are intentionally deferred to BBX-006B.

The default spool is below the operating system's per-user application-data
directory, never the captured repository. Override it with
`BLACKBOX_SPOOL_DIR` only for tests or operator recovery. The collector refuses
an override inside `BLACKBOX_REPOSITORY_ROOT`.

Content capture is metadata-only by default. `BLACKBOX_CAPTURE_CLASSES` may
opt in comma-separated classes such as `stdout` or `tool-output`. Input defaults
to 10,000,000 bytes and cannot exceed the 50,000,000-byte artifact ceiling.
Inline excerpts are at most 4,096 characters. The total spool quota defaults to
1,000,000,000 logical bytes. Quota pressure never deletes retained evidence.

Redaction uses `collector-redaction-v1`. Conservative environment-secret names,
names in `BLACKBOX_REDACT_ENV_NAMES`, collector credentials held in memory, and
one-literal-per-line values from `BLACKBOX_REDACT_LITERAL_FILE` are replaced
before excerpts, hashes, temporary files, SQLite, or batches are created.
Arbitrary regular expressions are not supported. Short values are ignored as
global literal rules to avoid destroying ordinary text.

`CollectorSession` is the only public content-ingestion boundary. It constructs
and owns the project redactor from copied, validated configuration and accepts
only bounded raw UTF-8 bytes on explicit observation methods. Callers cannot
submit prebuilt captures, canonical events, artifact declarations, or a custom
redactor. The separately exported work-spool facade exposes content-free
status/audit and lease-safe delivery state operations without exposing local
persistence methods.

`CollectorWorkSpool.prepareBatches()` is the public scheduling boundary for
forming delivery work. It accepts only an optional UUID run filter and a
positive bounded batch-count limit; it never accepts event or content data.
The collector applies the 500-event and 1,000,000-byte serialized limits and
atomically seals each exact contract batch before it becomes claimable.
Active runs are eligible so long captures can make progress, and closed or
recovered-interrupted runs remain eligible so terminal state cannot strand
persisted evidence. Repeated and concurrent preparation safely skip events
already represented by a non-superseded batch.

Spool schema version 2 seals every event's complete artifact-link set and every
batch's complete ordered membership in the transaction that creates it. The
forward version-1 migration verifies existing links and memberships before
sealing them; inconsistent legacy evidence fails closed and is retained.

The v0.1 spool uses restrictive user permissions where supported but is **not
encrypted at rest**. It does not protect against a compromised local account,
privileged malware, memory inspection, or unknown secret formats.

Lease durations are positive finite safe integers validated before a
transaction begins. Run-owner leases are bounded from 1,000 through 600,000
milliseconds; batch and artifact work leases are bounded from 1,000 through
300,000 milliseconds. The default for both is 30,000 milliseconds. Expired
owners cannot renew, acknowledge, verify, release, block, or supersede work.

```sh
blackbox status
blackbox status --json
blackbox status --run <run-id>
```

Status output contains counts, byte totals, safe codes, retry timing, and file
integrity totals only. It never prints captured content or local artifact paths.
See `docs/operations/local-spool-recovery.md` for non-destructive recovery.
