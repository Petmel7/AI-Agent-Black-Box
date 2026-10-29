import { mkdir, stat } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

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
    completeAfter: (
      resource: string,
      cleanup: (value: {
        authority: ReturnType<typeof fakeImporter>;
        entry: Entry;
      }) => Promise<void>,
    ) => Promise<{ alreadyCompleted: boolean }>;
    state: (
      resource: string,
    ) => 'planned' | 'accepted' | 'completing' | 'completed';
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

function accept(
  registry: ReturnType<typeof createParentResourceRegistry>,
  entry: Entry,
  processId: number,
) {
  return registry.accept(
    {
      type: 'owned-resource-authority',
      version: 1,
      resource: entry.resource,
      resourceId: entry.resourceId,
      authority: { metadataDirectory: entry.metadataDirectory, processId },
    },
    entry.resource,
  );
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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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

      await firstRegistry.completeAfter('playwright', async () => {
        await removeExactOwnedTempDirectory(first.metadataDirectory);
      });
      await secondRegistry.completeAfter('playwright', async () => {
        await removeExactOwnedTempDirectory(second.metadataDirectory);
      });
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

  it('keeps a failed cleanup accepted and retryable until exact completion', async () => {
    const plan = createParentResourcePlan(['playwright']);
    const entry = plan.get('playwright')!;
    const registry = createParentResourceRegistry(plan, fakeImporter);
    accept(registry, entry, 123);
    expect(registry.state('playwright')).toBe('accepted');

    await expect(
      registry.completeAfter('playwright', async () => {
        throw new Error('authority cleanup failed');
      }),
    ).rejects.toThrow('authority cleanup failed');
    expect(registry.state('playwright')).toBe('accepted');

    await expect(
      registry.completeAfter('playwright', async () => undefined),
    ).resolves.toEqual({ alreadyCompleted: false });
    expect(registry.state('playwright')).toBe('completed');
  });

  it('skips an already completed exact resource while retrying an incomplete peer', async () => {
    const plan = createParentResourcePlan(['playwright', 'playwright-owner']);
    const playwright = plan.get('playwright')!;
    const owner = plan.get('playwright-owner')!;
    const registry = createParentResourceRegistry(plan, fakeImporter);
    accept(registry, playwright, 123);
    accept(registry, owner, 124);
    const playwrightCleanup = vi.fn(async () => undefined);
    const ownerCleanup = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('owner cleanup failed'))
      .mockResolvedValue(undefined);

    await expect(
      registry.completeAfter('playwright', playwrightCleanup),
    ).resolves.toEqual({ alreadyCompleted: false });
    await expect(
      registry.completeAfter('playwright-owner', ownerCleanup),
    ).rejects.toThrow('owner cleanup failed');
    expect(registry.state('playwright')).toBe('completed');
    expect(registry.state('playwright-owner')).toBe('accepted');

    await expect(
      registry.completeAfter('playwright', playwrightCleanup),
    ).resolves.toEqual({ alreadyCompleted: true });
    await expect(
      registry.completeAfter('playwright-owner', ownerCleanup),
    ).resolves.toEqual({ alreadyCompleted: false });
    expect(playwrightCleanup).toHaveBeenCalledOnce();
    expect(ownerCleanup).toHaveBeenCalledTimes(2);
  });

  it('does not mark metadata complete while the exact path remains', async () => {
    const plan = createParentResourcePlan(['playwright']);
    const entry = plan.get('playwright')!;
    const registry = createParentResourceRegistry(plan, fakeImporter);
    accept(registry, entry, 123);
    await mkdir(entry.metadataDirectory, { recursive: false });
    try {
      await expect(
        registry.completeAfter('playwright', async () => {
          if (await exists(entry.metadataDirectory))
            throw new Error('metadata still present');
        }),
      ).rejects.toThrow('metadata still present');
      expect(registry.state('playwright')).toBe('accepted');
      await removeExactOwnedTempDirectory(entry.metadataDirectory);
      await expect(
        registry.completeAfter('playwright', async () => {
          expect(await exists(entry.metadataDirectory)).toBe(false);
        }),
      ).resolves.toEqual({ alreadyCompleted: false });
    } finally {
      if (await exists(entry.metadataDirectory))
        await removeExactOwnedTempDirectory(entry.metadataDirectory);
    }
  });

  it('keeps repeated converged cleanup idempotent without touching another resource', async () => {
    const plan = createParentResourcePlan(['playwright']);
    const unrelatedPlan = createParentResourcePlan(['playwright']);
    const entry = plan.get('playwright')!;
    const unrelated = unrelatedPlan.get('playwright')!;
    const registry = createParentResourceRegistry(plan, fakeImporter);
    accept(registry, entry, 123);
    await mkdir(unrelated.metadataDirectory, { recursive: false });
    const cleanup = vi.fn(async () => undefined);
    try {
      await expect(
        registry.completeAfter('playwright', cleanup),
      ).resolves.toEqual({ alreadyCompleted: false });
      for (let index = 0; index < 3; index += 1)
        await expect(
          registry.completeAfter('playwright', cleanup),
        ).resolves.toEqual({ alreadyCompleted: true });
      expect(cleanup).toHaveBeenCalledOnce();
      expect(await exists(unrelated.metadataDirectory)).toBe(true);
    } finally {
      await removeExactOwnedTempDirectory(unrelated.metadataDirectory);
    }
  });

  it('runs exactly one cleanup and rejects a concurrent completion immediately', async () => {
    const plan = createParentResourcePlan(['playwright']);
    const entry = plan.get('playwright')!;
    const registry = createParentResourceRegistry(plan, fakeImporter);
    accept(registry, entry, 123);
    const started = deferred();
    const release = deferred();
    const cleanup = vi.fn(async () => {
      started.resolve();
      await release.promise;
    });

    const first = registry.completeAfter('playwright', cleanup);
    await started.promise;
    expect(registry.state('playwright')).toBe('completing');
    await expect(registry.completeAfter('playwright', cleanup)).rejects.toThrow(
      'E2E resource completion is already in progress.',
    );
    expect(cleanup).toHaveBeenCalledOnce();
    release.resolve();
    await expect(first).resolves.toEqual({ alreadyCompleted: false });
    expect(registry.state('playwright')).toBe('completed');
  });

  it('fails re-entrant completion without deadlock and restores accepted after outer failure', async () => {
    const plan = createParentResourcePlan(['playwright']);
    const entry = plan.get('playwright')!;
    const registry = createParentResourceRegistry(plan, fakeImporter);
    accept(registry, entry, 123);
    const outerFailure = new Error('outer cleanup failed');
    const nestedCleanup = vi.fn(async () => undefined);

    await expect(
      registry.completeAfter('playwright', async () => {
        await expect(
          registry.completeAfter('playwright', nestedCleanup),
        ).rejects.toThrow('E2E resource completion is already in progress.');
        throw outerFailure;
      }),
    ).rejects.toBe(outerFailure);
    expect(nestedCleanup).not.toHaveBeenCalled();
    expect(registry.state('playwright')).toBe('accepted');

    await expect(
      registry.completeAfter('playwright', async () => undefined),
    ).resolves.toEqual({ alreadyCompleted: false });
    expect(registry.state('playwright')).toBe('completed');
  });

  it('has no direct completion API or planned-to-completed shortcut', async () => {
    const plan = createParentResourcePlan(['playwright']);
    const registry = createParentResourceRegistry(plan, fakeImporter);
    const cleanup = vi.fn(async () => undefined);

    expect('complete' in registry).toBe(false);
    await expect(registry.completeAfter('playwright', cleanup)).rejects.toThrow(
      'Invalid completed E2E resource identity.',
    );
    expect(cleanup).not.toHaveBeenCalled();
    expect(registry.state('playwright')).toBe('planned');
  });
});
