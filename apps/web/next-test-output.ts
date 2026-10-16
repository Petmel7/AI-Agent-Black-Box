const INTERNAL_TEST_CONTEXT = 'bbx-next-server-harness-v1';
const TEST_DIST_DIR_PATTERN = /^\.next\/bbx-test-[1-9][0-9]{0,9}$/;
const GENERIC_TEST_CONFIGURATION_ERROR =
  'Invalid internal Web test output configuration.';

export const webTestContextMarker = INTERNAL_TEST_CONTEXT;

export function resolveWebTestDistDir(
  environment: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const nodeEnvironment = environment.NODE_ENV;
  const context = environment.BBX_WEB_INTERNAL_TEST_CONTEXT;
  const distDir = environment.BBX_WEB_TEST_DIST_DIR;
  const hasTestControl = context !== undefined || distDir !== undefined;

  if (nodeEnvironment === 'production' && hasTestControl)
    throw new Error(GENERIC_TEST_CONFIGURATION_ERROR);

  if (!hasTestControl) return undefined;

  if (
    (nodeEnvironment !== 'development' && nodeEnvironment !== 'test') ||
    context !== INTERNAL_TEST_CONTEXT ||
    distDir === undefined ||
    !TEST_DIST_DIR_PATTERN.test(distDir)
  )
    throw new Error(GENERIC_TEST_CONFIGURATION_ERROR);

  return distDir;
}
