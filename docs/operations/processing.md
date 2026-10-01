# Processing relay and core projections

BBX-009A uses the standard-PostgreSQL `processing_intents` outbox and one private basic `pgmq` queue named `bbx_processing_v1`. Ingestion still commits evidence and exactly one pending intent without calling the queue.

## Provisioning

Provisioning is an explicit operator action. With `WORKER_DATABASE_URL` set to the intended pgmq-enabled database, build the database and worker packages and run:

```sh
pnpm --filter @blackbox/worker queue:provision
```

The command idempotently verifies/creates the `pgmq` extension and fixed queue. Normal worker startup only verifies them and fails closed with `queue_infrastructure_unavailable`; it never creates or repairs infrastructure. The queue and extension are deliberately absent from Prisma migrations.

## Runtime configuration

`WORKER_DATABASE_URL` is required and is never printed. Defaults are bounded: relay batch 20, queue batch 10, relay lease 60 seconds, a 240-second absolute projection-attempt deadline, a 5-second transition margin, projection lease 300 seconds, queue visibility 360 seconds, event page 500, 20,000 events and projected children per run, eight relay attempts, five projection/poison attempts, one-second idle polling, and a 30-second shutdown wait. Every default has a corresponding `WORKER_*` variable in `.env.example`. Configuration is rejected unless queue visibility is longer than the processing lease and the processing lease is longer than the absolute attempt deadline plus transition margin.

Queue payload version 1 contains only `schemaVersion` and `intentId`. Tenant, run, batch, and evidence data are reloaded from trusted relational rows.

## State, retries, and recovery

Intent delivery is `pending`, `leased`, `delivered`, or terminal `blocked`. Claims use PostgreSQL time, an unguessable lease, bounded attempts, and `FOR UPDATE SKIP LOCKED`. A stale owner cannot deliver, release, or block a lease. A crash after queue send and before the delivered transition can publish a duplicate; application receipts converge duplicates.

Core processing is independently `pending`, `processing`, `retrying`, `ready`, or `failed`. Attempts are scoped to the active intent and its source fingerprint; a new intent starts a fresh attempt budget after prior successful or failed work. Projection publication, replacement children, source fingerprint, ready state, and the exact receipt commit atomically. Database work is transaction-time-bounded, projector work cooperatively observes the same absolute deadline, and the final lease/deadline guard prevents a late publication or receipt. Queue messages are archived only after that commit or exact-receipt confirmation. Durable `failed` is an explicit consumer result: visibility expiry permits observation up to the poison-read threshold, then the message is archived while the failure row remains available to operators. Safe error codes contain no payload or connection values.

`blocked` intent and `failed` projection rows are visible operator states. After correcting the underlying infrastructure or invariant, recovery is an explicit replay through the injected processing service; do not edit immutable events or receipts. Bulk replay UI/CLI is intentionally deferred.

## Freshness and versioning

Core projector v1 rebuilds from all immutable events in canonical sequence. A snapshot is current only when projector name/version, event count, maximum sequence, and source fingerprint agree with processing state and current raw evidence. A version mismatch or late event makes the view stale until replay. Incomplete evidence (missing halves, conflicts, or absent terminal evidence) is distinct from failed processing and from the agent's observed outcome.

Core Git projections contain snapshot/diff metadata and canonical artifact IDs only. Artifact download, verification triggers, file-list parsing, file/path projections, and unified artifact-dependent freshness belong to BBX-009B.
