import { createHash } from 'node:crypto';

import {
  EvidenceExportQueryError,
  getEvidenceExportSnapshot,
  type DatabaseClient,
} from '@blackbox/database';
import {
  buildEvidenceExportV1,
  EVIDENCE_EXPORT_MEDIA_TYPE,
  EVIDENCE_EXPORT_V1_FINDING_RULES,
  EvidenceExportTooLargeError,
  parseEvidenceExportV1,
  type ExportV1Snapshot,
} from '@blackbox/export';
import { describe, expect, it, vi } from 'vitest';

import { DASHBOARD_AUTHENTICATED_HEADER } from '../../../../../../server/dashboard-auth';
import {
  DashboardConfigurationError,
  type DashboardServerConfig,
} from '../../../../../../server/dashboard-config';
import { createEvidenceExportHandler } from './route';

const repositoryId = '11111111-1111-4111-8111-111111111111';
const runId = '22222222-2222-4222-8222-222222222222';
const secretSentinel = 'export-route-secret-sentinel';
const coreFingerprint = createHash('sha256').update('').digest('hex');
const findingsFingerprint = 'b'.repeat(64);
const summaryFingerprint = 'c'.repeat(64);
const config: DashboardServerConfig = {
  organizationId: '33333333-3333-4333-8333-333333333333',
  accessTokenSha256: createHash('sha256').update(secretSentinel).digest('hex'),
  cursorSigningKey: Buffer.alloc(32, 7),
  trustedProxyTokenSha256: createHash('sha256').update('proxy').digest('hex'),
  databaseUrl: 'postgresql://dashboard:database-secret@localhost/db',
  allowInsecureLoopback: false,
  storage: {
    url: 'https://example.supabase.co',
    serviceRoleKey: 'storage-secret-sentinel',
    bucket: 'private',
    connectTimeoutMs: 1_000,
  },
  preview: {
    maximumBytes: 1_024,
    inactivityTimeoutMs: 1_000,
    attemptTimeoutMs: 2_000,
  },
};

function request(authenticated = true) {
  return new Request(
    `https://dashboard.example/repositories/${repositoryId}/runs/${runId}/export`,
    {
      headers: authenticated ? { [DASHBOARD_AUTHENTICATED_HEADER]: '1' } : {},
    },
  );
}

function context(
  repository = repositoryId,
  run = runId,
): { params: Promise<{ repositoryId: string; runId: string }> } {
  return { params: Promise.resolve({ repositoryId: repository, runId: run }) };
}

function databaseClientFor(transaction: unknown): DatabaseClient {
  return {
    $transaction: async (callback: (value: unknown) => unknown) =>
      callback(transaction),
  } as unknown as DatabaseClient;
}

function baseExportRun() {
  return {
    id: 'internal-run-id',
    coreRunProjection: null,
    fileRunProjection: null,
    findingsRunProjection: null,
    summaryRunProjection: null,
    processingStates: [],
  };
}

function hash(index: number): string {
  return index.toString(16).padStart(64, '0');
}

