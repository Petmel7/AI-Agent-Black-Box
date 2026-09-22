import { describe, expect, it } from 'vitest';

import { HealthResponseSchema } from './index.js';

describe('HealthResponseSchema', () => {
  it('accepts a healthy service response', () => {
    expect(
      HealthResponseSchema.parse({ status: 'ok', service: 'ingest' }),
    ).toEqual({ status: 'ok', service: 'ingest' });
  });

  it('rejects an invalid status', () => {
    expect(() =>
      HealthResponseSchema.parse({ status: 'degraded', service: 'ingest' }),
    ).toThrow();
  });
});
