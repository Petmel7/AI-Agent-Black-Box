import { mkdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';

import {
  INTERNAL_CONTROLLER_MARKER,
  runConfigurationFromEnvironment,
} from './e2e-controller.mjs';

const mode = process.env.BBX_E2E_INTERNAL_FIXTURE_MODE ?? 'hang';
if (
  process.env.BBX_E2E_INTERNAL_CONTROLLER_CONTEXT !==
    INTERNAL_CONTROLLER_MARKER ||
  ![
    'hang',
    'ignore-shutdown',
    'success',
    'failure',
    'signal',
    'already-absent',
  ].includes(mode)
)
  throw new Error(
    'Invalid authenticated E2E controller fixture configuration.',
  );

const configuration = runConfigurationFromEnvironment(process.env);
if (!Object.isFrozen(configuration))
  throw new Error('Fixture received mutable E2E configuration.');

await mkdir(configuration.runRoot, { recursive: false });
await mkdir(configuration.outputPath, { recursive: false });
await mkdir(configuration.reportPath, { recursive: false });
await writeFile(
  `${configuration.outputPath}/fixture-configuration.json`,
  `${JSON.stringify(configuration)}\n`,
  { flag: 'wx' },
);

if (mode === 'already-absent') {
  await rm(configuration.outputPath, { recursive: true, force: false });
  await rm(configuration.reportPath, { recursive: true, force: false });
  await rmdir(configuration.runRoot);
  process.exit(0);
}
if (mode === 'success') process.exit(0);
if (mode === 'failure') process.exit(17);
if (mode === 'signal') {
  process.kill(process.pid, 'SIGTERM');
  await new Promise(() => undefined);
}

function listen(port) {
  const server = createServer((socket) => socket.end());
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () =>
      resolvePromise(server),
    );
  });
}

const appServer = await listen(configuration.appPort);
const proxyServer = await listen(configuration.proxyPort);
process.stdout.write(
  `BBX_E2E_PHASE controller-fixture-ready app-port=${configuration.appPort} proxy-port=${configuration.proxyPort}\n`,
);

function close(server) {
  return new Promise((resolvePromise, reject) =>
    server.close((error) =>
      error ? reject(error) : resolvePromise(undefined),
    ),
  );
}

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await Promise.all([close(appServer), close(proxyServer)]);
  process.exit(0);
}

process.on('message', (message) => {
  if (message?.type === 'shutdown' && mode !== 'ignore-shutdown')
    void shutdown();
});
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => void shutdown());
