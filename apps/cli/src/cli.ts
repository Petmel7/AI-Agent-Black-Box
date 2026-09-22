export const CLI_VERSION = '0.1.0';

const HELP = `AI Agent Black Box collector

Usage: blackbox [options]

Options:
  -h, --help     Show help
  -v, --version  Show version
`;

export interface CliIo {
  error(message: string): void;
  output(message: string): void;
}

export function runCli(args: readonly string[], io: CliIo): number {
  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    io.output(HELP);
    return 0;
  }

  if (args.includes('--version') || args.includes('-v')) {
    io.output(CLI_VERSION);
    return 0;
  }

  io.error(`Unknown option: ${args[0] ?? ''}`);
  return 1;
}
