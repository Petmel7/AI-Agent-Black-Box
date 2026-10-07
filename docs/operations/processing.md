# Processing relay, core/files projections, and deterministic findings

BBX-009A uses the standard-PostgreSQL `processing_intents` outbox and one private basic `pgmq` queue named `bbx_processing_v1`. Ingestion still commits evidence and exactly one pending intent without calling the queue.

## Provisioning

Provisioning is an explicit operator action. With `WORKER_DATABASE_URL` set to the intended pgmq-enabled database, build the database and worker packages and run:

```sh
pnpm --filter @blackbox/worker queue:provision
```

The command idempotently verifies/creates the `pgmq` extension and fixed queue. Normal worker startup only verifies them and fails closed with `queue_infrastructure_unavailable`; it never creates or repairs infrastructure. The queue and extension are deliberately absent from Prisma migrations.

## Runtime configuration

`WORKER_DATABASE_URL` is required and is never printed. Defaults are bounded: relay batch 20, queue batch 10, relay lease 60 seconds, a 240-second absolute projection-attempt deadline, a 5-second transition margin, projection lease 300 seconds, queue visibility 360 seconds, event page 500, 20,000 events and projected children per run, eight relay attempts, five projection/poison attempts, one-second idle polling, and a 30-second shutdown wait. Every default has a corresponding `WORKER_*` variable in `.env.example`. Configuration is rejected unless queue visibility is longer than the processing lease and the processing lease is longer than the absolute attempt deadline plus transition margin.

Queue payload version 1 contains only `schemaVersion` and `intentId`. Tenant, run, batch, artifact, and evidence data are reloaded from trusted relational rows. File projection also requires the private storage variables documented in `docs/operations/artifact-storage.md`. Storage connect, inactivity, cumulative-byte, artifact-count, entry, row, concurrency, and attempt limits are explicit `WORKER_*` settings.

## State, retries, and recovery

Intent delivery is `pending`, `leased`, `delivered`, or terminal `blocked`. Claims use PostgreSQL time, an unguessable lease, bounded attempts, and `FOR UPDATE SKIP LOCKED`. A stale owner cannot deliver, release, or block a lease. A crash after queue send and before the delivered transition can publish a duplicate; application receipts converge duplicates.

Core and files processing are independently `pending`, `processing`, `retrying`, `ready`, or `failed`. Attempts and durable failure rows are scoped to the active intent and its recomputed source fingerprint; a changed fingerprint resets the bounded attempt budget, while an unchanged terminal failure remains stopped. Projection publication, replacement children, source fingerprint, ready state, failure cleanup, and the exact receipt commit atomically. Database work is transaction-time-bounded, projector work cooperatively observes the same absolute deadline, and the final lease/deadline guard prevents a late publication or receipt. Queue messages are archived only after that commit or exact-receipt confirmation. Durable `failed` is an explicit consumer result: visibility expiry permits observation up to the poison-read threshold, then the message is archived while the failure row remains available to operators. Safe error codes contain no payload or connection values.

`blocked` intent and `failed` projection rows are visible operator states. After correcting the underlying infrastructure or invariant, recovery is the bounded single-intent `replayCoreIntent` or `replayFilesIntent` operation through the injected processing service; do not edit immutable events, verified uploads, or receipts. An exact receipt replay performs no object read. Bulk replay UI/CLI is intentionally deferred.

## Freshness and versioning

Core projector v1 rebuilds from all immutable events in canonical sequence. A snapshot is current only when projector name/version, event count, maximum sequence, and source fingerprint agree with processing state and current raw evidence. A version mismatch or late event makes the view stale until replay. Incomplete evidence (missing halves, conflicts, or absent terminal evidence) is distinct from failed processing and from the agent's observed outcome.

Files projector v1 rebuilds the complete current file snapshot from every canonical `git.diff.captured` file-list declaration. It independently verifies exact length and SHA-256 before strict UTF-8/JSON parsing, then re-locks and revalidates the complete source fingerprint before atomic publication. A missing, unverified, conflicting, changed, invalid, or unavailable source never publishes a partial snapshot. Exact receipt replay performs no storage read; a different intent reaching the same fingerprint creates its receipt without rewriting rows.

File query state is independent of core state. Effective file counts are unknown while files are processing, stale, incomplete, or failed. Projected paths are already-redacted display evidence, may be ambiguous, and must never be treated as identity. `observed-during-run` is temporal evidence, not a causal claim.

Findings projector v1 runs after a successful or already-applied core/files result and before that exact queue message is archived. Findings configuration is mandatory for the supported worker composition; missing configuration fails closed and cannot archive successful dependency work. It uses the unchanged opaque queue payload. Its dependency fingerprint covers analyzer/catalog identity and exact core/files versions, fingerprints, and completeness markers under the shared run lock. Stale core is retryable and cannot publish; missing, stale, or incomplete files publish a complete nine-rule catalog with explicit `unknown` results, and a later files intent replaces it atomically. A receipt is honored only after the current dependency fingerprint and analyzer/catalog identity match the published projection. Exact replay creates no duplicate results or references; a changed dependency or analyzer version rebuilds atomically even when that intent already has a receipt. Ordinary delivery keeps the same exhausted intent and fingerprint stopped, while a distinct later valid intent may take ownership even when the dependency fingerprint is unchanged. The injected `replayFindingsIntent` operation explicitly authorizes one bounded retry of an exhausted intent; live leases, stale-owner checks, deadlines, and poison handling still apply. Raw evidence and core/files rows are never rewritten.

File-backed finding references retain two distinct RFC 6901 pointers: the
immutable event-to-artifact declaration pointer and the validated entry pointer
inside the verified file-list representation. Database constraints bind the
event, artifact, and declaration pointer exactly; the entry pointer, ordinal,
and opaque entry identity remain available for evidence navigation.

The current catalog has one result for every V1 rule. `pass` requires all nine results to be clear with complete coverage, `review` requires at least one triggered result, and every triggered result has an immutable same-run event or event-plus-artifact reference. Processing failure, evidence incompleteness, observed run outcome, and deterministic outcome remain separate query fields. After correcting an underlying safe failure, use the bounded injected `replayFindingsIntent`; do not edit evidence or upstream projections.

## Verified-artifact intent backfill

Verification now creates one `artifact.verified` intent atomically for an exact canonical `git-file-list` link. To enqueue older verified declarations, run the bounded metadata-only operation after migrations:

```sh
pnpm --filter @blackbox/worker artifact-intents:backfill
```

Set `WORKER_ARTIFACT_INTENT_BACKFILL_LIMIT` from 1 through 10,000. Repeat until it reports zero. The operation is idempotent and reads no object bytes. After a storage outage, restore private authenticated reads and allow retrying work to resume; terminal schema/integrity failures require corrected new evidence rather than mutation of declarations or verified history.
