import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const routeMocks = vi.hoisted(() => ({
  listRuns: vi.fn(),
  resolveEvidence: vi.fn(),
  getRunDetail: vi.fn(),
  listFiles: vi.fn(),
  listFindings: vi.fn(),
  listSummaryClaims: vi.fn(),
  listSummarySupports: vi.fn(),
  listTimeline: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: unknown;
  }) => createElement('a', { href, ...props }, children as never),
}));
vi.mock('next/navigation', () => ({
  notFound: routeMocks.notFound,
}));
vi.mock('../server/dashboard-runtime', () => ({
  getDashboardRuntime: () => ({
    listRuns: routeMocks.listRuns,
    resolveEvidence: routeMocks.resolveEvidence,
    getRunDetail: routeMocks.getRunDetail,
    listFiles: routeMocks.listFiles,
    listFindings: routeMocks.listFindings,
    listSummaryClaims: routeMocks.listSummaryClaims,
    listSummarySupports: routeMocks.listSummarySupports,
    listTimeline: routeMocks.listTimeline,
  }),
  isDashboardReadRequestError: () => false,
}));

import EvidencePage, {
  dynamic as evidenceDynamic,
  fetchCache as evidenceFetchCache,
} from './repositories/[repositoryId]/runs/[runId]/evidence/page';
import NotFound from './not-found';
import RunDetailPage from './repositories/[repositoryId]/runs/[runId]/page';
import RunsPage, {
  dynamic as runsDynamic,
  fetchCache as runsFetchCache,
} from './runs/page';
import {
  dashboardFixtureIds,
  dashboardRunFixture,
} from '../test/dashboard-fixtures';

const { repositoryId, runId, eventId } = dashboardFixtureIds;
const resultKey = 'a'.repeat(64);
const claimKey = 'b'.repeat(64);

function configureDetail(
  projection: Record<string, unknown> | null,
  summarySupports: Array<{
    ordinal: number;
    kind: 'finding' | 'evidence';
    resultKey?: string;
    eventId?: string;
    artifactId?: null;
    eventArtifactPointer?: null;
    jsonPointer?: null;
    fileOrdinal?: null;
    entryId?: null;
  }> = [
    { ordinal: 0, kind: 'finding', resultKey },
    {
      ordinal: 1,
      kind: 'evidence',
      eventId,
      artifactId: null,
      eventArtifactPointer: null,
      jsonPointer: null,
      fileOrdinal: null,
      entryId: null,
    },
  ],
) {
  routeMocks.getRunDetail.mockResolvedValueOnce({
    runId,
    createdAt: '2026-10-15T00:00:00.000Z',
    processingState: projection ? 'ready' : 'incomplete',
    processingErrorCode: null,
    filesProcessingState: 'ready',
    filesProcessingErrorCode: null,
    findingsProcessingState: 'ready',
    findingsProcessingErrorCode: null,
    summaryProcessingState: 'ready',
    summaryProcessingErrorCode: null,
    deterministicOutcome: 'review',
    summaryAvailability: 'current',
    summaryOutcome: 'review',
    presentationState: projection ? 'REVIEW' : 'INCOMPLETE',
    filesChanged: 1,
    projection,
  });
  routeMocks.listFiles.mockResolvedValueOnce({
    processingState: 'ready',
    items: [],
    nextCursor: null,
  });
  routeMocks.listFindings.mockResolvedValueOnce({
    processingState: 'ready',
    items: [
      {
        resultKey,
        ruleId: 'bbx.fixture.rule',
        ruleVersion: 1,
        severity: 'high',
        outcome: 'triggered',
        coverage: 'complete',
        reasonCodes: ['fixture'],
        explanation: 'Fixture finding',
        matchCount: 1,
        matchesTruncated: false,
        referencesTruncated: false,
        references: [
          {
            ordinal: 2,
            eventId,
            artifactId: null,
            eventArtifactPointer: null,
            jsonPointer: null,
            fileOrdinal: null,
            entryId: null,
          },
        ],
      },
      {
        resultKey: 'c'.repeat(64),
        ruleId: 'bbx.fixture.clear',
        ruleVersion: 1,
        severity: 'info',
        outcome: 'clear',
        coverage: 'complete',
        reasonCodes: [],
        explanation: 'Clear fixture finding',
        matchCount: 0,
        matchesTruncated: false,
        referencesTruncated: false,
        references: [],
      },
    ],
    nextCursor: null,
  });
  routeMocks.listSummaryClaims.mockResolvedValueOnce({
    summaryAvailability: 'current',
    items: [
      {
        claimKey,
        sectionId: 'findings',
        class: 'review',
        text: 'Review the exact finding.',
        supportCount: summarySupports.length,
        supportsTruncated: false,
        supports: summarySupports,
      },
    ],
    nextCursor: null,
  });
  routeMocks.listTimeline.mockResolvedValueOnce({
    items: [],
    nextCursor: null,
  });
}

