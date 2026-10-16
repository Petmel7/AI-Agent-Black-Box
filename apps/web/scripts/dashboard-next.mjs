#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';

const GENERIC_CONFIGURATION_ERROR =
  'Dashboard Web server configuration is invalid.';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1']);
const SIGNAL_EXIT_CODES = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};

function isPrivateIpv4(host) {
  const [first, second] = host.split('.').map(Number);
  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function isPrivateBinding(host) {
  if (LOOPBACK_HOSTS.has(host)) return true;
  const version = isIP(host);
  if (version === 4) return isPrivateIpv4(host);
  if (version !== 6) return false;
  const normalized = host.toLowerCase();
  return normalized.startsWith('fc') || normalized.startsWith('fd');
}

function failConfiguration() {
  console.error(GENERIC_CONFIGURATION_ERROR);
  process.exitCode = 1;
}

function hasHostnameOverride(arguments_) {
  return arguments_.some(
    (argument) =>
      argument === '-H' ||
      argument.startsWith('-H=') ||
      argument.startsWith('-H') ||
      argument === '--hostname' ||
      argument.startsWith('--hostname='),
  );
}

const [mode, ...nextArguments] = process.argv.slice(2);
const bindHost = process.env.DASHBOARD_SERVER_BIND_HOST;
const allowInsecureLoopback =
  process.env.DASHBOARD_ALLOW_INSECURE_LOOPBACK ?? 'false';

if (
  (mode !== 'dev' && mode !== 'start') ||
  bindHost === undefined ||
  bindHost.length === 0 ||
  bindHost !== bindHost.trim() ||
  !isPrivateBinding(bindHost) ||
  (allowInsecureLoopback !== 'true' && allowInsecureLoopback !== 'false') ||
  (allowInsecureLoopback === 'true' &&
    (mode === 'start' ||
      process.env.NODE_ENV === 'production' ||
      !LOOPBACK_HOSTS.has(bindHost))) ||
  hasHostnameOverride(nextArguments)
) {
  failConfiguration();
} else {
  const nextBin = fileURLToPath(
    new URL('../node_modules/next/dist/bin/next', import.meta.url),
  );
  const child = spawn(
    process.execPath,
    [nextBin, mode, '--hostname', bindHost, ...nextArguments],
    {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: process.env,
      stdio: 'inherit',
    },
  );

  let spawnFailed = false;
  child.once('error', () => {
    spawnFailed = true;
    console.error('Dashboard Web server failed to start.');
    process.exitCode = 1;
  });

  for (const signal of Object.keys(SIGNAL_EXIT_CODES)) {
    process.once(signal, () => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill(signal);
    });
  }

  child.once('exit', (code, signal) => {
    if (spawnFailed) return;
    process.exitCode = code ?? SIGNAL_EXIT_CODES[signal] ?? 1;
  });
}
