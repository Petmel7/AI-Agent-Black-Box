const MAX_TEST_OUTPUT_ID = 9_999_999_999n;

export const maximumHarnessProcessId = Number((MAX_TEST_OUTPUT_ID - 1n) / 2n);

export interface HarnessTestOutputOwnership {
  cleanupDistDirs: readonly [string, string];
  primaryDistDir: string;
  productionProbeDistDir: string;
}

export function createHarnessTestOutputOwnership(
  processId: number,
): HarnessTestOutputOwnership {
  if (!Number.isSafeInteger(processId) || processId <= 0)
    throw new Error('Invalid real-Next harness process ID.');

  const processIdBigInt = BigInt(processId);
  const primaryId = 2n * processIdBigInt;
  const productionProbeId = primaryId + 1n;
  if (productionProbeId > MAX_TEST_OUTPUT_ID)
    throw new Error('Invalid real-Next harness process ID.');

  const primaryDistDir = `.next/bbx-test-${primaryId}`;
  const productionProbeDistDir = `.next/bbx-test-${productionProbeId}`;
  return {
    primaryDistDir,
    productionProbeDistDir,
    cleanupDistDirs: [primaryDistDir, productionProbeDistDir],
  };
}
