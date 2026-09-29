import { UuidSchema } from '@blackbox/contracts';

import {
  CollectorWorkSpool,
  collectorConfigFromEnvironment,
  composeCollectorFromEnvironment,
} from './collector/index.js';
import { auditArtifacts } from './collector/artifacts.js';
import {
  DeliveryCoordinator,
  type DeliveryDrainResult,
} from './collector/coordinator.js';
import { deliveryConfigFromEnvironment } from './collector/delivery-config.js';
import { LocalSpool } from './collector/spool.js';
import {
  runWrappedProcess,
  type ProcessRunnerDependencies,
  type WrappedTermination,
} from './process-runner.js';

export const CLI_VERSION = '0.1.0';

const HELP = `AI Agent Black Box collector

Usage: blackbox [options]
       blackbox status [--json] [--run <run-id>]
       blackbox retry [--json] [--run <run-id>]
       blackbox run -- <command> [arguments...]

Options:
  -h, --help     Show help
  -v, --version  Show version

Commands:
  status         Show content-free local spool health and pending work
  retry          Perform one bounded delivery drain and exit
  run            Record one directly spawned child process
`;

export interface CliIo {
  error(message: string): void;
  output(message: string): void;
}

export interface CliRuntime {
  env?: NodeJS.ProcessEnv;
  processRunnerDependencies?: ProcessRunnerDependencies;
}

export type CliTermination = number | WrappedTermination;

function renderHumanStatus(
  status: ReturnType<LocalSpool['status']>,
  files: ReturnType<typeof auditArtifacts>,
): string {
  return [
    `Runs: active=${status.runs.active} closed=${status.runs.closed} interrupted=${status.runs.interrupted}`,
    `Batches: pending=${status.batches.pending} retry-delayed=${status.retryDelayed.batches} leased=${status.batches.leased} delivered=${status.batches.delivered} blocked=${status.batches.blocked} superseded=${status.batches.superseded}`,
    `Artifacts: pending=${status.artifacts.pending} retry-delayed=${status.retryDelayed.artifacts} leased=${status.artifacts.leased} verified=${status.artifacts.verified} blocked=${status.artifacts.blocked}`,
    `Stored bytes: total=${status.bytes.total} events=${status.bytes.events} batches=${status.bytes.batches} artifacts=${status.bytes.artifacts}`,
    `Unbatched events: ${status.unbatchedEvents}`,
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

function renderHumanRetry(result: DeliveryDrainResult): string {
  return [
    `Delivery: stopped=${result.stopped} attempts=${result.attempts} claimed=${result.claimedItems} prepared=${result.preparedBatches}`,
    `Batches: delivered=${result.batches.delivered} retried=${result.batches.retried} blocked=${result.batches.blocked} superseded=${result.batches.superseded}`,
    `Artifacts: verified=${result.artifacts.verified} retried=${result.artifacts.retried} blocked=${result.artifacts.blocked}`,
    `Remaining: ready-or-delayed=${result.remaining.readyOrDelayed} blocked=${result.remaining.blocked}`,
    `Safe codes: ${
      Object.entries(result.safeCodes)
        .map(([code, count]) => `${code}=${count}`)
        .join(' ') || 'none'
    }`,
  ].join('\n');
}

function parseScopedArguments(
  args: readonly string[],
): { json: boolean; runId?: string } | undefined {
  let json = false;
  let runId: string | undefined;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--json' && !json) json = true;
    else if (argument === '--run' && runId === undefined) {
      const candidate = args[index + 1];
      if (!UuidSchema.safeParse(candidate).success) return undefined;
      runId = candidate;
      index += 1;
    } else return undefined;
  }
  return { json, ...(runId ? { runId } : {}) };
}

export async function runCli(
  args: readonly string[],
  io: CliIo,
  runtime: CliRuntime = {},
): Promise<CliTermination> {
  if (
    args.length === 0 ||
    (args[0] !== 'run' && (args.includes('--help') || args.includes('-h')))
  ) {
    io.output(HELP);
    return 0;
  }

  if (
    args[0] !== 'run' &&
    (args.includes('--version') || args.includes('-v'))
  ) {
    io.output(CLI_VERSION);
    return 0;
  }

  if (args[0] === 'status') {
    const parsed = parseScopedArguments(args);
    if (!parsed) {
      io.error('Invalid status arguments');
      return 1;
    }
    try {
      const env = runtime.env ?? process.env;
      const config = collectorConfigFromEnvironment(env);
      using spool = new LocalSpool(config).open();
      const status = spool.status(parsed.runId);
      const files = auditArtifacts(spool);
      io.output(
        parsed.json
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

  if (args[0] === 'retry') {
    const parsed = parseScopedArguments(args);
    if (!parsed) {
      io.error('Invalid retry arguments');
      return 1;
    }
    try {
      const env = runtime.env ?? process.env;
      const local = collectorConfigFromEnvironment(env);
      const remote = deliveryConfigFromEnvironment(env);
      if (remote.state === 'offline') {
        const offline = {
          schemaVersion: 1 as const,
          state: 'offline' as const,
        };
        io.output(
          parsed.json
            ? JSON.stringify(offline)
            : 'Delivery unavailable: offline configuration',
        );
        return 2;
      }
      using spool = CollectorWorkSpool.open({
        captureClasses: [...local.captureClasses],
        inputLimitBytes: local.inputLimitBytes,
        ...(local.repositoryRoot
          ? { repositoryRoot: local.repositoryRoot }
          : {}),
        spoolQuotaBytes: local.spoolQuotaBytes,
        spoolRoot: local.spoolRoot,
      });
      const result = await new DeliveryCoordinator(spool, remote.config).drain(
        parsed.runId,
      );
      io.output(
        parsed.json ? JSON.stringify(result) : renderHumanRetry(result),
      );
      return result.remaining.blocked === 0 &&
        result.remaining.readyOrDelayed === 0
        ? 0
        : 2;
    } catch (error) {
      io.error(
        error instanceof Error && 'code' in error
          ? `Retry unavailable: ${String(error.code)}`
          : 'Retry unavailable: collection-failed',
      );
      return 1;
    }
  }

  if (args[0] === 'run') {
    if (args[1] !== '--' || args.length < 3 || args[2] === '') {
      io.error('Invalid run arguments');
      return 1;
    }
    try {
      const env = runtime.env ?? process.env;
      const delivery = deliveryConfigFromEnvironment(env);
      const composition = composeCollectorFromEnvironment(
        env,
        delivery.state === 'configured' ? [delivery.config.apiToken] : [],
      );
      return await runWrappedProcess(
        args[2]!,
        args.slice(3),
        env,
        composition,
        delivery,
        { warning: (message) => io.error(message) },
        runtime.processRunnerDependencies,
      );
    } catch (error) {
      io.error(
        error instanceof Error && 'code' in error
          ? `Run unavailable: ${String(error.code)}`
          : 'Run unavailable: collection-failed',
      );
      return 1;
    }
  }

  io.error(`Unknown option: ${args[0] ?? ''}`);
  return 1;
}
