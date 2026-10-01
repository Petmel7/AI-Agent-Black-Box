import {
  GitSnapshotPhaseSchema,
  type ContentCapture,
  type EvidenceEvent,
  type GitSnapshotPhase,
} from '@blackbox/contracts';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';

import {
  type CaptureClass,
  type CollectorConfig,
  type CollectorConfigInput,
  validateCollectorConfig,
} from './config.js';
import { CollectorError } from './errors.js';
import {
  GitReader,
  validateGitCheckpointWorkerMessage,
  type GitCheckpointObservation,
  type GitSnapshot,
} from './git.js';
import { Redactor, type RedactorOptions } from './redaction.js';
import {
  DEFAULT_LEASE_MS,
  LocalSpool,
  MAX_RUN_LEASE_MS,
  MIN_RUN_LEASE_MS,
  type RunHandle,
} from './spool.js';
import type {
  CodexAdapterSink,
  CodexDiagnosticCode,
} from '../codex-adapter.js';

const CODEX_SINK = Symbol('codex-adapter-sink');
const CODEX_CHECKPOINT = Symbol('codex-checkpoint');

interface CheckpointWorkerLike {
  on(event: 'error', listener: () => void): unknown;
  once(event: 'exit', listener: (code: number) => void): unknown;
  once(event: 'message', listener: (value: unknown) => void): unknown;
  removeListener(event: 'error', listener: () => void): unknown;
  removeListener(event: 'exit', listener: (code: number) => void): unknown;
  removeListener(event: 'message', listener: (value: unknown) => void): unknown;
  terminate(): Promise<number>;
}

export type CheckpointWorkerFactory = (
  url: URL,
  options: {
    workerData: {
      initialCwd: string;
      nonce: string;
      redactorOptions: RedactorOptions;
      repositoryRoot?: string;
    };
  },
) => CheckpointWorkerLike;

export interface CollectorSessionOptions {
  leaseMs?: number;
}

function sessionLease(value: unknown): number {
  const leaseMs = value === undefined ? DEFAULT_LEASE_MS : value;
  if (
    !Number.isSafeInteger(leaseMs) ||
    Number(leaseMs) < MIN_RUN_LEASE_MS ||
    Number(leaseMs) > MAX_RUN_LEASE_MS
  )
    throw new CollectorError(
      'invalid-config',
      'run lease duration is outside its safe bounds',
    );
  return Number(leaseMs);
}

function parseSessionOptions(value: unknown): number {
  if (value === undefined) return DEFAULT_LEASE_MS;
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new CollectorError(
      'invalid-config',
      'session options must be plain data',
    );
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(value).some((key) => key !== 'leaseMs') ||
    Object.values(descriptors).some(
      (descriptor) => descriptor.get || descriptor.set,
    )
  )
    throw new CollectorError(
      'invalid-config',
      'session options contain unsupported fields',
    );
  return sessionLease(descriptors.leaseMs?.value);
}

