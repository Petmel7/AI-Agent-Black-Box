import { spawnSync } from 'node:child_process';

import { validateTestDatabaseUrl } from '../../../packages/database/scripts/validate-test-database-url.mjs';

if (!process.env.TEST_DATABASE_URL?.trim()) {
  console.log(
    'Skipping @blackbox/worker queue tests: TEST_DATABASE_URL is not configured.',
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
  console.error('Unable to locate pnpm for the worker queue test command.');
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  [pnpmEntry, 'exec', 'vitest', 'run', '--config', 'vitest.queue.config.ts'],
  { stdio: 'inherit' },
);

if (result.error) {
  console.error('Unable to start the worker queue test process.');
  process.exit(1);
}

process.exit(result.status ?? 1);
