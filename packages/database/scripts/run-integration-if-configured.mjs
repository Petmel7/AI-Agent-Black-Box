import { spawnSync } from 'node:child_process';

import { validateTestDatabaseUrl } from './validate-test-database-url.mjs';

if (!process.env.TEST_DATABASE_URL?.trim()) {
  console.log(
    'Skipping @blackbox/database integration tests: TEST_DATABASE_URL is not configured.',
  );
  process.exit(0);
}

try {
  validateTestDatabaseUrl();
} catch (error) {
  const message =
    error instanceof Error ? error.message : 'Invalid test database URL.';
  console.error(message);
  process.exit(1);
}

const pnpmEntry = process.env.npm_execpath;
if (!pnpmEntry) {
  console.error('Unable to locate pnpm for the integration test command.');
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  [
    pnpmEntry,
    'exec',
    'vitest',
    'run',
    '--config',
    'vitest.integration.config.ts',
  ],
  { stdio: 'inherit' },
);

if (result.error) {
  console.error('Unable to start the database integration test process.');
  process.exit(1);
}

process.exit(result.status ?? 1);
