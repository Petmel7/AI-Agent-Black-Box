import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readLinuxProcessIdentity } from './e2e-process-control.mjs';
import {
  exactOwnedTempDirectory,
  removeExactOwnedTempDirectory,
} from './e2e-owned-process.mjs';

const fixtureApp = fileURLToPath(
  new URL('./e2e-fixture-app.mjs', import.meta.url),
);
const outputPath = process.env.BBX_E2E_OWNED_OUTPUT_DIR;
const port = Number(process.env.BBX_E2E_INTERNAL_CONTROLLER_PORT);
const mode = process.env.BBX_E2E_INTERNAL_CONTROLLER_MODE ?? 'hang';
if (
  process.env.BBX_E2E_INTERNAL_CONTROLLER_CONTEXT !==
    'bbx-e2e-controller-harness-v1' ||
  !outputPath ||
  !Number.isSafeInteger(port) ||
  port < 1024 ||
  ![
    'hang',
    'success',
    'failure',
    'signal',
    'already-absent',
    'root-exit',
    'uninstrumented-root-exit',
    'stubborn-hang',
    'stubborn-root-exit',
  ].includes(mode)
)
  throw new Error('Invalid E2E controller fixture configuration.');
exactOwnedTempDirectory(outputPath);

await mkdir(outputPath, { recursive: true });
await writeFile(join(outputPath, 'owned.txt'), 'owned');
if (mode === 'already-absent') {
  await removeExactOwnedTempDirectory(outputPath);
  process.exit(0);
}
if (mode === 'success') process.exit(0);
if (mode === 'failure') process.exit(17);
if (mode === 'signal') {
  process.kill(process.pid, 'SIGTERM');
  await new Promise(() => undefined);
}
const descendant = spawn(
  process.execPath,
  [
    fixtureApp,
    mode === 'stubborn-root-exit' || mode === 'stubborn-hang'
      ? 'stubborn-stall'
      : 'ready',
    String(port),
  ],
  { detached: false, stdio: 'inherit', windowsHide: true },
);
await new Promise((resolve, reject) => {
  descendant.once('spawn', resolve);
  descendant.once('error', reject);
});
const readinessDeadline = Date.now() + 5_000;
let descendantReady = false;
if (mode === 'stubborn-root-exit' || mode === 'stubborn-hang')
  descendantReady = true;
while (!descendantReady && Date.now() < readinessDeadline) {
  descendantReady = await new Promise((resolveReady) => {
    const probe = request(
      { host: '127.0.0.1', port, path: '/health', method: 'GET' },
      (response) => {
        response.resume();
        resolveReady(response.statusCode === 200);
      },
    );
    probe.setTimeout(250, () => probe.destroy());
    probe.once('error', () => resolveReady(false));
    probe.end();
  });
  if (!descendantReady)
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
}
if (!descendantReady) throw new Error('Controller fixture descendant timeout.');
const rootIdentity = readLinuxProcessIdentity(process.pid);
const descendantIdentity = readLinuxProcessIdentity(descendant.pid);
if (rootIdentity && descendantIdentity && mode !== 'uninstrumented-root-exit') {
  const ownershipToken = process.env.BBX_E2E_OWNERSHIP_TOKEN;
  if (!ownershipToken) throw new Error('Missing E2E ownership token.');
  await writeFile(
    join(outputPath, 'owned-members.json'),
    JSON.stringify([
      {
        processId: descendantIdentity.processId,
        processGroupId: descendantIdentity.processGroupId,
        sessionId: descendantIdentity.sessionId,
        startTime: descendantIdentity.startTime,
        tokenDigest: createHash('sha256').update(ownershipToken).digest('hex'),
      },
    ]),
    { encoding: 'utf8', flag: 'wx' },
  );
}
process.stdout.write(
  `BBX_E2E_PHASE controller-fixture-ready pid=${descendant.pid ?? 0}${
    rootIdentity && descendantIdentity
      ? ` ppid=${descendantIdentity.parentProcessId} pgid=${descendantIdentity.processGroupId} sid=${descendantIdentity.sessionId} root-pid=${rootIdentity.processId} root-ppid=${rootIdentity.parentProcessId} root-pgid=${rootIdentity.processGroupId} root-sid=${rootIdentity.sessionId}`
      : ''
  }\n`,
);
if (
  mode === 'root-exit' ||
  mode === 'uninstrumented-root-exit' ||
  mode === 'stubborn-root-exit'
)
  process.exit(0);
await new Promise(() => undefined);
