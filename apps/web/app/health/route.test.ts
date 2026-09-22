import { HealthResponseSchema } from '@blackbox/contracts';
import { describe, expect, it } from 'vitest';

import { GET } from './route';

describe('GET /health', () => {
  it('returns the shared healthy response contract', async () => {
    const response = GET();

    expect(response.status).toBe(200);
    expect(HealthResponseSchema.parse(await response.json())).toEqual({
      status: 'ok',
      service: 'web',
    });
  });
});
