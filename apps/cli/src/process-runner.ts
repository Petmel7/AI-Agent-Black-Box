import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from 'node:child_process';
import { performance } from 'node:perf_hooks';

import {
  CollectorSession,
  CollectorWorkSpool,
  type CollectorComposition,
} from './collector/index.js';
import { DeliveryCoordinator } from './collector/coordinator.js';
import type {
  DeliveryConfig,
  DeliveryConfiguration,
} from './collector/delivery-config.js';
import {
  DEFAULT_BUSY_TIMEOUT_MS,
  MAX_RUN_LEASE_MS,
  MIN_RUN_LEASE_MS,
} from './collector/spool.js';
import { CodexJsonlAdapter, type CodexAdapterSink } from './codex-adapter.js';
import {
  captureCodexCheckpoint,
  createCodexSessionSink,
} from './collector/session.js';

export const DEFAULT_WRAPPED_RUN_LEASE_MS = 30_000;
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
export const RUN_TRANSITION_MARGIN_MS = 1_000;
export const MIN_HEARTBEAT_INTERVAL_MS = 100;
export const MAX_SUCCESSFUL_CODEX_CHECKPOINTS = 8;
export const MAX_FAILED_CODEX_CHECKPOINTS = 8;

export type SupportedProcessSignal =
  'SIGBREAK' | 'SIGHUP' | 'SIGINT' | 'SIGTERM';

export type WrappedTermination =
  | { code: number; kind: 'exit' }
  | {
      fallbackCode: number;
      kind: 'signal';
      signal: SupportedProcessSignal;
    };

export interface WrappedRunIo {
  warning(message: string): void;
}

interface RunSession {
  readonly runId: string;
  captureGitSnapshot(phase: 'after' | 'before' | 'checkpoint'): unknown;
  close(): void;
  compareGitSnapshots(): unknown;
  observeRunFinished(input: {
    durationMs?: number;
    outcome: 'cancelled' | 'failed' | 'succeeded';
  }): unknown;
  observeRunStarted(input: { taskDescription?: Uint8Array }): unknown;
  renewLease(leaseMs?: number): void;
  [Symbol.dispose](): void;
}

interface SignalHost {
  on(signal: SupportedProcessSignal, listener: () => void): unknown;
  removeListener(signal: SupportedProcessSignal, listener: () => void): unknown;
}

interface ByteOutput {
  on(event: 'error', listener: () => void): unknown;
  once(event: 'close' | 'drain', listener: () => void): unknown;
  removeListener(
    event: 'close' | 'drain' | 'error',
    listener: () => void,
  ): unknown;
  write(chunk: Uint8Array): boolean;
}

export interface ProcessRunnerDependencies {
  captureCodexCheckpoint?(session: CollectorSession): Promise<void>;
  clearInterval?(timer: NodeJS.Timeout): void;
  createCoordinator?(
    spool: CollectorWorkSpool,
    config: DeliveryConfig,
  ): Pick<DeliveryCoordinator, 'drain'>;
  heartbeatIntervalMs?: number;
  monotonicNow?(): number;
  openDeliverySpool?(
    config: CollectorComposition['config'],
  ): CollectorWorkSpool;
  openSession?(composition: CollectorComposition, leaseMs: number): RunSession;
  runLeaseMs?: number;
  setInterval?(callback: () => void, milliseconds: number): NodeJS.Timeout;
  signalHost?: SignalHost;
  stdout?: ByteOutput;
  spawn?(
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ): ChildProcess;
}

interface WrappedProcessMode {
  codexJsonl?: boolean;
}

function deliverySpoolConfig(config: CollectorComposition['config']) {
  return {
    captureClasses: [...config.captureClasses],
    inputLimitBytes: config.inputLimitBytes,
    ...(config.repositoryRoot ? { repositoryRoot: config.repositoryRoot } : {}),
    spoolQuotaBytes: config.spoolQuotaBytes,
    spoolRoot: config.spoolRoot,
  };
}

function supportedSignals(
  platform = process.platform,
): SupportedProcessSignal[] {
  return platform === 'win32'
    ? ['SIGINT', 'SIGTERM', 'SIGBREAK']
    : ['SIGINT', 'SIGTERM', 'SIGHUP'];
}

function assertTiming(leaseMs: number, heartbeatMs: number): void {
  if (
    !Number.isSafeInteger(leaseMs) ||
    leaseMs < MIN_RUN_LEASE_MS ||
    leaseMs > MAX_RUN_LEASE_MS ||
    !Number.isSafeInteger(heartbeatMs) ||
    heartbeatMs < MIN_HEARTBEAT_INTERVAL_MS ||
    heartbeatMs + DEFAULT_BUSY_TIMEOUT_MS + RUN_TRANSITION_MARGIN_MS >= leaseMs
  )
    throw new TypeError('wrapped-run lease timing is outside its safe bounds');
}

