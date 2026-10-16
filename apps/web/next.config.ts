import type { NextConfig } from 'next';

import { resolveWebTestDistDir } from './next-test-output';

export function createNextConfig(
  environment: Readonly<Record<string, string | undefined>>,
): NextConfig {
  const testDistDir = resolveWebTestDistDir(environment);
  return {
    output: 'standalone',
    ...(testDistDir === undefined ? {} : { distDir: testDistDir }),
  };
}

export default createNextConfig(process.env);
