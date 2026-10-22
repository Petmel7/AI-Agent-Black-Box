import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  DiagnosticState,
  EmptyState,
  PresentationState,
  StructuredValue,
} from './dashboard-ui';

describe('dashboard UI components', () => {
  it.each(['PASS', 'REVIEW', 'FAILED', 'INCOMPLETE', 'PROCESSING'])(
    'renders presentation state %s with independent wording',
    (state) => {
      const html = renderToStaticMarkup(
        createElement(PresentationState, { state }),
      );
      expect(html).toContain(state);
      expect(html).toContain('Presentation:');
    },
  );

  it.each(['processing', 'stale', 'ready', 'incomplete', 'failed'])(
    'renders projector diagnostic %s',
    (state) => {
      const html = renderToStaticMarkup(
        createElement(DiagnosticState, {
          label: 'Core',
          state,
          errorCode: 'safe_code',
        }),
      );
      expect(html).toContain(state.toUpperCase());
      expect(html).toContain('safe_code');
    },
  );

  it('escapes hostile evidence and never activates markup', () => {
    const hostile =
      '<script>globalThis.pwned=true</script><a href="evil">x</a>';
    const html = renderToStaticMarkup(
      createElement(StructuredValue, { value: hostile }),
    );
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<a href');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders explicit empty state semantics', () => {
    const html = renderToStaticMarkup(
      createElement(EmptyState, null, 'No findings.'),
    );
    expect(html).toContain('role="status"');
    expect(html).toContain('No findings.');
  });
});
