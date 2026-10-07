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
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 15_000,
    hookTimeout: 15_000,
    fileParallelism: false,
  },
});
