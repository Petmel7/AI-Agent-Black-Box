import type { Metadata } from 'next';
import Link from 'next/link';

import {
  DefinitionGrid,
  EmptyState,
  NextPageLink,
  PresentationState,
  StateBadge,
  StructuredValue,
  Value,
} from '../../components/dashboard-ui';
import { RouteFocusCompletion } from '../../components/route-focus';
import {
  continuationHref,
  DashboardInputError,
  formatDuration,
  parseRunsSearch,
  type SearchValues,
} from '../../lib/dashboard-view';
import {
  getDashboardRuntime,
  isDashboardReadRequestError,
} from '../../server/dashboard-runtime';

export const metadata: Metadata = { title: 'Runs' };
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

function InvalidCursor() {
  return (
    <main id="main-content" className="error-state" tabIndex={-1}>
      <p className="eyebrow">Invalid pagination</p>
      <h1>This run-list page cannot be continued</h1>
      <p>The cursor is malformed, expired, rotated, wrong-scope, or stale.</p>
      <Link className="back-link" href="/runs">
        Restart the run list
      </Link>
      <RouteFocusCompletion />
    </main>
  );
}

export default async function RunsPage({
  searchParams,
}: {
  searchParams: Promise<SearchValues>;
}) {
  const raw = await searchParams;
  const loaded = await (async () => {
    try {
      const query = parseRunsSearch(raw);
      const page = await getDashboardRuntime().listRuns({
        ...query,
        limit: 25,
      });
      return { query, page };
    } catch (error) {
      if (
        error instanceof DashboardInputError ||
        isDashboardReadRequestError(error)
      )
        return null;
      throw error;
    }
  })();
  if (!loaded) return <InvalidCursor />;
  const { query, page } = loaded;
  const nextHref = page.nextCursor
    ? continuationHref('/runs', raw, 'cursor', page.nextCursor)
    : null;
  return (
    <main id="main-content" className="page-shell" tabIndex={-1}>
      <div className="page-heading">
        <div>
          <p className="eyebrow">Evidence recorder</p>
          <h1>Recorded runs</h1>
          <p className="lede">
            Current projections for the configured private workspace. Repository
            UUIDs are the trusted v0.1 labels.
          </p>
        </div>
        <form
          action="/runs"
          method="get"
          aria-label="Filter runs by repository"
        >
          <label>
            Repository UUID
            <input
              className="filter-input"
              name="repository"
              defaultValue={query.repositoryId ?? ''}
              pattern="[0-9a-fA-F-]{36}"
              placeholder="All repositories"
            />
          </label>
          <button type="submit">Apply filter</button>
        </form>
      </div>
      {page.items.length === 0 ? (
        <EmptyState>No runs are available for this exact scope.</EmptyState>
      ) : (
        <ol className="run-list">
          {page.items.map((run) => (
            <li
              className="run-card"
              key={`${run.repositoryId}:${run.runId}`}
              data-dashboard-collection="runs"
              data-dashboard-item-key={`${run.repositoryId}:${run.runId}`}
            >
              <div className="run-card-header">
                <div>
                  <p className="eyebrow">Repository {run.repositoryId}</p>
                  <h2>
                    <Link
                      href={`/repositories/${run.repositoryId}/runs/${run.runId}`}
                    >
                      Run <span className="mono">{run.runId}</span>
                    </Link>
                  </h2>
                </div>
                <StateBadge state={run.presentationState} />
              </div>
              <PresentationState state={run.presentationState} />
              <DefinitionGrid
                values={[
                  {
                    label: 'Created',
                    value: new Date(run.createdAt).toLocaleString(),
                  },
                  {
                    label: 'Duration',
                    value: formatDuration(run.durationMs),
                  },
                  {
                    label: 'Files changed',
                    value: <Value value={run.filesChanged} />,
                  },
                  {
                    label: 'Commands',
                    value: <Value value={run.commandCount} />,
                  },
                  {
                    label: 'Tools',
                    value: <Value value={run.toolCallCount} />,
                  },
                  { label: 'Test evidence', value: run.testObservationState },
                  {
                    label: 'Findings',
                    value: <Value value={run.triggeredFindingCount} />,
                  },
                  {
                    label: 'Tokens',
                    value:
                      run.tokenAggregates === null
                        ? 'Unavailable'
                        : 'Available below',
                  },
                ]}
              />
              {run.testCounts !== null ? (
                <details>
                  <summary>Test counts</summary>
                  <StructuredValue value={run.testCounts} />
                </details>
              ) : null}
              {run.tokenAggregates !== null ? (
                <details>
                  <summary>Token aggregates</summary>
                  <StructuredValue value={run.tokenAggregates} />
                </details>
              ) : null}
            </li>
          ))}
        </ol>
      )}
      <NextPageLink href={nextHref} collection="runs" />
      <RouteFocusCompletion />
    </main>
  );
}
