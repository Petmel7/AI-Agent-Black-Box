import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import {
  ArtifactReferenceSchema,
  ArtifactCompletionResponseSchema,
  EvidenceBatchSchema,
  EvidenceBatchIngestionResponseSchema,
  EvidenceEventSchema,
  UuidSchema,
  type ArtifactReference,
  type ContentCapture,
  type EvidenceBatch,
  type EvidenceEvent,
  MAX_BATCH_EVENTS,
} from '@blackbox/contracts';

import type { CaptureClass, CollectorConfig } from './config.js';
import { CollectorError, type CollectorErrorCode } from './errors.js';
import {
  captureText,
  REDACTION_RULESET_VERSION,
  Redactor,
  type RedactorOptions,
} from './redaction.js';

const SCHEMA_VERSION = 2;
export const DEFAULT_BUSY_TIMEOUT_MS = 2_000;
export const DEFAULT_LEASE_MS = 30_000;
export const MIN_RUN_LEASE_MS = 1_000;
export const MAX_RUN_LEASE_MS = 10 * 60_000;
export const MIN_WORK_LEASE_MS = 1_000;
export const MAX_WORK_LEASE_MS = 5 * 60_000;
export const MAX_SERIALIZED_BATCH_BYTES = 1_000_000;

type RunState = 'active' | 'closed' | 'interrupted';
export type WorkState =
  'pending' | 'leased' | 'delivered' | 'verified' | 'blocked' | 'superseded';

export type WorkErrorCode =
  | 'authentication-failed'
  | 'integrity-rejected'
  | 'network-failed'
  | 'ownership-rejected'
  | 'response-invalid'
  | 'validation-rejected';

interface EventRow {
  canonical_json: string;
  event_id: string;
  sequence: number;
}
interface WorkRow {
  id: string;
}

export interface ArtifactIntegrityRecord {
  byteLength: number;
  relativePath: string;
  sha256: string;
}

export interface SqliteSettings {
  defensive: boolean;
  foreignKeys: boolean;
  journalMode: string;
  timeoutMs: number;
}

export interface RunHandle {
  ownerToken: string;
  runId: string;
}

export interface WorkClaim {
  attemptCount: number;
  body?: string;
  id: string;
  leaseExpiresAt: string;
  leaseToken: string;
  relativePath?: string;
}

export interface StatusSummary {
  artifacts: Record<'blocked' | 'leased' | 'pending' | 'verified', number>;
  batches: Record<
    'blocked' | 'delivered' | 'leased' | 'pending' | 'superseded',
    number
  >;
  bytes: { artifacts: number; batches: number; events: number; total: number };
  diagnostics: Record<string, number>;
  nextRetryAt: string | null;
  retryDelayed: { artifacts: number; batches: number };
  runs: Record<RunState, number>;
  workErrorCodes: Record<string, number>;
}

export interface OpenSpoolOptions {
  busyTimeoutMs?: number;
}

export interface SpoolHooks {
  afterArtifactFlush?(): void;
  afterArtifactRename?(): void;
  afterArtifactWrite?(): void;
  beforeReplacementBatchInsert?(index: number): void;
}

export interface EventIdentity {
  eventId: string;
  runId: string;
  sequence: number;
}

type EventFactory = (identity: EventIdentity) => unknown;

function assertPlainData(value: unknown, label: string): void {
  const visit = (item: unknown): void => {
    if (item === null || typeof item !== 'object') return;
    if (item instanceof Uint8Array) return;
    const prototype = Object.getPrototypeOf(item);
    if (
      prototype !== Object.prototype &&
      prototype !== Array.prototype &&
      prototype !== null
    )
      throw new CollectorError(
        'collection-failed',
        `${label} must contain plain data`,
      );
    for (const descriptor of Object.values(
      Object.getOwnPropertyDescriptors(item),
    )) {
      if (descriptor.get || descriptor.set)
        throw new CollectorError(
          'collection-failed',
          `${label} must not contain accessors`,
        );
      visit(descriptor.value);
    }
  };
  visit(value);
}

function assertExactOwnKeys(
  value: unknown,
  expected: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new CollectorError('collection-failed', `${label} is invalid`);
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== 'string') ||
    keys.map(String).sort().join(',') !== [...expected].sort().join(',')
  )
    throw new CollectorError(
      'collection-failed',
      `${label} has unknown fields`,
    );
}

function parseOversizedBatchRejection(value: unknown): {
  batchId: string;
  code: 'payload_too_large';
  runId: string;
} {
  assertPlainData(value, 'oversized batch rejection');
  assertExactOwnKeys(
    value,
    ['batchId', 'code', 'runId'],
    'oversized batch rejection',
  );
  const record = value;
  if (
    record.code !== 'payload_too_large' ||
    !UuidSchema.safeParse(record.batchId).success ||
    !UuidSchema.safeParse(record.runId).success
  )
    throw new CollectorError(
      'collection-failed',
      'oversized batch rejection is invalid',
    );
  return {
    batchId: String(record.batchId),
    code: 'payload_too_large',
    runId: String(record.runId),
  };
}

function iso(milliseconds = Date.now()): string {
  return new Date(milliseconds).toISOString();
}

function assertLeaseDuration(
  value: number,
  minimum: number,
  maximum: number,
  now: number,
): void {
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum ||
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(now + value)
  )
    throw new CollectorError(
      'invalid-config',
      'lease duration is outside its safe bounds',
    );
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function syncDirectory(path: string): void {
  try {
    const descriptor = openSync(path, 'r');
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    if (process.platform !== 'win32') throw error;
  }
}

