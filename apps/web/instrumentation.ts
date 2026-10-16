import 'server-only';

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { loadDashboardConfig } = await import('./server/dashboard-config');
  loadDashboardConfig();
}
