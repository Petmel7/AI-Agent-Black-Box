#!/usr/bin/env node

import { runCli } from './cli.js';

const termination = await runCli(process.argv.slice(2), {
  error: (message) => console.error(message),
  output: (message) => console.log(message),
});

if (typeof termination === 'number') process.exitCode = termination;
else if (termination.kind === 'exit') process.exitCode = termination.code;
else
  try {
    process.kill(process.pid, termination.signal);
  } catch {
    process.exitCode = termination.fallbackCode;
  }
