import { HealthResponseSchema } from '@blackbox/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from './app.js';

const apps: ReturnType<typeof buildApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('GET /health', () => {
  it('returns the shared healthy response contract', async () => {
    const app = buildApp();
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(HealthResponseSchema.parse(response.json())).toEqual({
      status: 'ok',
      service: 'ingest',
    });
  });
});
