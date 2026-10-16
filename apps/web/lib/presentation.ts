export type DashboardPresentationState =
  'PASS' | 'REVIEW' | 'FAILED' | 'INCOMPLETE' | 'PROCESSING';

export type DashboardProjectionState =
  'processing' | 'stale' | 'ready' | 'incomplete' | 'failed';

export interface DashboardPresentationInput {
  observedOutcome: 'succeeded' | 'failed' | 'cancelled' | 'unknown' | null;
  processingState: DashboardProjectionState;
  filesProcessingState: DashboardProjectionState;
  findingsProcessingState: DashboardProjectionState;
  summaryProcessingState: DashboardProjectionState;
  deterministicOutcome: 'pass' | 'review' | 'unknown' | null;
  summaryAvailability: 'current' | 'stale' | 'absent';
  summaryOutcome: 'pass' | 'review' | 'unknown' | null;
}

/**
 * Derives only the fixed v0.1 presentation convenience state. PASS means the
 * current deterministic catalog is clear; it is not a correctness, completion,
 * test-sufficiency, merge-safety, or policy claim. FAILED is only the observed
 * wrapped-process outcome. Projector failures remain INCOMPLETE.
 */
export function deriveDashboardPresentationState(
  input: DashboardPresentationInput,
): DashboardPresentationState {
  if (
    input.observedOutcome === 'failed' ||
    input.observedOutcome === 'cancelled'
  )
    return 'FAILED';

  const projectorStates = [
    input.processingState,
    input.filesProcessingState,
    input.findingsProcessingState,
    input.summaryProcessingState,
  ];
  if (projectorStates.includes('processing')) return 'PROCESSING';
  if (projectorStates.some((state) => state !== 'ready')) return 'INCOMPLETE';
  if (
    input.observedOutcome !== null &&
    input.observedOutcome !== 'succeeded' &&
    input.observedOutcome !== 'unknown'
  )
    return 'INCOMPLETE';
  if (input.summaryAvailability !== 'current') return 'INCOMPLETE';
  if (
    (input.deterministicOutcome !== 'pass' &&
      input.deterministicOutcome !== 'review') ||
    (input.summaryOutcome !== 'pass' && input.summaryOutcome !== 'review') ||
    input.deterministicOutcome !== input.summaryOutcome
  )
    return 'INCOMPLETE';
  return input.summaryOutcome === 'review' ? 'REVIEW' : 'PASS';
}