function copyRedactorOptions(value: RedactorOptions): RedactorOptions {
  if (Object.getPrototypeOf(value) !== Object.prototype)
    throw new CollectorError(
      'invalid-config',
      'redaction configuration must be plain data',
    );
  for (const descriptor of Object.values(
    Object.getOwnPropertyDescriptors(value),
  ))
    if (descriptor.get || descriptor.set)
      throw new CollectorError(
        'invalid-config',
        'redaction configuration must not contain accessors',
      );
  const copyStrings = (
    items: readonly string[] | undefined,
  ): string[] | undefined => {
    if (items === undefined) return undefined;
    if (!Array.isArray(items) || items.some((item) => typeof item !== 'string'))
      throw new CollectorError(
        'invalid-config',
        'redaction configuration is invalid',
      );
    return items.map(String);
  };
  const credentials = copyStrings(value.collectorCredentials);
  const explicitNames = copyStrings(value.explicitEnvironmentNames);
  let environment: NodeJS.ProcessEnv | undefined;
  if (value.environment) {
    if (Object.getPrototypeOf(value.environment) !== Object.prototype)
      throw new CollectorError(
        'invalid-config',
        'redaction environment must be plain data',
      );
    environment = {};
    for (const [name, descriptor] of Object.entries(
      Object.getOwnPropertyDescriptors(value.environment),
    )) {
      if (descriptor.get || descriptor.set)
        throw new CollectorError(
          'invalid-config',
          'redaction environment must not contain accessors',
        );
      if (
        descriptor.value !== undefined &&
        typeof descriptor.value !== 'string'
      )
        throw new CollectorError(
          'invalid-config',
          'redaction environment is invalid',
        );
      environment[name] = descriptor.value as string | undefined;
    }
  }
  return {
    ...(credentials ? { collectorCredentials: credentials } : {}),
    ...(environment ? { environment } : {}),
    ...(explicitNames ? { explicitEnvironmentNames: explicitNames } : {}),
    ...(value.homeDirectory
      ? { homeDirectory: String(value.homeDirectory) }
      : {}),
    ...(value.literalFilePath
      ? { literalFilePath: String(value.literalFilePath) }
      : {}),
    ...(value.repositoryRoot
      ? { repositoryRoot: String(value.repositoryRoot) }
      : {}),
    ...(value.spoolRoot ? { spoolRoot: String(value.spoolRoot) } : {}),
  };
}

function freezeCapture(capture: ContentCapture): ContentCapture {
  const copy = structuredClone(capture);
  if (copy.state === 'captured') {
    if (copy.artifact) {
      Object.freeze(copy.artifact.redaction);
      Object.freeze(copy.artifact);
    }
    Object.freeze(copy.redaction);
  }
  return Object.freeze(copy);
}

export class CollectorSession implements Disposable {
  readonly #handle: RunHandle;
  readonly #spool: LocalSpool;
  readonly #initialCwd: string;
  readonly #repositoryRoot: string | undefined;
  readonly #workerRedactorOptions: RedactorOptions;
  #gitReader: GitReader | undefined;
  #comparisonRecorded = false;
  readonly #snapshots = new Map<GitSnapshotPhase, GitSnapshot>();

  private constructor(
    spool: LocalSpool,
    handle: RunHandle,
    initialCwd: string,
    repositoryRoot: string | undefined,
    workerRedactorOptions: RedactorOptions,
  ) {
    this.#spool = spool;
    this.#handle = handle;
    this.#initialCwd = initialCwd;
    this.#repositoryRoot = repositoryRoot;
    this.#workerRedactorOptions = workerRedactorOptions;
  }

  static open(
    configInput: CollectorConfigInput | CollectorConfig,
    redactorOptions: RedactorOptions = { environment: {} },
    options: CollectorSessionOptions = {},
  ): CollectorSession {
    const leaseMs = parseSessionOptions(options);
    const rawCaptureClasses = configInput.captureClasses;
    let requestedCaptureClasses: string[] | undefined;
    if (rawCaptureClasses)
      requestedCaptureClasses = Array.isArray(rawCaptureClasses)
        ? rawCaptureClasses.map(String)
        : Array.from(rawCaptureClasses as ReadonlySet<CaptureClass>, String);
    const normalizedConfig: CollectorConfigInput = {};
    if (requestedCaptureClasses)
      normalizedConfig.captureClasses = requestedCaptureClasses;
    if (configInput.inputLimitBytes !== undefined)
      normalizedConfig.inputLimitBytes = configInput.inputLimitBytes;
    if (configInput.repositoryRoot !== undefined)
      normalizedConfig.repositoryRoot = configInput.repositoryRoot;
    if (configInput.spoolQuotaBytes !== undefined)
      normalizedConfig.spoolQuotaBytes = configInput.spoolQuotaBytes;
    if (configInput.spoolRoot !== undefined)
      normalizedConfig.spoolRoot = configInput.spoolRoot;
    const config = validateCollectorConfig(normalizedConfig);
    const copiedRedactorOptions = {
      ...copyRedactorOptions(redactorOptions),
      ...(config.repositoryRoot
        ? { repositoryRoot: config.repositoryRoot }
        : {}),
      spoolRoot: config.spoolRoot,
    };
    const redactor = new Redactor(copiedRedactorOptions);
    const workerRedactorOptions: RedactorOptions = {
      collectorCredentials: [...redactor.literals],
      environment: {},
      homeDirectory: redactor.homeDirectory,
      ...(redactor.repositoryRoot
        ? { repositoryRoot: redactor.repositoryRoot }
        : {}),
      ...(redactor.spoolRoot ? { spoolRoot: redactor.spoolRoot } : {}),
    };
    const spool = new LocalSpool(config, {}, redactor).open();
    try {
      return new CollectorSession(
        spool,
        spool.createRun(leaseMs),
        process.cwd(),
        config.repositoryRoot,
        workerRedactorOptions,
      );
    } catch (cause) {
      spool.close();
      throw cause;
    }
  }

