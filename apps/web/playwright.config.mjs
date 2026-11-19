import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';

import {
  environmentForRunConfiguration,
  runConfigurationFromEnvironment,
} from './test/e2e-controller.mjs';

const configuration = runConfigurationFromEnvironment(process.env);
const serverPath = fileURLToPath(
  new URL('./test/e2e-server.mjs', import.meta.url),
);
const childEnvironment = environmentForRunConfiguration(
  process.env,
  configuration,
);

function shellArgument(value) {
  if (/["\r\n]/.test(value))
    throw new Error('Invalid E2E server command path.');
  return `"${value}"`;
}

export default defineConfig({
  testDir: './e2e',
  outputDir: configuration.outputPath,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: [
    ['html', { outputFolder: configuration.reportPath, open: 'never' }],
  ],
  use: {
    baseURL: `http://127.0.0.1:${configuration.proxyPort}`,
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
    env: childEnvironment,
    url: `http://127.0.0.1:${configuration.proxyPort}/health`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
