import { validateTestDatabaseUrl } from './validate-test-database-url.mjs';

try {
  validateTestDatabaseUrl();
} catch (error) {
  const message =
    error instanceof Error ? error.message : 'Invalid test database URL.';
  console.error(message);
  process.exitCode = 1;
}
