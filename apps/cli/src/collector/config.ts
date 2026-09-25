import { homedir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';

import { CollectorError } from './errors.js';

export const DEFAULT_SPOOL_QUOTA_BYTES = 1_000_000_000;
export const DEFAULT_CAPTURE_INPUT_BYTES = 10_000_000;
export const MAX_CAPTURE_INPUT_BYTES = 50_000_000;
export const MAX_LITERAL_RULES = 256;
export const MAX_LITERAL_BYTES = 4_096;

export const CAPTURE_CLASSES = [
  'task-description',
  'command',
  'working-directory',
  'stdout',
  'stderr',
  'tool-input',
  'tool-output',
  'provider-payload',
  'file-content',
] as const;

export type CaptureClass = (typeof CAPTURE_CLASSES)[number];

export interface CollectorConfig {
  captureClasses: ReadonlySet<CaptureClass>;
  inputLimitBytes: number;
  repositoryRoot?: string;
  spoolQuotaBytes: number;
  spoolRoot: string;
}

export interface CollectorConfigInput {
  captureClasses?: readonly string[];
  inputLimitBytes?: number;
  repositoryRoot?: string;
  spoolQuotaBytes?: number;
  spoolRoot?: string;
}

export interface PlatformLocations {
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
}

export function defaultSpoolRoot(locations: PlatformLocations = {}): string {
  const env = locations.env ?? process.env;
  const home = locations.home ?? homedir();
  const platform = locations.platform ?? process.platform;
  if (platform === 'win32') {
    return resolve(
      env.LOCALAPPDATA ?? env.APPDATA ?? home,
      'AI-Agent-Black-Box',
      'spool',
    );
  }
  if (platform === 'darwin') {
    return resolve(
      home,
      'Library',
      'Application Support',
      'ai-agent-black-box',
      'spool',
    );
  }
  return resolve(
    env.XDG_DATA_HOME ?? resolve(home, '.local', 'share'),
    'ai-agent-black-box',
    'spool',
  );
}

function assertPositiveInteger(
  value: number,
  maximum: number,
  field: string,
): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new CollectorError(
      'invalid-config',
      `${field} is outside its supported range`,
    );
  }
}

function containsPath(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

export function validateCollectorConfig(
  input: CollectorConfigInput = {},
): CollectorConfig {
  const spoolRoot = resolve(input.spoolRoot ?? defaultSpoolRoot());
  const repositoryRoot = input.repositoryRoot
    ? resolve(input.repositoryRoot)
    : undefined;
  const inputLimitBytes = input.inputLimitBytes ?? DEFAULT_CAPTURE_INPUT_BYTES;
  const spoolQuotaBytes = input.spoolQuotaBytes ?? DEFAULT_SPOOL_QUOTA_BYTES;
  assertPositiveInteger(
    inputLimitBytes,
    MAX_CAPTURE_INPUT_BYTES,
    'capture input limit',
  );
  assertPositiveInteger(
    spoolQuotaBytes,
    Number.MAX_SAFE_INTEGER,
    'spool quota',
  );
  if (repositoryRoot && containsPath(repositoryRoot, spoolRoot)) {
    throw new CollectorError(
      'invalid-config',
      'spool root must be outside the captured repository',
    );
  }

  const requested = input.captureClasses ?? [];
  const allowed = new Set<string>(CAPTURE_CLASSES);
  if (requested.some((captureClass) => !allowed.has(captureClass))) {
    throw new CollectorError(
      'invalid-config',
      'capture profile contains an unsupported class',
    );
  }
  return {
    captureClasses: new Set(requested as CaptureClass[]),
    inputLimitBytes,
    spoolQuotaBytes,
    spoolRoot,
    ...(repositoryRoot ? { repositoryRoot } : {}),
  };
}
