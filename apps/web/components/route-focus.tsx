'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect } from 'react';

interface RouteFocusTarget {
  focus(options?: FocusOptions): void;
  getAttribute(name: string): string | null;
}

interface RouteFocusEnvironment {
  getMainContent(): RouteFocusTarget | null;
  getPreferredTarget(): RouteFocusTarget | null;
  hasPreferredTarget(): boolean;
  isContentComplete(): boolean;
  observeContent(callback: () => void): () => void;
}

/** Focuses the first completed, programmatically focusable route landmark. */
export function focusPrimaryLandmarkWhenReady(
  environment: RouteFocusEnvironment,
): () => void {
  let finished = false;
  let stopObserving: () => void = () => undefined;

  const attemptFocus = () => {
    if (finished) return;
    const preferredTarget = environment.getPreferredTarget();
    if (
      environment.hasPreferredTarget() &&
      !preferredTarget &&
      !environment.isContentComplete()
    )
      return;
    const target = preferredTarget ?? environment.getMainContent();
    if (
      !target ||
      target.getAttribute('aria-busy') === 'true' ||
      target.getAttribute('tabindex') !== '-1'
    )
      return;

    target.focus({ preventScroll: true });
    finished = true;
    stopObserving();
  };

  stopObserving = environment.observeContent(attemptFocus);
  attemptFocus();

  return () => {
    finished = true;
    stopObserving();
  };
}

const RETURN_FOCUS_ID =
  /^(?:finding-[0-9a-f]{64}|finding-reference-[0-9a-f]{64}-(?:0|[1-9][0-9]?)|summary-support-(?:preview|page)-[0-9a-f]{64}-(?:0|[1-9][0-9]?))$/;

function browserRouteFocusEnvironment(): RouteFocusEnvironment {
  const fragment = window.location.hash.slice(1);
  const preferredId = RETURN_FOCUS_ID.test(fragment) ? fragment : null;
  return {
    getMainContent: () => document.getElementById('main-content'),
    getPreferredTarget: () =>
      preferredId ? document.getElementById(preferredId) : null,
    hasPreferredTarget: () => preferredId !== null,
    isContentComplete: () =>
      document.querySelector(
        '#main-content [data-route-focus-complete="true"]',
      ) !== null,
    observeContent: (callback) => {
      const observer = new MutationObserver(callback);
      observer.observe(document.body, {
        attributes: true,
        attributeFilter: ['aria-busy', 'tabindex'],
        childList: true,
        subtree: true,
      });
      return () => observer.disconnect();
    },
  };
}

/** Marks the end of a completed streamed route without adding a tab stop. */
export function RouteFocusCompletion() {
  return <span hidden data-route-focus-complete="true" />;
}

/** Moves keyboard focus after the destination server view replaces loading UI. */
export function RouteFocus() {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  useEffect(
    () => focusPrimaryLandmarkWhenReady(browserRouteFocusEnvironment()),
    [pathname, search],
  );
  return null;
}
