import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // Commands that connect are wrapped by a fail-closed TEST_DATABASE_URL guard.
    // Generation and validation remain credential-free.
    url: process.env.TEST_DATABASE_URL ?? '',
  },
});
