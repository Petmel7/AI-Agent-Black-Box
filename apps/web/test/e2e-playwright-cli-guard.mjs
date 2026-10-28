import childProcess, { spawn as esmSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';

const GUARD_VERSION = 2;
const MARKER_NAME = 'BBX_E2E_PLAYWRIGHT_SPAWN_GUARD';
const MARKER_VALUE = 'bbx-e2e-playwright-spawn-guard-v2';
const AUTHORITY_NAME = 'BBX_E2E_LINUX_GROUP_AUTHORITY';
const TOKEN_NAME = 'BBX_E2E_OWNERSHIP_TOKEN';
const ACTIVE_SYMBOL = Symbol.for('blackbox.e2e.playwrightSpawnGuard');
const expectedPreload = await realpath(
  fileURLToPath(new URL('./e2e-playwright-spawn-guard.cjs', import.meta.url)),
);
const expectedNodeOptions = `--require=${JSON.stringify(expectedPreload)}`;
const expectedContextDigest = createHash('sha256')
  .update(String(process.env[AUTHORITY_NAME]), 'utf8')
  .update('\0', 'utf8')
  .update(String(process.env[TOKEN_NAME]), 'utf8')
  .digest('hex');
const descriptor = Object.getOwnPropertyDescriptor(globalThis, ACTIVE_SYMBOL);
const attestation = descriptor?.value;

if (
  process.platform !== 'linux' ||
  process.env[MARKER_NAME] !== MARKER_VALUE ||
  process.env.NODE_OPTIONS !== expectedNodeOptions ||
  process.execArgv.length !== 0 ||
  descriptor?.configurable !== false ||
  descriptor?.writable !== false ||
  !Object.isFrozen(attestation) ||
  attestation?.version !== GUARD_VERSION ||
  attestation.marker !== MARKER_VALUE ||
  attestation.preloadPath !== expectedPreload ||
  attestation.nodeOptions !== expectedNodeOptions ||
  attestation.contextDigest !== expectedContextDigest ||
  childProcess.spawn !== attestation.guardedSpawn ||
  esmSpawn !== attestation.guardedSpawn ||
  process.kill !== attestation.guardedKill ||
  Object.getOwnPropertyDescriptor(childProcess, 'spawn')?.writable !== false ||
  Object.getOwnPropertyDescriptor(childProcess, 'spawn')?.configurable !==
    false ||
  Object.getOwnPropertyDescriptor(process, 'kill')?.writable !== false ||
  Object.getOwnPropertyDescriptor(process, 'kill')?.configurable !== false
)
  throw new Error('Guarded Playwright CLI spawn attestation failed.');

const [playwrightCli, ...playwrightArguments] = process.argv.slice(2);
const expectedPlaywrightCli = fileURLToPath(
  new URL('../node_modules/@playwright/test/cli.js', import.meta.url),
);
if (typeof playwrightCli !== 'string')
  throw new Error('Guarded Playwright CLI entrypoint is invalid.');
if ((await realpath(playwrightCli)) !== (await realpath(expectedPlaywrightCli)))
  throw new Error('Guarded Playwright CLI entrypoint is invalid.');

// This is deliberately the first code-loading operation after final attestation.
process.argv = [process.execPath, playwrightCli, ...playwrightArguments];
await import(pathToFileURL(playwrightCli).href);
