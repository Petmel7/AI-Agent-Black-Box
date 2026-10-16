import {
  DashboardQueryError,
  type DashboardRunListInput,
} from '@blackbox/database';

import {
  isAuthenticatedDashboardRequest,
  dashboardUnauthorizedResponse,
  dashboardUnavailableResponse,
  sanitizedDashboardRouteHeaders,
} from '../../../../server/dashboard-auth';
import {
  DashboardConfigurationError,
  loadDashboardConfig,
  type DashboardServerConfig,
} from '../../../../server/dashboard-config';
import {
  getDashboardRuntime,
  type DashboardRuntime,
} from '../../../../server/dashboard-runtime';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CURSOR = /^[A-Za-z0-9_-]{1,2048}$/;

export interface DashboardRunsRouteDependencies {
  config(): DashboardServerConfig;
  runtime(): Pick<DashboardRuntime, 'listRuns'>;
}

function badRequest(code = 'invalid_request'): Response {
  return Response.json(
    { error: code },
    { status: 400, headers: { 'cache-control': 'no-store' } },
  );
}

function input(
  url: URL,
): Omit<DashboardRunListInput, 'organizationId' | 'cursorSigningKey'> | null {
  const allowed = new Set(['repositoryId', 'limit', 'cursor']);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1)
      return null;
  }
  const repositoryId = url.searchParams.get('repositoryId') ?? undefined;
  const rawLimit = url.searchParams.get('limit') ?? '25';
  const cursor = url.searchParams.get('cursor') ?? undefined;
  if (
    (repositoryId !== undefined && !UUID.test(repositoryId)) ||
    !/^[1-9][0-9]{0,2}$/.test(rawLimit) ||
    Number(rawLimit) > 100 ||
    (cursor !== undefined && !CURSOR.test(cursor))
  )
    return null;
  return {
    ...(repositoryId ? { repositoryId } : {}),
    limit: Number(rawLimit),
    ...(cursor ? { cursor } : {}),
  };
}

export function createDashboardRunsHandler(
  dependencies: DashboardRunsRouteDependencies = {
    config: loadDashboardConfig,
    runtime: getDashboardRuntime,
  },
) {
  return async function dashboardRuns(request: Request): Promise<Response> {
    try {
      const routeRequest = new Request(request.url, {
        headers: sanitizedDashboardRouteHeaders(request),
      });
      dependencies.config();
      if (!isAuthenticatedDashboardRequest(routeRequest))
        return dashboardUnauthorizedResponse();
      const parsed = input(new URL(request.url));
      if (!parsed) return badRequest();
      const page = await dependencies.runtime().listRuns(parsed);
      return Response.json(page, {
        headers: { 'cache-control': 'private, no-store' },
      });
    } catch (error) {
      if (error instanceof DashboardConfigurationError)
        return dashboardUnavailableResponse();
      if (error instanceof DashboardQueryError) return badRequest(error.code);
      return dashboardUnavailableResponse();
    }
  };
}

export const GET = createDashboardRunsHandler();
