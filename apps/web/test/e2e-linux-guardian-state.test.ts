import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error -- test-only ESM helper intentionally has no declarations.
import * as guardianControllerModule from './e2e-linux-controller-guardian.mjs';
// @ts-expect-error -- test-only ESM helper intentionally has no declarations.
import * as guardianStateModule from './e2e-linux-guardian-state.mjs';

const { waitForLifecycleResult, waitForProtocolAcknowledgement } =
  guardianControllerModule as {
    waitForLifecycleResult: (
      child: EventEmitter,
      validate: (message: unknown) => boolean,
      deadlineAt: number,
    ) => Promise<unknown>;
    waitForProtocolAcknowledgement: (
      child: EventEmitter,
      validate: (message: unknown) => boolean,
      deadlineAt: number,
    ) => Promise<unknown>;
  };
const { createLinuxSignalAuthorityState, waitForFinalConvergence } =
  guardianStateModule as {
    createLinuxSignalAuthorityState: () => {
      converged: (owner: 'guardian' | 'supervisor') => string;
      failed: () => string;
      guardianCleaning: () => string;
      snapshot: () => { state: string; history: string[] };
      supervisorFallback: (guardianAbsent: boolean) => string;
    };
    waitForFinalConvergence: (options: {
      finalDeadlineAt: number;
      inspectGroup: () => { state: 'absent' | 'owned' };
      listenerIsFree: () => Promise<boolean>;
      finalizeAbsence: () => Promise<void>;
      pollMs?: number;
      now?: () => number;
      wait?: (delayMs: number) => Promise<void>;
    }) => Promise<{ converged: boolean; verificationFailures: number }>;
  };

afterEach(() => vi.useRealTimers());

describe('Linux guardian wait classes', () => {
  it('allows lifecycle results beyond the acknowledgement bound', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const child = new EventEmitter();
    const result = waitForLifecycleResult(
      child,
      (message) => (message as { type?: string })?.type === 'result',
      15_000,
    );
    await vi.advanceTimersByTimeAsync(2_100);
    child.emit('message', { type: 'result' });
    await expect(result).resolves.toEqual({ type: 'result' });
  });

  it('keeps immediate acknowledgements within the short bound', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const child = new EventEmitter();
    const acknowledgement = waitForProtocolAcknowledgement(
      child,
      () => false,
      15_000,
    );
    const rejection = expect(acknowledgement).rejects.toThrow(
      'acknowledgement timed out',
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await rejection;
  });
});

describe('bounded Linux guardian final convergence', () => {
  function clock() {
    let current = 1_000;
    return {
      now: () => current,
      wait: async (delayMs: number) => {
        current += delayMs;
      },
    };
  }

  it('fails closed for an unverifiable member at the final deadline', async () => {
    const time = clock();
    const result = await waitForFinalConvergence({
      finalDeadlineAt: 1_100,
      inspectGroup: () => {
        throw new Error('unverifiable');
      },
      listenerIsFree: async () => true,
      finalizeAbsence: async () => undefined,
      now: time.now,
      wait: time.wait,
    });
    expect(result.converged).toBe(false);
    expect(result.verificationFailures).toBeGreaterThan(0);
  });

  it('fails closed while the listener remains occupied', async () => {
    const time = clock();
    const finalize = vi.fn();
    const result = await waitForFinalConvergence({
      finalDeadlineAt: 1_100,
      inspectGroup: () => ({ state: 'absent' }),
      listenerIsFree: async () => false,
      finalizeAbsence: finalize,
      now: time.now,
      wait: time.wait,
    });
    expect(result).toEqual({ converged: false, verificationFailures: 0 });
    expect(finalize).not.toHaveBeenCalled();
  });

  it('reports eventual convergence without starting another signal sequence', async () => {
    const time = clock();
    const finalize = vi.fn(async () => undefined);
    let inspections = 0;
    const result = await waitForFinalConvergence({
      finalDeadlineAt: 1_100,
      inspectGroup: () => ({
        state: ++inspections < 3 ? 'owned' : 'absent',
      }),
      listenerIsFree: async () => true,
      finalizeAbsence: finalize,
      now: time.now,
      wait: time.wait,
    });
    expect(result).toEqual({ converged: true, verificationFailures: 0 });
    expect(finalize).toHaveBeenCalledOnce();
  });

  it('stops an uninterruptible non-converging group exactly at the immutable final deadline', async () => {
    const time = clock();
    const result = await waitForFinalConvergence({
      finalDeadlineAt: 1_050,
      inspectGroup: () => ({ state: 'owned' }),
      listenerIsFree: async () => true,
      finalizeAbsence: async () => undefined,
      pollMs: 25,
      now: time.now,
      wait: time.wait,
    });
    expect(time.now()).toBe(1_050);
    expect(result.converged).toBe(false);
  });
});

describe('Linux signal-authority failover', () => {
  it('keeps the normal guardian path exclusive through convergence', () => {
    const authority = createLinuxSignalAuthorityState();
    authority.guardianCleaning();
    authority.converged('guardian');
    expect(authority.snapshot().state).toBe('converged');
    expect(() => authority.supervisorFallback(true)).toThrow(
      'Invalid Linux signal-authority transition',
    );
  });

  it('requires guardian absence before granting exclusive fallback authority', () => {
    const authority = createLinuxSignalAuthorityState();
    authority.guardianCleaning();
    expect(() => authority.supervisorFallback(false)).toThrow(
      'requires guardian absence',
    );
    authority.supervisorFallback(true);
    authority.converged('supervisor');
    expect(authority.snapshot()).toEqual({
      state: 'converged',
      history: [
        'guardian-authority',
        'guardian-cleaning',
        'supervisor-fallback-authority',
        'converged',
      ],
    });
  });

  it('does not allow guardian convergence after supervisor takeover', () => {
    const authority = createLinuxSignalAuthorityState();
    authority.supervisorFallback(true);
    expect(() => authority.converged('guardian')).toThrow(
      'Invalid Linux signal-authority transition',
    );
  });
});
