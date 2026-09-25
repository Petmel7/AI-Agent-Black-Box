import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { auditArtifacts } from './artifacts.js';
import { validateCollectorConfig } from './config.js';
import { CollectorError } from './errors.js';
import type { RedactorOptions } from './redaction.js';
import { CollectorSession } from './session.js';
import { LocalSpool } from './spool.js';

const roots: string[] = [];
function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'bbx-artifact-'));
  roots.push(path);
  return join(path, 'spool');
}

afterEach(() => {
  for (const path of roots.splice(0))
    rmSync(path, { recursive: true, force: true });
});

function opened(
  quota = 1_000_000,
  hooks = {},
  redactorOptions: RedactorOptions = { environment: {} },
): LocalSpool {
  return new LocalSpool(
    validateCollectorConfig({
      captureClasses: ['stdout', 'file-content'],
      spoolQuotaBytes: quota,
      spoolRoot: root(),
    }),
    hooks,
    redactorOptions,
  ).open();
}

function openedSession(
  spool: LocalSpool,
  options: RedactorOptions = {},
): CollectorSession {
  return CollectorSession.open(
    {
      captureClasses: [...spool.config.captureClasses],
      inputLimitBytes: spool.config.inputLimitBytes,
      spoolQuotaBytes: spool.config.spoolQuotaBytes,
      spoolRoot: spool.config.spoolRoot,
    },
    options,
  );
}

