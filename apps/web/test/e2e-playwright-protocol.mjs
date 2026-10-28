const STATES = new Set([
  'awaiting-authority',
  'launch-authorized',
  'authority-retained',
  'running',
  'cleaning',
  'terminal-sent',
  'terminal-acknowledged',
  'closed',
]);

function protocolError(code) {
  return Object.assign(new Error('Invalid Playwright ownership protocol.'), {
    code,
  });
}

export function createPlaywrightProtocol() {
  let state = 'awaiting-authority';
  let failed = false;
  let failureCode;

  function requireState(...allowed) {
    if (!allowed.includes(state))
      throw protocolError('playwright-protocol-state');
  }

  function fail(code = 'playwright-protocol-message') {
    const firstFailure = !failed;
    failed = true;
    failureCode ??= code;
    if (state !== 'terminal-acknowledged' && state !== 'closed')
      state = 'cleaning';
    return Object.freeze({
      accepted: false,
      error: protocolError(failureCode),
      firstFailure,
      state,
    });
  }

  function receive(type, version) {
    try {
      if (version !== 1) throw protocolError('playwright-protocol-version');
      if (type === 'launch-authority') {
        requireState('awaiting-authority');
        state = 'launch-authorized';
      } else if (type === 'ownership-authority-ack') {
        requireState('launch-authorized');
        state = 'authority-retained';
      } else if (type === 'shutdown') {
        requireState(
          'awaiting-authority',
          'launch-authorized',
          'authority-retained',
          'running',
        );
        state = 'cleaning';
      } else if (type === 'result-ack') {
        requireState('terminal-sent');
        state = 'terminal-acknowledged';
      } else {
        throw protocolError('playwright-protocol-message');
      }
      return Object.freeze({ accepted: true, state });
    } catch (error) {
      return Object.freeze({ ...fail(error.code), error });
    }
  }

  function transition(expected, next) {
    if (!STATES.has(next)) throw protocolError('playwright-protocol-state');
    try {
      requireState(...(Array.isArray(expected) ? expected : [expected]));
      state = next;
      return Object.freeze({ accepted: true, state });
    } catch (error) {
      return Object.freeze({ ...fail(error.code), error });
    }
  }

  return Object.freeze({
    receive,
    fail,
    transition,
    snapshot: () => Object.freeze({ failed, failureCode, state }),
  });
}
