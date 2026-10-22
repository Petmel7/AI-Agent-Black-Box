import Link from 'next/link';

import { RouteFocusCompletion } from '../components/route-focus';

export default function NotFound() {
  return (
    <main id="main-content" className="error-state" tabIndex={-1}>
      <p className="eyebrow">Not found</p>
      <h1>Evidence view unavailable</h1>
      <p>The requested resource is missing or unavailable to this dashboard.</p>
      <Link className="back-link" href="/runs">
        Return to runs
      </Link>
      <RouteFocusCompletion />
    </main>
  );
}