describe('artifact durability and privacy', () => {
  it('stores exact redacted bytes and reports missing, corrupt, and orphan files', () => {
    const secret = `secret-${randomUUID()}`;
    using spool = opened(
      1_000_000,
      {},
      {
        collectorCredentials: [secret],
        environment: {},
      },
    );
    const handle = spool.createRun();
    const capture = spool.captureText(
      handle,
      'stdout',
      Buffer.from(`before ${secret} after`),
      { kind: 'command-output' },
    );
    expect(capture.state).toBe('captured');
    if (capture.state !== 'captured' || !capture.artifact)
      throw new Error('expected artifact');
    const row = spool.artifactIntegrityRecords()[0];
    if (!row) throw new Error('expected artifact record');
    const path = join(spool.artifactDirectory, row.relativePath);
    expect(readFileSync(path, 'utf8')).toBe('before [REDACTED] after');
    expect(auditArtifacts(spool)).toEqual({
      corrupt: 0,
      missing: 0,
      orphanFinal: 0,
      orphanTemporary: 0,
    });
    appendFileSync(path, 'tamper');
    expect(auditArtifacts(spool).corrupt).toBe(1);
    unlinkSync(path);
    expect(auditArtifacts(spool).missing).toBe(1);
  });

  it.each([
    'afterArtifactWrite',
    'afterArtifactFlush',
    'afterArtifactRename',
  ] as const)(
    'leaves visible unreferenced state when failure occurs at %s',
    (hook) => {
      using spool = opened(1_000_000, {
        [hook]: () => {
          throw new Error('injected');
        },
      });
      const handle = spool.createRun();
      const capture = spool.captureText(handle, 'stdout', Buffer.from('safe'), {
        kind: 'command-output',
      });
      expect(capture).toMatchObject({ state: 'captured', truncated: true });
      const audit = auditArtifacts(spool);
      expect(audit.orphanFinal + audit.orphanTemporary).toBe(1);
      expect(spool.status().artifacts.pending).toBe(0);
    },
  );

  it('keeps existing data and reports quota pressure', () => {
    using spool = opened(40);
    const handle = spool.createRun();
    expect(
      spool.captureText(handle, 'stdout', Buffer.alloc(41, 120), {
        kind: 'command-output',
      }),
    ).toMatchObject({ state: 'captured', truncated: true });
    expect(readdirSync(spool.artifactDirectory)).toEqual([]);
    expect(spool.status().diagnostics).toEqual({ 'quota-exceeded': 1 });
  });

  it('claims artifact work across connections and rejects stale lease owners', () => {
    using spool = opened();
    const handle = spool.createRun();
    const capture = spool.captureText(
      handle,
      'stdout',
      Buffer.from('redacted'),
      {
        kind: 'command-output',
      },
    );
    if (capture.state !== 'captured' || !capture.artifact)
      throw new Error('expected artifact');
    const reference = capture.artifact;
    const claim = spool.claimArtifact(1_000, 1_000)!;
    expect(claim.id).toBe(reference.artifactId);
    expect(() =>
      spool.releaseArtifact(
        reference.artifactId,
        claim.leaseToken,
        undefined,
        2_000,
      ),
    ).toThrowError(
      expect.objectContaining<Partial<CollectorError>>({ code: 'lease-lost' }),
    );
    expect(spool.recoverExpired(2_000).artifacts).toBe(1);
    const replacement = spool.claimArtifact(1_000, 2_001)!;
    spool.releaseArtifact(
      reference.artifactId,
      replacement.leaseToken,
      4_000,
      2_002,
    );
    expect(spool.status(undefined, 3_000)).toMatchObject({
      retryDelayed: { artifacts: 1 },
    });
  });

  it('requires complete immutable artifact declarations and rolls mismatches back', () => {
    using spool = opened();
    using session = openedSession(spool, { environment: {} });
    const valid = session.observeGitDiffCaptured({
      diff: Buffer.from('diff'),
      diffId: randomUUID(),
      fileList: Buffer.from('file.ts'),
      fromSnapshotId: randomUUID(),
      toSnapshotId: randomUUID(),
    });
    expect(valid.sequence).toBe(0);
    const database = new DatabaseSync(spool.databasePath);
    expect(
      database.prepare('SELECT COUNT(*) AS count FROM event_artifacts').get(),
    ).toMatchObject({ count: 2 });
    const extraArtifact = database
      .prepare('SELECT artifact_id,canonical_json FROM artifacts LIMIT 1')
      .get() as { artifact_id: string; canonical_json: string };
    expect(() =>
      database
        .prepare(
          'INSERT INTO event_artifacts(event_id,artifact_id,reference_json) VALUES (?,?,?)',
        )
        .run(
          valid.eventId,
          extraArtifact.artifact_id,
          extraArtifact.canonical_json,
        ),
    ).toThrow(/sealed event artifacts/);

    if (valid.kind !== 'git.diff.captured')
      throw new Error('expected git diff');
    const thirdEvent = session.observeCommandFinished({
      commandId: randomUUID(),
      outcome: 'succeeded',
      stdout: Buffer.from('third'),
    });
    if (
      thirdEvent.kind !== 'command.finished' ||
      thirdEvent.payload.stdout.state !== 'captured' ||
      !thirdEvent.payload.stdout.artifact
    )
      throw new Error('expected third artifact');
    const thirdReference = thirdEvent.payload.stdout.artifact;
    const references = [
      valid.payload.diffArtifact,
      valid.payload.fileListArtifact,
    ];
    const insertEvent = (eventId: string, diffArtifact = references[0]!) => {
      const event = {
        ...valid,
        eventId,
        sequence: 100,
        payload: { ...valid.payload, diffArtifact },
      };
      database
        .prepare(
          'INSERT INTO events(event_id,run_id,sequence,canonical_json,created_at) VALUES (?,?,?,?,?)',
        )
        .run(
          eventId,
          valid.runId,
          100,
          JSON.stringify(event),
          valid.observedAt,
        );
    };
    const reference = references[0]!;
    const mismatches = [
      { ...reference, artifactId: randomUUID() },
      { ...reference, kind: 'other-kind' },
      { ...reference, mediaType: 'text/csv' },
      { ...reference, byteLength: reference.byteLength + 1 },
      { ...reference, sha256: '0'.repeat(64) },
      { ...reference, redaction: { applied: false } },
      { ...reference, compression: 'gzip' as const },
      { ...reference, characterEncoding: 'ascii' },
    ];
    for (const mismatch of mismatches) {
      database.exec('BEGIN IMMEDIATE');
      const eventId = randomUUID();
      insertEvent(eventId, mismatch);
      expect(() =>
        database
          .prepare(
            'INSERT INTO event_artifacts(event_id,artifact_id,reference_json) VALUES (?,?,?)',
          )
          .run(eventId, mismatch.artifactId, JSON.stringify(mismatch)),
      ).toThrow(/inconsistent artifact reference/);
      database.exec('ROLLBACK');
    }
    database.exec('BEGIN IMMEDIATE');
    const missingEvent = randomUUID();
    insertEvent(missingEvent);
    expect(() =>
      database
        .prepare('INSERT INTO event_seals(event_id) VALUES (?)')
        .run(missingEvent),
    ).toThrow(/incomplete event artifacts/);
    database.exec('ROLLBACK');

    database.exec('BEGIN IMMEDIATE');
    const validEvent = randomUUID();
    insertEvent(validEvent);
    const link = database.prepare(
      'INSERT INTO event_artifacts(event_id,artifact_id,reference_json) VALUES (?,?,?)',
    );
    expect(() =>
      link.run(
        validEvent,
        thirdReference.artifactId,
        JSON.stringify(thirdReference),
      ),
    ).toThrow(/inconsistent artifact reference/);
    for (const reference of references)
      link.run(validEvent, reference.artifactId, JSON.stringify(reference));
    database
      .prepare('INSERT INTO event_seals(event_id) VALUES (?)')
      .run(validEvent);
    expect(() =>
      link.run(
        validEvent,
        thirdReference.artifactId,
        JSON.stringify(thirdReference),
      ),
    ).toThrow(/sealed event artifacts/);
    database.exec('ROLLBACK');
    database.close();
    expect(spool.createBatch(session.runId)?.events).toHaveLength(2);
  });

  it('verifies artifacts only from a matching owned upload response', () => {
    using spool = opened();
    const handle = spool.createRun();
    const capture = spool.captureText(
      handle,
      'stdout',
      Buffer.from('redacted'),
      {
        kind: 'command-output',
      },
    );
    if (capture.state !== 'captured' || !capture.artifact)
      throw new Error('expected artifact');
    const reference = capture.artifact;
    const claim = spool.claimArtifact(1_000, 1_000)!;
    const uploadId = randomUUID();
    spool.bindArtifactUpload(
      reference.artifactId,
      claim.leaseToken,
      uploadId,
      1_001,
    );
    const response = {
      schemaVersion: 1 as const,
      outcome: 'verified' as const,
      artifactId: reference.artifactId,
      verification: {
        uploadId,
        byteLength: reference.byteLength,
        sha256: reference.sha256,
        verifiedAt: '2026-09-24T10:00:00.000Z',
      },
    };
    const secret = `secret-${randomUUID()}`;
    expect(() =>
      spool.acknowledgeArtifactVerification(
        reference.artifactId,
        claim.leaseToken,
        { ...response, secret },
        1_002,
      ),
    ).toThrow();
    expect(() =>
      spool.acknowledgeArtifactVerification(
        reference.artifactId,
        claim.leaseToken,
        {
          ...response,
          verification: { ...response.verification, secret },
        },
        1_002,
      ),
    ).toThrow();
    const accessor = Object.defineProperty({}, 'verification', {
      enumerable: true,
      get: () => ({ ...response.verification, secret }),
    });
    expect(() =>
      spool.acknowledgeArtifactVerification(
        reference.artifactId,
        claim.leaseToken,
        accessor,
        1_002,
      ),
    ).toThrow();
    expect(() =>
      spool.acknowledgeArtifactVerification(
        reference.artifactId,
        claim.leaseToken,
        {
          ...response,
          verification: { ...response.verification, sha256: '0'.repeat(64) },
        },
        1_002,
      ),
    ).toThrow();
    expect(() =>
      spool.acknowledgeArtifactVerification(
        randomUUID(),
        claim.leaseToken,
        response,
        1_002,
      ),
    ).toThrow();
    spool.acknowledgeArtifactVerification(
      reference.artifactId,
      claim.leaseToken,
      response,
      1_002,
    );
    expect(() =>
      spool.acknowledgeArtifactVerification(
        reference.artifactId,
        'duplicate',
        response,
        9_000,
      ),
    ).not.toThrow();
    expect(spool.status().artifacts.verified).toBe(1);
    expect(JSON.stringify(spool.status())).not.toContain(secret);
    spool.close();
    expect(readFileSync(spool.databasePath).includes(Buffer.from(secret))).toBe(
      false,
    );
  });

  it('requires active unexpired run ownership in the artifact registration transaction', () => {
    const secret = `secret-${randomUUID()}`;
    const cases = ['expired', 'replaced', 'interrupted', 'closed'] as const;
    for (const kind of cases) {
      using spool = opened(
        1_000_000,
        {},
        {
          collectorCredentials: [secret],
          environment: {},
        },
      );
      const now = Date.now();
      const handle = spool.createRun(
        1_000,
        kind === 'expired' ? now - 2_000 : now,
      );
      if (kind === 'replaced') {
        const database = new DatabaseSync(spool.databasePath);
        database
          .prepare('UPDATE runs SET owner_token=? WHERE run_id=?')
          .run(randomUUID(), handle.runId);
        database.close();
      } else if (kind === 'interrupted') {
        spool.recoverExpired(now + 2_000);
      } else if (kind === 'closed') {
        spool.recordRunFinished(handle, { outcome: 'succeeded' }, now + 1);
        spool.closeRun(handle, now + 2);
      }
      const capture = spool.captureText(
        handle,
        'stdout',
        Buffer.from(`safe ${secret}`),
        { kind: 'command-output' },
      );
      expect(capture).toMatchObject({ state: 'captured', truncated: true });
      expect(spool.status().artifacts.pending).toBe(0);
      expect(auditArtifacts(spool).orphanFinal).toBe(1);
      for (const path of readdirSync(spool.artifactDirectory))
        expect(
          readFileSync(join(spool.artifactDirectory, path), 'utf8'),
        ).not.toContain(secret);
    }
  });

  it('leaves only a redacted visible orphan when ownership is lost after rename', () => {
    const spoolRoot = root();
    const config = validateCollectorConfig({
      captureClasses: ['stdout'],
      spoolRoot,
    });
    const ownership: {
      handle?: { ownerToken: string; runId: string };
    } = {};
    using spool = new LocalSpool(
      config,
      {
        afterArtifactRename: () => {
          if (!ownership.handle) return;
          const database = new DatabaseSync(join(spoolRoot, 'spool.sqlite3'));
          database
            .prepare('UPDATE runs SET owner_token=? WHERE run_id=?')
            .run(randomUUID(), ownership.handle.runId);
          database.close();
        },
      },
      { collectorCredentials: ['race-secret-value'], environment: {} },
    ).open();
    const handle = spool.createRun();
    ownership.handle = handle;
    const capture = spool.captureText(
      handle,
      'stdout',
      Buffer.from('race-secret-value'),
      { kind: 'command-output' },
    );
    expect(capture).toMatchObject({ state: 'captured', truncated: true });
    expect(spool.status().artifacts.pending).toBe(0);
    expect(auditArtifacts(spool).orphanFinal).toBe(1);
    const file = readdirSync(spool.artifactDirectory)[0]!;
    expect(readFileSync(join(spool.artifactDirectory, file), 'utf8')).toBe(
      '[REDACTED]',
    );
  });
});
