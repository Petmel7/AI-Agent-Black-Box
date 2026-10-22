'use client';

import Link from 'next/link';
import type { MouseEvent, ReactNode } from 'react';

const ORIGIN_ID =
  /^(?:finding-[0-9a-f]{64}|finding-reference-[0-9a-f]{64}-(?:0|[1-9][0-9]?)|summary-support-(?:preview|page)-[0-9a-f]{64}-(?:0|[1-9][0-9]?))$/;

function ordinaryActivation(event: MouseEvent<HTMLAnchorElement>): boolean {
  return (
    event.button === 0 &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey
  );
}

function checkedOriginId(originId: string): string {
  if (!ORIGIN_ID.test(originId))
    throw new Error('Invalid dashboard evidence origin.');
  return originId;
}

export function preserveEvidenceOrigin(originId: string): void {
  const checked = checkedOriginId(originId);
  const current = `${window.location.pathname}${window.location.search}#${checked}`;
  window.history.replaceState(window.history.state, '', current);
}

export function focusDashboardTarget(originId: string): boolean {
  const checked = checkedOriginId(originId);
  const target = document.getElementById(checked);
  if (!(target instanceof HTMLElement) || target.tabIndex !== -1) return false;
  window.history.pushState(window.history.state, '', `#${checked}`);
  target.focus({ preventScroll: false });
  return true;
}

export function EvidenceNavigationLink({
  href,
  originId,
  children,
}: {
  href: string;
  originId: string;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      onClick={(event) => {
        if (ordinaryActivation(event)) preserveEvidenceOrigin(originId);
      }}
    >
      {children}
    </Link>
  );
}

export function DashboardTargetLink({
  href,
  originId,
  targetId,
  children,
}: {
  href: string;
  originId: string;
  targetId: string;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      onClick={(event) => {
        if (!ordinaryActivation(event)) return;
        const destination = new URL(href, window.location.href);
        if (
          destination.pathname === window.location.pathname &&
          destination.search === window.location.search &&
          focusDashboardTarget(targetId)
        )
          event.preventDefault();
        else preserveEvidenceOrigin(originId);
      }}
    >
      {children}
    </Link>
  );
}
