import { z } from 'zod';

export * from './evidence/index.js';
export * from './ingestion.js';
export * from './artifacts.js';

export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.string().min(1),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
