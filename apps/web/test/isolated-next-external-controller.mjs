import { createIsolatedNextController } from './isolated-next-controller.mjs';

const [sourceWebRoot, host, rawPort] = process.argv.slice(2);
const port = Number(rawPort);
if (
  sourceWebRoot === undefined ||
  host !== '127.0.0.1' ||
  !Number.isSafeInteger(port) ||
  port <= 0 ||
  port > 65_535
)
  throw new Error('Invalid external-termination controller arguments.');

const controller = await createIsolatedNextController(sourceWebRoot);
const launch = await controller.launch({
  command: 'server',
  environment: process.env,
  mode: 'dev',
  port,
});
const baseUrl = `http://${host}:${port}`;
const deadline = Date.now() + 30_000;
while (Date.now() < deadline) {
  try {
    const response = await fetch(`${baseUrl}/health`);
    if (response.ok) break;
  } catch {
    // The isolated listener is not ready yet.
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}
if (Date.now() >= deadline)
  throw new Error(
    `Isolated Next server did not become ready.\n${launch.output()}`,
  );

process.stdout.write(
  `${JSON.stringify({
    ownerRoot: controller.ownerRoot,
    serverPid: launch.pid,
    workerPid: controller.workerPid,
    port,
  })}\n`,
);
setInterval(() => undefined, 60_000);
