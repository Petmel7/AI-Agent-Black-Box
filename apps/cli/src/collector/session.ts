import {
  GitSnapshotPhaseSchema,
  type ContentCapture,
  type EvidenceEvent,
  type GitSnapshotPhase,
} from '@blackbox/contracts';

import {
  type CaptureClass,
  type CollectorConfig,
  type CollectorConfigInput,
  validateCollectorConfig,
} from './config.js';
import { CollectorError } from './errors.js';
import { GitReader, type GitSnapshot } from './git.js';
import type { RedactorOptions } from './redaction.js';
import {
  DEFAULT_LEASE_MS,
  LocalSpool,
  MAX_RUN_LEASE_MS,
  MIN_RUN_LEASE_MS,
  type RunHandle,
} from './spool.js';

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
  #gitReader: GitReader | undefined;
  #comparisonRecorded = false;
  readonly #snapshots = new Map<GitSnapshotPhase, GitSnapshot>();

  private constructor(
    spool: LocalSpool,
    handle: RunHandle,
    initialCwd: string,
    repositoryRoot: string | undefined,
  ) {
    this.#spool = spool;
    this.#handle = handle;
    this.#initialCwd = initialCwd;
    this.#repositoryRoot = repositoryRoot;
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
    const spool = new LocalSpool(config, {}, copiedRedactorOptions).open();
    try {
      return new CollectorSession(
        spool,
        spool.createRun(leaseMs),
        process.cwd(),
        config.repositoryRoot,
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

  close(): void {
    this.#spool.closeRun(this.#handle);
    this.#spool.close();
  }

  [Symbol.dispose](): void {
    this.#spool.close();
  }
}
