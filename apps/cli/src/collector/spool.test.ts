import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { validateCollectorConfig } from './config.js';
import { CollectorError } from './errors.js';
import {
  LocalSpool,
  MAX_RUN_LEASE_MS,
  MAX_WORK_LEASE_MS,
  MIN_RUN_LEASE_MS,
  MIN_WORK_LEASE_MS,
} from './spool.js';

const roots: string[] = [];
const timestamp = '2026-09-24T10:00:00.000Z';

function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'bbx-spool-'));
  roots.push(path);
  return join(path, 'spool');
}

function open(path = root(), quota?: number): LocalSpool {
  return new LocalSpool(
    validateCollectorConfig({
      spoolRoot: path,
      ...(quota === undefined ? {} : { spoolQuotaBytes: quota }),
    }),
  ).open();
}

function downgradeCurrentSchemaToV1(
  databasePath: string,
  mutate?: (database: DatabaseSync) => void,
): void {
  const database = new DatabaseSync(databasePath);
  database.exec(`
    DROP TRIGGER members_validate_insert;
    DROP TRIGGER members_no_update;
    DROP TRIGGER members_no_delete;
    DROP TRIGGER batch_seals_validate;
    DROP TRIGGER batch_seals_no_update;
    DROP TRIGGER batch_seals_no_delete;
    DROP TRIGGER event_artifacts_validate_insert;
    DROP TRIGGER event_artifacts_no_update;
    DROP TRIGGER event_artifacts_no_delete;
    DROP TRIGGER event_seals_validate;
    DROP TRIGGER event_seals_no_update;
    DROP TRIGGER event_seals_no_delete;
    DROP TABLE event_seals;
    DROP TABLE batch_seals;
  `);
  mutate?.(database);
  database.exec(`
    CREATE TRIGGER members_no_update BEFORE UPDATE ON batch_members BEGIN SELECT RAISE(ABORT, 'immutable membership'); END;
    CREATE TRIGGER members_no_delete BEFORE DELETE ON batch_members BEGIN SELECT RAISE(ABORT, 'immutable membership'); END;
    CREATE TRIGGER event_artifacts_consistent BEFORE INSERT ON event_artifacts
    WHEN NOT EXISTS (
      SELECT 1 FROM events e JOIN artifacts a ON a.artifact_id=NEW.artifact_id
      WHERE e.event_id=NEW.event_id AND e.run_id=a.run_id AND a.canonical_json=NEW.reference_json
    ) BEGIN SELECT RAISE(ABORT, 'inconsistent artifact reference'); END;
    CREATE TRIGGER event_artifacts_no_update BEFORE UPDATE ON event_artifacts BEGIN SELECT RAISE(ABORT, 'immutable event artifact'); END;
    CREATE TRIGGER event_artifacts_no_delete BEFORE DELETE ON event_artifacts BEGIN SELECT RAISE(ABORT, 'immutable event artifact'); END;
    UPDATE schema_metadata SET version=1 WHERE singleton=1;
  `);
  database.close();
}

function started(
  spool: LocalSpool,
  handle: { ownerToken: string; runId: string },
  now: number,
) {
  return spool.recordRunStarted(handle, {}, now);
}

function finished(
  spool: LocalSpool,
  handle: { ownerToken: string; runId: string },
  now: number,
) {
  return spool.recordRunFinished(handle, { outcome: 'succeeded' }, now);
}

afterEach(() => {
  for (const path of roots.splice(0))
    rmSync(path, { recursive: true, force: true });
});

