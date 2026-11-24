import { EvidenceExportQueryError } from '@blackbox/database';
import {
  EVIDENCE_EXPORT_MEDIA_TYPE,
  EvidenceExportTooLargeError,
  InvalidEvidenceExportError,
} from '@blackbox/export';

import {
  dashboardUnauthorizedResponse,
  dashboardUnavailableResponse,
  isAuthenticatedDashboardRequest,
  sanitizedDashboardRouteHeaders,
} from '../../../../../../server/dashboard-auth';
import {
  DashboardConfigurationError,
  loadDashboardConfig,
  type DashboardServerConfig,
} from '../../../../../../server/dashboard-config';
import {
  getDashboardRuntime,
  type DashboardRuntime,
} from '../../../../../../server/dashboard-runtime';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';
export const runtime = 'nodejs';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface EvidenceExportRouteDependencies {
  config(): DashboardServerConfig;
  runtime(): Pick<DashboardRuntime, 'exportRun'>;
}

function unavailable(status = 404): Response {
  return new Response('Export unavailable', {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'text/plain; charset=utf-8',
      'x-content-type-options': 'nosniff',
    },
  });
}

function tooLarge(): Response {
  return new Response('Export too large', {
    status: 413,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'text/plain; charset=utf-8',
      'x-content-type-options': 'nosniff',
    },
  });
}

export function createEvidenceExportHandler(
  dependencies: EvidenceExportRouteDependencies = {
    config: loadDashboardConfig,
    runtime: getDashboardRuntime,
  },
) {
  return async function evidenceExport(
    request: Request,
    context: {
      params: Promise<{ repositoryId: string; runId: string }>;
    },
  ): Promise<Response> {
    try {
      const routeRequest = new Request(request.url, {
        headers: sanitizedDashboardRouteHeaders(request),
      });
      dependencies.config();
      if (!isAuthenticatedDashboardRequest(routeRequest))
        return dashboardUnauthorizedResponse();
      const params = await context.params;
      if (!UUID.test(params.repositoryId) || !UUID.test(params.runId))
        return unavailable();
      const repositoryId = params.repositoryId.toLowerCase();
      const runId = params.runId.toLowerCase();
      const built = await dependencies.runtime().exportRun({
        repositoryId,
        canonicalRunId: runId,
      });
      if (!built) return unavailable();
      const body = new ArrayBuffer(built.bytes.byteLength);
      new Uint8Array(body).set(built.bytes);
      return new Response(body, {
        status: 200,
        headers: {
          'cache-control': 'no-store',
          'content-disposition': `attachment; filename="blackbox-evidence-${runId}.v1.json"`,
          'content-length': String(built.bytes.byteLength),
          'content-type': EVIDENCE_EXPORT_MEDIA_TYPE,
          etag: `"${built.sha256}"`,
          'x-content-type-options': 'nosniff',
        },
      });
    } catch (error) {
      if (error instanceof DashboardConfigurationError)
        return dashboardUnavailableResponse();
      if (error instanceof EvidenceExportTooLargeError) return tooLarge();
      if (
        error instanceof EvidenceExportQueryError ||
        error instanceof InvalidEvidenceExportError
      )
        return unavailable(503);
      return dashboardUnavailableResponse();
    }
  };
}

export const GET = createEvidenceExportHandler();
