import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { exactOwnedTempDirectory } from './e2e-owned-process.mjs';

const RESOURCE_ID = /^[a-f0-9]{48}$/;
const RESOURCE_NAME =
  /^(?:playwright|playwright-owner|server-application|server-worker)$/;
const ENVIRONMENT_NAME = 'BBX_E2E_PARENT_RESOURCE_IDS';

function canonicalResourceNames(resources) {
  if (
    !Array.isArray(resources) ||
    resources.length === 0 ||
    resources.length > 4 ||
    resources.some(
      (resource) =>
        typeof resource !== 'string' || !RESOURCE_NAME.test(resource),
    ) ||
    new Set(resources).size !== resources.length
  )
    throw new Error('Invalid E2E parent resource names.');
  return [...resources].sort();
}

function resourcePath(resource, resourceId) {
  if (!RESOURCE_NAME.test(resource) || !RESOURCE_ID.test(resourceId))
    throw new Error('Invalid E2E parent resource identity.');
  return exactOwnedTempDirectory(
    resolve(tmpdir(), `bbx-e2e-${resource}-${resourceId}`),
  );
}

export function createParentResourcePlan(resources, random = randomBytes) {
  const plan = new Map();
  for (const resource of canonicalResourceNames(resources)) {
    let resourceId;
    do {
      resourceId = random(24).toString('hex');
    } while (
      !RESOURCE_ID.test(resourceId) ||
      [...plan.values()].some((entry) => entry.resourceId === resourceId)
    );
    plan.set(
      resource,
      Object.freeze({
        resource,
        resourceId,
        metadataDirectory: resourcePath(resource, resourceId),
      }),
    );
  }
  return plan;
}

export function serializeParentResourcePlan(plan) {
  if (!(plan instanceof Map) || plan.size === 0 || plan.size > 4)
    throw new Error('Invalid E2E parent resource plan.');
  const serialized = {};
  for (const [resource, entry] of plan) {
    const expectedPath = resourcePath(resource, entry?.resourceId);
    if (entry.resource !== resource || entry.metadataDirectory !== expectedPath)
      throw new Error('Invalid E2E parent resource plan.');
    serialized[resource] = entry.resourceId;
  }
  return JSON.stringify(serialized);
}

export function parseParentResourcePlan(value, requiredResources) {
  const resources = canonicalResourceNames(requiredResources);
  if (typeof value !== 'string' || value.length < 2 || value.length > 512)
    throw new Error('Missing E2E parent resource plan.');
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error('Invalid E2E parent resource plan.', { cause: error });
  }
  if (
    parsed === null ||
    Array.isArray(parsed) ||
    typeof parsed !== 'object' ||
    Object.keys(parsed).sort().join('\0') !== resources.join('\0')
  )
    throw new Error('Invalid E2E parent resource plan.');
  const plan = new Map();
  const identities = new Set();
  for (const resource of resources) {
    const resourceId = parsed[resource];
    if (!RESOURCE_ID.test(resourceId) || identities.has(resourceId))
      throw new Error('Invalid E2E parent resource plan.');
    identities.add(resourceId);
    plan.set(
      resource,
      Object.freeze({
        resource,
        resourceId,
        metadataDirectory: resourcePath(resource, resourceId),
      }),
    );
  }
  return plan;
}

export function parentResourceEnvironment(plan, environment = process.env) {
  return {
    ...environment,
    [ENVIRONMENT_NAME]: serializeParentResourcePlan(plan),
  };
}

export function parentResourcePlanFromEnvironment(requiredResources) {
  return parseParentResourcePlan(
    process.env[ENVIRONMENT_NAME],
    requiredResources,
  );
}

export function createParentResourceRegistry(plan, importAuthority) {
  if (!(plan instanceof Map) || typeof importAuthority !== 'function')
    throw new Error('Invalid E2E parent resource registry.');
  const registrations = new Map(
    [...plan].map(([resource, entry]) => [
      resource,
      { entry, authority: undefined, completed: false },
    ]),
  );

  function accept(candidate, expectedRole) {
    const registration = registrations.get(candidate?.resource);
    if (
      candidate?.version !== 1 ||
      registration === undefined ||
      registration.completed ||
      registration.authority !== undefined ||
      candidate.resourceId !== registration.entry.resourceId ||
      typeof expectedRole !== 'string'
    )
      throw new Error('Invalid registered E2E resource authority.');
    const authority = importAuthority(candidate.authority, {
      role: expectedRole,
      metadataDirectory: registration.entry.metadataDirectory,
    });
    registration.authority = authority;
    return authority;
  }

  function complete(resource) {
    const registration = registrations.get(resource);
    if (registration === undefined || registration.completed)
      throw new Error('Invalid completed E2E resource identity.');
    registration.completed = true;
  }

  function entry(resource) {
    const registration = registrations.get(resource);
    if (registration === undefined)
      throw new Error('Unknown E2E parent resource identity.');
    return registration.entry;
  }

  function authorities() {
    return [...registrations.values()]
      .map((registration) => registration.authority)
      .filter((authority) => authority !== undefined);
  }

  return Object.freeze({ accept, authorities, complete, entry });
}

export const E2E_PARENT_RESOURCE_ENVIRONMENT = ENVIRONMENT_NAME;
