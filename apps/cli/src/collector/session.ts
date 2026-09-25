import type { ContentCapture, EvidenceEvent } from '@blackbox/contracts';

import {
  type CaptureClass,
  type CollectorConfig,
  type CollectorConfigInput,
  validateCollectorConfig,
} from './config.js';
import { CollectorError } from './errors.js';
import type { RedactorOptions } from './redaction.js';
import { LocalSpool, type RunHandle } from './spool.js';

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

  private constructor(spool: LocalSpool, handle: RunHandle) {
    this.#spool = spool;
    this.#handle = handle;
  }

  static open(
    configInput: CollectorConfigInput | CollectorConfig,
    redactorOptions: RedactorOptions = { environment: {} },
  ): CollectorSession {
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
    const spool = new LocalSpool(
      config,
      {},
      copyRedactorOptions(redactorOptions),
    ).open();
    try {
      return new CollectorSession(spool, spool.createRun());
    } catch (cause) {
      spool.close();
      throw cause;
    }
  }

  get runId(): string {
    return this.#handle.runId;
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

  observeGitDiffCaptured(input: {
    diff: Uint8Array;
    diffId: string;
    fileList: Uint8Array;
    fromSnapshotId: string;
    toSnapshotId: string;
  }): EvidenceEvent {
    return structuredClone(
      this.#spool.recordGitDiffCaptured(this.#handle, input),
    );
  }

  observeRunFinished(input: {
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
