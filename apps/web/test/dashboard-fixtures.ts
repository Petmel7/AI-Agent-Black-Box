import type { DashboardRunListView } from '../server/dashboard-runtime';

export const dashboardFixtureIds = Object.freeze({
  repositoryId: '11111111-1111-4111-8111-111111111111',
  runId: '22222222-2222-4222-8222-222222222222',
  eventId: '33333333-3333-4333-8333-333333333333',
});

type RunItem = DashboardRunListView['items'][number];

/** Exact server-facade shape; individual tests override only the state under test. */
export function dashboardRunFixture(overrides: Partial<RunItem> = {}): RunItem {
  return {
    repositoryId: dashboardFixtureIds.repositoryId,
    runId: dashboardFixtureIds.runId,
    createdAt: '2026-10-15T00:00:00.000Z',
    processingState: 'ready',
    processingErrorCode: null,
    filesProcessingState: 'ready',
    filesProcessingErrorCode: null,
    filesCompleteness: 'complete',
    filesCompletenessReason: null,
    findingsProcessingState: 'ready',
    findingsProcessingErrorCode: null,
    deterministicOutcome: 'pass',
    findingsCoverage: 'complete',
    triggeredFindingCount: 0,
    unknownFindingCount: 0,
    highFindingCount: 0,
    mediumFindingCount: 0,
    summaryProcessingState: 'ready',
    summaryAvailability: 'current',
    summaryProcessingErrorCode: null,
    summaryOutcome: 'pass',
    summaryGeneratorVersion: 1,
    summaryFormatVersion: 1,
    summaryTemplateVersion: 1,
    summarySectionCount: 1,
    summaryClaimCount: 1,
    summaryClaimsTruncated: false,
    evidenceCompleteness: 'complete',
    observedOutcome: 'succeeded',
    durationMs: 1_250,
    commandCount: 1,
    toolCallCount: 1,
    testObservationState: 'observed',
    testCounts: { passed: 1, failed: 0 },
    tokenAggregates: { input: 10, output: 5 },
    filesChanged: 1,
    presentationState: 'PASS',
    ...overrides,
  };
}
