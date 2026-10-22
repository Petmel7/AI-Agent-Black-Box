import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import {
  DashboardSection,
  DefinitionGrid,
  DiagnosticState,
  EmptyState,
  NextPageLink,
  PresentationState,
  StateBadge,
  StructuredValue,
  Value,
} from '../../../../../components/dashboard-ui';
import {
  DashboardTargetLink,
  EvidenceNavigationLink,
} from '../../../../../components/evidence-navigation-link';
import { RouteFocusCompletion } from '../../../../../components/route-focus';
import {
  continuationHref,
  DashboardInputError,
  evidenceHref,
  evidenceReturnTarget,
  findingSupportTargetHref,
  findingOriginId,
  findingReferenceOriginId,
  formatDuration,
  isCanonicalUuid,
  parseDetailSearch,
  scopedHref,
  summarySupportOriginId,
  type EvidenceLocatorView,
  type SearchValues,
} from '../../../../../lib/dashboard-view';
import {
  getDashboardRuntime,
  isDashboardReadRequestError,
} from '../../../../../server/dashboard-runtime';

export const metadata: Metadata = { title: 'Run evidence' };
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

type SummarySupport =
  | {
      kind: 'evidence';
      ordinal: number;
      eventId: string | null;
      artifactId: string | null;
      eventArtifactPointer: string | null;
      jsonPointer: string | null;
      fileOrdinal: number | null;
      entryId: string | null;
    }
  | {
      kind: 'finding';
      ordinal: number;
      resultKey: string | null;
    };

const SUMMARY_SUPPORT_PREVIEW_LIMIT = 2;

