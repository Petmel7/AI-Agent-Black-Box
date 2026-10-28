import { remainingLifecycleMs } from './e2e-lifecycle-timing.mjs';

const SIGNAL_AUTHORITY_STATES = Object.freeze([
  'guardian-authority',
  'guardian-cleaning',
  'supervisor-fallback-authority',
  'converged',
  'failed',
]);

export function createLinuxSignalAuthorityState() {
  let state = 'guardian-authority';
  const history = [state];

  const transition = (allowed, next) => {
    if (!allowed.includes(state) || !SIGNAL_AUTHORITY_STATES.includes(next))
      throw new Error('Invalid Linux signal-authority transition.');
    state = next;
    history.push(next);
    return state;
  };

  return Object.freeze({
    guardianCleaning() {
      if (state === 'guardian-cleaning') return state;
      return transition(['guardian-authority'], 'guardian-cleaning');
    },
    supervisorFallback(guardianAbsent) {
      if (guardianAbsent !== true)
        throw new Error('Supervisor fallback requires guardian absence.');
      return transition(
        ['guardian-authority', 'guardian-cleaning'],
        'supervisor-fallback-authority',
      );
    },
    converged(owner) {
      if (owner === 'guardian')
        return transition(
          ['guardian-authority', 'guardian-cleaning'],
          'converged',
        );
      if (owner === 'supervisor')
        return transition(['supervisor-fallback-authority'], 'converged');
      throw new Error('Invalid Linux convergence owner.');
    },
    failed() {
      if (state === 'failed') return state;
      return transition(
        [
          'guardian-authority',
          'guardian-cleaning',
          'supervisor-fallback-authority',
        ],
        'failed',
      );
    },
    snapshot() {
      return Object.freeze({ state, history: Object.freeze([...history]) });
    },
  });
}

export async function waitForFinalConvergence({
  finalDeadlineAt,
  inspectGroup,
  listenerIsFree,
  finalizeAbsence,
  pollMs = 25,
  now = Date.now,
  wait = (delayMs) =>
    new Promise((resolveWait) => setTimeout(resolveWait, delayMs)),
}) {
  if (
    !Number.isSafeInteger(finalDeadlineAt) ||
    finalDeadlineAt < 1 ||
    typeof inspectGroup !== 'function' ||
    typeof listenerIsFree !== 'function' ||
    typeof finalizeAbsence !== 'function' ||
    !Number.isSafeInteger(pollMs) ||
    pollMs < 1 ||
    typeof now !== 'function' ||
    typeof wait !== 'function'
  )
    throw new Error('Invalid Linux guardian convergence contract.');

  let verificationFailures = 0;
  while (remainingLifecycleMs(finalDeadlineAt, now()) > 0) {
    try {
      if (inspectGroup().state === 'absent' && (await listenerIsFree())) {
        await finalizeAbsence();
        return Object.freeze({ converged: true, verificationFailures });
      }
    } catch {
      verificationFailures += 1;
    }
    const remainingMs = remainingLifecycleMs(finalDeadlineAt, now());
    if (remainingMs < 1) break;
    await wait(Math.min(pollMs, remainingMs));
  }
  return Object.freeze({ converged: false, verificationFailures });
}