describe('local SQLite spool', () => {
  it('performs no filesystem I/O until explicit open and supports repeated migration/disposal', () => {
    const path = root();
    const spool = new LocalSpool(validateCollectorConfig({ spoolRoot: path }));
    expect(existsSync(path)).toBe(false);
    spool.open();
    expect(existsSync(spool.databasePath)).toBe(true);
    expect(spool.sqliteSettings()).toMatchObject({
      defensive: true,
      foreignKeys: true,
      journalMode: 'wal',
      timeoutMs: 2_000,
    });
    spool.close();
    expect(() => spool.open().close()).not.toThrow();
  });

  it('rejects a newer schema without resetting it', () => {
    const path = root();
    const spool = open(path);
    spool.close();
    const database = new DatabaseSync(spool.databasePath);
    database.prepare('UPDATE schema_metadata SET version=3').run();
    database.close();
    expect(() => open(path)).toThrowError(
      expect.objectContaining<Partial<CollectorError>>({
        code: 'newer-schema',
      }),
    );
  });

  it('upgrades schema v1 rows in place and seals existing evidence', () => {
    const path = root();
    const config = validateCollectorConfig({
      captureClasses: ['file-content'],
      spoolRoot: path,
    });
    const initial = new LocalSpool(config, {}, { environment: {} }).open();
    const handle = initial.createRun();
    const event = initial.recordGitDiffCaptured(handle, {
      diff: Buffer.from('diff'),
      diffId: randomUUID(),
      fileList: Buffer.from('file.ts'),
      fromSnapshotId: randomUUID(),
      toSnapshotId: randomUUID(),
    });
    const batch = initial.createBatch(handle.runId)!;
    initial.close();
    downgradeCurrentSchemaToV1(initial.databasePath);

    using upgraded = new LocalSpool(config).open();
    const database = new DatabaseSync(upgraded.databasePath);
    expect(
      database.prepare('SELECT version FROM schema_metadata').get(),
    ).toMatchObject({ version: 2 });
    expect(
      database.prepare('SELECT COUNT(*) AS count FROM event_seals').get(),
    ).toMatchObject({ count: 1 });
    expect(
      database.prepare('SELECT COUNT(*) AS count FROM batch_seals').get(),
    ).toMatchObject({ count: 1 });
    const artifact = database
      .prepare('SELECT artifact_id,canonical_json FROM artifacts LIMIT 1')
      .get() as {
      artifact_id: string;
      canonical_json: string;
    };
    expect(() =>
      database
        .prepare(
          'INSERT INTO event_artifacts(event_id,artifact_id,reference_json) VALUES (?,?,?)',
        )
        .run(event.eventId, artifact.artifact_id, artifact.canonical_json),
    ).toThrow(/sealed event artifacts/);
    expect(() =>
      database
        .prepare(
          'INSERT INTO batch_members(batch_id,event_id,ordinal) VALUES (?,?,?)',
        )
        .run(batch.batchId, event.eventId, 1),
    ).toThrow(/sealed batch membership/);
    database.close();
  });

  it('fails a v1 upgrade closed when legacy membership is incomplete', () => {
    const path = root();
    const config = validateCollectorConfig({ spoolRoot: path });
    const initial = new LocalSpool(config).open();
    const handle = initial.createRun();
    started(initial, handle, Date.now());
    initial.createBatch(handle.runId);
    initial.close();
    downgradeCurrentSchemaToV1(initial.databasePath, (database) => {
      database.prepare('DELETE FROM batch_members').run();
    });
    expect(() => new LocalSpool(config).open()).toThrow(
      /incomplete batch membership/,
    );
    const database = new DatabaseSync(initial.databasePath);
    expect(
      database.prepare('SELECT version FROM schema_metadata').get(),
    ).toMatchObject({ version: 1 });
    expect(
      database.prepare('SELECT COUNT(*) AS count FROM batches').get(),
    ).toMatchObject({ count: 1 });
    database.close();
  });

  it('allocates sequence with event insertion across connections and keeps evidence immutable', () => {
    const path = root();
    using first = open(path);
    using second = open(path);
    const handle = first.createRun(60_000, 1_000);
    const one = started(first, handle, 1_001);
    const two = started(second, handle, 1_002);
    expect([one.sequence, two.sequence]).toEqual([0, 1]);
    const database = new DatabaseSync(first.databasePath);
    expect(() =>
      database.prepare('UPDATE events SET sequence=7').run(),
    ).toThrow(/immutable event/);
    database.close();
    expect(() => first.closeRun(handle, 1_003)).toThrowError(
      expect.objectContaining<Partial<CollectorError>>({
        code: 'invalid-owner',
      }),
    );
    finished(first, handle, 1_004);
    first.closeRun(handle, 1_005);
    expect(first.status().runs.closed).toBe(1);
  });

  it('persists exact stable batches and enforces lease ownership and expiry', () => {
    using spool = open();
    const handle = spool.createRun(60_000, 1_000);
    started(spool, handle, 1_001);
    finished(spool, handle, 1_002);
    spool.closeRun(handle, 1_003);
    const batch = spool.createBatch(handle.runId, 2_000)!;
    expect(batch.events.map((event) => event.sequence)).toEqual([0, 1]);
    expect(spool.createBatch(handle.runId, 2_001)).toBeUndefined();
    const claim = spool.claimBatch(1_000, 3_000)!;
    expect(JSON.parse(claim.body ?? '')).toEqual(batch);
    expect(() =>
      spool.acknowledgeBatchDelivery(
        batch.batchId,
        'wrong-token',
        {
          outcome: 'accepted',
          batchId: batch.batchId,
          runId: handle.runId,
          receivedAt: timestamp,
        },
        3_001,
      ),
    ).toThrowError(
      expect.objectContaining<Partial<CollectorError>>({ code: 'lease-lost' }),
    );
    expect(() =>
      spool.acknowledgeBatchDelivery(
        batch.batchId,
        claim.leaseToken,
        {
          outcome: 'accepted',
          batchId: batch.batchId,
          runId: handle.runId,
          receivedAt: timestamp,
        },
        4_000,
      ),
    ).toThrowError(
      expect.objectContaining<Partial<CollectorError>>({ code: 'lease-lost' }),
    );
    expect(spool.recoverExpired(4_000).batches).toBe(1);
    const replacement = spool.claimBatch(1_000, 4_001)!;
    spool.acknowledgeBatchDelivery(
      batch.batchId,
      replacement.leaseToken,
      {
        outcome: 'accepted',
        batchId: batch.batchId,
        runId: handle.runId,
        receivedAt: timestamp,
      },
      4_002,
    );
    expect(spool.status().batches.delivered).toBe(1);
    expect(() =>
      spool.acknowledgeBatchDelivery(
        batch.batchId,
        'duplicate-token-is-ignored-only-for-identical-ack',
        {
          outcome: 'accepted',
          batchId: batch.batchId,
          runId: handle.runId,
          receivedAt: timestamp,
        },
        9_000,
      ),
    ).not.toThrow();
    expect(() =>
      spool.acknowledgeBatchDelivery(
        batch.batchId,
        replacement.leaseToken,
        {
          outcome: 'already_accepted',
          batchId: batch.batchId,
          runId: handle.runId,
          receivedAt: timestamp,
        },
        4_003,
      ),
    ).toThrow();
  });

  it('caps batches at 500 events and does not lease later run work first', () => {
    using spool = open();
    const handle = spool.createRun(600_000, 1_000);
    for (let index = 0; index < 501; index += 1)
      started(spool, handle, 1_001 + index);
    finished(spool, handle, 2_000);
    spool.closeRun(handle, 2_001);
    const firstBatch = spool.createBatch(handle.runId, 3_000)!;
    const secondBatch = spool.createBatch(handle.runId, 3_001)!;
    expect(firstBatch.events).toHaveLength(500);
    expect(secondBatch.events).toHaveLength(2);
    const firstClaim = spool.claimBatch(1_000, 4_000)!;
    expect(firstClaim.id).toBe(firstBatch.batchId);
    expect(spool.claimBatch(1_000, 4_001)).toBeUndefined();
    spool.acknowledgeBatchDelivery(
      firstBatch.batchId,
      firstClaim.leaseToken,
      {
        outcome: 'accepted',
        batchId: firstBatch.batchId,
        runId: handle.runId,
        receivedAt: timestamp,
      },
      4_002,
    );
    expect(spool.claimBatch(1_000, 4_003)?.id).toBe(secondBatch.batchId);
  }, 15_000);

  it('marks expired capture owners interrupted and rejects stale owners', () => {
    using spool = open();
    const handle = spool.createRun(1_000, 1_000);
    expect(spool.recoverExpired(2_000).runs).toBe(1);
    expect(() => started(spool, handle, 2_001)).toThrowError(
      expect.objectContaining<Partial<CollectorError>>({
        code: 'invalid-owner',
      }),
    );
    expect(spool.status().runs.interrupted).toBe(1);
  });

  it('batches sealed interrupted evidence and excludes unsealed direct rows', () => {
    using spool = open();
    const interrupted = spool.createRun(1_000, 1_000);
    started(spool, interrupted, 1_001);
    expect(spool.recoverExpired(2_000).runs).toBe(1);
    expect(spool.createBatch(interrupted.runId, 2_001)?.events).toHaveLength(1);

    const unsealed = spool.createRun(60_000, 3_000);
    const source = spool.recordRunStarted(unsealed, {}, 3_001);
    const database = new DatabaseSync(spool.databasePath);
    const directRun = randomUUID();
    database
      .prepare(
        `INSERT INTO runs(run_id,capture_state,owner_token,owner_lease_expires_at_ms,created_at)
         VALUES (?,'active',?,60000,?)`,
      )
      .run(directRun, randomUUID(), timestamp);
    const directEvent = {
      ...source,
      eventId: randomUUID(),
      runId: directRun,
      sequence: 0,
    };
    database
      .prepare(
        'INSERT INTO events(event_id,run_id,sequence,canonical_json,created_at) VALUES (?,?,?,?,?)',
      )
      .run(
        directEvent.eventId,
        directRun,
        0,
        JSON.stringify(directEvent),
        timestamp,
      );
    database.close();
    expect(spool.eligibleBatchRunIds(directRun)).toEqual([]);
    expect(spool.createBatch(directRun, 3_002)).toBeUndefined();
  });

  it('bounds lock waiting and fails closed under another immediate transaction', () => {
    const path = root();
    using first = open(path);
    using second = new LocalSpool(
      validateCollectorConfig({ spoolRoot: path }),
    ).open({ busyTimeoutMs: 20 });
    const blocker = new DatabaseSync(first.databasePath);
    blocker.exec('BEGIN IMMEDIATE');
    const before = Date.now();
    expect(() => second.createRun()).toThrow();
    expect(Date.now() - before).toBeLessThan(1_000);
    blocker.exec('ROLLBACK');
    blocker.close();
  });

  it('enforces configured quota without deleting retained evidence', () => {
    using spool = open(root(), 400);
    const handle = spool.createRun(60_000, 1_000);
    started(spool, handle, 1_001);
    expect(() => started(spool, handle, 1_002)).toThrowError(
      expect.objectContaining<Partial<CollectorError>>({
        code: 'quota-exceeded',
      }),
    );
    expect(spool.status().bytes.events).toBeGreaterThan(0);
  });

  it('rejects direct mutation of artifacts, batches, and memberships', () => {
    using spool = new LocalSpool(
      validateCollectorConfig({
        spoolRoot: root(),
        captureClasses: ['stdout'],
      }),
    ).open();
    const handle = spool.createRun();
    const capture = spool.captureText(handle, 'stdout', Buffer.from('safe'), {
      kind: 'command-output',
    });
    if (capture.state !== 'captured' || !capture.artifact)
      throw new Error('expected artifact');
    started(spool, handle, Date.now());
    const batch = spool.createBatch(handle.runId)!;
    const database = new DatabaseSync(spool.databasePath);
    expect(() =>
      database.prepare('UPDATE artifacts SET byte_length=0').run(),
    ).toThrow(/immutable artifact/);
    expect(() => database.prepare('DELETE FROM artifacts').run()).toThrow(
      /immutable artifact/,
    );
    expect(() =>
      database.prepare('UPDATE batches SET byte_length=1').run(),
    ).toThrow(/immutable batch/);
    expect(() => database.prepare('DELETE FROM batches').run()).toThrow(
      /immutable batch/,
    );
    expect(() =>
      database
        .prepare('UPDATE batch_members SET ordinal=9 WHERE batch_id=?')
        .run(batch.batchId),
    ).toThrow(/immutable membership/);
    expect(() =>
      database
        .prepare('DELETE FROM batch_members WHERE batch_id=?')
        .run(batch.batchId),
    ).toThrow(/immutable membership/);
    database.close();
  });

  it('validates complete ordered membership before sealing and rolls partial construction back', () => {
    using spool = open();
    const handle = spool.createRun();
    const first = started(spool, handle, Date.now());
    const second = started(spool, handle, Date.now() + 1);
    const source = spool.createBatch(handle.runId)!;
    const third = started(spool, handle, Date.now() + 2);
    const database = new DatabaseSync(spool.databasePath);
    const insertBatch = (batchId: string) => {
      const body = JSON.stringify({ ...source, batchId });
      database
        .prepare(
          `INSERT INTO batches(batch_id,run_id,sent_at,canonical_json,byte_length,first_sequence,last_sequence,created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        )
        .run(
          batchId,
          handle.runId,
          source.sentAt,
          body,
          Buffer.byteLength(body),
          0,
          1,
          source.sentAt,
        );
    };

    database.exec('BEGIN IMMEDIATE');
    const wrong = randomUUID();
    insertBatch(wrong);
    expect(() =>
      database
        .prepare(
          'INSERT INTO batch_members(batch_id,event_id,ordinal) VALUES (?,?,?)',
        )
        .run(wrong, first.eventId, 1),
    ).toThrow(/inconsistent batch membership/);
    database.exec('ROLLBACK');

    database.exec('BEGIN IMMEDIATE');
    const missing = randomUUID();
    insertBatch(missing);
    database
      .prepare(
        'INSERT INTO batch_members(batch_id,event_id,ordinal) VALUES (?,?,?)',
      )
      .run(missing, first.eventId, 0);
    expect(() =>
      database
        .prepare('INSERT INTO batch_seals(batch_id) VALUES (?)')
        .run(missing),
    ).toThrow(/incomplete batch membership/);
    database.exec('ROLLBACK');

    database.exec('BEGIN IMMEDIATE');
    const valid = randomUUID();
    insertBatch(valid);
    const member = database.prepare(
      'INSERT INTO batch_members(batch_id,event_id,ordinal) VALUES (?,?,?)',
    );
    member.run(valid, first.eventId, 0);
    member.run(valid, second.eventId, 1);
    expect(() => member.run(valid, third.eventId, 2)).toThrow(
      /inconsistent batch membership/,
    );
    database.prepare('INSERT INTO batch_seals(batch_id) VALUES (?)').run(valid);
    expect(() => member.run(valid, third.eventId, 2)).toThrow(
      /sealed batch membership/,
    );
    database.exec('ROLLBACK');
    expect(
      database
        .prepare('SELECT COUNT(*) AS count FROM batches WHERE batch_id=?')
        .get(valid),
    ).toMatchObject({ count: 0 });
    database.close();
  });

  it('bounds run and work leases before any database mutation', () => {
    using spool = open();
    const invalid = [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER,
      MAX_RUN_LEASE_MS + 1,
    ];
    for (const value of invalid)
      expect(() => spool.createRun(value, 1_000)).toThrowError(
        expect.objectContaining<Partial<CollectorError>>({
          code: 'invalid-config',
        }),
      );
    expect(spool.status().runs.active).toBe(0);
    expect(() =>
      spool.createRun(MIN_RUN_LEASE_MS, Number.MAX_SAFE_INTEGER),
    ).toThrow();
    const handle = spool.createRun(MIN_RUN_LEASE_MS, 1_000);
    spool.renewRunLease(handle, MAX_RUN_LEASE_MS, 1_001);
    started(spool, handle, 1_002);
    const batch = spool.createBatch(handle.runId)!;
    for (const value of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER,
      MAX_WORK_LEASE_MS + 1,
    ])
      expect(() => spool.claimBatch(value, 2_000)).toThrow();
    expect(spool.status().batches.pending).toBe(1);
    const minimum = spool.claimBatch(MIN_WORK_LEASE_MS, 2_000)!;
    expect(minimum.id).toBe(batch.batchId);
    spool.releaseBatch(batch.batchId, minimum.leaseToken, undefined, 2_001);
    expect(spool.claimBatch(MAX_WORK_LEASE_MS, 2_002)?.id).toBe(batch.batchId);
  });

  it('atomically replaces an explicitly rejected oversized batch and recovers on failure', () => {
    const path = root();
    let fail = true;
    using spool = new LocalSpool(validateCollectorConfig({ spoolRoot: path }), {
      beforeReplacementBatchInsert: (index) => {
        if (fail && index === 1)
          throw new Error('injected replacement failure');
      },
    }).open();
    const handle = spool.createRun(60_000, 1_000);
    for (let index = 0; index < 4; index += 1)
      started(spool, handle, 1_001 + index);
    const batch = spool.createBatch(handle.runId, 2_000)!;
    const claim = spool.claimBatch(1_000, 3_000)!;
    const rejection = {
      batchId: batch.batchId,
      runId: handle.runId,
      code: 'payload_too_large' as const,
    };
    expect(() =>
      spool.supersedeOversizedBatch(
        batch.batchId,
        claim.leaseToken,
        rejection,
        2,
        3_001,
      ),
    ).toThrow('injected');
    expect(spool.status().batches).toMatchObject({ pending: 1, superseded: 0 });
    fail = false;
    const retry = spool.claimBatch(1_000, 3_002)!;
    expect(() =>
      spool.supersedeOversizedBatch(
        batch.batchId,
        'stale',
        rejection,
        2,
        3_003,
      ),
    ).toThrow();
    expect(() =>
      spool.supersedeOversizedBatch(
        batch.batchId,
        retry.leaseToken,
        { ...rejection, runId: randomUUID() },
        2,
        3_003,
      ),
    ).toThrow();
    expect(spool.status().batches.leased).toBe(1);
    spool.releaseBatch(batch.batchId, retry.leaseToken, undefined, 3_003);
    const finalClaim = spool.claimBatch(1_000, 3_004)!;
    const replacements = spool.supersedeOversizedBatch(
      batch.batchId,
      finalClaim.leaseToken,
      rejection,
      2,
      3_005,
    );
    expect(replacements.map((item) => item.events.length)).toEqual([2, 2]);
    expect(spool.status().batches).toMatchObject({ pending: 2, superseded: 1 });
  });

  it('rejects unsafe acknowledgement and rejection objects before database mutation', () => {
    using spool = open();
    const handle = spool.createRun();
    started(spool, handle, Date.now());
    started(spool, handle, Date.now() + 1);
    const batch = spool.createBatch(handle.runId)!;
    const claim = spool.claimBatch(1_000)!;
    const secret = `secret-${randomUUID()}`;
    const acknowledgement = {
      outcome: 'accepted',
      batchId: batch.batchId,
      runId: handle.runId,
      receivedAt: timestamp,
      secret,
    };
    expect(() =>
      spool.acknowledgeBatchDelivery(
        batch.batchId,
        claim.leaseToken,
        acknowledgement,
      ),
    ).toThrow();
    const accessor = Object.defineProperty({}, 'batchId', {
      enumerable: true,
      get: () => batch.batchId,
    });
    expect(() =>
      spool.acknowledgeBatchDelivery(batch.batchId, claim.leaseToken, accessor),
    ).toThrow();
    const hiddenExtra = { ...acknowledgement };
    delete (hiddenExtra as { secret?: string }).secret;
    Object.defineProperty(hiddenExtra, 'hidden', { value: secret });
    expect(() =>
      spool.acknowledgeBatchDelivery(
        batch.batchId,
        claim.leaseToken,
        hiddenExtra,
      ),
    ).toThrow();
    for (const rejection of [
      Object.assign(Object.create({ secret }), {
        batchId: batch.batchId,
        code: 'payload_too_large',
        runId: handle.runId,
      }),
      {
        batchId: batch.batchId,
        code: 'payload_too_large',
        runId: handle.runId,
        secret,
      },
    ])
      expect(() =>
        spool.supersedeOversizedBatch(
          batch.batchId,
          claim.leaseToken,
          rejection,
          1,
        ),
      ).toThrow();
    expect(spool.status().batches.leased).toBe(1);
    expect(JSON.stringify(spool.status())).not.toContain(secret);
    spool.close();
    expect(
      readFileSync(join(spool.config.spoolRoot, 'spool.sqlite3')).includes(
        Buffer.from(secret),
      ),
    ).toBe(false);
  });
});
