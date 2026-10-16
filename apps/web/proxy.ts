import { NextResponse, type NextRequest } from 'next/server';

import {
  authenticatedDashboardHeaders,
  authenticateDashboardRequest,
  dashboardUnauthorizedResponse,
  dashboardUnavailableResponse,
} from './server/dashboard-auth';
import {
  DashboardConfigurationError,
  loadDashboardConfig,
} from './server/dashboard-config';

/** Application-level fail-closed boundary for every dashboard page and route. */
export function proxy(request: NextRequest) {
  try {
    const config = loadDashboardConfig();
    if (!authenticateDashboardRequest(request, config).authenticated)
      return dashboardUnauthorizedResponse();
    return NextResponse.next({
      request: { headers: authenticatedDashboardHeaders(request) },
    });
  } catch (error) {
    if (error instanceof DashboardConfigurationError)
      return dashboardUnavailableResponse();
    return dashboardUnavailableResponse();
  }
}

export const config = {
  matcher: ['/((?!health|_next/static|_next/image|favicon.ico).*)'],
};
