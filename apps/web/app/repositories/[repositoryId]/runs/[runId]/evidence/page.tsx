import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import {
  DashboardSection,
  DefinitionGrid,
  EmptyState,
  StateBadge,
  StructuredValue,
  Value,
} from '../../../../../../components/dashboard-ui';
import { RouteFocusCompletion } from '../../../../../../components/route-focus';
import {
  DashboardInputError,
  evidenceReturnHref,
  isCanonicalUuid,
  parseEvidencePageSearch,
  type SearchValues,
} from '../../../../../../lib/dashboard-view';
import {
  getDashboardRuntime,
  isDashboardReadRequestError,
} from '../../../../../../server/dashboard-runtime';

export const metadata: Metadata = { title: 'Exact evidence' };
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

function UnavailableEvidence() {
  return (
    <main id="main-content" className="error-state" tabIndex={-1}>
      <p className="eyebrow">Evidence unavailable</p>
      <h1>This exact evidence target cannot be displayed</h1>
      <p>
        The locator is invalid, stale, incompatible, missing, or outside the
        configured private workspace.
      </p>
      <Link className="back-link" href="/runs">
        Return to runs
      </Link>
      <RouteFocusCompletion />
    </main>
  );
}

export default async function EvidencePage({
  params,
  searchParams,
}: {
  params: Promise<{ repositoryId: string; runId: string }>;
  searchParams: Promise<SearchValues>;
}) {
  const { repositoryId, runId } = await params;
  if (!isCanonicalUuid(repositoryId) || !isCanonicalUuid(runId)) notFound();
  const loaded = await (async () => {
    try {
      const parsed = parseEvidencePageSearch(
        await searchParams,
        repositoryId,
        runId,
      );
      const evidence = await getDashboardRuntime().resolveEvidence({
        repositoryId,
        canonicalRunId: runId,
        locator: parsed.locator,
      });
      return { evidence, returnTarget: parsed.returnTarget };
    } catch (error) {
      if (
        error instanceof DashboardInputError ||
        isDashboardReadRequestError(error)
      )
        return 'invalid' as const;
      throw error;
    }
  })();
  if (loaded === 'invalid') return <UnavailableEvidence />;
  const { evidence, returnTarget } = loaded;
  if (!evidence) notFound();
  const preview = evidence.artifact?.preview ?? null;
  return (
    <main id="main-content" className="page-shell" tabIndex={-1}>
      <Link
        className="back-link"
        href={
          returnTarget
            ? evidenceReturnHref(returnTarget)
            : `/repositories/${repositoryId}/runs/${runId}`
        }
      >
        ← Back to run evidence
      </Link>
      <div className="page-heading">
        <div>
          <p className="eyebrow">Exact same-run evidence</p>
          <h1>Evidence detail</h1>
          <p>
            Locator <strong>{evidence.locatorKind}</strong>
          </p>
        </div>
        <StateBadge state={evidence.artifact?.verificationState ?? 'EVENT'} />
      </div>

      <DashboardSection
        id="event"
        title="Canonical event"
        description="Canonical event data is displayed as bounded, escaped structured text."
      >
        <DefinitionGrid
          values={[
            { label: 'Event ID', value: evidence.event.eventId },
            { label: 'Sequence', value: evidence.event.sequence },
            { label: 'Kind', value: evidence.event.kind },
            { label: 'Observed', value: evidence.event.observedAt },
            {
              label: 'Occurred',
              value: <Value value={evidence.event.occurredAt} />,
            },
            { label: 'Received', value: evidence.event.receivedAt },
          ]}
        />
        <StructuredValue value={evidence.event.data} />
      </DashboardSection>

      {evidence.finding ? (
        <DashboardSection id="finding-context" title="Finding locator context">
          <DefinitionGrid
            values={[
              { label: 'Result key', value: evidence.finding.resultKey },
              { label: 'Rule', value: evidence.finding.ruleId },
              { label: 'Rule version', value: evidence.finding.ruleVersion },
              {
                label: 'Reference ordinal',
                value: evidence.finding.referenceOrdinal,
              },
            ]}
          />
        </DashboardSection>
      ) : null}

      {evidence.file ? (
        <DashboardSection id="file-context" title="File-entry context">
          <DefinitionGrid
            values={[
              { label: 'Path', value: evidence.file.displayPath },
              { label: 'Ordinal', value: evidence.file.ordinal },
              { label: 'Entry ID', value: evidence.file.entryId },
              { label: 'Attribution', value: evidence.file.attribution },
              {
                label: 'Display ambiguity',
                value: evidence.file.displayAmbiguous
                  ? 'Ambiguous'
                  : 'Unambiguous',
              },
            ]}
          />
          <StructuredValue
            value={{
              before: evidence.file.before,
              after: evidence.file.after,
            }}
          />
        </DashboardSection>
      ) : null}

      {evidence.artifact ? (
        <DashboardSection
          id="artifact"
          title="Verified artifact preview"
          description="Only the bounded BBX-012A verified text/JSON preview is rendered. Binary and unverifiable bytes remain unavailable."
        >
          <DefinitionGrid
            values={[
              { label: 'Artifact ID', value: evidence.artifact.artifactId },
              { label: 'Kind', value: evidence.artifact.kind },
              { label: 'Media type', value: evidence.artifact.mediaType },
              { label: 'Bytes', value: evidence.artifact.byteLength },
              { label: 'SHA-256', value: evidence.artifact.sha256 },
              {
                label: 'Artifact pointer',
                value: <Value value={evidence.artifact.eventArtifactPointer} />,
              },
              {
                label: 'JSON pointer',
                value: <Value value={evidence.artifact.jsonPointer} />,
              },
              {
                label: 'Verification',
                value: evidence.artifact.verificationState,
              },
            ]}
          />
          {!preview || preview.state === 'unavailable' ? (
            <EmptyState>
              Preview unavailable{preview ? `: ${preview.reason}` : '.'}
            </EmptyState>
          ) : (
            <pre className="evidence-preview">{preview.text}</pre>
          )}
        </DashboardSection>
      ) : (
        <EmptyState>This locator resolves to event evidence only.</EmptyState>
      )}
      <RouteFocusCompletion />
    </main>
  );
}
