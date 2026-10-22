import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense, type ReactNode } from 'react';

import { RouteFocus } from '../components/route-focus';

import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Runs · AI Agent Black Box', template: '%s · Black Box' },
  description: 'Private, read-only evidence for AI-generated code',
};

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <Suspense fallback={null}>
          <RouteFocus />
        </Suspense>
        <a className="skip-link" href="#main-content">
          Skip to evidence
        </a>
        <header className="site-header">
          <Link
            className="brand"
            href="/runs"
            aria-label="AI Agent Black Box runs"
          >
            <span className="brand-mark" aria-hidden="true">
              BB
            </span>
            <span>AI Agent Black Box</span>
          </Link>
          <span className="privacy-label">Private · read only</span>
        </header>
        {children}
      </body>
    </html>
  );
}
