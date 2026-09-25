import { UuidSchema } from '@blackbox/contracts';

import { collectorConfigFromEnvironment } from './collector/index.js';
import { auditArtifacts } from './collector/artifacts.js';
import { LocalSpool } from './collector/spool.js';

export const CLI_VERSION = '0.1.0';

const HELP = `AI Agent Black Box collector

Usage: blackbox [options]
       blackbox status [--json] [--run <run-id>]

Options:
  -h, --help     Show help
  -v, --version  Show version

Commands:
  status         Show content-free local spool health and pending work
`;

export interface CliIo {
  error(message: string): void;
  output(message: string): void;
}

export interface CliRuntime {
  env?: NodeJS.ProcessEnv;
}

function renderHumanStatus(
  status: ReturnType<LocalSpool['status']>,
  files: ReturnType<typeof auditArtifacts>,
): string {
  return [
    `Runs: active=${status.runs.active} closed=${status.runs.closed} interrupted=${status.runs.interrupted}`,
    `Batches: pending=${status.batches.pending} retry-delayed=${status.retryDelayed.batches} leased=${status.batches.leased} delivered=${status.batches.delivered} blocked=${status.batches.blocked} superseded=${status.batches.superseded}`,
    `Artifacts: pending=${status.artifacts.pending} retry-delayed=${status.retryDelayed.artifacts} leased=${status.artifacts.leased} verified=${status.artifacts.verified} blocked=${status.artifacts.blocked}`,
    `Stored bytes: total=${status.bytes.total} events=${status.bytes.events} batches=${status.bytes.batches} artifacts=${status.bytes.artifacts}`,
    `Filesystem: missing=${files.missing} corrupt=${files.corrupt} orphan-final=${files.orphanFinal} orphan-temporary=${files.orphanTemporary}`,
    `Next retry: ${status.nextRetryAt ?? 'none'}`,
    `Diagnostics: ${
      Object.entries(status.diagnostics)
        .map(([code, count]) => `${code}=${count}`)
        .join(' ') || 'none'
    }`,
    `Work errors: ${
      Object.entries(status.workErrorCodes)
        .map(([code, count]) => `${code}=${count}`)
        .join(' ') || 'none'
    }`,
  ].join('\n');
}

export function runCli(
  args: readonly string[],
  io: CliIo,
  runtime: CliRuntime = {},
): number {
  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    io.output(HELP);
    return 0;
  }

  if (args.includes('--version') || args.includes('-v')) {
    io.output(CLI_VERSION);
    return 0;
  }

  if (args[0] === 'status') {
    const supported = new Set(['status', '--json', '--run']);
    if (
      args.some(
        (argument, index) =>
          index > 0 && !supported.has(argument) && args[index - 1] !== '--run',
      )
    ) {
      io.error('Invalid status arguments');
      return 1;
    }
    const runIndex = args.indexOf('--run');
    const runId = runIndex >= 0 ? args[runIndex + 1] : undefined;
    if (runIndex >= 0 && !UuidSchema.safeParse(runId).success) {
      io.error('Invalid run identifier');
      return 1;
    }
    try {
      const env = runtime.env ?? process.env;
      const config = collectorConfigFromEnvironment(env);
      using spool = new LocalSpool(config).open();
      const status = spool.status(runId);
      const files = auditArtifacts(spool);
      io.output(
        args.includes('--json')
          ? JSON.stringify({ schemaVersion: 1, ...status, filesystem: files })
          : renderHumanStatus(status, files),
      );
      return Object.values(files).some((count) => count > 0) ? 2 : 0;
    } catch (error) {
      io.error(
        error instanceof Error && 'code' in error
          ? `Status unavailable: ${String(error.code)}`
          : 'Status unavailable: collection-failed',
      );
      return 1;
    }
  }

  io.error(`Unknown option: ${args[0] ?? ''}`);
  return 1;
}
