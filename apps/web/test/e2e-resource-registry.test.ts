import { mkdir, stat } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

// @ts-expect-error -- this Node-owned test helper intentionally executes as ESM.
import { removeExactOwnedTempDirectory } from './e2e-owned-process.mjs';
// @ts-expect-error -- this Node-owned test helper intentionally executes as ESM.
import * as resourceRegistryModule from './e2e-resource-registry.mjs';

type Entry = {
  metadataDirectory: string;
  resource: string;
  resourceId: string;
};
type Plan = Map<string, Entry>;

const {
  createParentResourcePlan,
  createParentResourceRegistry,
  parseParentResourcePlan,
  serializeParentResourcePlan,
} = resourceRegistryModule as unknown as {
  createParentResourcePlan: (resources: string[]) => Plan;
  createParentResourceRegistry: (
    plan: Plan,
    importer: typeof fakeImporter,
  ) => {
    accept: (
      candidate: unknown,
      expectedRole: string,
    ) => ReturnType<typeof fakeImporter>;
    complete: (resource: string) => void;
  };
  parseParentResourcePlan: (value: string, resources: string[]) => Plan;
  serializeParentResourcePlan: (plan: Plan) => string;
};

function fakeImporter(
  authority: { metadataDirectory?: string; processId?: number },
  expected: { metadataDirectory: string; role: string },
) {
  if (
    authority?.metadataDirectory !== expected.metadataDirectory ||
    !Number.isSafeInteger(authority.processId) ||
    authority.processId! < 1
  )
    throw new Error('Invalid fake cleanup authority.');
  return Object.freeze({ ...authority, role: expected.role });
}

async function exists(path: string) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

describe('parent-generated E2E resource identities', () => {
  it('round-trips only exact role-bound high-entropy identities', () => {
    const plan = createParentResourcePlan(['playwright', 'playwright-owner']);
    const parsed = parseParentResourcePlan(serializeParentResourcePlan(plan), [
      'playwright',
      'playwright-owner',
    ]);

    for (const resource of ['playwright', 'playwright-owner']) {
      const entry = parsed.get(resource) as Entry;
      expect(entry.resource).toBe(resource);
      expect(entry.resourceId).toMatch(/^[a-f0-9]{48}$/);
      expect(entry.metadataDirectory).toContain(
        `bbx-e2e-${resource}-${entry.resourceId}`,
      );
    }
    expect(parsed.get('playwright')!.resourceId).not.toBe(
      parsed.get('playwright-owner')!.resourceId,
    );
  });

  it('rejects a concurrent run identity/path spoof without deleting either resource', async () => {
    const firstPlan = createParentResourcePlan(['playwright']);
    const secondPlan = createParentResourcePlan(['playwright']);
    const first = firstPlan.get('playwright') as Entry;
    const second = secondPlan.get('playwright') as Entry;
    const firstRegistry = createParentResourceRegistry(firstPlan, fakeImporter);
    const secondRegistry = createParentResourceRegistry(
      secondPlan,
      fakeImporter,
    );
    await mkdir(first.metadataDirectory, { recursive: false });
    await mkdir(second.metadataDirectory, { recursive: false });
    try {
      expect(() =>
        firstRegistry.accept(
          {
            type: 'owned-resource-authority',
            version: 1,
            resource: 'playwright',
            resourceId: second.resourceId,
            layerProcessId: 1231,
            authority: {
              metadataDirectory: second.metadataDirectory,
              processId: 1231,
            },
          },
          'playwright',
        ),
      ).toThrow('Invalid registered E2E resource authority.');
      expect(await exists(first.metadataDirectory)).toBe(true);
      expect(await exists(second.metadataDirectory)).toBe(true);

      for (const [registry, entry, processId] of [
        [firstRegistry, first, 123],
        [secondRegistry, second, 1231],
      ] as const) {
        expect(
          registry.accept(
            {
              type: 'owned-resource-authority',
              version: 1,
              resource: 'playwright',
              resourceId: entry.resourceId,
              layerProcessId: processId,
              authority: {
                metadataDirectory: entry.metadataDirectory,
                processId,
              },
            },
            'playwright',
          ),
        ).toMatchObject({
          metadataDirectory: entry.metadataDirectory,
          processId,
        });
      }

      await removeExactOwnedTempDirectory(first.metadataDirectory);
      firstRegistry.complete('playwright');
      await removeExactOwnedTempDirectory(second.metadataDirectory);
      secondRegistry.complete('playwright');
      expect(await exists(first.metadataDirectory)).toBe(false);
      expect(await exists(second.metadataDirectory)).toBe(false);
      expect(() =>
        firstRegistry.accept(
          {
            version: 1,
            resource: 'playwright',
            resourceId: first.resourceId,
            authority: {
              metadataDirectory: first.metadataDirectory,
              processId: 123,
            },
          },
          'playwright',
        ),
      ).toThrow('Invalid registered E2E resource authority.');
    } finally {
      if (await exists(first.metadataDirectory))
        await removeExactOwnedTempDirectory(first.metadataDirectory);
      if (await exists(second.metadataDirectory))
        await removeExactOwnedTempDirectory(second.metadataDirectory);
    }
  });

  it('rejects malformed, partial, duplicated, or unexpected plans', () => {
    const plan = createParentResourcePlan(['playwright']);
    const serialized = serializeParentResourcePlan(plan);
    const resourceId = plan.get('playwright')!.resourceId;
    expect(() =>
      parseParentResourcePlan(serialized, ['server-application']),
    ).toThrow();
    expect(() =>
      parseParentResourcePlan(
        JSON.stringify({
          playwright: resourceId,
          'playwright-owner': resourceId,
        }),
        ['playwright', 'playwright-owner'],
      ),
    ).toThrow();
    expect(() =>
      parseParentResourcePlan(
        JSON.stringify({ playwright: resourceId, unexpected: resourceId }),
        ['playwright'],
      ),
    ).toThrow();
  });
});