function currentSummaryOverMissingFiles(): ExportV1Snapshot {
  const results = EVIDENCE_EXPORT_V1_FINDING_RULES.map((ruleId, index) => ({
    resultKey: hash(index + 1),
    catalogOrder: index,
    ruleId,
    ruleVersion: 1 as const,
    severity: (index === 4 || index === 5 ? 'medium' : 'high') as
      'medium' | 'high',
    outcome: 'unknown' as const,
    coverage: 'partial' as const,
    reasonCodes: ['file_evidence_missing'],
    explanation: 'File evidence is unavailable.',
    matchCount: 0,
    matches: [],
    matchesTruncated: false,
    referencesTruncated: false,
    references: [],
  }));
  return {
    repositoryId,
    runId,
    events: [],
    artifacts: [],
    processing: {
      core: {
        projectorName: 'core',
        expectedVersion: 1,
        observedVersion: 1,
        state: 'ready',
        currentness: 'incomplete',
        sourceEventCount: 0,
        sourceMaxSequence: null,
        sourceFingerprint: coreFingerprint,
        errorCode: null,
      },
      files: {
        projectorName: 'files',
        expectedVersion: 1,
        observedVersion: null,
        state: 'missing',
        currentness: 'processing',
        sourceEventCount: null,
        sourceMaxSequence: null,
        sourceFingerprint: null,
        errorCode: null,
      },
      findings: {
        projectorName: 'findings',
        expectedVersion: 1,
        observedVersion: 1,
        state: 'ready',
        currentness: 'ready',
        sourceEventCount: 0,
        sourceMaxSequence: null,
        sourceFingerprint: findingsFingerprint,
        errorCode: null,
      },
      summary: {
        projectorName: 'summary',
        expectedVersion: 1,
        observedVersion: 1,
        state: 'ready',
        currentness: 'ready',
        sourceEventCount: 1,
        sourceMaxSequence: null,
        sourceFingerprint: summaryFingerprint,
        errorCode: null,
      },
    },
    core: {
      state: 'available',
      projectorName: 'core',
      projectorVersion: 1,
      source: {
        eventCount: 0,
        maxSequence: null,
        fingerprint: coreFingerprint,
      },
      run: {
        started: null,
        finished: null,
        adapter: null,
        provider: null,
        observedOutcome: null,
        durationMs: null,
        evidenceCompleteness: 'incomplete',
        completenessReasons: ['run_finish_missing', 'run_start_missing'],
        commandCount: 0,
        toolCallCount: 0,
        testObservationState: 'not_observed',
        testCounts: {
          total: null,
          passed: null,
          failed: null,
          skipped: null,
          todo: null,
        },
        tokenAggregates: {
          inputTokens: { reportedTotal: null, unavailableCount: 0 },
          outputTokens: { reportedTotal: null, unavailableCount: 0 },
          cachedInputTokens: { reportedTotal: null, unavailableCount: 0 },
          reasoningTokens: { reportedTotal: null, unavailableCount: 0 },
          totalTokens: { reportedTotal: null, unavailableCount: 0 },
        },
        filesChanged: null,
      },
      commands: [],
      tools: [],
      tests: [],
      gitSnapshots: [],
      gitDiffs: [],
      errors: [],
      usage: [],
    },
    files: { state: 'unavailable', reason: 'missing' },
    findings: {
      state: 'available',
      projectorName: 'findings',
      projectorVersion: 1,
      analyzerName: 'deterministic-findings',
      analyzerVersion: 1,
      catalogVersion: 1,
      sourceFingerprint: findingsFingerprint,
      coreVersion: 1,
      coreFingerprint,
      coreCompleteness: 'incomplete',
      filesVersion: null,
      filesFingerprint: null,
      filesCompleteness: 'missing',
      deterministicOutcome: 'unknown',
      coverage: 'partial',
      triggeredCount: 0,
      unknownCount: results.length,
      highCount: 0,
      mediumCount: 0,
      results,
    },
    summary: {
      state: 'available',
      projectorName: 'summary',
      projectorVersion: 1,
      generatorName: 'deterministic-structured-summary',
      generatorVersion: 1,
      formatVersion: 1,
      templateVersion: 1,
      summaryKey: hash(20),
      sourceFingerprint: summaryFingerprint,
      coreVersion: 1,
      coreFingerprint,
      coreCompleteness: 'incomplete',
      filesVersion: null,
      filesFingerprint: null,
      filesCompleteness: 'missing',
      findingsProjectorVersion: 1,
      findingsFingerprint,
      findingsAnalyzerName: 'deterministic-findings',
      findingsAnalyzerVersion: 1,
      findingsCatalogVersion: 1,
      outcome: 'unknown',
      sectionCount: 1,
      claimCount: 1,
      claimsTruncated: false,
      claims: [
        {
          claimKey: hash(21),
          stableId: 'v1.limitations.files-missing',
          sectionId: 'limitations',
          sectionOrder: 3,
          claimOrder: 0,
          class: 'limitation',
          templateId: 'v1.limitations.files-missing',
          text: 'File evidence is unavailable.',
          supportCount: 1,
          supportsTruncated: false,
          supports: [
            {
              kind: 'finding',
              ordinal: 0,
              resultKey: results[0]!.resultKey,
              ruleId: results[0]!.ruleId,
              ruleVersion: 1,
              findingsSourceFingerprint: findingsFingerprint,
            },
          ],
        },
      ],
    },
  };
}

