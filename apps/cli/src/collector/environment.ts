import {
  type CaptureClass,
  type CollectorConfig,
  validateCollectorConfig,
} from './config.js';
import { CollectorError } from './errors.js';
import type { RedactorOptions } from './redaction.js';

function positiveInteger(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new CollectorError(
      'invalid-config',
      'numeric collector configuration is invalid',
    );
  return parsed;
}

function list(value: string | undefined): string[] {
  return value
    ? value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

export interface CollectorComposition {
  config: CollectorConfig;
  redactorOptions: RedactorOptions;
}

export function collectorConfigFromEnvironment(
  env: NodeJS.ProcessEnv,
): CollectorConfig {
  const quota = positiveInteger(env.BLACKBOX_SPOOL_QUOTA_BYTES);
  const inputLimit = positiveInteger(env.BLACKBOX_CAPTURE_INPUT_BYTES);
  return validateCollectorConfig({
    captureClasses: list(env.BLACKBOX_CAPTURE_CLASSES) as CaptureClass[],
    ...(inputLimit === undefined ? {} : { inputLimitBytes: inputLimit }),
    ...(env.BLACKBOX_REPOSITORY_ROOT
      ? { repositoryRoot: env.BLACKBOX_REPOSITORY_ROOT }
      : {}),
    ...(quota === undefined ? {} : { spoolQuotaBytes: quota }),
    ...(env.BLACKBOX_SPOOL_DIR ? { spoolRoot: env.BLACKBOX_SPOOL_DIR } : {}),
  });
}

export function composeCollectorFromEnvironment(
  env: NodeJS.ProcessEnv,
  collectorCredentials: readonly string[] = [],
): CollectorComposition {
  const config = collectorConfigFromEnvironment(env);
  const redactorOptions: RedactorOptions = {
    collectorCredentials,
    environment: env,
    explicitEnvironmentNames: list(env.BLACKBOX_REDACT_ENV_NAMES),
    ...(env.BLACKBOX_REDACT_LITERAL_FILE
      ? { literalFilePath: env.BLACKBOX_REDACT_LITERAL_FILE }
      : {}),
    ...(config.repositoryRoot ? { repositoryRoot: config.repositoryRoot } : {}),
  };
  return { config, redactorOptions };
}
