import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const proxyPort = process.env.BBX_E2E_PROXY_PORT ?? '43121';
const serverPath = fileURLToPath(
  new URL('./test/e2e-server.mjs', import.meta.url),
);

function shellArgument(value) {
  if (/["\r\n]/.test(value))
    throw new Error('Invalid E2E server command path.');
  return `"${value}"`;
}

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: `http://127.0.0.1:${proxyPort}`,
    httpCredentials: {
      username: 'blackbox',
      password: process.env.BBX_E2E_DASHBOARD_TOKEN ?? '',
    },
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], browserName: 'chromium' },
    },
  ],
  webServer: {
    command: `${shellArgument(process.execPath)} ${shellArgument(serverPath)}`,
    url: `http://127.0.0.1:${proxyPort}/health`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
