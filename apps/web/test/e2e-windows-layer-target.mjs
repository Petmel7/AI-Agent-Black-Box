import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const fixturePath = fileURLToPath(
  new URL('./e2e-fixture-app.mjs', import.meta.url),
);
if (
  process.platform !== 'win32' ||
  process.env.BBX_E2E_INTERNAL_LAYER_TARGET_CONTEXT !==
    'bbx-e2e-layer-target-v1'
)
  throw new Error('Invalid Windows layer target context.');

let launched = false;
process.on('message', (message) => {
  if (launched || message?.type !== 'launch' || message.version !== 1) {
    process.exitCode = 1;
    process.disconnect();
    return;
  }
  launched = true;
  const descendant = spawn(
    process.execPath,
    [fixturePath, 'stubborn-stall', '43123'],
    { detached: false, stdio: 'ignore', windowsHide: true },
  );
  descendant.once('spawn', () =>
    process.send?.({
      type: 'ready',
      version: 1,
      descendantPid: descendant.pid,
    }),
  );
  descendant.once('error', () => process.exit(1));
});

await new Promise(() => undefined);
