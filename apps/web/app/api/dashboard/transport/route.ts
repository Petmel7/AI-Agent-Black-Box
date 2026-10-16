import {
  DASHBOARD_AUTHENTICATED_HEADER,
  DASHBOARD_PROXY_TOKEN_HEADER,
  dashboardUnauthorizedResponse,
  isAuthenticatedDashboardRequest,
  sanitizedDashboardRouteHeaders,
} from '../../../../server/dashboard-auth';

/** Minimal authenticated fixture proving proxy-owned header sanitation. */
export function GET(request: Request): Response {
  const headers = sanitizedDashboardRouteHeaders(request);
  const routeRequest = new Request(request.url, { headers });
  if (!isAuthenticatedDashboardRequest(routeRequest))
    return dashboardUnauthorizedResponse();
  const unsafeHeaders = [...headers.keys()].filter((name) => {
    const normalized = name.toLowerCase();
    return (
      normalized === 'authorization' ||
      normalized === 'forwarded' ||
      normalized === DASHBOARD_PROXY_TOKEN_HEADER ||
      (normalized.startsWith('x-forwarded-') &&
        normalized !== DASHBOARD_AUTHENTICATED_HEADER)
    );
  });
  return Response.json(
    { sanitized: unsafeHeaders.length === 0 },
    { headers: { 'cache-control': 'private, no-store' } },
  );
}
