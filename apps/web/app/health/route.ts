import { HealthResponseSchema } from '@blackbox/contracts';

export function GET() {
  return Response.json(
    HealthResponseSchema.parse({ status: 'ok', service: 'web' }),
  );
}
