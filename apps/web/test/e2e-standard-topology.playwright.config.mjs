import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const serverPath = fileURLToPath(new URL('./e2e-server.mjs', import.meta.url));
const proxyPort = process.env.BBX_E2E_PROXY_PORT;
if (!/^[1-9][0-9]{3,4}$/.test(proxyPort ?? ''))
  throw new Error('Invalid standard-topology fixture port.');

function shellArgument(value) {
  if (/['"\r\n]/.test(value))
    throw new Error('Invalid standard-topology command path.');
  return `"${value}"`;
}

export default defineConfig({
  testDir: fileURLToPath(new URL('.', import.meta.url)),
  testMatch: '**/e2e-standard-topology.spec.mjs',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  use: {
    baseURL: `http://127.0.0.1:${proxyPort}`,
    trace: 'off',
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
    timeout: 20_000,
  },
});
