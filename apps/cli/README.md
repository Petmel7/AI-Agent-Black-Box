# Local collector foundation

The collector owns a versioned SQLite spool and adjacent immutable artifact
files. It works without a backend and can directly wrap one child process while
preserving its outcome.

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
along with repository, user-home, and spool paths before excerpts, hashes,
temporary files, SQLite, or batches are created.
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

## Explicit delivery

Set `BLACKBOX_API_BASE_URL`, `BLACKBOX_REPOSITORY_ID`, and
`BLACKBOX_API_TOKEN` together, then run one finite drain:

```sh
blackbox retry
blackbox retry --json
blackbox retry --run <run-id>
```

The API base URL must be absolute HTTPS. Plain HTTP is accepted only for
`localhost`, `127.0.0.1`, or `[::1]`. User information, fragments, query
strings, redirects, malformed response media, and unbounded responses are
rejected. The bearer token is sent only to the configured Black Box origin.
Signed TUS capabilities remain in memory and are sent only as `x-signature` to
the exact validated storage endpoint; the bearer token is never sent there.

One invocation defaults to at most 20 attempts, 20 distinct claimed items, and
60 seconds. Connect, inactive-request, and overall request timeouts default to
5, 30, and 60 seconds. Retry delay starts at one second and is capped at five
minutes, including `Retry-After`. All limits have positive finite configuration
bounds through the `BLACKBOX_*` variables documented in `.env.example`.
Every request for one claimed item shares the remaining drain deadline. Active
Black Box and TUS requests are cancelled at that deadline, the work lease keeps
a bounded local-transition margin, and new work is not claimed when too little
bounded time remains. SQLite claim waiting is capped by that same remaining
budget (and by the delivery busy timeout), while artifact opening and
incremental integrity hashing observe the operation cancellation signal before
any TUS PATCH can start. Lease expiry is evaluated after acquiring the SQLite
writer transaction for every delivery-state mutation.

Exit `0` means the selected scope has no ready, delayed, leased, or blocked
delivery work. Exit `2` means remote configuration is offline or retained work
remains. Exit `1` means arguments, configuration, or the local spool are
invalid. Output contains aggregate counts and safe codes only.

## Wrapped process

Use the mandatory delimiter so child arguments remain unambiguous:

```sh
blackbox run -- <command> [arguments...]
```

The collector spawns the command directly with `shell: false`, the caller's
working directory, and inherited stdin/stdout/stderr. Arguments are never
joined or interpreted as shell text. All case variants of `BLACKBOX_*` are
removed from the copied child environment; only `BLACKBOX_RUN_ID` is injected.

Run identity and `run.started` are durable before launch. A bounded heartbeat
retains ownership while the direct child is active. Normal exit records one
terminal event with monotonic duration, closes the run, and may perform one
run-scoped bounded drain when delivery is configured. Offline mode and delivery
failure never replace the child's exact exit code. Supported signals are
forwarded only to the direct child; signal completion skips remote delivery.
The collector does not supervise descendant process trees or capture child
stdio in this task.

### Local Git evidence

`blackbox run` requires the initial working directory to resolve to a non-bare
local Git worktree. Git must be installed. Attached branches, detached HEAD,
unborn branches, and linked worktrees are supported. When
`BLACKBOX_REPOSITORY_ROOT` is set, its canonical path must exactly match the
discovered worktree root. A missing Git executable, non-repository, bare
repository, root mismatch, unsafe or excessive output, or inconsistent read
prevents child launch and returns collector exit `1`.

The collector records `run.started`, a consistent `before` snapshot, the
child's actual close, an `after` snapshot and conservative comparison,
`run.finished`, and then closes the run. Final Git degradation produces the
existing content-free warning but cannot replace the child's exit or supported
signal result. Signal completion may perform bounded local Git finalization
but never enables remote delivery.

Git is invoked directly without a shell. Prompts, pagers, optional locks,
external diff/textconv/fsmonitor helpers, unsafe inherited Git environment
overrides, and network-capable operations are disabled. Collection never stages, commits,
checks out, stashes, cleans, writes refs or objects, or recursively inspects
submodules, nested repositories, ignored files, or symlink targets. Status,
patch, and untracked text cross the existing redaction boundary before any
temporary or final spool write.

Artifact schema, ordering, attribution meanings, and fixed limits are defined
in `docs/architecture/git-artifact-formats-v1.md`. In particular,
`observed-during-run` is temporal evidence and is not a causal claim.
