import { describe, expect, it } from 'vitest';

import {
  deriveDashboardPresentationState,
  type DashboardPresentationInput,
} from './presentation';

const ready: DashboardPresentationInput = {
  observedOutcome: 'succeeded',
  processingState: 'ready',
  filesProcessingState: 'ready',
  findingsProcessingState: 'ready',
  summaryProcessingState: 'ready',
  deterministicOutcome: 'pass',
  summaryAvailability: 'current',
  summaryOutcome: 'pass',
};

const observedOutcomes: DashboardPresentationInput['observedOutcome'][] = [
  'succeeded',
  'failed',
  'cancelled',
  'unknown',
  null,
];
const projectorStates: DashboardPresentationInput['processingState'][] = [
  'processing',
  'stale',
  'ready',
  'incomplete',
  'failed',
];
const summaryAvailabilities: DashboardPresentationInput['summaryAvailability'][] =
  ['current', 'stale', 'absent'];
const outcomes: DashboardPresentationInput['summaryOutcome'][] = [
  'pass',
  'review',
  'unknown',
  null,
];

function independentOracle(
  input: DashboardPresentationInput,
): ReturnType<typeof deriveDashboardPresentationState> {
  if (['failed', 'cancelled'].includes(input.observedOutcome ?? ''))
    return 'FAILED';
  if (
    [
      input.processingState,
      input.filesProcessingState,
      input.findingsProcessingState,
      input.summaryProcessingState,
    ].some((state) => state === 'processing')
  )
    return 'PROCESSING';
  const allProjectorsReady = [
    input.processingState,
    input.filesProcessingState,
    input.findingsProcessingState,
    input.summaryProcessingState,
  ].every((state) => state === 'ready');
  const compatibleOutcome =
    input.summaryOutcome === input.deterministicOutcome &&
    (input.summaryOutcome === 'pass' || input.summaryOutcome === 'review');
  if (
    !allProjectorsReady ||
    input.summaryAvailability !== 'current' ||
    !compatibleOutcome
  )
    return 'INCOMPLETE';
  return input.summaryOutcome === 'review' ? 'REVIEW' : 'PASS';
}

describe('deriveDashboardPresentationState', () => {
  it('matches an independent precedence oracle for the complete finite input matrix', () => {
    const counts = new Map<string, number>();
    const mismatches: Array<{
      input: DashboardPresentationInput;
      expected: string;
      actual: string;
    }> = [];
    let combinations = 0;
    for (const observedOutcome of observedOutcomes)
      for (const processingState of projectorStates)
        for (const filesProcessingState of projectorStates)
          for (const findingsProcessingState of projectorStates)
            for (const summaryProcessingState of projectorStates)
              for (const summaryAvailability of summaryAvailabilities)
                for (const deterministicOutcome of outcomes)
                  for (const summaryOutcome of outcomes) {
                    const input: DashboardPresentationInput = {
                      observedOutcome,
                      processingState,
                      filesProcessingState,
                      findingsProcessingState,
                      summaryProcessingState,
                      summaryAvailability,
                      deterministicOutcome,
                      summaryOutcome,
                    };
                    const expected = independentOracle(input);
                    const actual = deriveDashboardPresentationState(input);
                    combinations += 1;
                    if (actual !== expected && mismatches.length < 10)
                      mismatches.push({ input, expected, actual });
                    counts.set(actual, (counts.get(actual) ?? 0) + 1);
                  }
    expect(combinations).toBe(150_000);
    expect(mismatches).toEqual([]);
    expect([...counts.keys()].sort()).toEqual([
      'FAILED',
      'INCOMPLETE',
      'PASS',
      'PROCESSING',
      'REVIEW',
    ]);
  });

  it.each(['failed', 'cancelled'] as const)(
    'maps observed %s before every processing condition',
    (observedOutcome) => {
      expect(
        deriveDashboardPresentationState({
          ...ready,
          observedOutcome,
          processingState: 'processing',
          summaryAvailability: 'absent',
          summaryOutcome: 'unknown',
        }),
      ).toBe('FAILED');
    },
  );

  it.each([
    'processingState',
    'filesProcessingState',
    'findingsProcessingState',
    'summaryProcessingState',
  ] as const)('maps pending %s to PROCESSING', (field) => {
    expect(
      deriveDashboardPresentationState({ ...ready, [field]: 'processing' }),
    ).toBe('PROCESSING');
  });

  it('gives pending work precedence over stale and failed projector states', () => {
    expect(
      deriveDashboardPresentationState({
        ...ready,
        processingState: 'processing',
        filesProcessingState: 'stale',
        findingsProcessingState: 'failed',
      }),
    ).toBe('PROCESSING');
  });

  it.each(['stale', 'incomplete', 'failed'] as const)(
    'maps settled %s projector state to INCOMPLETE',
    (state) => {
      expect(
        deriveDashboardPresentationState({
          ...ready,
          filesProcessingState: state,
        }),
      ).toBe('INCOMPLETE');
    },
  );

  it.each(['stale', 'absent'] as const)(
    'maps settled %s summary availability to INCOMPLETE',
    (summaryAvailability) => {
      expect(
        deriveDashboardPresentationState({ ...ready, summaryAvailability }),
      ).toBe('INCOMPLETE');
    },
  );

  it.each([
    ['deterministicOutcome', null],
    ['deterministicOutcome', 'unknown'],
    ['summaryOutcome', null],
    ['summaryOutcome', 'unknown'],
  ] as const)('maps unavailable %s=%s to INCOMPLETE', (field, value) => {
    expect(deriveDashboardPresentationState({ ...ready, [field]: value })).toBe(
      'INCOMPLETE',
    );
  });

  it('fails closed when findings and summary outcomes disagree', () => {
    expect(
      deriveDashboardPresentationState({
        ...ready,
        deterministicOutcome: 'review',
      }),
    ).toBe('INCOMPLETE');
  });

  it('fails closed for unsupported runtime outcome values', () => {
    for (const input of [
      { ...ready, observedOutcome: 'corrupt' as never },
      { ...ready, processingState: 'corrupt' as never },
      { ...ready, filesProcessingState: 'corrupt' as never },
      { ...ready, findingsProcessingState: 'corrupt' as never },
      { ...ready, summaryProcessingState: 'corrupt' as never },
      { ...ready, summaryAvailability: 'corrupt' as never },
      {
        ...ready,
        deterministicOutcome: 'clear' as never,
        summaryOutcome: 'clear' as never,
      },
    ])
      expect(deriveDashboardPresentationState(input)).toBe('INCOMPLETE');
  });

  it('maps a current compatible review outcome to REVIEW', () => {
    expect(
      deriveDashboardPresentationState({
        ...ready,
        deterministicOutcome: 'review',
        summaryOutcome: 'review',
      }),
    ).toBe('REVIEW');
  });

  it('maps only a fully current compatible clear catalog to PASS', () => {
    expect(deriveDashboardPresentationState(ready)).toBe('PASS');
  });
});
