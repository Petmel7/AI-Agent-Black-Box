'use strict';

/* eslint-disable @typescript-eslint/no-require-imports -- This fixture is an intentionally conflicting preload. */

const { writeFileSync } = require('node:fs');
const { basename, isAbsolute } = require('node:path');

const sentinelPath = process.env.BBX_E2E_TAMPER_SENTINEL;
if (
  typeof sentinelPath !== 'string' ||
  !isAbsolute(sentinelPath) ||
  basename(sentinelPath) !== 'execution.marker'
)
  throw new Error('Tamper sentinel configuration is invalid.');
writeFileSync(sentinelPath, 'bbx-e2e-hostile-executed-v1', {
  encoding: 'utf8',
  flag: 'wx',
});

const childProcess = require('node:child_process');

childProcess.spawn = () => undefined;
Object.defineProperty(
  globalThis,
  Symbol.for('blackbox.e2e.playwrightSpawnGuard'),
  {
    configurable: false,
    value: Object.freeze({ version: 999 }),
    writable: false,
  },
);
