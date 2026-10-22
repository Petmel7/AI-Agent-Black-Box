'use client';

import { RouteFocusCompletion } from '../components/route-focus';

export default function ErrorPage({ reset }: { reset(): void }) {
  return (
    <main id="main-content" className="error-state" tabIndex={-1}>
      <p className="eyebrow">Safe error</p>
      <h1>Evidence is temporarily unavailable</h1>
      <p>
        No private identifiers or provider details are included in this
        response.
      </p>
      <button type="button" onClick={reset}>
        Try again
      </button>
      <RouteFocusCompletion />
    </main>
  );
}
