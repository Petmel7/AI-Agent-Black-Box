import { fork, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// @ts-expect-error -- this Node-owned test helper intentionally executes as ESM.
import { removeExactOwnedTempDirectory } from './e2e-owned-process.mjs';
// @ts-expect-error -- this Node-owned test helper intentionally executes as ESM.
import { probeProcessState } from './e2e-process-control.mjs';
// @ts-expect-error -- this Node-owned test helper intentionally executes as ESM.
import { startWindowsLayerJob } from './e2e-windows-layer-job.mjs';
// @ts-expect-error -- this Node-owned test helper intentionally executes as ESM.
import { createParentResourcePlan } from './e2e-resource-registry.mjs';

const targetPath = fileURLToPath(
  new URL('./e2e-windows-layer-target.mjs', import.meta.url),
);
const INTERNAL_FAULT_CONTEXT = 'bbx-e2e-layer-job-fault-v1';

function layerMetadataDirectory() {
  return createParentResourcePlan(['playwright-owner']).get('playwright-owner')
    .metadataDirectory as string;
}

function startTarget() {
  return fork(targetPath, [], {
    detached: true,
    env: {
      ...process.env,
      BBX_E2E_INTERNAL_LAYER_TARGET_CONTEXT: 'bbx-e2e-layer-target-v1',
    },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    windowsHide: true,
  });
}

function waitForExit(child: ChildProcess, timeoutMs = 10_000) {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Windows layer process did not exit.')),
      timeoutMs,
    );
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function waitForReady(target: ChildProcess) {
  return new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Windows layer target did not become ready.')),
      5_000,
    );
    target.on('message', (message) => {
      const candidate = message as {
        descendantPid?: number;
        type?: string;
        version?: number;
      };
      if (
        candidate.type === 'ready' &&
        candidate.version === 1 &&
        Number.isSafeInteger(candidate.descendantPid)
      ) {
        clearTimeout(timeout);
        resolve(candidate.descendantPid!);
      }
    });
  });
}

async function waitForGuardianExit(processId: number, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (probeProcessState(processId) === 'absent') return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error('Windows layer guardian did not exit.');
}

async function terminateTarget(target: ChildProcess) {
  if (target.exitCode === null && target.signalCode === null)
    target.kill('SIGKILL');
  await waitForExit(target).catch(() => undefined);
}

const windowsIt = it.skipIf(process.platform !== 'win32');

describe('Windows layer Job immutable ownership', () => {
  windowsIt.each([
    ['owner creation identity mismatch', 'owner-identity'],
    ['target creation identity mismatch', 'target-identity'],
    ['simulated PID reuse', 'target-identity'],
    ['target exit before validation', 'target-exit'],
  ] as const)(
    'fails closed on %s',
    async (_label, faultInjection) => {
      const target = startTarget();
      try {
        await expect(
          startWindowsLayerJob({
            targetChild: target,
            role: 'playwright-owner',
            metadataDirectory: layerMetadataDirectory(),
            faultInjection,
            internalFaultContext: INTERNAL_FAULT_CONTEXT,
          }),
        ).rejects.toThrow();
      } finally {
        await terminateTarget(target);
      }
    },
    15_000,
  );

  windowsIt(
    'emits cleanup completion only after its descendant Job is empty',
    async () => {
      const target = startTarget();
      const layer = await startWindowsLayerJob({
        targetChild: target,
        role: 'playwright-owner',
        metadataDirectory: layerMetadataDirectory(),
      });
      try {
        const ready = waitForReady(target);
        target.send({ type: 'launch', version: 1 });
        const descendantPid = await ready;
        target.kill('SIGKILL');
        await waitForGuardianExit(layer.guardianProcessId);
        const evidence = JSON.parse(
          await readFile(
            join(layer.metadataDirectory, 'windows-layer-job-result.json'),
            'utf8',
          ),
        );
        expect(evidence).toEqual({
          version: 1,
          activeProcesses: 0,
          cleanupCompleted: true,
        });
        expect(probeProcessState(descendantPid)).toBe('absent');
      } finally {
        await terminateTarget(target);
        await removeExactOwnedTempDirectory(layer.metadataDirectory);
      }
    },
    20_000,
  );

  windowsIt(
    'fails when Job convergence cannot be proved before the shared deadline',
    async () => {
      const target = startTarget();
      const layer = await startWindowsLayerJob({
        targetChild: target,
        role: 'playwright-owner',
        metadataDirectory: layerMetadataDirectory(),
        faultInjection: 'convergence-timeout',
        internalFaultContext: INTERNAL_FAULT_CONTEXT,
      });
      try {
        target.kill('SIGKILL');
        await waitForGuardianExit(layer.guardianProcessId, 12_000);
        expect(
          JSON.parse(
            await readFile(
              join(layer.metadataDirectory, 'windows-layer-job-result.json'),
              'utf8',
            ),
          ),
        ).toMatchObject({
          version: 1,
          cleanupCompleted: false,
          failureStage: 5,
        });
      } finally {
        await terminateTarget(target);
        await removeExactOwnedTempDirectory(layer.metadataDirectory);
      }
    },
    20_000,
  );

  windowsIt(
    'keeps concurrent valid layer owners isolated',
    async () => {
      const first = startTarget();
      const second = startTarget();
      const firstLayer = await startWindowsLayerJob({
        targetChild: first,
        role: 'playwright-owner',
        metadataDirectory: layerMetadataDirectory(),
      });
      const secondLayer = await startWindowsLayerJob({
        targetChild: second,
        role: 'playwright-owner',
        metadataDirectory: layerMetadataDirectory(),
      });
      try {
        first.kill('SIGKILL');
        await waitForGuardianExit(firstLayer.guardianProcessId);
        expect(probeProcessState(second.pid!)).toBe('live');
        second.kill('SIGKILL');
        await waitForGuardianExit(secondLayer.guardianProcessId);
      } finally {
        await terminateTarget(first);
        await terminateTarget(second);
        await removeExactOwnedTempDirectory(firstLayer.metadataDirectory);
        await removeExactOwnedTempDirectory(secondLayer.metadataDirectory);
      }
    },
    25_000,
  );
});
