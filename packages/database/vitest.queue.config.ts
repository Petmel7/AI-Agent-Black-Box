import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@blackbox/analyzers': fileURLToPath(
        new URL('../analyzers/src/index.ts', import.meta.url),
      ),
      '@blackbox/contracts': fileURLToPath(
        new URL('../contracts/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['tests/queue/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