export function buildChildEnvironment(
  source: NodeJS.ProcessEnv,
  runId: string,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  const seen = new Map<string, string | undefined>();
  for (const key of Object.keys(source)) {
    const normalized = key.toUpperCase();
    const value = source[key];
    if (seen.has(normalized)) {
      if (seen.get(normalized) !== value)
        throw new TypeError('child environment contains ambiguous keys');
      continue;
    }
    seen.set(normalized, value);
    if (normalized.startsWith('BLACKBOX_')) continue;
    if (value !== undefined) result[key] = value;
  }
  result.BLACKBOX_RUN_ID = runId;
  return result;
}

function duration(
  startedAt: number | undefined,
  now: number,
): number | undefined {
  if (startedAt === undefined || !Number.isFinite(now - startedAt))
    return undefined;
  return Math.min(
    Number.MAX_SAFE_INTEGER,
    Math.max(0, Math.floor(now - startedAt)),
  );
}

function fallbackSignalCode(signal: SupportedProcessSignal): number {
  const numbers: Record<SupportedProcessSignal, number> = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGTERM: 15,
    SIGBREAK: 21,
  };
  return 128 + numbers[signal];
}

async function runProcess(
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  composition: CollectorComposition,
  delivery: DeliveryConfiguration,
  io: WrappedRunIo,
  dependencies: ProcessRunnerDependencies = {},
  mode: WrappedProcessMode = {},
): Promise<WrappedTermination> {
  const leaseMs = dependencies.runLeaseMs ?? DEFAULT_WRAPPED_RUN_LEASE_MS;
  const heartbeatMs =
    dependencies.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  assertTiming(leaseMs, heartbeatMs);
  const now = dependencies.monotonicNow ?? (() => performance.now());
  const setHeartbeat = dependencies.setInterval ?? setInterval;
  const clearHeartbeat = dependencies.clearInterval ?? clearInterval;
  const signalHost = dependencies.signalHost ?? process;
  const spawnChild = dependencies.spawn ?? spawn;
  const openSession =
    dependencies.openSession ??
    ((value: CollectorComposition, requestedLeaseMs: number) =>
      CollectorSession.open(value.config, value.redactorOptions, {
        leaseMs: requestedLeaseMs,
      }));
  let session: RunSession | undefined;
  let child: ChildProcess | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let startedAt: number | undefined;
  let writesDisabled = false;
  let warned = false;
  let active = false;
  let sessionFinalized = false;
  let adapter: CodexJsonlAdapter | undefined;
  let adapterSink: CodexAdapterSink | undefined;
  let adapterEnabled = mode.codexJsonl === true;
  let checkpointPending = false;
  let checkpointTask: Promise<void> | undefined;
  let checkpoints = 0;
  let checkpointFailures = 0;
  let checkpointAbandonmentRecorded = false;
  const recordCheckpointDiagnostic = (
    code: 'codex-checkpoint-abandoned' | 'codex-checkpoint-failed',
  ) => {
    try {
      adapterSink?.diagnostic(code);
    } catch {
      warn(false);
    }
  };
  const abandonCheckpoints = (): void => {
    checkpointPending = false;
    if (checkpointAbandonmentRecorded) return;
    checkpointAbandonmentRecorded = true;
    recordCheckpointDiagnostic('codex-checkpoint-abandoned');
  };
  const scheduleCheckpoint = (): void => {
    if (
      checkpointFailures >= MAX_FAILED_CODEX_CHECKPOINTS ||
      checkpoints >= MAX_SUCCESSFUL_CODEX_CHECKPOINTS
    ) {
      abandonCheckpoints();
      return;
    }
    checkpointPending = true;
    if (checkpointTask) return;
    checkpointTask = new Promise<void>((resolve) => setImmediate(resolve))
      .then(async () => {
        while (
          checkpointPending &&
          checkpointFailures < MAX_FAILED_CODEX_CHECKPOINTS &&
          checkpoints < MAX_SUCCESSFUL_CODEX_CHECKPOINTS
        ) {
          checkpointPending = false;
          try {
            await (
              dependencies.captureCodexCheckpoint ?? captureCodexCheckpoint
            )(session as CollectorSession);
            checkpoints += 1;
          } catch {
            checkpointFailures += 1;
            recordCheckpointDiagnostic('codex-checkpoint-failed');
            warn(false);
          }
        }
        if (
          checkpointPending ||
          checkpointFailures >= MAX_FAILED_CODEX_CHECKPOINTS
        )
          abandonCheckpoints();
      })
      .finally(() => {
        checkpointTask = undefined;
      });
  };
  const listeners = new Map<SupportedProcessSignal, () => void>();
  const warn = (disableWrites = true): void => {
    if (disableWrites) writesDisabled = true;
    if (warned) return;
    warned = true;
    try {
      io.warning('Collector degraded: collection-failed');
    } catch {
      /* Warning output cannot replace the child result. */
    }
  };
  const cleanup = (): void => {
    active = false;
    if (heartbeat) {
      try {
        clearHeartbeat(heartbeat);
      } catch {
        warn();
      }
      heartbeat = undefined;
    }
    for (const [signal, listener] of listeners)
      try {
        signalHost.removeListener(signal, listener);
      } catch {
        warn();
      }
    listeners.clear();
  };
  const disposeSession = (): void => {
    if (!session || sessionFinalized) return;
    sessionFinalized = true;
    try {
      session[Symbol.dispose]();
    } catch {
      warn();
    }
  };
  try {
    buildChildEnvironment(environment, '00000000-0000-4000-8000-000000000000');
    session = openSession(composition, leaseMs);
    session.observeRunStarted({});
    try {
      session.captureGitSnapshot('before');
      session.renewLease(leaseMs);
    } catch {
      try {
        session.observeRunFinished({ outcome: 'failed' });
        session.close();
        sessionFinalized = true;
      } catch {
        warn();
        disposeSession();
      }
      return { code: 1, kind: 'exit' };
    }
    const childEnvironment = buildChildEnvironment(environment, session.runId);
    if (mode.codexJsonl) {
      if (!(session instanceof CollectorSession))
        throw new TypeError('Codex adapter requires a collector session');
      adapterSink = createCodexSessionSink(session, scheduleCheckpoint);
      adapter = new CodexJsonlAdapter(adapterSink);
    }
    try {
      child = spawnChild(command, [...args], {
        cwd: process.cwd(),
        env: childEnvironment,
        shell: false,
        stdio: mode.codexJsonl ? ['inherit', 'pipe', 'inherit'] : 'inherit',
      });
    } catch {
      try {
        session.observeRunFinished({ outcome: 'failed' });
        session.close();
        sessionFinalized = true;
      } catch {
        warn();
        disposeSession();
      }
      return { code: 1, kind: 'exit' };
    }

    const output = dependencies.stdout ?? process.stdout;
    let outputFailed = false;
    let stdoutEnded = !mode.codexJsonl;
    const source = child.stdout;
    const onOutputDrain = () => child?.stdout?.resume();
    const onOutputFailure = () => {
      outputFailed = true;
      output.removeListener('drain', onOutputDrain);
      warn(false);
      child?.stdout?.resume();
    };
    const onSourceData = (chunk: Buffer) => {
      if (adapterEnabled)
        try {
          adapter!.push(chunk);
        } catch {
          adapterEnabled = false;
          warn(false);
        }
      if (!outputFailed)
        try {
          if (!output.write(chunk)) {
            source!.pause();
            output.once('drain', onOutputDrain);
          }
        } catch {
          onOutputFailure();
        }
    };
    const onSourceEnd = () => {
      stdoutEnded = true;
      if (adapterEnabled)
        try {
          adapter!.finish();
        } catch {
          adapterEnabled = false;
          warn(false);
        }
    };
    const onSourceFailure = () => {
      if (!stdoutEnded && adapterEnabled)
        try {
          adapter!.transportFailure();
        } catch {
          adapterEnabled = false;
        }
      warn(false);
      source?.resume();
    };
    const onSourceClose = () => {
      if (!stdoutEnded) onSourceFailure();
    };
    if (mode.codexJsonl) {
      output.on('error', onOutputFailure);
      output.once('close', onOutputFailure);
      source?.on('data', onSourceData);
      source?.once('end', onSourceEnd);
      source?.on('error', onSourceFailure);
      source?.once('close', onSourceClose);
    }

    const closed = await new Promise<
      | { kind: 'launch-error' }
      | { code: number | null; kind: 'close'; signal: NodeJS.Signals | null }
    >((resolve) => {
      let settled = false;
      let spawned = false;
      const detachChildListeners = () => {
        child!.removeListener('spawn', onSpawn);
        child!.removeListener('error', onError);
        child!.removeListener('close', onClose);
      };
      const settle = (
        result:
          | { kind: 'launch-error' }
          | {
              code: number | null;
              kind: 'close';
              signal: NodeJS.Signals | null;
            },
      ) => {
        if (settled) return;
        settled = true;
        detachChildListeners();
        resolve(result);
      };
      const onSpawn = () => {
        if (settled) return;
        spawned = true;
        startedAt = now();
        active = true;
        for (const signal of supportedSignals()) {
          const listener = () => {
            if (!active) return;
            try {
              if (!child!.kill(signal)) warn(false);
            } catch {
              warn(false);
            }
          };
          listeners.set(signal, listener);
          signalHost.on(signal, listener);
        }
        heartbeat = setHeartbeat(() => {
          if (!active || writesDisabled) return;
          try {
            session!.renewLease(leaseMs);
          } catch {
            if (heartbeat) {
              clearHeartbeat(heartbeat);
              heartbeat = undefined;
            }
            warn();
          }
        }, heartbeatMs);
        heartbeat.unref?.();
      };
      const onError = () => {
        if (!spawned) {
          settle({ kind: 'launch-error' });
          return;
        }
        warn(false);
      };
      const onClose = (code: number | null, signal: NodeJS.Signals | null) =>
        settle({ code, kind: 'close', signal });
      child!.once('spawn', onSpawn);
      child!.on('error', onError);
      child!.once('close', onClose);
    });
    if (mode.codexJsonl) {
      output.removeListener('error', onOutputFailure);
      output.removeListener('close', onOutputFailure);
      output.removeListener('drain', onOutputDrain);
      source?.removeListener('data', onSourceData);
      source?.removeListener('end', onSourceEnd);
      source?.removeListener('error', onSourceFailure);
      source?.removeListener('close', onSourceClose);
    }
    cleanup();

    if (closed.kind === 'launch-error') {
      try {
        session.observeRunFinished({ outcome: 'failed' });
        session.close();
        sessionFinalized = true;
      } catch {
        warn();
        disposeSession();
      }
      return { code: 1, kind: 'exit' };
    }

    const observedDuration = duration(startedAt, now());
    const supportedSignal = supportedSignals().includes(
      closed.signal as SupportedProcessSignal,
    )
      ? (closed.signal as SupportedProcessSignal)
      : undefined;
    const outcome = closed.signal
      ? 'cancelled'
      : closed.code === 0
        ? 'succeeded'
        : 'failed';
    if (checkpointTask) await checkpointTask;
    if (!writesDisabled)
      try {
        session.captureGitSnapshot('after');
        session.compareGitSnapshots();
      } catch {
        warn(false);
      }
    let closedDurably = false;
    if (!writesDisabled)
      try {
        session.observeRunFinished({
          outcome,
          ...(observedDuration === undefined
            ? {}
            : { durationMs: observedDuration }),
        });
        session.close();
        sessionFinalized = true;
        closedDurably = true;
      } catch {
        warn();
        disposeSession();
      }
    else disposeSession();

    if (closed.signal)
      return supportedSignal
        ? {
            fallbackCode: fallbackSignalCode(supportedSignal),
            kind: 'signal',
            signal: supportedSignal,
          }
        : { code: 1, kind: 'exit' };

    const childCode =
      closed.code !== null && Number.isInteger(closed.code) ? closed.code : 1;
    if (closedDurably && delivery.state === 'configured') {
      try {
        using spool = dependencies.openDeliverySpool
          ? dependencies.openDeliverySpool(composition.config)
          : CollectorWorkSpool.open(deliverySpoolConfig(composition.config));
        const coordinator = dependencies.createCoordinator
          ? dependencies.createCoordinator(spool, delivery.config)
          : new DeliveryCoordinator(spool, delivery.config);
        const result = await coordinator.drain(session.runId);
        if (result.remaining.blocked > 0 || result.remaining.readyOrDelayed > 0)
          warn();
      } catch {
        warn();
      }
    }
    return { code: childCode, kind: 'exit' };
  } finally {
    cleanup();
    if (!child) disposeSession();
  }
}

export async function runWrappedProcess(
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  composition: CollectorComposition,
  delivery: DeliveryConfiguration,
  io: WrappedRunIo,
  dependencies: ProcessRunnerDependencies = {},
): Promise<WrappedTermination> {
  return runProcess(
    command,
    args,
    environment,
    composition,
    delivery,
    io,
    dependencies,
  );
}

export async function runCodexProcess(
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  composition: CollectorComposition,
  delivery: DeliveryConfiguration,
  io: WrappedRunIo,
  dependencies: ProcessRunnerDependencies = {},
): Promise<WrappedTermination> {
  return runProcess(
    'codex',
    ['exec', '--json', ...args],
    environment,
    composition,
    delivery,
    io,
    dependencies,
    { codexJsonl: true },
  );
}
