'use strict';

/* eslint-disable @typescript-eslint/no-require-imports -- This fixture verifies the CommonJS preload boundary. */

const childProcess = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { readFileSync } = require('node:fs');

function identity(processId) {
  const stat = readFileSync(`/proc/${processId}/stat`, 'utf8');
  const fields = stat
    .slice(stat.lastIndexOf(')') + 2)
    .trim()
    .split(/\s+/);
  return { processGroupId: Number(fields[2]), sessionId: Number(fields[3]) };
}

const parent = identity(process.pid);
const token = randomBytes(32).toString('base64url');
process.env.BBX_E2E_OWNERSHIP_TOKEN = token;
process.env.BBX_E2E_LINUX_GROUP_AUTHORITY = JSON.stringify({
  version: 1,
  platform: 'linux',
  role: 'playwright',
  ownershipIdentity: {
    processGroupId: parent.processGroupId,
    sessionId: parent.sessionId,
    ownershipToken: token,
  },
});
process.env.BBX_E2E_PLAYWRIGHT_SPAWN_GUARD =
  'bbx-e2e-playwright-spawn-guard-v2';
process.env.NODE_OPTIONS = `--require=${JSON.stringify(
  require.resolve('./e2e-playwright-spawn-guard.cjs'),
)}`;
require('./e2e-playwright-spawn-guard.cjs');

function spawnAndCapture(spawn) {
  return new Promise((resolveCapture, rejectCapture) => {
    const child = spawn(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 1000)'],
      { detached: true, env: process.env, stdio: 'ignore' },
    );
    child.once('error', rejectCapture);
    child.once('spawn', () => {
      const childIdentity = identity(child.pid);
      process.kill(-child.pid, 'SIGTERM');
      child.once('exit', () => resolveCapture(childIdentity));
    });
  });
}

void (async () => {
  const commonJsChild = await spawnAndCapture(childProcess.spawn);
  const { spawn: esmSpawn } = await import('node:child_process');
  const esmChild = await spawnAndCapture(esmSpawn);
  process.stdout.write(JSON.stringify({ parent, commonJsChild, esmChild }));
})().catch((error) => {
  process.stderr.write(String(error?.stack ?? error));
  process.exitCode = 1;
});
