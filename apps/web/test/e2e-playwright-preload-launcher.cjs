'use strict';

/* eslint-disable @typescript-eslint/no-require-imports -- This launcher creates a fresh Linux session before the guarded child starts. */

const { randomBytes } = require('node:crypto');
const { existsSync, readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const guardPath = require.resolve('./e2e-playwright-spawn-guard.cjs');
const targetPath = require.resolve('./e2e-playwright-preload-target.cjs');
const wrapperPath = resolve(__dirname, 'e2e-playwright-cli-guard.mjs');
const tamperLoaderPath = resolve(__dirname, 'e2e-playwright-tamper-loader.mjs');
const tamperPreloadPath =
  require.resolve('./e2e-playwright-tamper-preload.cjs');
const playwrightCli = resolve(
  __dirname,
  '../node_modules/@playwright/test/cli.js',
);
const pinnedLauncher = resolve(
  __dirname,
  '../../../node_modules/.pnpm/playwright-core@1.51.1/node_modules/playwright-core/lib/server/utils/processLauncher.js',
);

function identity() {
  const stat = readFileSync('/proc/self/stat', 'utf8');
  const fields = stat
    .slice(stat.lastIndexOf(')') + 2)
    .trim()
    .split(/\s+/);
  return { processGroupId: Number(fields[2]), sessionId: Number(fields[3]) };
}

const mode = process.argv[2];
const vulnerableModes = new Set([
  'vulnerable-tamper-commonjs-spawn',
  'vulnerable-tamper-esm-spawn',
  'vulnerable-tamper-process-kill',
  'vulnerable-loader',
  'vulnerable-preload',
]);
const guardedInvalidModes = new Set([
  'alternate-require',
  'alternate-before',
  'alternate-after',
  'import-before',
  'import-after',
  'loader',
  'experimental-loader',
]);
const vulnerable = vulnerableModes.has(mode);
const canonical = `--require=${JSON.stringify(guardPath)}`;
const baseEnvironment = { ...process.env };
if (vulnerable) {
  delete baseEnvironment.BBX_E2E_LINUX_GROUP_AUTHORITY;
  delete baseEnvironment.BBX_E2E_OWNERSHIP_TOKEN;
  delete baseEnvironment.BBX_E2E_PLAYWRIGHT_SPAWN_GUARD;
  delete baseEnvironment.BBX_E2E_PINNED_LAUNCHER;
  delete baseEnvironment.NODE_OPTIONS;
} else {
  const current = identity();
  if (
    current.processGroupId !== process.pid ||
    current.sessionId !== process.pid
  )
    throw new Error('Preload probe launcher does not own its Linux session.');
  const token = randomBytes(32).toString('base64url');
  Object.assign(baseEnvironment, {
    BBX_E2E_LINUX_GROUP_AUTHORITY: JSON.stringify({
      version: 1,
      platform: 'linux',
      role: 'playwright',
      ownershipIdentity: {
        processGroupId: current.processGroupId,
        sessionId: current.sessionId,
        ownershipToken: token,
      },
    }),
    BBX_E2E_OWNERSHIP_TOKEN: token,
    BBX_E2E_PLAYWRIGHT_SPAWN_GUARD: 'bbx-e2e-playwright-spawn-guard-v2',
    BBX_E2E_PINNED_LAUNCHER: pinnedLauncher,
    NODE_OPTIONS: canonical,
  });
}

let arguments_ = [targetPath, 'attest'];
const environment = { ...baseEnvironment };
if (mode === 'canonical') arguments_ = [targetPath, 'attest'];
else if (mode === 'worker') arguments_ = [targetPath, 'worker-parent'];
else if (mode === 'pinned-launcher') arguments_ = [targetPath, mode];
else if (mode === 'wrapper')
  arguments_ = [wrapperPath, playwrightCli, '--version'];
else if (mode === 'missing') {
  delete environment.NODE_OPTIONS;
  delete environment.BBX_E2E_PLAYWRIGHT_SPAWN_GUARD;
  delete environment.BBX_E2E_LINUX_GROUP_AUTHORITY;
  delete environment.BBX_E2E_OWNERSHIP_TOKEN;
  arguments_ = [wrapperPath, playwrightCli, '--version'];
} else if (mode === 'marker-only') {
  delete environment.NODE_OPTIONS;
  arguments_ = [wrapperPath, playwrightCli, '--version'];
} else if (mode === 'duplicate')
  environment.NODE_OPTIONS = `${canonical} ${canonical}`;
else if (guardedInvalidModes.has(mode)) {
  environment.BBX_E2E_INVALID_LAUNCH_MODE = mode;
  environment.BBX_E2E_TAMPER_LOADER = pathToFileURL(tamperLoaderPath).href;
  environment.BBX_E2E_TAMPER_PRELOAD = tamperPreloadPath;
  arguments_ = [targetPath, 'invalid-launch'];
} else if (mode === 'relative')
  environment.NODE_OPTIONS = '--require=./test/e2e-playwright-spawn-guard.cjs';
else if (mode === 'marker-forgery') {
  delete environment.NODE_OPTIONS;
  arguments_ = [
    '-e',
    `globalThis[Symbol.for('blackbox.e2e.playwrightSpawnGuard')] = Object.freeze({version:2}); import(${JSON.stringify(wrapperPath)});`,
  ];
} else if (
  ['tamper-commonjs-spawn', 'tamper-esm-spawn', 'tamper-process-kill'].includes(
    mode,
  )
)
  arguments_ = [targetPath, mode];
else if (mode === 'vulnerable-tamper-commonjs-spawn')
  arguments_ = [targetPath, 'tamper-commonjs-spawn'];
else if (mode === 'vulnerable-tamper-esm-spawn')
  arguments_ = [targetPath, 'tamper-esm-spawn'];
else if (mode === 'vulnerable-tamper-process-kill')
  arguments_ = [targetPath, 'tamper-process-kill'];
else if (mode === 'vulnerable-loader') {
  environment.NODE_OPTIONS = `--import=${JSON.stringify(pathToFileURL(tamperLoaderPath).href)}`;
  arguments_ = ['-e', "process.stdout.write('vulnerable-child-complete')"];
} else if (mode === 'vulnerable-preload') {
  environment.NODE_OPTIONS = `--require=${JSON.stringify(tamperPreloadPath)}`;
  arguments_ = ['-e', "process.stdout.write('vulnerable-child-complete')"];
} else throw new Error('Unknown preload launcher mode.');

const result = spawnSync(process.execPath, arguments_, {
  cwd: resolve(__dirname, '..'),
  encoding: 'utf8',
  env: environment,
  timeout: 30_000,
});
const sentinelPath = process.env.BBX_E2E_TAMPER_SENTINEL;
const sentinelCreated =
  typeof sentinelPath === 'string' && existsSync(sentinelPath);
const sentinelMarkerValid =
  sentinelCreated &&
  readFileSync(sentinelPath, 'utf8') === 'bbx-e2e-hostile-executed-v1';
process.stdout.write(
  JSON.stringify({
    errorCode:
      typeof result.error?.code === 'string' ? result.error.code : null,
    signal: result.signal,
    status: result.status,
    stderrLength: result.stderr?.length ?? 0,
    stdout: result.stdout?.trim() ?? '',
    sentinelCreated,
    sentinelMarkerValid,
  }),
);
