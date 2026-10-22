import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const workerPath = fileURLToPath(
  new URL('./isolated-next-worker.mjs', import.meta.url),
);

export async function createIsolatedNextController(sourceWebRoot) {
  const worker = fork(workerPath, [], {
    detached: true,
    env: {
      ...process.env,
      BBX_ISOLATED_NEXT_SOURCE_ROOT: sourceWebRoot,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  let diagnostics = '';
  const appendDiagnostic = (chunk) => {
    diagnostics = `${diagnostics}${String(chunk)}`.slice(-12_000);
  };
  worker.stdout?.on('data', appendDiagnostic);
  worker.stderr?.on('data', appendDiagnostic);

  const launches = new Map();
  const pendingLaunches = new Map();
  let nextLaunchId = 0;
  let shutdownComplete = false;
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  worker.on('message', (message) => {
    if (message?.type === 'ready') readyResolve(message);
    else if (message?.type === 'launched') {
      const pending = pendingLaunches.get(message.launchId);
      if (pending !== undefined) {
        pendingLaunches.delete(message.launchId);
        pending.resolve(message);
      }
    } else if (message?.type === 'output') {
      const launch = launches.get(message.launchId);
      if (launch !== undefined)
        launch.output = `${launch.output}${message.value}`.slice(-12_000);
    } else if (message?.type === 'exit') {
      const launch = launches.get(message.launchId);
      if (launch !== undefined) {
        launch.result = { code: message.code, signal: message.signal };
        launch.resolveExit(launch.result);
      }
    } else if (message?.type === 'launch-error') {
      const pending = pendingLaunches.get(message.launchId);
      pending?.reject(new Error(message.message));
      pendingLaunches.delete(message.launchId);
    } else if (message?.type === 'shutdown-complete') shutdownComplete = true;
    else if (message?.type === 'fatal') {
      const error = new Error(
        `Isolated Next worker failed: ${message.message}`,
      );
      readyReject(error);
      for (const pending of pendingLaunches.values()) pending.reject(error);
      pendingLaunches.clear();
    }
  });
  worker.once('exit', (code, signal) => {
    const error = new Error(
      `Isolated Next worker exited (${String(code ?? signal)}).\n${diagnostics}`,
    );
    readyReject(error);
    for (const pending of pendingLaunches.values()) pending.reject(error);
    pendingLaunches.clear();
    for (const launch of launches.values()) {
      if (launch.result === undefined) launch.rejectExit(error);
    }
  });

  const ownership = await ready;
  return {
    ownerRoot: ownership.ownerRoot,
    webRoot: ownership.webRoot,
    workerPid: ownership.workerPid,
    async launch(options) {
      const launchId = `launch-${++nextLaunchId}`;
      let resolveExit;
      let rejectExit;
      const exited = new Promise((resolve, reject) => {
        resolveExit = resolve;
        rejectExit = reject;
      });
      const state = {
        output: '',
        result: undefined,
        resolveExit,
        rejectExit,
      };
      launches.set(launchId, state);
      const launched = new Promise((resolve, reject) =>
        pendingLaunches.set(launchId, { resolve, reject }),
      );
      worker.send({
        type: 'launch',
        launchId,
        command: options.command,
        mode: options.mode,
        port: options.port,
        nextArguments: options.nextArguments ?? [],
        environment: options.environment,
      });
      const launchResult = await launched;
      return {
        id: launchId,
        pid: launchResult.pid,
        output: () => state.output,
        wait: () =>
          state.result === undefined ? exited : Promise.resolve(state.result),
        stop() {
          if (state.result === undefined)
            worker.send({ type: 'stop', launchId });
          return state.result === undefined
            ? exited
            : Promise.resolve(state.result);
        },
      };
    },
    async shutdown() {
      if (worker.exitCode !== null || worker.signalCode !== null) return;
      worker.send({ type: 'shutdown' });
      await Promise.race([
        new Promise((resolve, reject) =>
          worker.once('exit', (code) =>
            shutdownComplete && code === 0
              ? resolve()
              : reject(
                  new Error(
                    `Isolated Next worker did not cleanly shut down.\n${diagnostics}`,
                  ),
                ),
          ),
        ),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('Isolated Next worker cleanup timed out.')),
            30_000,
          ),
        ),
      ]);
    },
  };
}
