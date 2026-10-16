import { describe, expect, it } from 'vitest';

import {
  createHarnessTestOutputOwnership,
  maximumHarnessProcessId,
} from './next-test-output-ownership';

describe('real-Next harness output ownership', () => {
  it('keeps all four roles distinct for reviewer PIDs 123 and 1231', () => {
    const first = createHarnessTestOutputOwnership(123);
    const second = createHarnessTestOutputOwnership(1231);

    expect(first).toEqual({
      primaryDistDir: '.next/bbx-test-246',
      productionProbeDistDir: '.next/bbx-test-247',
      cleanupDistDirs: ['.next/bbx-test-246', '.next/bbx-test-247'],
    });
    expect(second).toEqual({
      primaryDistDir: '.next/bbx-test-2462',
      productionProbeDistDir: '.next/bbx-test-2463',
      cleanupDistDirs: ['.next/bbx-test-2462', '.next/bbx-test-2463'],
    });
    expect(
      new Set([
        first.primaryDistDir,
        first.productionProbeDistDir,
        second.primaryDistDir,
        second.productionProbeDistDir,
      ]).size,
    ).toBe(4);
  });

  it('partitions primary and probe roles across representative process IDs', () => {
    const processIds = [1, 2, 3, 123, 1231, 65_535, maximumHarnessProcessId];
    const ownership = processIds.map(createHarnessTestOutputOwnership);
    const primaryPaths = ownership.map(({ primaryDistDir }) => primaryDistDir);
    const probePaths = ownership.map(
      ({ productionProbeDistDir }) => productionProbeDistDir,
    );

    expect(new Set(primaryPaths).size).toBe(processIds.length);
    expect(new Set(probePaths).size).toBe(processIds.length);
    expect(primaryPaths.every((path) => !probePaths.includes(path))).toBe(true);
    expect(new Set([...primaryPaths, ...probePaths]).size).toBe(
      processIds.length * 2,
    );
  });

  it('maps the minimum and maximum supported process IDs within ten digits', () => {
    expect(createHarnessTestOutputOwnership(1)).toEqual({
      primaryDistDir: '.next/bbx-test-2',
      productionProbeDistDir: '.next/bbx-test-3',
      cleanupDistDirs: ['.next/bbx-test-2', '.next/bbx-test-3'],
    });
    expect(createHarnessTestOutputOwnership(maximumHarnessProcessId)).toEqual({
      primaryDistDir: '.next/bbx-test-9999999998',
      productionProbeDistDir: '.next/bbx-test-9999999999',
      cleanupDistDirs: [
        '.next/bbx-test-9999999998',
        '.next/bbx-test-9999999999',
      ],
    });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid process ID %s before returning filesystem targets',
    (processId) => {
      expect(() => createHarnessTestOutputOwnership(processId)).toThrowError(
        'Invalid real-Next harness process ID.',
      );
    },
  );

  it('rejects an ID that cannot fit the bounded grammar before returning filesystem targets', () => {
    expect(() =>
      createHarnessTestOutputOwnership(maximumHarnessProcessId + 1),
    ).toThrowError('Invalid real-Next harness process ID.');
  });

  it('returns only the two exact cleanup targets owned by each process', () => {
    const first = createHarnessTestOutputOwnership(123);
    const second = createHarnessTestOutputOwnership(1231);

    expect(first.cleanupDistDirs).toEqual([
      first.primaryDistDir,
      first.productionProbeDistDir,
    ]);
    expect(second.cleanupDistDirs).toEqual([
      second.primaryDistDir,
      second.productionProbeDistDir,
    ]);
    expect(
      first.cleanupDistDirs.some((path) =>
        second.cleanupDistDirs.includes(path),
      ),
    ).toBe(false);
  });
});
