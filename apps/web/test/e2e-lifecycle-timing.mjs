const POSITIVE_INTEGER = /^[1-9][0-9]*$/;

export const E2E_LIFECYCLE_BOUNDS = Object.freeze({
  termConvergenceMs: 2_000,
  killConvergenceMs: 2_000,
  terminalAcknowledgementMs: 2_000,
  controllerReportingMarginMs: 1_000,
});

export function completeCleanupBudgetMs(bounds = E2E_LIFECYCLE_BOUNDS) {
  const values = [
    bounds.termConvergenceMs,
    bounds.killConvergenceMs,
    bounds.terminalAcknowledgementMs,
    bounds.controllerReportingMarginMs,
  ];
  if (
    values.some(
      (value) => !Number.isSafeInteger(value) || value < 1 || value > 60_000,
    )
  )
    throw new Error('Invalid E2E lifecycle timing contract.');
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(total))
    throw new Error('Invalid E2E lifecycle timing contract.');
  return total;
}

export function parseInternalDuration(value, { minimum, maximum, label }) {
  if (
    typeof value !== 'string' ||
    !POSITIVE_INTEGER.test(value) ||
    value.length > String(maximum).length
  )
    throw new Error(`Invalid ${label}.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum)
    throw new Error(`Invalid ${label}.`);
  return parsed;
}

export function deriveOuterWatchdogMs(operationDeadlineMs) {
  if (
    !Number.isSafeInteger(operationDeadlineMs) ||
    operationDeadlineMs < 1 ||
    operationDeadlineMs > 3_600_000
  )
    throw new Error('Invalid E2E operation deadline.');
  const cleanupBudgetMs = completeCleanupBudgetMs();
  const outerWatchdogMs = operationDeadlineMs + cleanupBudgetMs;
  if (
    !Number.isSafeInteger(outerWatchdogMs) ||
    outerWatchdogMs <= operationDeadlineMs
  )
    throw new Error('Invalid E2E outer watchdog ordering.');
  return Object.freeze({
    operationDeadlineMs,
    cleanupBudgetMs,
    outerWatchdogMs,
  });
}

export function createLifecycleTimeline(operationDurationMs, now = Date.now()) {
  if (!Number.isSafeInteger(now) || now < 1)
    throw new Error('Invalid E2E lifecycle clock.');
  const timing = deriveOuterWatchdogMs(operationDurationMs);
  const operationDeadlineAt = now + timing.operationDeadlineMs;
  const outerDeadlineAt = now + timing.outerWatchdogMs;
  if (
    !Number.isSafeInteger(operationDeadlineAt) ||
    !Number.isSafeInteger(outerDeadlineAt) ||
    outerDeadlineAt <= operationDeadlineAt
  )
    throw new Error('Invalid E2E lifecycle deadline ordering.');
  return Object.freeze({ ...timing, operationDeadlineAt, outerDeadlineAt });
}

export function remainingLifecycleMs(deadlineAt, now = Date.now()) {
  if (
    !Number.isSafeInteger(deadlineAt) ||
    !Number.isSafeInteger(now) ||
    deadlineAt < 1 ||
    now < 1
  )
    throw new Error('Invalid E2E lifecycle deadline.');
  return Math.max(0, deadlineAt - now);
}

export function boundedLifecycleWaitMs(
  deadlineAt,
  maximumMs,
  now = Date.now(),
) {
  if (!Number.isSafeInteger(maximumMs) || maximumMs < 1)
    throw new Error('Invalid E2E lifecycle wait bound.');
  const remainingMs = remainingLifecycleMs(deadlineAt, now);
  if (remainingMs < 1)
    throw Object.assign(new Error('E2E cleanup deadline exhausted.'), {
      code: 'e2e-cleanup-deadline-exhausted',
    });
  return Math.min(remainingMs, maximumMs);
}

export function assertCleanupMilestones({
  operationDeadlineAt,
  cleanupStartedAt,
  termCompletedAt,
  killVerificationCompletedAt,
  outerDeadlineAt,
}) {
  const values = [
    operationDeadlineAt,
    cleanupStartedAt,
    termCompletedAt,
    killVerificationCompletedAt,
    outerDeadlineAt,
  ];
  if (
    values.some((value) => !Number.isSafeInteger(value) || value < 1) ||
    !(operationDeadlineAt < cleanupStartedAt) ||
    !(cleanupStartedAt < termCompletedAt) ||
    !(termCompletedAt < killVerificationCompletedAt) ||
    !(killVerificationCompletedAt <= outerDeadlineAt)
  )
    throw new Error('Invalid E2E cleanup milestone ordering.');
  return Object.freeze({
    operationDeadlineAt,
    cleanupStartedAt,
    termCompletedAt,
    killVerificationCompletedAt,
    outerDeadlineAt,
  });
}
