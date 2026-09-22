import { HealthResponseSchema } from '@blackbox/contracts';
import Fastify from 'fastify';

export function buildApp() {
  const app = Fastify({ logger: false });

  app.get('/health', async () =>
    HealthResponseSchema.parse({ status: 'ok', service: 'ingest' }),
  );

  return app;
}
