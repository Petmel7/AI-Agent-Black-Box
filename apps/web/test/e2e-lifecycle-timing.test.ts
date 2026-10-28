import { describe, expect, it } from 'vitest';

// @ts-expect-error -- this Node-owned test helper intentionally executes as ESM.
import * as timingModule from './e2e-lifecycle-timing.mjs';

const {
  boundedLifecycleWaitMs,
  assertCleanupMilestones,
  completeCleanupBudgetMs,
  createLifecycleTimeline,
  deriveOuterWatchdogMs,
  E2E_LIFECYCLE_BOUNDS,
  remainingLifecycleMs,
} = timingModule as unknown as {
  E2E_LIFECYCLE_BOUNDS: {
    controllerReportingMarginMs: number;
    killConvergenceMs: number;
    termConvergenceMs: number;
    terminalAcknowledgementMs: number;
  };
  completeCleanupBudgetMs: (bounds?: {
    controllerReportingMarginMs: number;
    killConvergenceMs: number;
    termConvergenceMs: number;
    terminalAcknowledgementMs: number;
  }) => number;
  deriveOuterWatchdogMs: (operationDeadlineMs: number) => {
    cleanupBudgetMs: number;
    operationDeadlineMs: number;
    outerWatchdogMs: number;
  };
  createLifecycleTimeline: (
    operationDeadlineMs: number,
    now?: number,
  ) => {
    cleanupBudgetMs: number;
    operationDeadlineAt: number;
    operationDeadlineMs: number;
    outerDeadlineAt: number;
    outerWatchdogMs: number;
  };
  remainingLifecycleMs: (deadlineAt: number, now?: number) => number;
  boundedLifecycleWaitMs: (
    deadlineAt: number,
    maximumMs: number,
    now?: number,
  ) => number;
  assertCleanupMilestones: (value: {
    cleanupStartedAt: number;
    killVerificationCompletedAt: number;
    operationDeadlineAt: number;
    outerDeadlineAt: number;
    termCompletedAt: number;
  }) => unknown;
};

describe('E2E lifecycle timing contract', () => {
  it('derives the outer watchdog after every bounded cleanup phase', () => {
    const cleanupBudgetMs = completeCleanupBudgetMs();
    expect(cleanupBudgetMs).toBe(
      E2E_LIFECYCLE_BOUNDS.termConvergenceMs +
        E2E_LIFECYCLE_BOUNDS.killConvergenceMs +
        E2E_LIFECYCLE_BOUNDS.terminalAcknowledgementMs +
        E2E_LIFECYCLE_BOUNDS.controllerReportingMarginMs,
    );
    expect(deriveOuterWatchdogMs(250)).toEqual({
      operationDeadlineMs: 250,
      cleanupBudgetMs,
      outerWatchdogMs: 250 + cleanupBudgetMs,
    });
  });

  it('fails closed on an invalid cleanup bound or outer ordering input', () => {
    expect(() =>
      completeCleanupBudgetMs({
        ...E2E_LIFECYCLE_BOUNDS,
        killConvergenceMs: 0,
      }),
    ).toThrow('Invalid E2E lifecycle timing contract.');
    expect(() => deriveOuterWatchdogMs(0)).toThrow(
      'Invalid E2E operation deadline.',
    );
  });

  it('establishes operation and outer deadlines from one absolute clock', () => {
    expect(createLifecycleTimeline(250, 10_000)).toEqual({
      operationDeadlineMs: 250,
      cleanupBudgetMs: 7_000,
      outerWatchdogMs: 7_250,
      operationDeadlineAt: 10_250,
      outerDeadlineAt: 17_250,
    });
    expect(remainingLifecycleMs(17_250, 10_250)).toBe(7_000);
    expect(boundedLifecycleWaitMs(17_250, 2_000, 16_250)).toBe(1_000);
  });

  it('never grants another wait after the shared outer deadline', () => {
    expect(() => boundedLifecycleWaitMs(10_000, 2_000, 10_000)).toThrow(
      'E2E cleanup deadline exhausted.',
    );
  });

  it('fits one shortened TERM/KILL/verification sequence inside the shared final deadline', () => {
    const timeline = createLifecycleTimeline(250, 10_000);
    expect(
      assertCleanupMilestones({
        operationDeadlineAt: timeline.operationDeadlineAt,
        cleanupStartedAt: timeline.operationDeadlineAt + 1,
        termCompletedAt:
          timeline.operationDeadlineAt + E2E_LIFECYCLE_BOUNDS.termConvergenceMs,
        killVerificationCompletedAt:
          timeline.operationDeadlineAt +
          E2E_LIFECYCLE_BOUNDS.termConvergenceMs +
          E2E_LIFECYCLE_BOUNDS.killConvergenceMs,
        outerDeadlineAt: timeline.outerDeadlineAt,
      }),
    ).toBeDefined();
  });

  it('rejects a second sequential cleanup budget beyond the final deadline', () => {
    const timeline = createLifecycleTimeline(250, 10_000);
    expect(() =>
      assertCleanupMilestones({
        operationDeadlineAt: timeline.operationDeadlineAt,
        cleanupStartedAt: timeline.operationDeadlineAt + 1,
        termCompletedAt: timeline.outerDeadlineAt - 1,
        killVerificationCompletedAt:
          timeline.outerDeadlineAt + completeCleanupBudgetMs(),
        outerDeadlineAt: timeline.outerDeadlineAt,
      }),
    ).toThrow('Invalid E2E cleanup milestone ordering.');
  });
});