function sealingSql(): string {
  return `
    CREATE TRIGGER members_validate_insert BEFORE INSERT ON batch_members BEGIN
      SELECT CASE WHEN EXISTS (SELECT 1 FROM batch_seals WHERE batch_id=NEW.batch_id)
        THEN RAISE(ABORT, 'sealed batch membership') END;
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM batches b JOIN events e ON e.event_id=NEW.event_id
        WHERE b.batch_id=NEW.batch_id AND b.run_id=e.run_id
          AND NEW.ordinal >= 0
          AND json_extract(b.canonical_json, '$.events[' || NEW.ordinal || '].eventId')=NEW.event_id
          AND json_extract(b.canonical_json, '$.events[' || NEW.ordinal || ']')=e.canonical_json
      ) THEN RAISE(ABORT, 'inconsistent batch membership') END;
    END;
    CREATE TRIGGER members_no_update BEFORE UPDATE ON batch_members BEGIN SELECT RAISE(ABORT, 'immutable membership'); END;
    CREATE TRIGGER members_no_delete BEFORE DELETE ON batch_members BEGIN SELECT RAISE(ABORT, 'immutable membership'); END;
    CREATE TRIGGER batch_seals_validate BEFORE INSERT ON batch_seals BEGIN
      SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM batches WHERE batch_id=NEW.batch_id)
        THEN RAISE(ABORT, 'missing batch') END;
      SELECT CASE WHEN
        (SELECT COUNT(*) FROM batch_members WHERE batch_id=NEW.batch_id) !=
        (SELECT json_array_length(canonical_json, '$.events') FROM batches WHERE batch_id=NEW.batch_id)
        THEN RAISE(ABORT, 'incomplete batch membership') END;
      SELECT CASE WHEN EXISTS (
        SELECT 1 FROM batch_members m JOIN events e USING(event_id) JOIN batches b USING(batch_id)
        WHERE m.batch_id=NEW.batch_id AND (
          json_extract(b.canonical_json, '$.events[' || m.ordinal || '].eventId')<>m.event_id OR
          json_extract(b.canonical_json, '$.events[' || m.ordinal || ']')<>e.canonical_json
        )
      ) THEN RAISE(ABORT, 'inconsistent batch membership') END;
    END;
    CREATE TRIGGER batch_seals_no_update BEFORE UPDATE ON batch_seals BEGIN SELECT RAISE(ABORT, 'immutable batch seal'); END;
    CREATE TRIGGER batch_seals_no_delete BEFORE DELETE ON batch_seals BEGIN SELECT RAISE(ABORT, 'immutable batch seal'); END;

    CREATE TRIGGER event_artifacts_validate_insert BEFORE INSERT ON event_artifacts BEGIN
      SELECT CASE WHEN EXISTS (SELECT 1 FROM event_seals WHERE event_id=NEW.event_id)
        THEN RAISE(ABORT, 'sealed event artifacts') END;
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM events e JOIN artifacts a ON a.artifact_id=NEW.artifact_id,
          json_tree(e.canonical_json) j
        WHERE e.event_id=NEW.event_id AND e.run_id=a.run_id
          AND a.canonical_json=NEW.reference_json AND j.type='object' AND j.value=NEW.reference_json
      ) THEN RAISE(ABORT, 'inconsistent artifact reference') END;
    END;
    CREATE TRIGGER event_artifacts_no_update BEFORE UPDATE ON event_artifacts BEGIN SELECT RAISE(ABORT, 'immutable event artifact'); END;
    CREATE TRIGGER event_artifacts_no_delete BEFORE DELETE ON event_artifacts BEGIN SELECT RAISE(ABORT, 'immutable event artifact'); END;
    CREATE TRIGGER event_seals_validate BEFORE INSERT ON event_seals BEGIN
      SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM events WHERE event_id=NEW.event_id)
        THEN RAISE(ABORT, 'missing event') END;
      SELECT CASE WHEN
        (SELECT COUNT(*) FROM event_artifacts WHERE event_id=NEW.event_id) !=
        (SELECT COUNT(DISTINCT json_extract(j.value,'$.artifactId')) FROM events e, json_tree(e.canonical_json) j
          WHERE e.event_id=NEW.event_id AND j.type='object'
            AND json_extract(j.value,'$.artifactId') IS NOT NULL AND json_extract(j.value,'$.sha256') IS NOT NULL)
        THEN RAISE(ABORT, 'incomplete event artifacts') END;
      SELECT CASE WHEN EXISTS (
        SELECT 1 FROM event_artifacts ea WHERE ea.event_id=NEW.event_id AND NOT EXISTS (
          SELECT 1 FROM events e, json_tree(e.canonical_json) j
          WHERE e.event_id=NEW.event_id AND j.type='object' AND j.value=ea.reference_json
        )
      ) THEN RAISE(ABORT, 'inconsistent event artifacts') END;
    END;
    CREATE TRIGGER event_seals_no_update BEFORE UPDATE ON event_seals BEGIN SELECT RAISE(ABORT, 'immutable event seal'); END;
    CREATE TRIGGER event_seals_no_delete BEFORE DELETE ON event_seals BEGIN SELECT RAISE(ABORT, 'immutable event seal'); END;
  `;
}

function migrationSql(): string {
  return `
    CREATE TABLE schema_metadata (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      version INTEGER NOT NULL CHECK (version >= 0)
    ) STRICT;
    INSERT INTO schema_metadata(singleton, version) VALUES (1, ${SCHEMA_VERSION});

    CREATE TABLE runs (
      run_id TEXT PRIMARY KEY,
      capture_state TEXT NOT NULL CHECK (capture_state IN ('active','closed','interrupted')),
      owner_token TEXT,
      owner_lease_expires_at_ms INTEGER,
      next_sequence INTEGER NOT NULL DEFAULT 0 CHECK (next_sequence >= 0),
      created_at TEXT NOT NULL,
      closed_at TEXT,
      CHECK ((capture_state = 'active' AND owner_token IS NOT NULL AND owner_lease_expires_at_ms IS NOT NULL)
          OR (capture_state <> 'active' AND owner_token IS NULL AND owner_lease_expires_at_ms IS NULL))
    ) STRICT;

    CREATE TABLE events (
      event_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(run_id),
      sequence INTEGER NOT NULL CHECK (sequence >= 0),
      canonical_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(run_id, sequence)
    ) STRICT;

    CREATE TABLE artifacts (
      artifact_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(run_id),
      relative_path TEXT NOT NULL UNIQUE CHECK (relative_path NOT LIKE '%/%' AND relative_path NOT LIKE '%\\%'),
      canonical_json TEXT NOT NULL,
      byte_length INTEGER NOT NULL CHECK (byte_length >= 0 AND byte_length <= 50000000),
      sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE artifact_work (
      artifact_id TEXT PRIMARY KEY REFERENCES artifacts(artifact_id),
      state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','leased','verified','blocked')),
      lease_token TEXT,
      lease_expires_at_ms INTEGER,
      safe_error_code TEXT CHECK (safe_error_code IS NULL OR safe_error_code IN
        ('authentication-failed','integrity-rejected','network-failed','ownership-rejected','response-invalid','validation-rejected')),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      next_attempt_at_ms INTEGER,
      remote_acknowledgement TEXT,
      remote_upload_id TEXT,
      CHECK ((state = 'leased' AND lease_token IS NOT NULL AND lease_expires_at_ms IS NOT NULL)
          OR (state <> 'leased' AND lease_token IS NULL AND lease_expires_at_ms IS NULL)),
      CHECK (state <> 'verified' OR (remote_acknowledgement IS NOT NULL AND remote_upload_id IS NOT NULL))
    ) STRICT;

    CREATE TABLE batches (
      batch_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(run_id),
      sent_at TEXT NOT NULL,
      canonical_json TEXT NOT NULL,
      byte_length INTEGER NOT NULL CHECK (byte_length > 0 AND byte_length < 16000000),
      first_sequence INTEGER NOT NULL,
      last_sequence INTEGER NOT NULL CHECK (last_sequence >= first_sequence),
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE batch_members (
      batch_id TEXT NOT NULL REFERENCES batches(batch_id),
      event_id TEXT NOT NULL REFERENCES events(event_id),
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      PRIMARY KEY(batch_id, ordinal),
      UNIQUE(batch_id, event_id)
    ) STRICT;

    CREATE TABLE event_artifacts (
      event_id TEXT NOT NULL REFERENCES events(event_id),
      artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
      reference_json TEXT NOT NULL,
      PRIMARY KEY(event_id, artifact_id)
    ) STRICT;

    CREATE TABLE event_seals (
      event_id TEXT PRIMARY KEY REFERENCES events(event_id)
    ) STRICT;

    CREATE TABLE batch_seals (
      batch_id TEXT PRIMARY KEY REFERENCES batches(batch_id)
    ) STRICT;

    CREATE TABLE batch_work (
      batch_id TEXT PRIMARY KEY REFERENCES batches(batch_id),
      state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','leased','delivered','blocked','superseded')),
      lease_token TEXT,
      lease_expires_at_ms INTEGER,
      safe_error_code TEXT CHECK (safe_error_code IS NULL OR safe_error_code IN
        ('authentication-failed','integrity-rejected','network-failed','ownership-rejected','response-invalid','validation-rejected')),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      next_attempt_at_ms INTEGER,
      remote_acknowledgement TEXT,
      CHECK ((state = 'leased' AND lease_token IS NOT NULL AND lease_expires_at_ms IS NOT NULL)
          OR (state <> 'leased' AND lease_token IS NULL AND lease_expires_at_ms IS NULL)),
      CHECK (state NOT IN ('delivered','superseded') OR remote_acknowledgement IS NOT NULL)
    ) STRICT;

    CREATE TABLE diagnostics (
      code TEXT PRIMARY KEY CHECK (code IN ('artifact-corrupt','artifact-missing','busy','capture-bound-reached',
        'collection-failed','invalid-config','invalid-owner','lease-lost','newer-schema','orphan-file','quota-exceeded','spool-corrupt')),
      count INTEGER NOT NULL DEFAULT 1 CHECK (count > 0),
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'immutable event'); END;
    CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'immutable event'); END;
    CREATE TRIGGER artifacts_no_update BEFORE UPDATE ON artifacts BEGIN SELECT RAISE(ABORT, 'immutable artifact'); END;
    CREATE TRIGGER artifacts_no_delete BEFORE DELETE ON artifacts BEGIN SELECT RAISE(ABORT, 'immutable artifact'); END;
    CREATE TRIGGER batches_no_update BEFORE UPDATE ON batches BEGIN SELECT RAISE(ABORT, 'immutable batch'); END;
    CREATE TRIGGER batches_no_delete BEFORE DELETE ON batches BEGIN SELECT RAISE(ABORT, 'immutable batch'); END;
    ${sealingSql()}
  `;
}

