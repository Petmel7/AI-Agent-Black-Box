import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
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
});
