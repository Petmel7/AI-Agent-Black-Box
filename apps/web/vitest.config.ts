import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
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
    include: ['**/*.test.ts', '**/*.test.tsx'],
  },
});