function migrationV1ToV2Sql(): string {
  return `
    DROP TRIGGER members_no_update;
    DROP TRIGGER members_no_delete;
    DROP TRIGGER event_artifacts_consistent;
    DROP TRIGGER event_artifacts_no_update;
    DROP TRIGGER event_artifacts_no_delete;
    CREATE TABLE event_seals (event_id TEXT PRIMARY KEY REFERENCES events(event_id)) STRICT;
    CREATE TABLE batch_seals (batch_id TEXT PRIMARY KEY REFERENCES batches(batch_id)) STRICT;
    ${sealingSql()}
    INSERT INTO event_seals(event_id) SELECT event_id FROM events;
    INSERT INTO batch_seals(batch_id) SELECT batch_id FROM batches;
    UPDATE schema_metadata SET version=2 WHERE singleton=1 AND version=1;
  `;
}

function countRecord<T extends string>(
  states: readonly T[],
): Record<T, number> {
  return Object.fromEntries(states.map((state) => [state, 0])) as Record<
    T,
    number
  >;
}

export class LocalSpool implements Disposable {
  readonly config: CollectorConfig;
  #database: DatabaseSync | undefined;
  readonly #redactor: Redactor;

  constructor(
    config: CollectorConfig,
    private readonly hooks: SpoolHooks = {},
    redactorOptions: RedactorOptions = { environment: {} },
  ) {
    this.config = config;
    this.#redactor = new Redactor(redactorOptions);
  }

  get databasePath(): string {
    return join(this.config.spoolRoot, 'spool.sqlite3');
  }
  get artifactDirectory(): string {
    return join(this.config.spoolRoot, 'artifacts');
  }

