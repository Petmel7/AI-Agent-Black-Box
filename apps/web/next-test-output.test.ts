import { describe, expect, it } from 'vitest';

import { createNextConfig } from './next.config';
import {
  resolveWebTestDistDir,
  webTestContextMarker,
} from './next-test-output';

const validDistDir = '.next/bbx-test-12345';
const invalidConfigurationMessage =
  'Invalid internal Web test output configuration.';

function controls(
  values: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    NODE_ENV: 'development',
    BBX_WEB_INTERNAL_TEST_CONTEXT: webTestContextMarker,
    BBX_WEB_TEST_DIST_DIR: validDistDir,
    ...values,
  };
}

describe('internal Next test output configuration', () => {
  it('uses the ordinary output for a normal production configuration', () => {
    expect(createNextConfig({ NODE_ENV: 'production' })).toEqual({
      output: 'standalone',
    });
  });

  it.each([
    {
      name: 'the distDir alone',
      environment: {
        NODE_ENV: 'production',
        BBX_WEB_TEST_DIST_DIR: validDistDir,
      },
    },
    {
      name: 'the context marker alone',
      environment: {
        NODE_ENV: 'production',
        BBX_WEB_INTERNAL_TEST_CONTEXT: webTestContextMarker,
      },
    },
    {
      name: 'both otherwise-valid controls',
      environment: controls({ NODE_ENV: 'production' }),
    },
  ])('rejects production with $name', ({ environment }) => {
    expect(() => createNextConfig(environment)).toThrowError(
      invalidConfigurationMessage,
    );
  });

  it.each([
    {
      name: 'a custom output without the marker',
      environment: controls({ BBX_WEB_INTERNAL_TEST_CONTEXT: undefined }),
    },
    {
      name: 'the marker without a custom output',
      environment: controls({ BBX_WEB_TEST_DIST_DIR: undefined }),
    },
    {
      name: 'both controls without an explicit non-production environment',
      environment: controls({ NODE_ENV: undefined }),
    },
  ])('rejects $name', ({ environment }) => {
    expect(() => resolveWebTestDistDir(environment)).toThrowError(
      invalidConfigurationMessage,
    );
  });

  it.each(['development', 'test'])(
    'selects the bounded direct child in an explicit %s test context',
    (nodeEnvironment) => {
      expect(createNextConfig(controls({ NODE_ENV: nodeEnvironment }))).toEqual(
        {
          output: 'standalone',
          distDir: validDistDir,
        },
      );
    },
  );

  it.each([
    ['POSIX absolute path', '/tmp/bbx-test-1'],
    ['Windows absolute path', String.raw`C:\temp\bbx-test-1`],
    ['parent traversal', '../.next/bbx-test-1'],
    ['nested parent traversal', '.next/../bbx-test-1'],
    ['additional separator', '.next/bbx-test-1/child'],
    ['Windows separator', String.raw`.next\bbx-test-1`],
    ['leading whitespace', ' .next/bbx-test-1'],
    ['trailing whitespace', '.next/bbx-test-1 '],
    ['zero ID', '.next/bbx-test-0'],
    ['leading-zero ID', '.next/bbx-test-01'],
    ['missing ID', '.next/bbx-test-'],
    ['non-numeric ID', '.next/bbx-test-one'],
    ['overlong ID', '.next/bbx-test-12345678901'],
    ['old top-level form', '.next-bbx-test-1'],
    ['duplicated value', '.next/bbx-test-1,.next/bbx-test-2'],
  ])('rejects %s', (_name, distDir) => {
    expect(() =>
      resolveWebTestDistDir(controls({ BBX_WEB_TEST_DIST_DIR: distDir })),
    ).toThrowError(invalidConfigurationMessage);
  });

  it.each([
    ['unexpected marker', 'next-server-harness-v1'],
    ['leading marker whitespace', ` ${webTestContextMarker}`],
    ['trailing marker whitespace', `${webTestContextMarker} `],
    ['duplicated marker', `${webTestContextMarker},${webTestContextMarker}`],
  ])('rejects an %s', (_name, context) => {
    expect(() =>
      resolveWebTestDistDir(
        controls({ BBX_WEB_INTERNAL_TEST_CONTEXT: context }),
      ),
    ).toThrowError(invalidConfigurationMessage);
  });
});
