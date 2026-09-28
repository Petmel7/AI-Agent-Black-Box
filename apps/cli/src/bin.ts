#!/usr/bin/env node

import { runCli } from './cli.js';

process.exitCode = await runCli(process.argv.slice(2), {
  error: (message) => console.error(message),
  output: (message) => console.log(message),
});
