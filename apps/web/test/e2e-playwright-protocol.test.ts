import { describe, expect, it } from 'vitest';

// @ts-expect-error -- this Node-owned test helper intentionally executes as ESM.
import { createPlaywrightProtocol } from './e2e-playwright-protocol.mjs';

function validRunningProtocol() {
  const protocol = createPlaywrightProtocol();
  expect(protocol.receive('launch-authority', 1).accepted).toBe(true);
  expect(protocol.receive('ownership-authority-ack', 1).accepted).toBe(true);
  expect(protocol.transition('authority-retained', 'running').accepted).toBe(
    true,
  );
  return protocol;
}

describe('Playwright ownership protocol state machine', () => {
  it.each([
    ['launch authority', 'launch-authority'],
    ['ownership authority acknowledgement', 'ownership-authority-ack'],
    ['shutdown', 'shutdown'],
    ['terminal acknowledgement', 'result-ack'],
  ])('rejects duplicate %s messages', (_label, type) => {
    const protocol = createPlaywrightProtocol();
    if (type === 'launch-authority') {
      expect(protocol.receive(type, 1).accepted).toBe(true);
    } else if (type === 'ownership-authority-ack') {
      protocol.receive('launch-authority', 1);
      expect(protocol.receive(type, 1).accepted).toBe(true);
    } else if (type === 'shutdown') {
      protocol.receive('launch-authority', 1);
      expect(protocol.receive(type, 1).accepted).toBe(true);
    } else {
      protocol.receive('launch-authority', 1);
      protocol.receive('ownership-authority-ack', 1);
      protocol.transition('authority-retained', 'running');
      protocol.receive('shutdown', 1);
      protocol.transition('cleaning', 'terminal-sent');
      expect(protocol.receive(type, 1).accepted).toBe(true);
    }
    expect(protocol.receive(type, 1)).toMatchObject({
      accepted: false,
    });
    expect(protocol.snapshot().failed).toBe(true);
  });

  it.each([
    'launch-authority',
    'ownership-authority-ack',
    'shutdown',
    'result-ack',
  ])('rejects invalid-version %s messages', (type) => {
    const protocol = createPlaywrightProtocol();
    expect(protocol.receive(type, 2)).toMatchObject({ accepted: false });
    expect(protocol.snapshot()).toMatchObject({ failed: true });
  });

  it('rejects late and out-of-order messages once cleanup begins', () => {
    const protocol = validRunningProtocol();
    expect(protocol.receive('shutdown', 1).accepted).toBe(true);
    expect(protocol.receive('launch-authority', 1)).toMatchObject({
      accepted: false,
      state: 'cleaning',
    });
  });

  it('accepts exactly one ordered terminal acknowledgement', () => {
    const protocol = validRunningProtocol();
    protocol.receive('shutdown', 1);
    expect(protocol.transition('cleaning', 'terminal-sent').accepted).toBe(
      true,
    );
    expect(protocol.receive('result-ack', 1)).toMatchObject({
      accepted: true,
      state: 'terminal-acknowledged',
    });
    expect(
      protocol.transition('terminal-acknowledged', 'closed'),
    ).toMatchObject({ accepted: true, state: 'closed' });
  });

  it.each([
    'awaiting-authority',
    'launch-authorized',
    'authority-retained',
    'running',
    'cleaning',
    'terminal-sent',
    'terminal-acknowledged',
  ])('records one immutable failure from %s', (targetState) => {
    const protocol = createPlaywrightProtocol();
    if (targetState !== 'awaiting-authority')
      protocol.receive('launch-authority', 1);
    if (!['awaiting-authority', 'launch-authorized'].includes(targetState))
      protocol.receive('ownership-authority-ack', 1);
    if (
      [
        'running',
        'cleaning',
        'terminal-sent',
        'terminal-acknowledged',
      ].includes(targetState)
    )
      protocol.transition('authority-retained', 'running');
    if (
      ['cleaning', 'terminal-sent', 'terminal-acknowledged'].includes(
        targetState,
      )
    )
      protocol.receive('shutdown', 1);
    if (['terminal-sent', 'terminal-acknowledged'].includes(targetState))
      protocol.transition('cleaning', 'terminal-sent');
    if (targetState === 'terminal-acknowledged')
      protocol.receive('result-ack', 1);

    const first = protocol.fail('injected-protocol-failure');
    const second = protocol.fail('different-late-failure');
    expect(first.firstFailure).toBe(true);
    expect(second.firstFailure).toBe(false);
    expect(protocol.snapshot()).toMatchObject({
      failed: true,
      failureCode: 'injected-protocol-failure',
    });
  });
});