function coreProjection(errors: unknown[]) {
  const page = (items: unknown[]) => ({ items, nextCursor: null });
  return {
    observedOutcome: 'succeeded',
    evidenceCompleteness: 'complete',
    completenessReasons: [],
    durationMs: 10,
    filesChanged: 1,
    testObservationState: 'observed',
    commands: page([]),
    tests: page([]),
    tools: page([]),
    gitSnapshots: page([]),
    gitDiffs: page([]),
    errors: page(errors),
    usage: page([]),
  };
}

describe('dashboard server routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps private pages dynamic and non-cacheable', () => {
    expect([runsDynamic, evidenceDynamic]).toEqual([
      'force-dynamic',
      'force-dynamic',
    ]);
    expect([runsFetchCache, evidenceFetchCache]).toEqual([
      'force-no-store',
      'force-no-store',
    ]);
  });

  it('renders nullable list metrics as unavailable and preserves accepted PASS wording', async () => {
    routeMocks.listRuns.mockResolvedValueOnce({
      items: [
        dashboardRunFixture({
          durationMs: null,
          filesChanged: null,
          commandCount: null,
          toolCallCount: null,
          testObservationState: 'not_observed',
          testCounts: null,
          triggeredFindingCount: null,
          tokenAggregates: null,
        }),
      ],
      nextCursor: null,
    });
    const view = await RunsPage({ searchParams: Promise.resolve({}) });
    const html = renderToStaticMarkup(view);
    expect(html).toContain('PASS');
    expect(html).toContain('not a correctness');
    expect(html.match(/Unavailable/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it('rejects unknown query authority before the run facade is called', async () => {
    const view = await RunsPage({
      searchParams: Promise.resolve({ organizationId: repositoryId }),
    });
    expect(renderToStaticMarkup(view)).toContain('cannot be continued');
    expect(routeMocks.listRuns).not.toHaveBeenCalled();
  });

  it('renders hostile event and preview content only as escaped text', async () => {
    routeMocks.resolveEvidence.mockResolvedValueOnce({
      locatorKind: 'event',
      event: {
        eventId,
        sequence: 1,
        kind: 'error.observed',
        observedAt: '2026-10-15T00:00:00.000Z',
        occurredAt: null,
        receivedAt: '2026-10-15T00:00:01.000Z',
        data: { hostile: '<script>globalThis.pwned=true</script>' },
      },
      artifact: null,
      file: null,
      finding: null,
    });
    const view = await EvidencePage({
      params: Promise.resolve({ repositoryId, runId }),
      searchParams: Promise.resolve({ kind: 'event', eventId }),
    });
    const html = renderToStaticMarkup(view);
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('DATABASE_URL');
  });

  it('uses one generic not-found result for missing or tenant-hidden evidence', async () => {
    routeMocks.resolveEvidence.mockResolvedValueOnce(null);
    await expect(
      EvidencePage({
        params: Promise.resolve({ repositoryId, runId }),
        searchParams: Promise.resolve({ kind: 'event', eventId }),
      }),
    ).rejects.toThrow('NEXT_NOT_FOUND');
    expect(routeMocks.notFound).toHaveBeenCalledOnce();
  });

  it('renders generic not-found content without route, tenant, or diagnostic data', () => {
    const html = renderToStaticMarkup(createElement(NotFound));
    expect(html).toContain('<main id="main-content"');
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain('Evidence view unavailable');
    expect(html).toContain(
      'The requested resource is missing or unavailable to this dashboard.',
    );
    for (const privateValue of [
      repositoryId,
      runId,
      'DASHBOARD_ORGANIZATION_ID',
      'DATABASE_URL',
      'NEXT_NOT_FOUND',
    ])
      expect(html).not.toContain(privateValue);
  });

  it('targets a summary finding support at the finding and keeps references independent', async () => {
    configureDetail(coreProjection([]));
    const view = await RunDetailPage({
      params: Promise.resolve({ repositoryId, runId }),
      searchParams: Promise.resolve({ tools: 'signed-tools' }),
    });
    const html = renderToStaticMarkup(view);
    expect(html).toContain(
      `href="/repositories/${repositoryId}/runs/${runId}?tools=signed-tools&amp;focusFinding=${resultKey}#finding-${resultKey}"`,
    );
    expect(html).not.toContain('referenceOrdinal=0');
    expect(html).toContain('referenceOrdinal=2');
    expect(html).toContain(
      'No navigable immutable evidence reference is available for this finding.',
    );
  });

  it('renders a bounded support preview and exposes complete claim-bound pagination', async () => {
    const allSupports = Array.from({ length: 7 }, (_, ordinal) => ({
      ordinal,
      kind: 'evidence' as const,
      eventId,
      artifactId: null,
      eventArtifactPointer: null,
      jsonPointer: null,
      fileOrdinal: null,
      entryId: null,
    }));
    configureDetail(coreProjection([]), allSupports);
    routeMocks.listSummarySupports.mockResolvedValueOnce({
      processingState: 'ready',
      summaryAvailability: 'current',
      processingErrorCode: null,
      claimKey,
      items: allSupports.slice(0, 5),
      nextCursor: 'signed-next-supports',
    });

    const first = await RunDetailPage({
      params: Promise.resolve({ repositoryId, runId }),
      searchParams: Promise.resolve({ supportClaim: claimKey }),
    });
    const firstHtml = renderToStaticMarkup(first);
    expect(firstHtml).toContain('7 supports');
    expect(
      firstHtml.match(/data-dashboard-collection="summary-support-preview-/g),
    ).toHaveLength(2);
    expect(firstHtml).toContain('Page all supports');
    expect(
      firstHtml.match(
        new RegExp('data-dashboard-collection="summary-supports"', 'g'),
      ),
    ).toHaveLength(5);
    expect(firstHtml).toContain('aria-label="Next summary supports page"');
    expect(routeMocks.listSummarySupports).toHaveBeenCalledWith({
      repositoryId,
      canonicalRunId: runId,
      claimKey,
      limit: 5,
    });

    configureDetail(coreProjection([]), allSupports);
    routeMocks.listSummarySupports.mockResolvedValueOnce({
      processingState: 'ready',
      summaryAvailability: 'current',
      processingErrorCode: null,
      claimKey,
      items: allSupports.slice(5),
      nextCursor: null,
    });
    const terminal = await RunDetailPage({
      params: Promise.resolve({ repositoryId, runId }),
      searchParams: Promise.resolve({
        supportClaim: claimKey,
        summarySupports: 'signed-support-page',
      }),
    });
    const terminalHtml = renderToStaticMarkup(terminal);
    expect(
      terminalHtml.match(
        new RegExp('data-dashboard-collection="summary-supports"', 'g'),
      ),
    ).toHaveLength(2);
    expect(terminalHtml).not.toContain(
      'aria-label="Next summary supports page"',
    );
    expect(terminalHtml).toContain(
      'data-terminal-collection="summary supports"',
    );
    expect(routeMocks.listSummarySupports).toHaveBeenLastCalledWith({
      repositoryId,
      canonicalRunId: runId,
      claimKey,
      limit: 5,
      cursor: 'signed-support-page',
    });
  });

  it('renders only the exact focused finding when the target follows a later catalog page', async () => {
    configureDetail(coreProjection([]));
    const laterResultKey = 'c'.repeat(64);
    const view = await RunDetailPage({
      params: Promise.resolve({ repositoryId, runId }),
      searchParams: Promise.resolve({
        summaryClaims: 'signed-summary-page',
        focusFinding: laterResultKey,
      }),
    });
    const html = renderToStaticMarkup(view);

    expect(routeMocks.listFindings).toHaveBeenCalledWith({
      repositoryId,
      canonicalRunId: runId,
      limit: 100,
    });
    expect(html).toContain(`id="finding-${laterResultKey}"`);
    expect(html).not.toContain(`id="finding-${resultKey}"`);
    expect(html).toContain(
      'No navigable immutable evidence reference is available for this finding.',
    );
    expect(html).not.toContain('aria-label="Next findings page"');
  });

  it('fails closed when a focused finding is stale, replaced, or belongs to another run', async () => {
    configureDetail(coreProjection([]));
    await expect(
      RunDetailPage({
        params: Promise.resolve({ repositoryId, runId }),
        searchParams: Promise.resolve({ focusFinding: 'd'.repeat(64) }),
      }),
    ).rejects.toThrow('NEXT_NOT_FOUND');
    expect(routeMocks.notFound).toHaveBeenCalledOnce();
  });

  it('distinguishes an absent core projection from a present empty error collection', async () => {
    configureDetail(null);
    let view = await RunDetailPage({
      params: Promise.resolve({ repositoryId, runId }),
      searchParams: Promise.resolve({}),
    });
    let html = renderToStaticMarkup(view);
    expect(html).toContain(
      'Core projection unavailable; error evidence completeness is unknown.',
    );
    expect(html).not.toContain(
      'No error observations exist on this complete projection page.',
    );

    configureDetail(coreProjection([]));
    view = await RunDetailPage({
      params: Promise.resolve({ repositoryId, runId }),
      searchParams: Promise.resolve({}),
    });
    html = renderToStaticMarkup(view);
    expect(html).toContain(
      'No error observations exist on this complete projection page.',
    );
    expect(html).not.toContain(
      'Core projection unavailable; error evidence completeness is unknown.',
    );
  });

  it('renders present error rows with a stable collection identity and continuation', async () => {
    configureDetail({
      ...coreProjection([{ errorId: 'error-1', code: 'fixture' }]),
      errors: {
        items: [{ errorId: 'error-1', code: 'fixture' }],
        nextCursor: 'signed-next-errors',
      },
    });
    const view = await RunDetailPage({
      params: Promise.resolve({ repositoryId, runId }),
      searchParams: Promise.resolve({}),
    });
    const html = renderToStaticMarkup(view);
    expect(html).toContain('data-dashboard-collection="errors"');
    expect(html).toContain('data-dashboard-item-key="error-1"');
    expect(html).toContain('aria-label="Next errors page"');
  });
});
