import { spawn, spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, rm, symlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

const WORKSPACE_PREFIX = 'bbx-harness-';
const EXCLUDED_SOURCE_ENTRIES = new Set([
  '.next',
  'node_modules',
  'playwright-report',
  'test-results',
]);

const configuredSourceWebRoot = process.env.BBX_ISOLATED_NEXT_SOURCE_ROOT;
if (
  configuredSourceWebRoot === undefined ||
  !isAbsolute(configuredSourceWebRoot)
)
  throw new Error('Invalid isolated Next source root.');
const sourceWebRoot = resolve(configuredSourceWebRoot);
const workspaceParent = join(sourceWebRoot, '.next');

/** @type {Map<string, import('node:child_process').ChildProcess>} */
const children = new Map();
let ownerRoot;
let webRoot;
let shuttingDown;

function send(message) {
  if (process.connected) process.send?.(message);
}

function isOwnedWorkspace(path) {
  return (
    isAbsolute(path) &&
    dirname(path) === workspaceParent &&
    new RegExp(`^${WORKSPACE_PREFIX}[A-Za-z0-9_-]{6}$`).test(basename(path))
  );
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise((resolveExit) => child.once('exit', resolveExit)),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error('Owned Next process did not exit.')),
        timeoutMs,
      ),
    ),
  ]);
}

async function terminateOwnedProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } else {
    child.kill('SIGTERM');
  }
  try {
    await waitForExit(child, 5_000);
  } catch {
    child.kill('SIGKILL');
    await waitForExit(child, 5_000).catch(() => undefined);
  }
}

async function cleanup() {
  if (shuttingDown !== undefined) return shuttingDown;
  shuttingDown = (async () => {
    await Promise.all([...children.values()].map(terminateOwnedProcess));
    children.clear();
    if (ownerRoot !== undefined) {
      if (!isOwnedWorkspace(ownerRoot))
        throw new Error(
          'Refusing to remove an invalid isolated Next workspace.',
        );
      await rm(ownerRoot, {
        force: true,
        maxRetries: 20,
        recursive: true,
        retryDelay: 100,
      });
    }
  })();
  return shuttingDown;
}

async function initialize() {
  await mkdir(workspaceParent, { recursive: true });
  ownerRoot = await mkdtemp(join(workspaceParent, WORKSPACE_PREFIX));
  if (!isOwnedWorkspace(ownerRoot))
    throw new Error('Invalid isolated Next workspace ownership.');
  webRoot = join(ownerRoot, 'web');
  await mkdir(webRoot);
  const sourceEntries = await readdir(sourceWebRoot, { withFileTypes: true });
  await Promise.all(
    sourceEntries
      .filter(({ name }) => !EXCLUDED_SOURCE_ENTRIES.has(name))
      .map(({ name }) =>
        cp(join(sourceWebRoot, name), join(webRoot, name), { recursive: true }),
      ),
  );
  await symlink(
    join(sourceWebRoot, 'node_modules'),
    join(webRoot, 'node_modules'),
    'junction',
  );
  send({ type: 'ready', ownerRoot, webRoot, workerPid: process.pid });
}

function launch(message) {
  if (shuttingDown !== undefined || webRoot === undefined) return;
  const launchId = message.launchId;
  if (typeof launchId !== 'string' || children.has(launchId))
    throw new Error('Invalid isolated Next launch identity.');
  const executable = process.execPath;
  const nextBin = join(webRoot, 'node_modules', 'next', 'dist', 'bin', 'next');
  const launcher = join(webRoot, 'scripts', 'dashboard-next.mjs');
  const arguments_ =
    message.command === 'build'
      ? [nextBin, 'build']
      : [
          launcher,
          message.mode,
          '--port',
          String(message.port),
          ...message.nextArguments,
        ];
  const child = spawn(executable, arguments_, {
    cwd: webRoot,
    env: message.environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  children.set(launchId, child);
  send({ type: 'launched', launchId, pid: child.pid });
  const output = (stream, chunk) =>
    send({ type: 'output', launchId, stream, value: String(chunk) });
  child.stdout?.on('data', (chunk) => output('stdout', chunk));
  child.stderr?.on('data', (chunk) => output('stderr', chunk));
  child.once('error', (error) =>
    send({ type: 'launch-error', launchId, message: error.message }),
  );
  child.once('exit', (code, signal) => {
    children.delete(launchId);
    send({ type: 'exit', launchId, code, signal });
  });
}

process.on('message', (message) => {
  void (async () => {
    if (message?.type === 'launch') launch(message);
    else if (message?.type === 'stop') {
      const child = children.get(message.launchId);
      if (child !== undefined) await terminateOwnedProcess(child);
    } else if (message?.type === 'shutdown') {
      await cleanup();
      send({ type: 'shutdown-complete' });
      process.disconnect();
    }
  })().catch((error) => {
    send({
      type: 'fatal',
      message: error instanceof Error ? error.message : String(error),
    });
    void cleanup().finally(() => process.exit(1));
  });
});

process.once('disconnect', () => {
  void cleanup().finally(() => process.exit(0));
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    void cleanup().finally(() => process.exit(0));
  });
}

initialize().catch((error) => {
  send({
    type: 'fatal',
    message: error instanceof Error ? error.message : String(error),
  });
  void cleanup().finally(() => process.exit(1));
});
