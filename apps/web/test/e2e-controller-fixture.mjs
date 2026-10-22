import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  !['hang', 'success', 'failure', 'signal', 'already-absent'].includes(mode)
)
  throw new Error('Invalid E2E controller fixture configuration.');

await mkdir(outputPath, { recursive: false });
await writeFile(join(outputPath, 'owned.txt'), 'owned');
if (mode === 'already-absent') {
  await rm(outputPath, { recursive: true, force: false });
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
  [fixtureApp, 'ready', String(port)],
  { detached: true, stdio: 'inherit', windowsHide: true },
);
process.stdout.write(
  `BBX_E2E_PHASE controller-fixture-ready pid=${descendant.pid ?? 0}\n`,
);
await new Promise(() => undefined);
