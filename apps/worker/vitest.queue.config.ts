import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: {
    alias: {
      '@blackbox/analyzers': fileURLToPath(
        new URL('../../packages/analyzers/src/index.ts', import.meta.url),
      ),
      '@blackbox/artifact-storage': fileURLToPath(
        new URL(
          '../../packages/artifact-storage/src/index.ts',
          import.meta.url,
        ),
      ),
      '@blackbox/contracts': fileURLToPath(
        new URL('../../packages/contracts/src/index.ts', import.meta.url),
      ),
      '@blackbox/database': fileURLToPath(
        new URL('../../packages/database/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['src/**/*.integration.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