describe('GET private evidence export', () => {
  it('returns a parseable current summary over missing files with exact inert attachment headers', async () => {
    const built = buildEvidenceExportV1(currentSummaryOverMissingFiles());
    const exportRun = vi.fn(async () => built);
    const handler = createEvidenceExportHandler({
      config: () => config,
      runtime: () => ({ exportRun }),
    });
    const response = await handler(
      request(),
      context(repositoryId.toUpperCase(), runId.toUpperCase()),
    );

    expect(response.status).toBe(200);
    const responseBytes = new Uint8Array(await response.arrayBuffer());
    expect(responseBytes).toEqual(built.bytes);
    expect(parseEvidenceExportV1(responseBytes).bundle).toEqual(built.bundle);
    expect(response.headers.get('content-type')).toBe(
      EVIDENCE_EXPORT_MEDIA_TYPE,
    );
    expect(response.headers.get('content-disposition')).toBe(
      `attachment; filename="blackbox-evidence-${runId}.v1.json"`,
    );
    expect(response.headers.get('content-length')).toBe(
      String(built.bytes.length),
    );
    expect(response.headers.get('etag')).toBe(`"${built.sha256}"`);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(exportRun).toHaveBeenCalledWith({
      repositoryId,
      canonicalRunId: runId,
    });
  });

  it('fails closed for incompatible unavailable-files dependency facts', async () => {
    const snapshot = currentSummaryOverMissingFiles();
    if (snapshot.summary.state !== 'available') throw new Error();
    snapshot.summary.filesCompleteness = 'stale';
    const handler = createEvidenceExportHandler({
      config: () => config,
      runtime: () => ({
        exportRun: vi.fn(async () => buildEvidenceExportV1(snapshot)),
      }),
    });

    const response = await handler(request(), context());
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('Export unavailable');
  });

  it('challenges unauthenticated requests before runtime access', async () => {
    const exportRun = vi.fn();
    const handler = createEvidenceExportHandler({
      config: () => config,
      runtime: () => ({ exportRun }),
    });
    const response = await handler(request(false), context());
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('Basic');
    expect(exportRun).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong tenant or missing run', null, 404, 'Export unavailable'],
    [
      'safe source failure',
      new EvidenceExportQueryError('export_unavailable'),
      503,
      'Export unavailable',
    ],
    [
      'bounded export failure',
      new EvidenceExportTooLargeError(),
      413,
      'Export too large',
    ],
  ])('returns generic %s behavior', async (_name, result, status, body) => {
    const exportRun = vi.fn(async () => {
      if (result instanceof Error) throw result;
      return result;
    });
    const handler = createEvidenceExportHandler({
      config: () => config,
      runtime: () => ({ exportRun }),
    });
    const response = await handler(request(), context());
    expect(response.status).toBe(status);
    expect(await response.text()).toBe(body);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(JSON.stringify([...response.headers])).not.toContain(secretSentinel);
    expect(JSON.stringify([...response.headers])).not.toContain(
      config.organizationId,
    );
    expect(JSON.stringify([...response.headers])).not.toContain(
      config.storage.serviceRoleKey,
    );
  });

  it('rejects malformed route identities before a read', async () => {
    const exportRun = vi.fn();
    const handler = createEvidenceExportHandler({
      config: () => config,
      runtime: () => ({ exportRun }),
    });
    const response = await handler(request(), context('not-a-uuid', runId));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Export unavailable');
    expect(exportRun).not.toHaveBeenCalled();
  });

  it('stops cumulative database reads at the byte budget, bounds every page, and preserves export_too_large through the route', async () => {
    const totalRows = 5_000;
    const pageTakes: number[] = [];
    let requestedRows = 0;
    const evidenceEvent = {
      findMany: vi.fn(
        async ({ skip, take }: { skip: number; take: number }) => {
          pageTakes.push(take);
          requestedRows += take;
          return Array.from(
            { length: Math.min(take, totalRows - skip) },
            (_, offset) => {
              const sequence = skip + offset;
              const suffix = sequence.toString(16).padStart(12, '0');
              const eventId = `aaaaaaaa-aaaa-4aaa-8aaa-${suffix}`;
              const commandId = `bbbbbbbb-bbbb-4bbb-8bbb-${suffix}`;
              const observedAt = new Date('2026-11-23T10:00:00.000Z');
              const rawEvent = {
                schemaVersion: 1,
                eventId,
                runId,
                sequence,
                kind: 'command.finished',
                observedAt: observedAt.toISOString(),
                source: { component: 'collector' },
                payload: {
                  commandId,
                  outcome: 'succeeded',
                  stdout: {
                    state: 'captured',
                    excerpt: 'x'.repeat(4_096),
                    truncated: true,
                    redaction: { applied: false },
                  },
                  stderr: {
                    state: 'captured',
                    excerpt: 'y'.repeat(4_096),
                    truncated: true,
                    redaction: { applied: false },
                  },
                },
              };
              return {
                canonicalEventId: eventId,
                schemaVersion: 1,
                sequence: BigInt(sequence),
                kind: 'command.finished',
                observedAt,
                occurredAt: null,
                receivedAt: observedAt,
                rawEvent,
              };
            },
          );
        },
      ),
    };
    const transaction = {
      run: { findFirst: vi.fn(async () => baseExportRun()) },
      evidenceEvent,
    };
    let failure: unknown;
    try {
      await getEvidenceExportSnapshot(databaseClientFor(transaction), {
        organizationId: config.organizationId,
        repositoryId,
        canonicalRunId: runId,
        pageSize: 1_000,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(EvidenceExportTooLargeError);
    expect(requestedRows).toBeLessThan(totalRows);
    expect(Math.max(...pageTakes)).toBe(16);
    expect(evidenceEvent.findMany).toHaveBeenCalledTimes(pageTakes.length);

    const handler = createEvidenceExportHandler({
      config: () => config,
      runtime: () => ({
        exportRun: vi.fn(async () => {
          throw failure;
        }),
      }),
    });
    const response = await handler(request(), context());
    expect(response.status).toBe(413);
    expect(await response.text()).toBe('Export too large');
  });

  it('preflights database completenessReasons and preserves export_too_large instead of a 503', async () => {
    const evidenceEventRead = vi.fn();
    const transaction = {
      run: {
        findFirst: vi.fn(async () => ({
          ...baseExportRun(),
          coreRunProjection: {
            completenessReasons: new Array(101).fill('bounded-reason'),
          },
        })),
      },
      evidenceEvent: { findMany: evidenceEventRead },
    };
    let failure: unknown;
    try {
      await getEvidenceExportSnapshot(databaseClientFor(transaction), {
        organizationId: config.organizationId,
        repositoryId,
        canonicalRunId: runId,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(EvidenceExportTooLargeError);
    expect(evidenceEventRead).not.toHaveBeenCalled();

    const handler = createEvidenceExportHandler({
      config: () => config,
      runtime: () => ({
        exportRun: vi.fn(async () => {
          throw failure;
        }),
      }),
    });
    const response = await handler(request(), context());
    expect(response.status).toBe(413);
    expect(await response.text()).toBe('Export too large');
  });

  it('fails closed before reads for invalid server configuration', async () => {
    const exportRun = vi.fn();
    const handler = createEvidenceExportHandler({
      config: () => {
        throw new DashboardConfigurationError();
      },
      runtime: () => ({ exportRun }),
    });
    const response = await handler(request(), context());
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('Service unavailable');
    expect(exportRun).not.toHaveBeenCalled();
  });
});
