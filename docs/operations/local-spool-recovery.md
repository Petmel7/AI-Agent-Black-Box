# Local spool recovery

The collector spool is the local source of truth for evidence that has not been
acknowledged remotely. Do not delete, edit, vacuum, copy over, or reconstruct its
database or artifact files while diagnosing it.

1. Stop collector processes that use the spool.
2. Run `blackbox status --json` with the same `BLACKBOX_SPOOL_DIR`, if an
   override is used.
3. Preserve the complete spool directory, including `spool.sqlite3`, any
   `-wal`/`-shm` files, and the `artifacts` directory. Restrict access because
   the spool is redacted but not encrypted.
4. Treat `artifact-missing`, `artifact-corrupt`, orphan-file counts,
   `quota-exceeded`, and `newer-schema` as operator-visible degradation. Do not
   manufacture replacement bytes or downgrade a newer schema.
5. Free capacity outside the spool or move the complete stopped spool to a
   private location outside every captured repository. Update
   `BLACKBOX_SPOOL_DIR` to that location and rerun status.

BBX-006A provides detection and explicit expired-lease recovery through the
collector API. `blackbox retry [--run <run-id>] [--json]` first recovers expired
leases and then performs one bounded delivery drain when remote configuration is
complete. It never becomes a background service. It does not provide
destructive repair or retention cleanup.
Automatic deletion of pending, leased, blocked, or otherwise unacknowledged
evidence is forbidden. Network delivery and retry commands arrive in BBX-006B.

After recovery, `CollectorWorkSpool.prepareBatches()` may be run repeatedly to
form sealed delivery work from persisted events. Active, closed, and
recovered-interrupted runs are eligible. Preparation is local and content-free;
`prepareBatches()` itself does not perform network delivery, retry scheduling,
or process wrapping. The retry command consumes its sealed work through leased
claims. Signed upload endpoints and capabilities are deliberately not persisted,
so restart recovery may request a fresh attempt and resend an artifact from
zero.

`blackbox run -- <command> [arguments...]` renews a bounded owner lease while
its direct child is active. A hard collector stop can leave an active run with
only `run.started`; after lease expiry, `blackbox retry` or the public recovery
operation marks it `interrupted` without inventing `run.finished`. Its retained
events remain eligible for sealed batch preparation. Do not manually close or
rewrite such a run. A normally observed signal skips lifecycle delivery so the
caller can reproduce the child signal promptly; use `blackbox retry --run
<run-id>` later when delivery is configured.
