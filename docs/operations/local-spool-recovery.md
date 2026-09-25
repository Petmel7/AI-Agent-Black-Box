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
collector API. It does not provide destructive repair or retention cleanup.
Automatic deletion of pending, leased, blocked, or otherwise unacknowledged
evidence is forbidden. Network delivery and retry commands arrive in BBX-006B.

After recovery, `CollectorWorkSpool.prepareBatches()` may be run repeatedly to
form sealed delivery work from persisted events. Active, closed, and
recovered-interrupted runs are eligible. Preparation is local and content-free;
it does not perform network delivery, retry scheduling, or process wrapping.
