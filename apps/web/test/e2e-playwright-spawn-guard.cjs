'use strict';

/* eslint-disable @typescript-eslint/no-require-imports -- Node preloads must load before ESM consumers. */

const childProcess = require('node:child_process');
const { createHash } = require('node:crypto');
const { realpathSync, readFileSync } = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const { isAbsolute, relative } = require('node:path');

const GUARD_VERSION = 2;
const MARKER_NAME = 'BBX_E2E_PLAYWRIGHT_SPAWN_GUARD';
const MARKER_VALUE = 'bbx-e2e-playwright-spawn-guard-v2';
const AUTHORITY_NAME = 'BBX_E2E_LINUX_GROUP_AUTHORITY';
const TOKEN_NAME = 'BBX_E2E_OWNERSHIP_TOKEN';
const PRELOAD_PATH = realpathSync(__filename);
const TEST_DIRECTORY = realpathSync(__dirname);
const ACTIVE_SYMBOL = Symbol.for('blackbox.e2e.playwrightSpawnGuard');
const MAX_LINUX_PID = 2_147_483_647;

function guardedError(message) {
  return Object.assign(new Error(message), {
    code: 'e2e-playwright-spawn-guard-invalid',
  });
}

function noSuchGuardedProcessError() {
  return Object.assign(new Error('Guarded child process is not available.'), {
    code: 'ESRCH',
    errno: -3,
    syscall: 'kill',
  });
}

function assertRepositoryOwnedPreload(path = PRELOAD_PATH) {
  if (typeof path !== 'string' || !isAbsolute(path))
    throw guardedError('Playwright spawn-guard preload path is invalid.');
  const canonical = realpathSync(path);
  const location = relative(TEST_DIRECTORY, canonical);
  if (
    canonical !== PRELOAD_PATH ||
    location.startsWith('..') ||
    isAbsolute(location)
  )
    throw guardedError(
      'Playwright spawn-guard preload is not repository-owned.',
    );
  return canonical;
}

function canonicalNodeOptions(preloadPath = PRELOAD_PATH) {
  const canonical = assertRepositoryOwnedPreload(preloadPath);
  return `--require=${JSON.stringify(canonical)}`;
}

function assertCanonicalLaunch(
  nodeOptions,
  execArguments = process.execArgv,
  preloadPath = PRELOAD_PATH,
) {
  if (nodeOptions !== canonicalNodeOptions(preloadPath))
    throw guardedError('Playwright spawn-guard preload is not canonical.');
  if (!Array.isArray(execArguments) || execArguments.length !== 0)
    throw guardedError('Guarded Playwright Node arguments are not canonical.');
  return true;
}

function contextDigest(authority, token) {
  return createHash('sha256')
    .update(String(authority), 'utf8')
    .update('\0', 'utf8')
    .update(String(token), 'utf8')
    .digest('hex');
}

function parseLinuxIdentity(statText) {
  const closing = statText.lastIndexOf(')');
  if (closing < 1) throw guardedError('Linux process identity is malformed.');
  const fields = statText
    .slice(closing + 2)
    .trim()
    .split(/\s+/);
  const processGroupId = Number(fields[2]);
  const sessionId = Number(fields[3]);
  if (
    !Number.isSafeInteger(processGroupId) ||
    processGroupId < 1 ||
    !Number.isSafeInteger(sessionId) ||
    sessionId < 1
  )
    throw guardedError('Linux process identity is invalid.');
  return Object.freeze({ processGroupId, sessionId });
}

function parseLinuxChildIdentity(statText) {
  const closing = statText.lastIndexOf(')');
  if (closing < 1) throw guardedError('Linux child identity is malformed.');
  const fields = statText
    .slice(closing + 2)
    .trim()
    .split(/\s+/);
  const processGroupId = Number(fields[2]);
  const sessionId = Number(fields[3]);
  const startTime = fields[19];
  if (
    !Number.isSafeInteger(processGroupId) ||
    processGroupId < 1 ||
    !Number.isSafeInteger(sessionId) ||
    sessionId < 1 ||
    typeof startTime !== 'string' ||
    !/^[0-9]{1,32}$/.test(startTime)
  )
    throw guardedError('Linux child identity is invalid.');
  return Object.freeze({ processGroupId, sessionId, startTime });
}

function readLinuxChildIdentity(processId) {
  return parseLinuxChildIdentity(
    readFileSync(`/proc/${processId}/stat`, 'utf8'),
  );
}

