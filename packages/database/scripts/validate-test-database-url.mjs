const ISOLATED_DATABASE_NAME = /^blackbox_(?:test|integration)$/;

export function validateTestDatabaseUrl(value = process.env.TEST_DATABASE_URL) {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(
      'TEST_DATABASE_URL is required for database migration and integration commands.',
    );
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('TEST_DATABASE_URL must be a valid PostgreSQL URL.');
  }

  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('TEST_DATABASE_URL must use postgres: or postgresql:.');
  }

  if (parsed.hostname.length === 0 || parsed.username.length === 0) {
    throw new Error(
      'TEST_DATABASE_URL must include an explicit hostname and username.',
    );
  }

  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!ISOLATED_DATABASE_NAME.test(databaseName)) {
    throw new Error(
      'TEST_DATABASE_URL must name the isolated blackbox_test or blackbox_integration database.',
    );
  }

  return value;
}