  get runId(): string {
    return this.#handle.runId;
  }

  renewLease(leaseMs = DEFAULT_LEASE_MS): void {
    this.#spool.renewRunLease(this.#handle, sessionLease(leaseMs));
  }

  captureText(captureClass: CaptureClass, input: Uint8Array): ContentCapture {
    return freezeCapture(
      this.#spool.captureText(
        this.#handle,
        captureClass,
        Uint8Array.from(input),
      ),
    );
  }

  observeRunStarted(input: { taskDescription?: Uint8Array }): EvidenceEvent {
    return structuredClone(this.#spool.recordRunStarted(this.#handle, input));
  }

  observeCommandFinished(input: {
    commandId: string;
    outcome: 'cancelled' | 'failed' | 'succeeded';
    stderr?: Uint8Array;
    stdout?: Uint8Array;
  }): EvidenceEvent {
    return structuredClone(
      this.#spool.recordCommandFinished(this.#handle, input),
    );
  }

  captureGitSnapshot(phase: GitSnapshotPhase): EvidenceEvent {
    const parsedPhase = GitSnapshotPhaseSchema.safeParse(phase);
    if (!parsedPhase.success)
      throw new CollectorError(
        'collection-failed',
        'Git snapshot phase is invalid',
      );
    this.#gitReader ??= GitReader.open(this.#initialCwd, this.#repositoryRoot);
    const snapshot = this.#gitReader.capture(parsedPhase.data, (value) =>
      this.#spool.redactGitDisplayPath(value),
    );
    const event = this.#spool.recordGitSnapshot(this.#handle, snapshot);
    this.#snapshots.set(parsedPhase.data, snapshot);
    return structuredClone(event);
  }

  compareGitSnapshots(): EvidenceEvent {
    if (this.#comparisonRecorded)
      throw new CollectorError(
        'collection-failed',
        'Git comparison is already recorded',
      );
    const before = this.#snapshots.get('before');
    const after = this.#snapshots.get('after');
    if (!before || !after)
      throw new CollectorError(
        'collection-failed',
        'before and after Git snapshots are required',
      );
    if (!this.#gitReader)
      throw new CollectorError(
        'collection-failed',
        'Git reader is unavailable for comparison',
      );
    const event = this.#spool.recordGitComparison(
      this.#handle,
      before,
      after,
      this.#gitReader.compare(before, after),
    );
    this.#comparisonRecorded = true;
    return structuredClone(event);
  }

  observeRunFinished(input: {
    durationMs?: number;
    outcome: 'cancelled' | 'failed' | 'succeeded';
  }): EvidenceEvent {
    return structuredClone(this.#spool.recordRunFinished(this.#handle, input));
  }

  [CODEX_SINK](requestCheckpoint: () => void): CodexAdapterSink {
    const clone = <T>(value: T): T => structuredClone(value);
    return {
      commandStarted: (input) => {
        this.#spool.recordCodexCommandStarted(this.#handle, clone(input));
      },
      commandFinished: (input) => {
        this.#spool.recordCodexCommandFinished(this.#handle, clone(input));
      },
      toolStarted: (input) => {
        this.#spool.recordCodexToolStarted(this.#handle, clone(input));
      },
      toolFinished: (input) => {
        this.#spool.recordCodexToolFinished(this.#handle, clone(input));
      },
      fileChangeCompleted: (input) => {
        this.#spool.recordCodexToolFinished(this.#handle, {
          nativeEventId: input.nativeEventId,
          nativeSessionId: input.nativeSessionId,
          ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
          outcome: 'succeeded',
          toolCallId: input.toolCallId,
          toolName: 'file-change',
        });
      },
      errorObserved: (input) => {
        this.#spool.recordCodexError(this.#handle, clone(input));
      },
      usageObserved: (input) => {
        this.#spool.recordCodexUsage(this.#handle, clone(input));
      },
      diagnostic: (code: CodexDiagnosticCode, nativeSessionId?: string) => {
        this.#spool.recordCodexError(this.#handle, {
          code,
          ...(nativeSessionId ? { nativeSessionId } : {}),
        });
      },
      requestCheckpoint,
    };
  }

  async [CODEX_CHECKPOINT](
    workerFactory: CheckpointWorkerFactory = (url, options) =>
      new Worker(url, options),
  ): Promise<void> {
    const nonce = randomUUID();
    const worker = workerFactory(
      new URL('../../dist/collector/checkpoint-worker.js', import.meta.url),
      {
        workerData: {
          initialCwd: this.#initialCwd,
          nonce,
          redactorOptions: this.#workerRedactorOptions,
          ...(this.#repositoryRoot
            ? { repositoryRoot: this.#repositoryRoot }
            : {}),
        },
      },
    );
    const checkpoint = await new Promise<GitCheckpointObservation>(
      (resolve, reject) => {
        let settled = false;
        const cleanup = () => {
          worker.removeListener('message', onMessage);
          worker.removeListener('error', onError);
          worker.removeListener('exit', onExit);
        };
        const terminate = (callback: () => void) => {
          void worker
            .terminate()
            .catch(() => undefined)
            .then(() => {
              cleanup();
              callback();
            });
        };
        const fail = () => {
          if (settled) return;
          settled = true;
          terminate(() =>
            reject(
              new CollectorError(
                'collection-failed',
                'Git checkpoint capture failed',
              ),
            ),
          );
        };
        const onMessage = (value: unknown) => {
          if (settled) return;
          let parsed: GitCheckpointObservation;
          try {
            parsed = validateGitCheckpointWorkerMessage(value, nonce, (path) =>
              this.#spool.redactGitDisplayPath(path),
            );
          } catch {
            return fail();
          }
          settled = true;
          terminate(() => resolve(parsed));
        };
        const onError = () => fail();
        const onExit = (code: number) => {
          if (code !== 0 || !settled) fail();
        };
        worker.once('message', onMessage);
        worker.on('error', onError);
        worker.once('exit', onExit);
      },
    );
    this.#spool.recordGitCheckpoint(this.#handle, checkpoint);
  }

  close(): void {
    this.#spool.closeRun(this.#handle);
    this.#spool.close();
  }

  [Symbol.dispose](): void {
    this.#spool.close();
  }
}

/** Internal adapter composition seam; intentionally not re-exported publicly. */
export function createCodexSessionSink(
  session: CollectorSession,
  requestCheckpoint: () => void,
): CodexAdapterSink {
  return session[CODEX_SINK](requestCheckpoint);
}

/** Internal checkpoint seam; Git reads run in a worker and persistence stays owner-bound. */
export function captureCodexCheckpoint(
  session: CollectorSession,
  workerFactory?: CheckpointWorkerFactory,
): Promise<void> {
  return session[CODEX_CHECKPOINT](workerFactory);
}
