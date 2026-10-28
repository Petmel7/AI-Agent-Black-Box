import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  oxc: {
    jsx: { runtime: 'automatic' },
  },
  resolve: {
    alias: {
      'server-only': fileURLToPath(
        new URL('./test/server-only.ts', import.meta.url),
      ),
      '@blackbox/artifact-storage': fileURLToPath(
        new URL(
          '../../packages/artifact-storage/src/index.ts',
          import.meta.url,
        ),
      ),
      '@blackbox/database': fileURLToPath(
        new URL('../../packages/database/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    // Live process-ownership and real-Next suites require serialized file execution.
    fileParallelism: false,
    include: ['**/*.test.ts', '**/*.test.tsx'],
  },
});
