import { expect, test } from '@playwright/test';

test('keeps the actual Playwright web-server topology alive for guardian cleanup', async ({
  page,
}) => {
  if (process.platform === 'linux') {
    const attestation =
      globalThis[Symbol.for('blackbox.e2e.playwrightSpawnGuard')];
    expect(Object.isFrozen(attestation)).toBe(true);
    expect(attestation?.version).toBe(2);
  }
  const response = await page.goto('/health');
  expect(response?.status()).toBe(200);
  await new Promise(() => undefined);
});