function validateOwnershipContext(
  environment,
  identityText,
  execArguments = process.execArgv,
) {
  if (
    environment?.[MARKER_NAME] !== MARKER_VALUE ||
    typeof environment[AUTHORITY_NAME] !== 'string' ||
    typeof environment[TOKEN_NAME] !== 'string'
  )
    throw guardedError('Guarded Playwright ownership context is incomplete.');
  assertCanonicalLaunch(environment.NODE_OPTIONS, execArguments);
  let authority;
  try {
    authority = JSON.parse(environment[AUTHORITY_NAME]);
  } catch {
    throw guardedError('Guarded Playwright ownership authority is malformed.');
  }
  const ownership = authority?.ownershipIdentity;
  if (
    authority?.version !== 1 ||
    authority.platform !== 'linux' ||
    authority.role !== 'playwright' ||
    !ownership ||
    !Number.isSafeInteger(ownership.processGroupId) ||
    !Number.isSafeInteger(ownership.sessionId) ||
    ownership.processGroupId < 1 ||
    ownership.sessionId < 1 ||
    ownership.processGroupId !== ownership.sessionId ||
    ownership.ownershipToken !== environment[TOKEN_NAME]
  )
    throw guardedError('Guarded Playwright ownership authority is invalid.');
  const current = parseLinuxIdentity(
    identityText ?? readFileSync('/proc/self/stat', 'utf8'),
  );
  if (
    current.processGroupId !== ownership.processGroupId ||
    current.sessionId !== ownership.sessionId
  )
    throw guardedError('Guarded Playwright process left its authorized group.');
  return Object.freeze({
    authority: environment[AUTHORITY_NAME],
    contextDigest: contextDigest(
      environment[AUTHORITY_NAME],
      environment[TOKEN_NAME],
    ),
    nodeOptions: environment.NODE_OPTIONS,
    ownershipIdentity: Object.freeze({
      processGroupId: ownership.processGroupId,
      sessionId: ownership.sessionId,
    }),
    token: environment[TOKEN_NAME],
  });
}

function assertInheritedContext(environment, expected) {
  if (
    environment?.[MARKER_NAME] !== MARKER_VALUE ||
    environment[AUTHORITY_NAME] !== expected.authority ||
    environment[TOKEN_NAME] !== expected.token ||
    environment.NODE_OPTIONS !== expected.nodeOptions
  )
    throw guardedError(
      'A guarded Playwright descendant contradicted ownership.',
    );
}

function guardedSpawnArguments(argumentsList, expectedContext) {
  const [command, argumentsOrOptions, maybeOptions] = argumentsList;
  const hasArguments = Array.isArray(argumentsOrOptions);
  const options = hasArguments ? maybeOptions : argumentsOrOptions;
  assertInheritedContext(options?.env ?? process.env, expectedContext);
  const guardedOptions = { ...(options ?? {}), detached: false };
  return hasArguments
    ? [command, argumentsOrOptions, guardedOptions]
    : [command, guardedOptions];
}

function createGuardedChildRegistry(options = {}) {
  const readProcessIdentity =
    options.readProcessIdentity ?? readLinuxChildIdentity;
  if (typeof readProcessIdentity !== 'function')
    throw guardedError('Guarded child identity reader is invalid.');
  const active = new Map();
  const retired = new Set();
  let nextGeneration = 1;

  function invalidate(record) {
    record.live = false;
    retired.add(record.pid);
    if (active.get(record.pid) === record) active.delete(record.pid);
  }

  function track(child) {
    if (
      child === null ||
      typeof child !== 'object' ||
      typeof child.prependOnceListener !== 'function'
    )
      throw guardedError('Guarded Playwright child identity is invalid.');
    const record = {
      child,
      generation: nextGeneration++,
      live: false,
      operatingSystemIdentity: undefined,
      pid: undefined,
    };
    const onSpawn = () => {
      const pid = child.pid;
      let operatingSystemIdentity;
      try {
        operatingSystemIdentity = readProcessIdentity(pid);
      } catch {
        if (Number.isSafeInteger(pid) && pid > 0) retired.add(pid);
        return;
      }
      if (
        !Number.isSafeInteger(pid) ||
        pid < 2 ||
        pid > MAX_LINUX_PID ||
        retired.has(pid) ||
        active.has(pid) ||
        typeof operatingSystemIdentity?.startTime !== 'string' ||
        (options.expectedProcessGroupId !== undefined &&
          operatingSystemIdentity.processGroupId !==
            options.expectedProcessGroupId) ||
        (options.expectedSessionId !== undefined &&
          operatingSystemIdentity.sessionId !== options.expectedSessionId)
      ) {
        if (Number.isSafeInteger(pid) && pid > 0) retired.add(pid);
        return;
      }
      record.pid = pid;
      record.operatingSystemIdentity = operatingSystemIdentity;
      record.live = true;
      active.set(pid, record);
    };
    const onExit = () => {
      if (record.pid !== undefined) invalidate(record);
    };
    child.prependOnceListener('spawn', onSpawn);
    child.prependOnceListener('exit', onExit);
    child.prependOnceListener('error', onExit);
    return Object.freeze({ generation: record.generation, record });
  }

  function kill(processId, signal) {
    if (
      !Number.isSafeInteger(processId) ||
      Object.is(processId, -0) ||
      processId >= 0 ||
      processId === -1 ||
      processId < -MAX_LINUX_PID
    )
      throw noSuchGuardedProcessError();
    const pid = -processId;
    const record = active.get(pid);
    let currentIdentity;
    try {
      currentIdentity = readProcessIdentity(pid);
    } catch {
      if (record !== undefined) invalidate(record);
      throw noSuchGuardedProcessError();
    }
    if (
      record === undefined ||
      !record.live ||
      record.pid !== pid ||
      record.child.pid !== pid ||
      record.child.exitCode !== null ||
      record.child.signalCode !== null ||
      currentIdentity.processGroupId !==
        record.operatingSystemIdentity.processGroupId ||
      currentIdentity.sessionId !== record.operatingSystemIdentity.sessionId ||
      currentIdentity.startTime !== record.operatingSystemIdentity.startTime
    ) {
      if (record !== undefined) invalidate(record);
      throw noSuchGuardedProcessError();
    }
    let signaled;
    try {
      signaled = record.child.kill(signal);
    } catch (error) {
      if (error?.code === 'ESRCH') {
        invalidate(record);
        throw noSuchGuardedProcessError();
      }
      throw error;
    }
    if (!signaled) {
      invalidate(record);
      throw noSuchGuardedProcessError();
    }
    return true;
  }

  return Object.freeze({
    activeCount: () => active.size,
    kill,
    track,
  });
}