function supportLocator(support: SummarySupport): EvidenceLocatorView | null {
  if (support.kind !== 'evidence' || !support.eventId) return null;
  if (
    support.artifactId &&
    support.eventArtifactPointer &&
    support.jsonPointer &&
    support.fileOrdinal !== null &&
    support.entryId
  )
    return {
      kind: 'file',
      eventId: support.eventId,
      artifactId: support.artifactId,
      eventArtifactPointer: support.eventArtifactPointer,
      jsonPointer: support.jsonPointer,
      fileOrdinal: support.fileOrdinal,
      entryId: support.entryId,
    };
  if (support.artifactId && support.eventArtifactPointer)
    return {
      kind: 'artifact',
      eventId: support.eventId,
      artifactId: support.artifactId,
      eventArtifactPointer: support.eventArtifactPointer,
      ...(support.jsonPointer ? { jsonPointer: support.jsonPointer } : {}),
    };
  return { kind: 'event', eventId: support.eventId };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function InvalidPage() {
  return (
    <main id="main-content" className="error-state" tabIndex={-1}>
      <p className="eyebrow">Invalid or stale page</p>
      <h1>This evidence page cannot be continued</h1>
      <p>
        The cursor is malformed, wrong-scope, key-rotated, or belongs to a
        replaced snapshot.
      </p>
      <Link className="back-link" href="/runs">
        Return to runs
      </Link>
      <RouteFocusCompletion />
    </main>
  );
}

export default async function RunDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ repositoryId: string; runId: string }>;
  searchParams: Promise<SearchValues>;
}) {
  const { repositoryId, runId } = await params;
  if (!isCanonicalUuid(repositoryId) || !isCanonicalUuid(runId)) notFound();
  const raw = await searchParams;
  const loaded = await (async () => {
    try {
      const { cursors, focusFinding } = parseDetailSearch(raw);
      const runtime = getDashboardRuntime();
      const [detail, files, findings, claims, timeline, supports] =
        await Promise.all([
          runtime.getRunDetail({
            repositoryId,
            canonicalRunId: runId,
            limit: 5,
            cursors: {
              ...(cursors.commands ? { commands: cursors.commands } : {}),
              ...(cursors.tools ? { tools: cursors.tools } : {}),
              ...(cursors.tests ? { tests: cursors.tests } : {}),
              ...(cursors.gitSnapshots
                ? { gitSnapshots: cursors.gitSnapshots }
                : {}),
              ...(cursors.gitDiffs ? { gitDiffs: cursors.gitDiffs } : {}),
              ...(cursors.errors ? { errors: cursors.errors } : {}),
              ...(cursors.usage ? { usage: cursors.usage } : {}),
            },
          }),
          runtime.listFiles({
            repositoryId,
            canonicalRunId: runId,
            limit: 5,
            ...(cursors.files ? { cursor: cursors.files } : {}),
          }),
          runtime.listFindings({
            repositoryId,
            canonicalRunId: runId,
            limit: focusFinding ? 100 : 5,
            ...(cursors.findings ? { cursor: cursors.findings } : {}),
          }),
          runtime.listSummaryClaims({
            repositoryId,
            canonicalRunId: runId,
            limit: 5,
            ...(cursors.summaryClaims ? { cursor: cursors.summaryClaims } : {}),
          }),
          runtime.listTimeline({
            repositoryId,
            canonicalRunId: runId,
            limit: 5,
            ...(cursors.timeline ? { cursor: cursors.timeline } : {}),
          }),
          cursors.supportClaim
            ? runtime.listSummarySupports({
                repositoryId,
                canonicalRunId: runId,
                claimKey: cursors.supportClaim,
                limit: 5,
                ...(cursors.summarySupports
                  ? { cursor: cursors.summarySupports }
                  : {}),
              })
            : Promise.resolve(null),
        ]);
      return {
        cursors,
        focusFinding,
        detail,
        files,
        findings,
        claims,
        timeline,
        supports,
      };
    } catch (error) {
      if (
        error instanceof DashboardInputError ||
        isDashboardReadRequestError(error)
      )
        return null;
      throw error;
    }
  })();
  if (!loaded) return <InvalidPage />;
  const {
    cursors,
    focusFinding,
    detail,
    files,
    findings,
    claims,
    timeline,
    supports,
  } = loaded;
  if (!detail || !files || !findings || !claims || !timeline) notFound();
  if (cursors.supportClaim && !supports) notFound();
  if (
    focusFinding &&
    !findings.items.some((finding) => finding.resultKey === focusFinding)
  )
    notFound();
  const visibleFindings = focusFinding
    ? {
        ...findings,
        items: findings.items.filter(
          (finding) => finding.resultKey === focusFinding,
        ),
        nextCursor: null,
      }
    : findings;
  const pathname = `/repositories/${repositoryId}/runs/${runId}`;
  const projection = detail.projection;
  const next = (
    name: string,
    value: string | null,
    extras: Record<string, string> = {},
  ) => (value ? continuationHref(pathname, raw, name, value, extras) : null);
  const exactEvidenceHref = (
    locator: EvidenceLocatorView,
    section: 'findings' | 'summary',
    itemId: string,
  ) => {
    const returnSearch =
      section === 'summary' && focusFinding !== null
        ? { ...raw, focusFinding: undefined }
        : raw;
    return evidenceHref(
      repositoryId,
      runId,
      locator,
      evidenceReturnTarget(repositoryId, runId, returnSearch, section, itemId),
    );
  };
  return (
    <main id="main-content" className="page-shell" tabIndex={-1}>
      <Link className="back-link" href="/runs">
        ← All runs
      </Link>
      <div className="page-heading">
        <div>
          <p className="eyebrow">Repository {repositoryId}</p>
          <h1>Run evidence</h1>
          <p className="mono">{runId}</p>
        </div>
        <StateBadge state={detail.presentationState} />
      </div>
      <PresentationState state={detail.presentationState} />
      <nav aria-label="Run evidence sections">
        <ul className="section-nav">
          {[
            'overview',
            'summary',
            'findings',
            'files',
            'commands',
            'tests',
            'tools',
            'git',
            'errors',
            'usage',
            'timeline',
          ].map((id) => (
            <li key={id}>
              <a href={`#${id}`}>{id}</a>
            </li>
          ))}
        </ul>
      </nav>

      <DashboardSection
        id="overview"
        title="Overview"
        description="Presentation, process, and projection states remain independent."
      >
        <div className="diagnostics">
          <DiagnosticState
            label="Core"
            state={detail.processingState}
            errorCode={detail.processingErrorCode}
          />
          <DiagnosticState
            label="Files"
            state={detail.filesProcessingState}
            errorCode={detail.filesProcessingErrorCode}
          />
          <DiagnosticState
            label="Findings"
            state={detail.findingsProcessingState}
            errorCode={detail.findingsProcessingErrorCode}
          />
          <DiagnosticState
            label="Summary"
            state={detail.summaryProcessingState}
            errorCode={detail.summaryProcessingErrorCode}
          />
        </div>
        <DefinitionGrid
          values={[
            {
              label: 'Observed child outcome',
              value: <Value value={projection?.observedOutcome} />,
            },
            {
              label: 'Evidence completeness',
              value: <Value value={projection?.evidenceCompleteness} />,
            },
            {
              label: 'Deterministic outcome',
              value: <Value value={detail.deterministicOutcome} />,
            },
            {
              label: 'Summary availability',
              value: detail.summaryAvailability,
            },
            {
              label: 'Summary outcome',
              value: <Value value={detail.summaryOutcome} />,
            },
            {
              label: 'Duration',
              value: formatDuration(projection?.durationMs),
            },
            {
              label: 'Files changed',
              value: (
                <Value
                  value={
                    projection?.filesChanged ??
                    ('filesChanged' in detail ? detail.filesChanged : null)
                  }
                />
              ),
            },
            {
              label: 'Created',
              value: new Date(detail.createdAt).toLocaleString(),
            },
          ]}
        />
        {stringList(projection?.completenessReasons).length ? (
          <StructuredValue value={projection?.completenessReasons} />
        ) : null}
      </DashboardSection>

      <DashboardSection
        id="summary"
        title="Structured summary"
        description="Claim text is rendered unchanged as inert text."
      >
        {claims.items.length === 0 ? (
          <EmptyState>
            Summary claims are {claims.summaryAvailability}.
          </EmptyState>
        ) : (
          <ol className="item-list">
            {claims.items.map((claim) => (
              <li
                className="item-card"
                id={`claim-${claim.claimKey}`}
                key={claim.claimKey}
                tabIndex={-1}
                data-dashboard-collection="summary-claims"
                data-dashboard-item-key={claim.claimKey}
              >
                <div className="item-header">
                  <h3>
                    {claim.sectionId} · {claim.class}
                  </h3>
                  <span>{claim.supportCount} supports</span>
                </div>
                <p>{claim.text}</p>
                {claim.supportsTruncated ? (
                  <p className="truncation">Support preview truncated.</p>
                ) : null}
                <ul>
                  {claim.supports
                    .slice(0, SUMMARY_SUPPORT_PREVIEW_LIMIT)
                    .map((support) => {
                      const originId = summarySupportOriginId(
                        claim.claimKey,
                        support.ordinal,
                        'preview',
                      );
                      const locator = supportLocator(support as SummarySupport);
                      const href = locator
                        ? exactEvidenceHref(locator, 'summary', originId)
                        : support.kind === 'finding' && support.resultKey
                          ? findingSupportTargetHref(
                              repositoryId,
                              runId,
                              raw,
                              support.resultKey,
                            )
                          : null;
                      return (
                        <li
                          id={originId}
                          key={support.ordinal}
                          tabIndex={-1}
                          data-dashboard-collection={`summary-support-preview-${claim.claimKey}`}
                          data-dashboard-item-key={String(support.ordinal)}
                          data-summary-support-kind={support.kind}
                        >
                          {href && locator ? (
                            <EvidenceNavigationLink
                              href={href}
                              originId={originId}
                            >
                              Support {support.ordinal + 1}: {support.kind}
                            </EvidenceNavigationLink>
                          ) : href && support.resultKey ? (
                            <DashboardTargetLink
                              href={href}
                              originId={originId}
                              targetId={findingOriginId(support.resultKey)}
                            >
                              Support {support.ordinal + 1}: finding
                            </DashboardTargetLink>
                          ) : (
                            `Support ${support.ordinal + 1}: unavailable`
                          )}
                        </li>
                      );
                    })}
                </ul>
                {claim.supportCount >
                Math.min(
                  claim.supports.length,
                  SUMMARY_SUPPORT_PREVIEW_LIMIT,
                ) ? (
                  <Link
                    href={scopedHref(
                      pathname,
                      raw,
                      { supportClaim: claim.claimKey },
                      ['summarySupports'],
                    )}
                  >
                    Page all supports
                  </Link>
                ) : null}
              </li>
            ))}
          </ol>
        )}
        <NextPageLink
          href={next('summaryClaims', claims.nextCursor)}
          collection="summary claims"
        />
        {supports ? (
          <div className="item-card">
            <h3>Selected claim supports</h3>
            <ul>
              {supports.items.map((support) => {
                const originId = summarySupportOriginId(
                  supports.claimKey!,
                  support.ordinal,
                  'page',
                );
                const locator = supportLocator(support as SummarySupport);
                return (
                  <li
                    id={originId}
                    key={support.ordinal}
                    tabIndex={-1}
                    data-dashboard-collection="summary-supports"
                    data-dashboard-item-key={`${supports.claimKey}:${support.ordinal}`}
                    data-summary-support-kind={support.kind}
                  >
                    {locator ? (
                      <EvidenceNavigationLink
                        href={exactEvidenceHref(locator, 'summary', originId)}
                        originId={originId}
                      >
                        Open support {support.ordinal + 1}
                      </EvidenceNavigationLink>
                    ) : support.kind === 'finding' && support.resultKey ? (
                      <DashboardTargetLink
                        href={findingSupportTargetHref(
                          repositoryId,
                          runId,
                          raw,
                          support.resultKey,
                        )}
                        originId={originId}
                        targetId={findingOriginId(support.resultKey)}
                      >
                        Open finding support
                      </DashboardTargetLink>
                    ) : (
                      'Unavailable support'
                    )}
                  </li>
                );
              })}
            </ul>
            <NextPageLink
              href={next('summarySupports', supports.nextCursor, {
                supportClaim: cursors.supportClaim!,
              })}
              collection="summary supports"
            />
          </div>
        ) : null}
      </DashboardSection>

      <DashboardSection
        id="findings"
        title="Deterministic findings"
        description="Findings are evidence-backed review signals, not policy decisions."
      >
        {visibleFindings.items.length === 0 ? (
          <EmptyState>No current finding rows are available.</EmptyState>
        ) : (
          <ol className="item-list">
            {visibleFindings.items.map((finding) => (
              <li
                className="item-card"
                id={findingOriginId(finding.resultKey)}
                key={finding.resultKey}
                tabIndex={-1}
                data-dashboard-collection="findings"
                data-dashboard-item-key={finding.resultKey}
              >
                <div className="item-header">
                  <h3>
                    {finding.ruleId} v{finding.ruleVersion}
                  </h3>
                  <span>
                    <StateBadge state={finding.severity.toUpperCase()} />{' '}
                    <StateBadge state={finding.outcome.toUpperCase()} />
                  </span>
                </div>
                <p>{finding.explanation}</p>
                <DefinitionGrid
                  values={[
                    { label: 'Coverage', value: finding.coverage },
                    { label: 'Matches', value: finding.matchCount },
                    {
                      label: 'Reason codes',
                      value:
                        stringList(finding.reasonCodes).join(', ') || 'None',
                    },
                  ]}
                />
                {finding.matchesTruncated || finding.referencesTruncated ? (
                  <p className="truncation">Finding output is truncated.</p>
                ) : null}
                {finding.references.length === 0 ? (
                  <p className="empty-state" role="status">
                    No navigable immutable evidence reference is available for
                    this finding.
                  </p>
                ) : (
                  <ul>
                    {finding.references.map((reference) => {
                      const originId = findingReferenceOriginId(
                        finding.resultKey,
                        reference.ordinal,
                      );
                      return (
                        <li
                          id={originId}
                          key={reference.ordinal}
                          tabIndex={-1}
                          data-finding-reference={String(reference.ordinal)}
                        >
                          <EvidenceNavigationLink
                            href={exactEvidenceHref(
                              {
                                kind: 'finding',
                                resultKey: finding.resultKey,
                                referenceOrdinal: reference.ordinal,
                              },
                              'findings',
                              originId,
                            )}
                            originId={originId}
                          >
                            Evidence reference {reference.ordinal + 1}
                          </EvidenceNavigationLink>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            ))}
          </ol>
        )}
        <NextPageLink
          href={next('findings', visibleFindings.nextCursor)}
          collection="findings"
        />
      </DashboardSection>

      <DashboardSection
        id="files"
        title="Changed files"
        description={`File projection: ${files.processingState}`}
      >
        {files.items.length === 0 ? (
          <EmptyState>No current file entries are available.</EmptyState>
        ) : (
          <ol className="item-list">
            {files.items.map((file) => (
              <li
                className="item-card"
                key={`${file.sourceEventId}:${file.ordinal}`}
                data-dashboard-collection="files"
                data-dashboard-item-key={`${file.sourceEventId}:${file.ordinal}`}
              >
                <div className="item-header">
                  <h3 className="mono">{file.displayPath}</h3>
                  <span>{file.attribution}</span>
                </div>
                <p>
                  {file.displayAmbiguous
                    ? `Ambiguous: ${file.displayReason ?? 'unknown reason'}`
                    : (file.reason ?? 'No additional reason.')}
                </p>
                <Link
                  href={evidenceHref(repositoryId, runId, {
                    kind: 'file',
                    eventId: file.sourceEventId,
                    artifactId: file.artifactId,
                    eventArtifactPointer: '/payload/fileListArtifact',
                    jsonPointer: `/files/${file.ordinal}`,
                    fileOrdinal: file.ordinal,
                    entryId: file.entryId,
                  })}
                >
                  Open exact file evidence
                </Link>
              </li>
            ))}
          </ol>
        )}
        <NextPageLink
          href={next('files', files.nextCursor)}
          collection="files"
        />
      </DashboardSection>

      <DashboardSection
        id="commands"
        title="Commands"
        description="Observed command operations only."
      >
        {!projection ? (
          <EmptyState>
            Core projection unavailable; command evidence completeness is
            unknown.
          </EmptyState>
        ) : projection.commands.items.length === 0 ? (
          <EmptyState>
            No command observations exist on this complete projection page.
          </EmptyState>
        ) : (
          <ol className="item-list">
            {projection.commands.items.map((item) => (
              <li
                className="item-card"
                key={item.operationId}
                data-dashboard-collection="commands"
                data-dashboard-item-key={item.operationId}
              >
                <div className="item-header">
                  <h3 className="mono">{item.operationId}</h3>
                  <span>
                    {item.state} · <Value value={item.outcome} />
                  </span>
                </div>
                <DefinitionGrid
                  values={[
                    {
                      label: 'Duration',
                      value: formatDuration(item.durationMs),
                    },
                    {
                      label: 'Exit code',
                      value: <Value value={item.exitCode} />,
                    },
                    {
                      label: 'Signal',
                      value: <Value value={item.terminationSignal} />,
                    },
                  ]}
                />
                <StructuredValue
                  value={{
                    command: item.commandCapture,
                    cwd: item.workingDirectory,
                    stdout: item.stdoutCapture,
                    stderr: item.stderrCapture,
                  }}
                />
              </li>
            ))}
          </ol>
        )}
        {projection ? (
          <NextPageLink
            href={next('commands', projection.commands.nextCursor)}
            collection="commands"
          />
        ) : null}
      </DashboardSection>

      <DashboardSection
        id="tests"
        title="Explicit test observations"
        description={`Observation state: ${projection?.testObservationState ?? 'unavailable'}`}
      >
        {!projection ? (
          <EmptyState>
            Core projection unavailable; test evidence completeness is unknown.
          </EmptyState>
        ) : projection.tests.items.length === 0 ? (
          <EmptyState>
            No test observations exist on this complete projection page; absence
            is not a pass.
          </EmptyState>
        ) : (
          <ol className="item-list">
            {projection.tests.items.map((item) => (
              <li
                className="item-card"
                key={item.testRunId}
                data-dashboard-collection="tests"
                data-dashboard-item-key={item.testRunId}
              >
                <div className="item-header">
                  <h3>{item.framework ?? 'Framework unavailable'}</h3>
                  <StateBadge state={item.outcome.toUpperCase()} />
                </div>
                <StructuredValue value={item.counts} />
              </li>
            ))}
          </ol>
        )}
        {projection ? (
          <NextPageLink
            href={next('tests', projection.tests.nextCursor)}
            collection="tests"
          />
        ) : null}
      </DashboardSection>

      <DashboardSection id="tools" title="Tool calls">
        {!projection ? (
          <EmptyState>
            Core projection unavailable; tool-call evidence completeness is
            unknown.
          </EmptyState>
        ) : projection.tools.items.length === 0 ? (
          <EmptyState>
            No tool-call observations exist on this complete projection page.
          </EmptyState>
        ) : (
          <ol className="item-list">
            {projection.tools.items.map((item) => (
              <li
                className="item-card"
                key={item.operationId}
                data-dashboard-collection="tools"
                data-dashboard-item-key={item.operationId}
              >
                <div className="item-header">
                  <h3>{item.toolName ?? 'Unnamed tool'}</h3>
                  <span>{item.state}</span>
                </div>
                <StructuredValue
                  value={{
                    input: item.inputCapture,
                    output: item.outputCapture,
                  }}
                />
              </li>
            ))}
          </ol>
        )}
        {projection ? (
          <NextPageLink
            href={next('tools', projection.tools.nextCursor)}
            collection="tools"
          />
        ) : null}
      </DashboardSection>

      <DashboardSection id="git" title="Git snapshots and diffs">
        {!projection ? (
          <EmptyState>
            Core projection unavailable; Git evidence completeness is unknown.
          </EmptyState>
        ) : (
          <>
            <h3>Snapshots</h3>
            {projection.gitSnapshots.items.length === 0 ? (
              <EmptyState>
                No Git snapshots exist on this complete projection page.
              </EmptyState>
            ) : (
              <ol className="item-list">
                {projection.gitSnapshots.items.map((item) => (
                  <li
                    className="item-card"
                    key={item.snapshotId}
                    data-dashboard-collection="git-snapshots"
                    data-dashboard-item-key={item.snapshotId}
                  >
                    <StructuredValue value={item} />
                  </li>
                ))}
              </ol>
            )}
            <NextPageLink
              href={next('gitSnapshots', projection.gitSnapshots.nextCursor)}
              collection="git snapshots"
            />
            <h3>Diffs</h3>
            {projection.gitDiffs.items.length === 0 ? (
              <EmptyState>
                No Git diffs exist on this complete projection page.
              </EmptyState>
            ) : (
              <ol className="item-list">
                {projection.gitDiffs.items.map((item) => (
                  <li
                    className="item-card"
                    key={item.diffId}
                    data-dashboard-collection="git-diffs"
                    data-dashboard-item-key={item.diffId}
                  >
                    <StructuredValue value={item} />
                  </li>
                ))}
              </ol>
            )}
            <NextPageLink
              href={next('gitDiffs', projection.gitDiffs.nextCursor)}
              collection="git diffs"
            />
          </>
        )}
      </DashboardSection>

      <DashboardSection id="errors" title="Observed errors">
        {!projection ? (
          <EmptyState>
            Core projection unavailable; error evidence completeness is unknown.
          </EmptyState>
        ) : projection.errors.items.length === 0 ? (
          <EmptyState>
            No error observations exist on this complete projection page.
          </EmptyState>
        ) : (
          <ol className="item-list">
            {projection.errors.items.map((item) => (
              <li
                className="item-card"
                key={item.errorId}
                data-dashboard-collection="errors"
                data-dashboard-item-key={item.errorId}
              >
                <StructuredValue value={item} />
              </li>
            ))}
          </ol>
        )}
        {projection ? (
          <NextPageLink
            href={next('errors', projection.errors.nextCursor)}
            collection="errors"
          />
        ) : null}
      </DashboardSection>

      <DashboardSection
        id="usage"
        title="Usage observations"
        description="Provider-reported measurements remain distinct and nullable."
      >
        {!projection ? (
          <EmptyState>
            Core projection unavailable; usage evidence completeness is unknown.
          </EmptyState>
        ) : projection.usage.items.length === 0 ? (
          <EmptyState>
            No usage observations exist on this complete projection page.
          </EmptyState>
        ) : (
          <ol className="item-list">
            {projection.usage.items.map((item) => (
              <li
                className="item-card"
                key={`${item.sourceEventId}:${item.sourceSequence}`}
                data-dashboard-collection="usage"
                data-dashboard-item-key={`${item.sourceEventId}:${item.sourceSequence}`}
              >
                <StructuredValue value={item} />
              </li>
            ))}
          </ol>
        )}
        {projection ? (
          <NextPageLink
            href={next('usage', projection.usage.nextCursor)}
            collection="usage"
          />
        ) : null}
      </DashboardSection>

      <DashboardSection
        id="timeline"
        title="Canonical timeline"
        description="Ordered by sequence and canonical event ID."
      >
        {timeline.items.length === 0 ? (
          <EmptyState>No canonical events are available.</EmptyState>
        ) : (
          <ol className="item-list">
            {timeline.items.map((event) => (
              <li
                className="item-card"
                key={event.eventId}
                data-dashboard-collection="timeline"
                data-dashboard-item-key={event.eventId}
              >
                <div className="item-header">
                  <h3>
                    {event.sequence} · {event.kind}
                  </h3>
                  <time dateTime={event.observedAt}>
                    {new Date(event.observedAt).toLocaleString()}
                  </time>
                </div>
                <Link
                  href={evidenceHref(repositoryId, runId, {
                    kind: 'event',
                    eventId: event.eventId,
                  })}
                >
                  Inspect event
                </Link>
              </li>
            ))}
          </ol>
        )}
        <NextPageLink
          href={next('timeline', timeline.nextCursor)}
          collection="timeline"
        />
      </DashboardSection>
      <RouteFocusCompletion />
    </main>
  );
}
