import Link from 'next/link';
import type { ReactNode } from 'react';

import {
  boundedJson,
  displayValue,
  presentationDescription,
} from '../lib/dashboard-view';

export function StateBadge({ state }: { state: string }) {
  return (
    <span className={`state-badge state-${state.toLowerCase()}`}>{state}</span>
  );
}

export function PresentationState({ state }: { state: string }) {
  return (
    <div className="presentation-state" aria-label={`Presentation: ${state}`}>
      <StateBadge state={state} />
      <p>{presentationDescription(state)}</p>
    </div>
  );
}

export function DashboardSection({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="panel" tabIndex={-1}>
      <header className="panel-heading">
        <h2>{title}</h2>
        {description ? <p>{description}</p> : null}
      </header>
      {children}
    </section>
  );
}

export function DefinitionGrid({
  values,
}: {
  values: Array<{ label: string; value: ReactNode }>;
}) {
  return (
    <dl className="definition-grid">
      {values.map(({ label, value }) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <p className="empty-state" role="status">
      {children}
    </p>
  );
}

export function DiagnosticState({
  label,
  state,
  errorCode,
}: {
  label: string;
  state: string;
  errorCode?: string | null;
}) {
  return (
    <div className="diagnostic">
      <span>{label}</span>
      <StateBadge state={state.toUpperCase()} />
      {errorCode ? <span>Safe error: {errorCode}</span> : null}
    </div>
  );
}

export function StructuredValue({ value }: { value: unknown }) {
  const rendered = boundedJson(value);
  return (
    <div>
      <pre className="structured-value">{rendered.text}</pre>
      {rendered.truncated ? (
        <p className="truncation" role="note">
          Display truncated at the safe UI limit.
        </p>
      ) : null}
    </div>
  );
}

export function NextPageLink({
  href,
  collection,
}: {
  href: string | null;
  collection: string;
}) {
  return href ? (
    <nav className="pagination" aria-label={`${collection} pagination`}>
      <Link href={href} aria-label={`Next ${collection} page`}>
        Next page
      </Link>
      <span>Use browser history to return to the previous page.</span>
    </nav>
  ) : (
    <p className="terminal-page" data-terminal-collection={collection}>
      End of this collection.
    </p>
  );
}

export function Value({ value }: { value: unknown }) {
  return <>{displayValue(value)}</>;
}