function createGuardedEnvironment(environment, authority) {
  if (process.platform !== 'linux') return { ...environment };
  if (
    environment?.[MARKER_NAME] !== undefined ||
    typeof authority !== 'object' ||
    authority === null
  )
    throw guardedError('Guarded Playwright environment is invalid.');
  const guarded = {
    ...environment,
    [MARKER_NAME]: MARKER_VALUE,
    [AUTHORITY_NAME]: JSON.stringify(authority),
    NODE_OPTIONS: canonicalNodeOptions(),
  };
  // The owner validates the exact argument-free Node launch it is about to
  // create, not any execArgv inherited by the unguarded owner process itself.
  validateOwnershipContext(guarded, undefined, []);
  return guarded;
}

function createGuardedKill(registry, originalKill) {
  if (
    typeof registry?.kill !== 'function' ||
    typeof originalKill !== 'function'
  )
    throw guardedError('Guarded Playwright kill boundary is invalid.');
  return function guardedKill(processId, signal) {
    if (Number.isSafeInteger(processId) && processId > 0)
      return Reflect.apply(originalKill, this, [processId, signal]);
    return registry.kill(processId, signal);
  };
}

function defineImmutableFunction(target, name, value) {
  Object.defineProperty(target, name, {
    configurable: false,
    enumerable: true,
    value,
    writable: false,
  });
}

function activate() {
  if (process.platform !== 'linux') return false;
  const marker = process.env[MARKER_NAME];
  if (marker === undefined) return false;
  if (marker !== MARKER_VALUE)
    throw guardedError('Guarded Playwright marker is invalid.');
  if (globalThis[ACTIVE_SYMBOL] !== undefined)
    throw guardedError('Playwright spawn guard was loaded more than once.');
  const expectedContext = validateOwnershipContext(process.env);
  const originalSpawn = childProcess.spawn;
  const originalKill = process.kill;
  const registry = createGuardedChildRegistry({
    expectedProcessGroupId: expectedContext.ownershipIdentity.processGroupId,
    expectedSessionId: expectedContext.ownershipIdentity.sessionId,
  });
  const guardedSpawn = function guardedSpawn(...argumentsList) {
    const options = Array.isArray(argumentsList[1])
      ? argumentsList[2]
      : argumentsList[1];
    const detachedRequested = options?.detached === true;
    const child = Reflect.apply(
      originalSpawn,
      this,
      guardedSpawnArguments(argumentsList, expectedContext),
    );
    if (detachedRequested) registry.track(child);
    return child;
  };
  const guardedKill = createGuardedKill(registry, originalKill);
  defineImmutableFunction(childProcess, 'spawn', guardedSpawn);
  defineImmutableFunction(process, 'kill', guardedKill);
  syncBuiltinESMExports();
  const attestation = Object.freeze({
    contextDigest: expectedContext.contextDigest,
    guardedKill,
    guardedSpawn,
    marker: MARKER_VALUE,
    nodeOptions: expectedContext.nodeOptions,
    preloadPath: PRELOAD_PATH,
    version: GUARD_VERSION,
  });
  Object.defineProperty(globalThis, ACTIVE_SYMBOL, {
    configurable: false,
    enumerable: false,
    value: attestation,
    writable: false,
  });
  return true;
}

activate();

module.exports = Object.freeze({
  ACTIVE_SYMBOL,
  AUTHORITY_NAME,
  GUARD_VERSION,
  MARKER_NAME,
  MARKER_VALUE,
  MAX_LINUX_PID,
  PRELOAD_PATH,
  activate,
  assertCanonicalLaunch,
  assertInheritedContext,
  assertRepositoryOwnedPreload,
  canonicalNodeOptions,
  contextDigest,
  createGuardedChildRegistry,
  createGuardedEnvironment,
  createGuardedKill,
  guardedSpawnArguments,
  parseLinuxIdentity,
  parseLinuxChildIdentity,
  readLinuxChildIdentity,
  validateOwnershipContext,
});