  open(options: OpenSpoolOptions = {}): this {
    if (this.#database) return this;
    mkdirSync(this.artifactDirectory, { recursive: true, mode: 0o700 });
    const database = new DatabaseSync(this.databasePath, {
      timeout: options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
    });
    this.#database = database;
    try {
      try {
        chmodSync(this.databasePath, 0o600);
      } catch (error) {
        if (process.platform !== 'win32') throw error;
      }
      database.exec('PRAGMA foreign_keys = ON');
      database.exec(
        `PRAGMA busy_timeout = ${options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS}`,
      );
      const journal = database.prepare('PRAGMA journal_mode = WAL').get() as {
        journal_mode: string;
      };
      if (journal.journal_mode.toLowerCase() !== 'wal')
        throw new CollectorError(
          'spool-corrupt',
          'WAL mode could not be enabled',
        );
      this.#migrate();
      database.enableDefensive(true);
      this.#verifyPragmas();
      return this;
    } catch (cause) {
      database.close();
      this.#database = undefined;
      throw cause;
    }
  }

  close(): void {
    this.#database?.close();
    this.#database = undefined;
  }

  [Symbol.dispose](): void {
    this.close();
  }

  #db(): DatabaseSync {
    if (!this.#database) throw new Error('spool is not open');
    return this.#database;
  }

  #migrate(): void {
    const database = this.#db();
    const exists = database
      .prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='schema_metadata'",
      )
      .get();
    if (exists) {
      const row = database
        .prepare('SELECT version FROM schema_metadata WHERE singleton = 1')
        .get() as { version: number } | undefined;
      if (!row)
        throw new CollectorError('spool-corrupt', 'schema metadata is missing');
      if (row.version > SCHEMA_VERSION)
        throw new CollectorError(
          'newer-schema',
          'spool schema is newer than this collector',
        );
      if (row.version === 1) {
        this.#immediate(() => database.exec(migrationV1ToV2Sql()));
        return;
      }
      if (row.version !== SCHEMA_VERSION)
        throw new CollectorError(
          'spool-corrupt',
          'unsupported spool schema version',
        );
      return;
    }
    this.#immediate(() => database.exec(migrationSql()));
  }

  #verifyPragmas(): void {
    const database = this.#db();
    const foreignKeys = database.prepare('PRAGMA foreign_keys').get() as {
      foreign_keys: number;
    };
    const timeout = database.prepare('PRAGMA busy_timeout').get() as {
      timeout: number;
    };
    database.exec('PRAGMA writable_schema = ON');
    const writable = database.prepare('PRAGMA writable_schema').get() as {
      writable_schema: number;
    };
    if (
      foreignKeys.foreign_keys !== 1 ||
      timeout.timeout <= 0 ||
      writable.writable_schema !== 0
    ) {
      throw new CollectorError(
        'spool-corrupt',
        'required SQLite defensive settings are unavailable',
      );
    }
  }

  #immediate<T>(operation: () => T): T {
    const database = this.#db();
    database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      database.exec('COMMIT');
      return result;
    } catch (cause) {
      try {
        database.exec('ROLLBACK');
      } catch {
        /* Preserve the original failure. */
      }
      throw cause;
    }
  }

  #logicalBytes(): number {
    const row = this.#db()
      .prepare(
        `SELECT
      (SELECT COALESCE(SUM(length(CAST(canonical_json AS BLOB))),0) FROM events) +
      (SELECT COALESCE(SUM(byte_length),0) FROM artifacts) +
      (SELECT COALESCE(SUM(byte_length),0) FROM batches) AS total`,
      )
      .get() as {
      total: number;
    };
    return row.total;
  }

  #assertQuota(additionalBytes: number): void {
    if (this.#logicalBytes() + additionalBytes > this.config.spoolQuotaBytes) {
      throw new CollectorError(
        'quota-exceeded',
        'spool quota does not permit this operation',
      );
    }
  }

  createRun(leaseMs = DEFAULT_LEASE_MS, now = Date.now()): RunHandle {
    assertLeaseDuration(leaseMs, MIN_RUN_LEASE_MS, MAX_RUN_LEASE_MS, now);
    const runId = randomUUID();
    const ownerToken = randomUUID();
    this.#immediate(() =>
      this.#db()
        .prepare(
          `INSERT INTO runs
      (run_id,capture_state,owner_token,owner_lease_expires_at_ms,created_at)
      VALUES (?,?,?,?,?)`,
        )
        .run(runId, 'active', ownerToken, now + leaseMs, iso(now)),
    );
    return { runId, ownerToken };
  }

  renewRunLease(
    handle: RunHandle,
    leaseMs = DEFAULT_LEASE_MS,
    now = Date.now(),
  ): void {
    assertLeaseDuration(leaseMs, MIN_RUN_LEASE_MS, MAX_RUN_LEASE_MS, now);
    const result = this.#immediate(() =>
      this.#db()
        .prepare(
          `UPDATE runs SET owner_lease_expires_at_ms = ?
      WHERE run_id = ? AND capture_state = 'active' AND owner_token = ? AND owner_lease_expires_at_ms > ?`,
        )
        .run(now + leaseMs, handle.runId, handle.ownerToken, now),
    );
    if (result.changes !== 1)
      throw new CollectorError('invalid-owner', 'run ownership is not active');
  }

  #appendEvent(
    handle: RunHandle,
    factory: EventFactory,
    now = Date.now(),
  ): EvidenceEvent {
    return this.#immediate(() => {
      const row = this.#db()
        .prepare(
          `SELECT next_sequence FROM runs WHERE run_id = ? AND capture_state = 'active'
        AND owner_token = ? AND owner_lease_expires_at_ms > ?`,
        )
        .get(handle.runId, handle.ownerToken, now) as
        { next_sequence: number } | undefined;
      if (!row)
        throw new CollectorError(
          'invalid-owner',
          'run ownership is not active',
        );
      const event = EvidenceEventSchema.parse(
        factory({
          eventId: randomUUID(),
          runId: handle.runId,
          sequence: row.next_sequence,
        }),
      );
      assertRedactedCanonicalValue(event);
      const references = findArtifactReferences(event);
      for (const reference of references.values()) {
        const artifact = this.#db()
          .prepare(
            'SELECT run_id,canonical_json FROM artifacts WHERE artifact_id=?',
          )
          .get(reference.artifactId) as
          { canonical_json: string; run_id: string } | undefined;
        if (
          !artifact ||
          artifact.run_id !== handle.runId ||
          artifact.canonical_json !== JSON.stringify(reference)
        )
          throw new CollectorError(
            'spool-corrupt',
            'event artifact declaration is missing or inconsistent',
          );
      }
      const canonical = JSON.stringify(event);
      this.#assertQuota(Buffer.byteLength(canonical));
      this.#db()
        .prepare(
          'INSERT INTO events(event_id,run_id,sequence,canonical_json,created_at) VALUES (?,?,?,?,?)',
        )
        .run(event.eventId, event.runId, event.sequence, canonical, iso(now));
      const link = this.#db().prepare(
        'INSERT INTO event_artifacts(event_id,artifact_id,reference_json) VALUES (?,?,?)',
      );
      for (const reference of references.values())
        link.run(
          event.eventId,
          reference.artifactId,
          JSON.stringify(reference),
        );
      this.#db()
        .prepare('INSERT INTO event_seals(event_id) VALUES (?)')
        .run(event.eventId);
      const update = this.#db()
        .prepare(
          'UPDATE runs SET next_sequence = next_sequence + 1 WHERE run_id = ? AND next_sequence = ?',
        )
        .run(handle.runId, row.next_sequence);
      if (update.changes !== 1)
        throw new CollectorError(
          'spool-corrupt',
          'sequence allocation conflict',
        );
      return event;
    });
  }

  recordRunStarted(
    handle: RunHandle,
    input: { taskDescription?: Uint8Array },
    now = Date.now(),
  ): EvidenceEvent {
    assertPlainData(input, 'run observation');
    if (
      input.taskDescription !== undefined &&
      !(input.taskDescription instanceof Uint8Array)
    )
      throw new CollectorError(
        'collection-failed',
        'task description must be bytes',
      );
    const taskDescription = input.taskDescription
      ? this.captureText(
          handle,
          'task-description',
          Uint8Array.from(input.taskDescription),
        )
      : ({ state: 'omitted' } as const);
    return this.#appendEvent(
      handle,
      ({ eventId, runId, sequence }) => ({
        schemaVersion: 1,
        eventId,
        runId,
        sequence,
        kind: 'run.started',
        observedAt: iso(now),
        source: { component: 'collector' },
        payload: {
          adapter: 'codex',
          provider: 'codex',
          taskDescription,
        },
      }),
      now,
    );
  }

  recordRunFinished(
    handle: RunHandle,
    input: { outcome: 'cancelled' | 'failed' | 'succeeded' },
    now = Date.now(),
  ): EvidenceEvent {
    assertPlainData(input, 'run observation');
    return this.#appendEvent(
      handle,
      ({ eventId, runId, sequence }) => ({
        schemaVersion: 1,
        eventId,
        runId,
        sequence,
        kind: 'run.finished',
        observedAt: iso(now),
        source: { component: 'collector' },
        payload: { outcome: input.outcome },
      }),
      now,
    );
  }

  recordCommandFinished(
    handle: RunHandle,
    input: {
      commandId: string;
      outcome: 'cancelled' | 'failed' | 'succeeded';
      stderr?: Uint8Array;
      stdout?: Uint8Array;
    },
    now = Date.now(),
  ): EvidenceEvent {
    assertPlainData(input, 'command observation');
    if (
      (input.stdout !== undefined && !(input.stdout instanceof Uint8Array)) ||
      (input.stderr !== undefined && !(input.stderr instanceof Uint8Array))
    )
      throw new CollectorError(
        'collection-failed',
        'command content must be bytes',
      );
    const stdout = input.stdout
      ? this.captureText(handle, 'stdout', Uint8Array.from(input.stdout), {
          kind: 'command-output',
        })
      : ({ state: 'omitted' } as const);
    const stderr = input.stderr
      ? this.captureText(handle, 'stderr', Uint8Array.from(input.stderr), {
          kind: 'command-output',
        })
      : ({ state: 'omitted' } as const);
    return this.#appendEvent(
      handle,
      ({ eventId, runId, sequence }) => ({
        schemaVersion: 1,
        eventId,
        runId,
        sequence,
        kind: 'command.finished',
        observedAt: iso(now),
        source: { component: 'collector' },
        payload: {
          commandId: String(input.commandId),
          outcome: input.outcome,
          stdout,
          stderr,
        },
      }),
      now,
    );
  }

  recordGitDiffCaptured(
    handle: RunHandle,
    input: {
      diff: Uint8Array;
      diffId: string;
      fileList: Uint8Array;
      fromSnapshotId: string;
      toSnapshotId: string;
    },
    now = Date.now(),
  ): EvidenceEvent {
    assertPlainData(input, 'git diff observation');
    if (
      !(input.diff instanceof Uint8Array) ||
      !(input.fileList instanceof Uint8Array)
    )
      throw new CollectorError(
        'collection-failed',
        'git diff content must be bytes',
      );
    const diff = this.captureText(
      handle,
      'file-content',
      Uint8Array.from(input.diff),
      {
        kind: 'git-diff',
      },
    );
    const fileList = this.captureText(
      handle,
      'file-content',
      Uint8Array.from(input.fileList),
      { kind: 'git-file-list' },
    );
    if (
      diff.state !== 'captured' ||
      !diff.artifact ||
      fileList.state !== 'captured' ||
      !fileList.artifact
    )
      throw new CollectorError(
        'collection-failed',
        'git diff artifacts were not captured',
      );
    return this.#appendEvent(
      handle,
      ({ eventId, runId, sequence }) => ({
        schemaVersion: 1,
        eventId,
        runId,
        sequence,
        kind: 'git.diff.captured',
        observedAt: iso(now),
        source: { component: 'collector' },
        payload: {
          diffId: String(input.diffId),
          fromSnapshotId: String(input.fromSnapshotId),
          toSnapshotId: String(input.toSnapshotId),
          diffArtifact: diff.artifact,
          fileListArtifact: fileList.artifact,
        },
      }),
      now,
    );
  }

  closeRun(handle: RunHandle, now = Date.now()): void {
    const result = this.#immediate(() =>
      this.#db()
        .prepare(
          `UPDATE runs SET capture_state='closed', owner_token=NULL,
      owner_lease_expires_at_ms=NULL, closed_at=? WHERE run_id=? AND capture_state='active' AND owner_token=?
      AND owner_lease_expires_at_ms > ? AND EXISTS (
        SELECT 1 FROM events WHERE events.run_id=runs.run_id
        AND json_extract(events.canonical_json, '$.kind')='run.finished')`,
        )
        .run(iso(now), handle.runId, handle.ownerToken, now),
    );
    if (result.changes !== 1)
      throw new CollectorError('invalid-owner', 'run ownership is not active');
  }

  recoverExpired(now = Date.now()): {
    artifacts: number;
    batches: number;
    runs: number;
  } {
    return this.#immediate(() => {
      const runs = this.#db()
        .prepare(
          `UPDATE runs SET capture_state='interrupted', owner_token=NULL,
        owner_lease_expires_at_ms=NULL, closed_at=? WHERE capture_state='active' AND owner_lease_expires_at_ms <= ?`,
        )
        .run(iso(now), now).changes;
      const batches = this.#db()
        .prepare(
          `UPDATE batch_work SET state='pending', lease_token=NULL, lease_expires_at_ms=NULL
        WHERE state='leased' AND lease_expires_at_ms <= ?`,
        )
        .run(now).changes;
      const artifacts = this.#db()
        .prepare(
          `UPDATE artifact_work SET state='pending', lease_token=NULL, lease_expires_at_ms=NULL
        WHERE state='leased' AND lease_expires_at_ms <= ?`,
        )
        .run(now).changes;
      return {
        artifacts: Number(artifacts),
        batches: Number(batches),
        runs: Number(runs),
      };
    });
  }

  #registerArtifact(
    handle: RunHandle,
    reference: unknown,
    relativePath: string,
    now = Date.now(),
  ): void {
    const parsed = awaitArtifactReference(reference);
    if (
      !parsed.redaction.applied ||
      parsed.redaction.rulesetVersion !== 'collector-redaction-v1' ||
      parsed.characterEncoding !== 'utf-8'
    ) {
      throw new CollectorError(
        'collection-failed',
        'artifact is not a collector-redaction-v1 UTF-8 artifact',
      );
    }
    if (parsed.byteLength > 50_000_000)
      throw new CollectorError(
        'quota-exceeded',
        'artifact exceeds the server maximum',
      );
    const canonical = JSON.stringify(parsed);
    this.#immediate(() => {
      this.#assertQuota(parsed.byteLength + Buffer.byteLength(canonical));
      const inserted = this.#db()
        .prepare(
          `INSERT INTO artifacts
        (artifact_id,run_id,relative_path,canonical_json,byte_length,sha256,created_at)
        SELECT ?,r.run_id,?,?,?,?,? FROM runs r
        WHERE r.run_id=? AND r.capture_state='active' AND r.owner_token=?
          AND r.owner_lease_expires_at_ms > CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)`,
        )
        .run(
          parsed.artifactId,
          relativePath,
          canonical,
          parsed.byteLength,
          parsed.sha256,
          iso(now),
          handle.runId,
          handle.ownerToken,
        );
      if (inserted.changes !== 1)
        throw new CollectorError(
          'invalid-owner',
          'run ownership is not active',
        );
      this.#db()
        .prepare('INSERT INTO artifact_work(artifact_id) VALUES (?)')
        .run(parsed.artifactId);
    });
  }

  captureText(
    handle: RunHandle,
    captureClass: CaptureClass,
    input: Uint8Array,
    artifact?: { kind: string; mediaType?: string },
  ): ContentCapture {
    const result = captureText(
      captureClass,
      Uint8Array.from(input),
      this.config,
      this.#redactor,
    );
    if (result.diagnosticCode) this.recordDiagnostic(result.diagnosticCode);
    if (result.capture.state !== 'captured' || !result.fullBytes || !artifact)
      return result.capture;
    const bytes = result.fullBytes;
    try {
      if (bytes.byteLength > 50_000_000)
        throw new CollectorError(
          'quota-exceeded',
          'artifact exceeds the server maximum',
        );
      if (
        this.status().bytes.total + bytes.byteLength >
        this.config.spoolQuotaBytes
      ) {
        this.recordDiagnostic('quota-exceeded');
        throw new CollectorError(
          'quota-exceeded',
          'spool quota does not permit this artifact',
        );
      }
      const artifactId = randomUUID();
      const relativePath = `${randomUUID()}.artifact`;
      const temporaryPath = join(this.artifactDirectory, `${randomUUID()}.tmp`);
      const finalPath = join(this.artifactDirectory, relativePath);
      const descriptor = openSync(temporaryPath, 'wx', 0o600);
      try {
        writeFileSync(descriptor, bytes);
        this.hooks.afterArtifactWrite?.();
        fsyncSync(descriptor);
        this.hooks.afterArtifactFlush?.();
      } finally {
        closeSync(descriptor);
      }
      renameSync(temporaryPath, finalPath);
      syncDirectory(this.artifactDirectory);
      this.hooks.afterArtifactRename?.();
      const observed = readFileSync(finalPath);
      const reference: ArtifactReference = ArtifactReferenceSchema.parse({
        artifactId,
        kind: artifact.kind,
        mediaType: artifact.mediaType ?? 'text/plain',
        byteLength: observed.byteLength,
        sha256: sha256(observed),
        redaction: { applied: true, rulesetVersion: REDACTION_RULESET_VERSION },
        characterEncoding: 'utf-8',
      });
      this.#registerArtifact(handle, reference, relativePath);
      return { ...result.capture, artifact: reference };
    } catch {
      return { ...result.capture, truncated: true };
    }
  }

  #insertBatch(batch: EvidenceBatch, serialized: string, now: number): void {
    const selected = batch.events;
    this.#assertQuota(Buffer.byteLength(serialized));
    this.#db()
      .prepare(
        `INSERT INTO batches
       (batch_id,run_id,sent_at,canonical_json,byte_length,first_sequence,last_sequence,created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        batch.batchId,
        batch.runId,
        batch.sentAt,
        serialized,
        Buffer.byteLength(serialized),
        selected[0]!.sequence,
        selected.at(-1)!.sequence,
        iso(now),
      );
    const addMember = this.#db().prepare(
      'INSERT INTO batch_members(batch_id,event_id,ordinal) VALUES (?,?,?)',
    );
    selected.forEach((event, ordinal) =>
      addMember.run(batch.batchId, event.eventId, ordinal),
    );
    this.#db()
      .prepare('INSERT INTO batch_seals(batch_id) VALUES (?)')
      .run(batch.batchId);
    this.#db()
      .prepare('INSERT INTO batch_work(batch_id) VALUES (?)')
      .run(batch.batchId);
  }

  createBatch(runId: string, now = Date.now()): EvidenceBatch | undefined {
    return this.#immediate(() => {
      const rows = this.#db()
        .prepare(
          `SELECT e.event_id,e.sequence,e.canonical_json FROM events e
        JOIN event_seals s ON s.event_id=e.event_id
        JOIN runs r ON r.run_id=e.run_id
        WHERE e.run_id=? AND r.capture_state IN ('active','closed','interrupted') AND NOT EXISTS (
          SELECT 1 FROM batch_members m JOIN batch_work w USING(batch_id)
          WHERE m.event_id=e.event_id AND w.state <> 'superseded'
        ) ORDER BY e.sequence LIMIT ?`,
        )
        .all(runId, MAX_BATCH_EVENTS) as unknown as EventRow[];
      if (rows.length === 0) return undefined;
      const events: EvidenceEvent[] = [];
      let selected: EvidenceEvent[] = [];
      let serialized = '';
      const batchId = randomUUID();
      const sentAt = iso(now);
      for (const row of rows) {
        events.push(EvidenceEventSchema.parse(JSON.parse(row.canonical_json)));
        const candidate = EvidenceBatchSchema.parse({
          schemaVersion: 1,
          batchId,
          runId,
          sentAt,
          events,
        });
        const candidateJson = JSON.stringify(candidate);
        if (Buffer.byteLength(candidateJson) > MAX_SERIALIZED_BATCH_BYTES)
          break;
        selected = [...events];
        serialized = candidateJson;
      }
      if (selected.length === 0)
        throw new CollectorError(
          'quota-exceeded',
          'one event cannot fit in a conservative batch',
        );
      const batch = EvidenceBatchSchema.parse(JSON.parse(serialized));
      this.#insertBatch(batch, serialized, now);
      return batch;
    });
  }

  eligibleBatchRunIds(runId?: string): readonly string[] {
    const rows = this.#db()
      .prepare(
        `SELECT DISTINCT r.run_id,r.created_at FROM runs r
        JOIN events e ON e.run_id=r.run_id
        JOIN event_seals s ON s.event_id=e.event_id
        WHERE r.capture_state IN ('active','closed','interrupted')
          AND (? IS NULL OR r.run_id=?)
          AND NOT EXISTS (
            SELECT 1 FROM batch_members m JOIN batch_work w USING(batch_id)
            WHERE m.event_id=e.event_id AND w.state <> 'superseded'
          )
        ORDER BY r.created_at,r.run_id`,
      )
      .all(runId ?? null, runId ?? null) as unknown as { run_id: string }[];
    return rows.map((row) => row.run_id);
  }

  claimBatch(
    leaseMs = DEFAULT_LEASE_MS,
    now = Date.now(),
  ): WorkClaim | undefined {
    assertLeaseDuration(leaseMs, MIN_WORK_LEASE_MS, MAX_WORK_LEASE_MS, now);
    return this.#claim('batch', leaseMs, now);
  }

  claimArtifact(
    leaseMs = DEFAULT_LEASE_MS,
    now = Date.now(),
  ): WorkClaim | undefined {
    assertLeaseDuration(leaseMs, MIN_WORK_LEASE_MS, MAX_WORK_LEASE_MS, now);
    return this.#claim('artifact', leaseMs, now);
  }

  #claim(
    kind: 'artifact' | 'batch',
    leaseMs: number,
    now: number,
  ): WorkClaim | undefined {
    return this.#immediate(() => {
      const table = kind === 'batch' ? 'batch_work' : 'artifact_work';
      const idColumn = `${kind}_id`;
      const orderJoin =
        kind === 'batch'
          ? 'JOIN batches c ON c.batch_id=w.batch_id'
          : 'JOIN artifacts c ON c.artifact_id=w.artifact_id';
      const order =
        kind === 'batch' ? 'c.first_sequence,c.created_at' : 'c.created_at';
      const row = this.#db()
        .prepare(
          `SELECT w.${idColumn} AS id FROM ${table} w ${orderJoin}
        WHERE w.state='pending' AND (w.next_attempt_at_ms IS NULL OR w.next_attempt_at_ms <= ?)
        ${
          kind === 'batch'
            ? `AND NOT EXISTS (SELECT 1 FROM batches earlier JOIN batch_work ew USING(batch_id)
              WHERE earlier.run_id=c.run_id AND earlier.first_sequence<c.first_sequence
              AND ew.state NOT IN ('delivered','superseded'))`
            : ''
        }
        ORDER BY ${order} LIMIT 1`,
        )
        .get(now) as WorkRow | undefined;
      if (!row) return undefined;
      const token = randomUUID();
      const expiry = now + leaseMs;
      const update = this.#db()
        .prepare(
          `UPDATE ${table} SET state='leased',lease_token=?,lease_expires_at_ms=?,
        attempt_count=attempt_count+1 WHERE ${idColumn}=? AND state='pending'`,
        )
        .run(token, expiry, row.id);
      if (update.changes !== 1) return undefined;
      if (kind === 'batch') {
        const detail = this.#db()
          .prepare(
            `SELECT b.canonical_json,w.attempt_count FROM batches b JOIN batch_work w USING(batch_id)
          WHERE b.batch_id=?`,
          )
          .get(row.id) as { attempt_count: number; canonical_json: string };
        return {
          id: row.id,
          leaseToken: token,
          leaseExpiresAt: iso(expiry),
          attemptCount: detail.attempt_count,
          body: detail.canonical_json,
        };
      }
      const detail = this.#db()
        .prepare(
          `SELECT a.relative_path,w.attempt_count FROM artifacts a JOIN artifact_work w USING(artifact_id)
        WHERE a.artifact_id=?`,
        )
        .get(row.id) as { attempt_count: number; relative_path: string };
      return {
        id: row.id,
        leaseToken: token,
        leaseExpiresAt: iso(expiry),
        attemptCount: detail.attempt_count,
        relativePath: detail.relative_path,
      };
    });
  }

  releaseBatch(
    id: string,
    leaseToken: string,
    nextAttemptAt?: number,
    now = Date.now(),
  ): void {
    this.#transition(
      'batch',
      id,
      leaseToken,
      'pending',
      nextAttemptAt === undefined ? {} : { nextAttemptAt },
      now,
    );
  }

  blockBatch(
    id: string,
    leaseToken: string,
    errorCode: WorkErrorCode,
    now = Date.now(),
  ): void {
    this.#transition('batch', id, leaseToken, 'blocked', { errorCode }, now);
  }

  releaseArtifact(
    id: string,
    leaseToken: string,
    nextAttemptAt?: number,
    now = Date.now(),
  ): void {
    this.#transition(
      'artifact',
      id,
      leaseToken,
      'pending',
      nextAttemptAt === undefined ? {} : { nextAttemptAt },
      now,
    );
  }

  blockArtifact(
    id: string,
    leaseToken: string,
    errorCode: WorkErrorCode,
    now = Date.now(),
  ): void {
    this.#transition('artifact', id, leaseToken, 'blocked', { errorCode }, now);
  }

  acknowledgeBatchDelivery(
    id: string,
    leaseToken: string,
    response: unknown,
    now = Date.now(),
  ): void {
    assertPlainData(response, 'delivery acknowledgement');
    assertExactOwnKeys(
      response,
      ['outcome', 'batchId', 'runId', 'receivedAt'],
      'delivery acknowledgement',
    );
    const parsed = EvidenceBatchIngestionResponseSchema.parse(response);
    const safeResponse = {
      outcome: parsed.outcome,
      batchId: parsed.batchId,
      runId: parsed.runId,
      receivedAt: parsed.receivedAt,
    };
    const canonical = JSON.stringify(safeResponse);
    this.#immediate(() => {
      const existing = this.#db()
        .prepare(
          `SELECT b.run_id,w.state,w.remote_acknowledgement,w.lease_token,w.lease_expires_at_ms
         FROM batches b JOIN batch_work w USING(batch_id) WHERE b.batch_id=?`,
        )
        .get(id) as
        | {
            lease_expires_at_ms: number | null;
            lease_token: string | null;
            remote_acknowledgement: string | null;
            run_id: string;
            state: string;
          }
        | undefined;
      if (
        !existing ||
        parsed.batchId !== id ||
        parsed.runId !== existing.run_id
      )
        throw new CollectorError(
          'collection-failed',
          'delivery acknowledgement identity does not match',
        );
      if (existing.state === 'delivered') {
        if (existing.remote_acknowledgement === canonical) return;
        throw new CollectorError(
          'collection-failed',
          'delivery acknowledgement contradicts stored evidence',
        );
      }
      if (
        existing.state !== 'leased' ||
        existing.lease_token !== leaseToken ||
        (existing.lease_expires_at_ms ?? 0) <= now
      )
        throw new CollectorError(
          'lease-lost',
          'batch lease is no longer owned',
        );
      this.#db()
        .prepare(
          `UPDATE batch_work SET state='delivered',lease_token=NULL,lease_expires_at_ms=NULL,
         safe_error_code=NULL,next_attempt_at_ms=NULL,remote_acknowledgement=? WHERE batch_id=?`,
        )
        .run(canonical, id);
    });
  }

  bindArtifactUpload(
    id: string,
    leaseToken: string,
    uploadId: string,
    now = Date.now(),
  ): void {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        uploadId,
      )
    )
      throw new CollectorError(
        'collection-failed',
        'upload identity is invalid',
      );
    const result = this.#immediate(() =>
      this.#db()
        .prepare(
          `UPDATE artifact_work SET remote_upload_id=? WHERE artifact_id=? AND state='leased' AND lease_token=? AND lease_expires_at_ms>? AND (remote_upload_id IS NULL OR remote_upload_id=?)`,
        )
        .run(uploadId, id, leaseToken, now, uploadId),
    );
    if (result.changes !== 1)
      throw new CollectorError(
        'lease-lost',
        'artifact lease is no longer owned',
      );
  }

  acknowledgeArtifactVerification(
    id: string,
    leaseToken: string,
    response: unknown,
    now = Date.now(),
  ): void {
    assertPlainData(response, 'artifact verification');
    assertExactOwnKeys(
      response,
      ['schemaVersion', 'outcome', 'artifactId', 'verification'],
      'artifact verification',
    );
    assertExactOwnKeys(
      response.verification,
      ['uploadId', 'byteLength', 'sha256', 'verifiedAt'],
      'artifact verification metadata',
    );
    const parsed = ArtifactCompletionResponseSchema.parse(response);
    if (parsed.outcome !== 'verified')
      throw new CollectorError(
        'collection-failed',
        'artifact response is not verified',
      );
    const safeResponse = {
      schemaVersion: 1 as const,
      outcome: 'verified' as const,
      artifactId: parsed.artifactId,
      verification: {
        uploadId: parsed.verification.uploadId,
        byteLength: parsed.verification.byteLength,
        sha256: parsed.verification.sha256,
        verifiedAt: parsed.verification.verifiedAt,
      },
    };
    const canonical = JSON.stringify(safeResponse);
    this.#immediate(() => {
      const row = this.#db()
        .prepare(
          `SELECT a.byte_length,a.sha256,w.state,w.remote_upload_id,w.remote_acknowledgement,w.lease_token,w.lease_expires_at_ms
         FROM artifacts a JOIN artifact_work w USING(artifact_id) WHERE a.artifact_id=?`,
        )
        .get(id) as
        | {
            byte_length: number;
            lease_expires_at_ms: number | null;
            lease_token: string | null;
            remote_acknowledgement: string | null;
            remote_upload_id: string | null;
            sha256: string;
            state: string;
          }
        | undefined;
      if (
        !row ||
        parsed.artifactId !== id ||
        parsed.verification.uploadId !== row.remote_upload_id ||
        parsed.verification.byteLength !== row.byte_length ||
        parsed.verification.sha256 !== row.sha256
      )
        throw new CollectorError(
          'collection-failed',
          'artifact verification metadata does not match',
        );
      if (row.state === 'verified') {
        if (row.remote_acknowledgement === canonical) return;
        throw new CollectorError(
          'collection-failed',
          'artifact verification contradicts stored evidence',
        );
      }
      if (
        row.state !== 'leased' ||
        row.lease_token !== leaseToken ||
        (row.lease_expires_at_ms ?? 0) <= now
      )
        throw new CollectorError(
          'lease-lost',
          'artifact lease is no longer owned',
        );
      this.#db()
        .prepare(
          `UPDATE artifact_work SET state='verified',lease_token=NULL,lease_expires_at_ms=NULL,
         safe_error_code=NULL,next_attempt_at_ms=NULL,remote_acknowledgement=? WHERE artifact_id=?`,
        )
        .run(canonical, id);
    });
  }

  supersedeOversizedBatch(
    id: string,
    leaseToken: string,
    rejection: unknown,
    maximumEvents: number,
    now = Date.now(),
  ): readonly EvidenceBatch[] {
    const parsedRejection = parseOversizedBatchRejection(rejection);
    const safeRejection = {
      batchId: parsedRejection.batchId,
      code: 'payload_too_large' as const,
      runId: parsedRejection.runId,
    };
    if (!Number.isSafeInteger(maximumEvents) || maximumEvents < 1)
      throw new CollectorError(
        'collection-failed',
        'replacement batch bound is invalid',
      );
    let replacementCreationStarted = false;
    try {
      return this.#immediate(() => {
        const source = this.#db()
          .prepare(
            `SELECT b.run_id,w.lease_expires_at_ms FROM batches b JOIN batch_work w USING(batch_id)
           WHERE b.batch_id=? AND w.state='leased' AND w.lease_token=? AND w.lease_expires_at_ms>?`,
          )
          .get(id, leaseToken, now) as
          { lease_expires_at_ms: number; run_id: string } | undefined;
        if (!source)
          throw new CollectorError(
            'lease-lost',
            'batch lease is no longer owned',
          );
        if (
          safeRejection.batchId !== id ||
          safeRejection.runId !== source.run_id
        )
          throw new CollectorError(
            'collection-failed',
            'oversized rejection identity does not match',
          );
        const rows = this.#db()
          .prepare(
            `SELECT e.canonical_json FROM batch_members m JOIN events e USING(event_id)
           WHERE m.batch_id=? ORDER BY m.ordinal`,
          )
          .all(id) as unknown as { canonical_json: string }[];
        if (rows.length < 2 || maximumEvents >= rows.length)
          throw new CollectorError(
            'collection-failed',
            'replacement batches must be smaller than the rejected batch',
          );
        const events = rows.map((row) =>
          EvidenceEventSchema.parse(JSON.parse(row.canonical_json)),
        );
        const replacements: EvidenceBatch[] = [];
        replacementCreationStarted = true;
        for (let offset = 0; offset < events.length; offset += maximumEvents) {
          const selected = events.slice(offset, offset + maximumEvents);
          const batch = EvidenceBatchSchema.parse({
            schemaVersion: 1,
            batchId: randomUUID(),
            runId: source.run_id,
            sentAt: iso(now),
            events: selected,
          });
          const serialized = JSON.stringify(batch);
          if (Buffer.byteLength(serialized) > MAX_SERIALIZED_BATCH_BYTES)
            throw new CollectorError(
              'quota-exceeded',
              'replacement batch remains oversized',
            );
          this.hooks.beforeReplacementBatchInsert?.(replacements.length);
          this.#insertBatch(batch, serialized, now);
          replacements.push(batch);
        }
        const changed = this.#db()
          .prepare(
            `UPDATE batch_work SET state='superseded',lease_token=NULL,lease_expires_at_ms=NULL,
           remote_acknowledgement=? WHERE batch_id=? AND state='leased' AND lease_token=? AND lease_expires_at_ms>?`,
          )
          .run(JSON.stringify(safeRejection), id, leaseToken, now);
        if (changed.changes !== 1)
          throw new CollectorError(
            'lease-lost',
            'batch lease is no longer owned',
          );
        return replacements;
      });
    } catch (cause) {
      if (replacementCreationStarted) {
        try {
          this.releaseBatch(id, leaseToken, undefined, now);
        } catch {
          /* Preserve original failure and ownership state. */
        }
      }
      throw cause;
    }
  }

  #transition(
    kind: 'artifact' | 'batch',
    id: string,
    token: string,
    state: string,
    options: {
      errorCode?: WorkErrorCode;
      nextAttemptAt?: number;
      acknowledgement?: string;
    },
    now: number,
  ): void {
    const table = `${kind}_work`;
    const idColumn = `${kind}_id`;
    const result = this.#immediate(() =>
      this.#db()
        .prepare(
          `UPDATE ${table} SET state=?,lease_token=NULL,lease_expires_at_ms=NULL,
      safe_error_code=?,next_attempt_at_ms=?,remote_acknowledgement=? WHERE ${idColumn}=? AND state='leased' AND lease_token=?
      AND lease_expires_at_ms > ?`,
        )
        .run(
          state,
          options.errorCode ?? null,
          options.nextAttemptAt ?? null,
          options.acknowledgement ?? null,
          id,
          token,
          now,
        ),
    );
    if (result.changes !== 1)
      throw new CollectorError('lease-lost', 'work lease is no longer owned');
  }

  recordDiagnostic(
    code: CollectorErrorCode | 'capture-bound-reached' | 'orphan-file',
    count = 1,
    now = Date.now(),
  ): void {
    this.#db()
      .prepare(
        `INSERT INTO diagnostics(code,count,updated_at) VALUES (?,?,?)
         ON CONFLICT(code) DO UPDATE SET count=count+excluded.count,updated_at=excluded.updated_at`,
      )
      .run(code, count, iso(now));
  }

  status(runId?: string, now = Date.now()): StatusSummary {
    const runFilter = runId ? ' WHERE run_id = ?' : '';
    const parameter: SQLInputValue[] = runId ? [runId] : [];
    const runs = countRecord<RunState>(['active', 'closed', 'interrupted']);
    for (const row of this.#db()
      .prepare(
        `SELECT capture_state AS state,COUNT(*) AS count FROM runs${runFilter} GROUP BY capture_state`,
      )
      .all(...parameter) as unknown as { state: RunState; count: number }[])
      runs[row.state] = row.count;
    const batches = countRecord([
      'pending',
      'leased',
      'delivered',
      'blocked',
      'superseded',
    ] as const);
    const batchWhere = runId ? ' WHERE b.run_id = ?' : '';
    for (const row of this.#db()
      .prepare(
        `SELECT w.state,COUNT(*) AS count FROM batch_work w JOIN batches b USING(batch_id)${batchWhere} GROUP BY w.state`,
      )
      .all(...parameter) as unknown as {
      state: keyof typeof batches;
      count: number;
    }[])
      batches[row.state] = row.count;
    const artifacts = countRecord([
      'pending',
      'leased',
      'verified',
      'blocked',
    ] as const);
    const artifactWhere = runId ? ' WHERE a.run_id = ?' : '';
    for (const row of this.#db()
      .prepare(
        `SELECT w.state,COUNT(*) AS count FROM artifact_work w JOIN artifacts a USING(artifact_id)${artifactWhere} GROUP BY w.state`,
      )
      .all(...parameter) as unknown as {
      state: keyof typeof artifacts;
      count: number;
    }[])
      artifacts[row.state] = row.count;
    const sizes = this.#db()
      .prepare(
        `SELECT
      (SELECT COALESCE(SUM(length(CAST(canonical_json AS BLOB))),0) FROM events${runFilter}) AS events,
      (SELECT COALESCE(SUM(byte_length),0) FROM artifacts${runFilter}) AS artifacts,
      (SELECT COALESCE(SUM(byte_length),0) FROM batches${runFilter}) AS batches`,
      )
      .get(...parameter, ...parameter, ...parameter) as {
      artifacts: number;
      batches: number;
      events: number;
    };
    const diagnostics: Record<string, number> = {};
    for (const row of this.#db()
      .prepare(
        'SELECT code,SUM(count) AS count FROM diagnostics GROUP BY code ORDER BY code',
      )
      .all() as unknown as { code: string; count: number }[])
      diagnostics[row.code] = row.count;
    const retry = this.#db()
      .prepare(
        `SELECT MIN(next_attempt_at_ms) AS value FROM (
      SELECT w.next_attempt_at_ms FROM batch_work w JOIN batches b USING(batch_id)${batchWhere}
      UNION ALL SELECT w.next_attempt_at_ms FROM artifact_work w JOIN artifacts a USING(artifact_id)${artifactWhere})`,
      )
      .get(...parameter, ...parameter) as { value: number | null };
    const delayedBatches = this.#db()
      .prepare(
        `SELECT COUNT(*) AS count FROM batch_work w JOIN batches b USING(batch_id)
         WHERE w.state='pending' AND w.next_attempt_at_ms > ?${
           runId ? ' AND b.run_id = ?' : ''
         }`,
      )
      .get(now, ...parameter) as { count: number };
    const delayedArtifacts = this.#db()
      .prepare(
        `SELECT COUNT(*) AS count FROM artifact_work w JOIN artifacts a USING(artifact_id)
         WHERE w.state='pending' AND w.next_attempt_at_ms > ?${
           runId ? ' AND a.run_id = ?' : ''
         }`,
      )
      .get(now, ...parameter) as { count: number };
    const workErrorCodes: Record<string, number> = {};
    for (const row of this.#db()
      .prepare(
        `SELECT safe_error_code AS code,COUNT(*) AS count FROM (
          SELECT w.safe_error_code FROM batch_work w JOIN batches b USING(batch_id)
          WHERE w.safe_error_code IS NOT NULL${runId ? ' AND b.run_id = ?' : ''}
          UNION ALL
          SELECT w.safe_error_code FROM artifact_work w JOIN artifacts a USING(artifact_id)
          WHERE w.safe_error_code IS NOT NULL${runId ? ' AND a.run_id = ?' : ''}
        ) GROUP BY safe_error_code ORDER BY safe_error_code`,
      )
      .all(...parameter, ...parameter) as unknown as {
      code: string;
      count: number;
    }[])
      workErrorCodes[row.code] = row.count;
    return {
      runs,
      batches,
      artifacts,
      bytes: {
        ...sizes,
        total: sizes.events + sizes.artifacts + sizes.batches,
      },
      diagnostics,
      nextRetryAt: retry.value === null ? null : iso(retry.value),
      retryDelayed: {
        artifacts: delayedArtifacts.count,
        batches: delayedBatches.count,
      },
      workErrorCodes,
    };
  }

  sqliteSettings(): SqliteSettings {
    const database = this.#db();
    const foreignKeys = database.prepare('PRAGMA foreign_keys').get() as {
      foreign_keys: number;
    };
    const journal = database.prepare('PRAGMA journal_mode').get() as {
      journal_mode: string;
    };
    const timeout = database.prepare('PRAGMA busy_timeout').get() as {
      timeout: number;
    };
    database.exec('PRAGMA writable_schema = ON');
    const writable = database.prepare('PRAGMA writable_schema').get() as {
      writable_schema: number;
    };
    return {
      defensive: writable.writable_schema === 0,
      foreignKeys: foreignKeys.foreign_keys === 1,
      journalMode: journal.journal_mode,
      timeoutMs: timeout.timeout,
    };
  }

  artifactIntegrityRecords(): readonly ArtifactIntegrityRecord[] {
    const rows = this.#db()
      .prepare('SELECT relative_path,byte_length,sha256 FROM artifacts')
      .all() as unknown as {
      byte_length: number;
      relative_path: string;
      sha256: string;
    }[];
    return rows.map((row) => ({
      byteLength: row.byte_length,
      relativePath: row.relative_path,
      sha256: row.sha256,
    }));
  }
}

function awaitArtifactReference(value: unknown) {
  return ArtifactReferenceSchema.parse(value);
}

function findArtifactReferences(
  value: unknown,
): Map<string, ArtifactReference> {
  const found = new Map<string, ArtifactReference>();
  const visit = (item: unknown): void => {
    if (!item || typeof item !== 'object') return;
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    const record = item as Record<string, unknown>;
    if (
      typeof record.artifactId === 'string' &&
      typeof record.sha256 === 'string'
    ) {
      const reference = ArtifactReferenceSchema.parse(record);
      const existing = found.get(reference.artifactId);
      if (existing && JSON.stringify(existing) !== JSON.stringify(reference))
        throw new CollectorError(
          'spool-corrupt',
          'duplicate artifact references disagree',
        );
      found.set(reference.artifactId, reference);
    }
    Object.values(record).forEach(visit);
  };
  visit(value);
  return found;
}

function assertRedactedCanonicalValue(value: unknown): void {
  const visit = (item: unknown): void => {
    if (!item || typeof item !== 'object') return;
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    const record = item as Record<string, unknown>;
    if (record.state === 'captured') {
      const redaction = record.redaction as Record<string, unknown> | undefined;
      if (
        redaction?.applied !== true ||
        redaction.rulesetVersion !== 'collector-redaction-v1'
      ) {
        throw new CollectorError(
          'collection-failed',
          'captured content did not pass collector-redaction-v1',
        );
      }
    }
    Object.values(record).forEach(visit);
  };
  visit(value);
}
