import { PrismaPg } from '@prisma/adapter-pg';

import { Prisma, PrismaClient } from './generated/client/client.js';

export type DatabaseClient = PrismaClient;
export type DatabaseAdapter = Prisma.PrismaClientOptionsWithAdapter['adapter'];

export type DatabaseClientOptions =
  | {
      connectionString: string;
      adapter?: never;
    }
  | {
      adapter: DatabaseAdapter;
      connectionString?: never;
    };

export interface DatabaseClientHandle {
  client: DatabaseClient;
  dispose(): Promise<void>;
}

function createPostgresAdapter(connectionString: string): DatabaseAdapter {
  const value = connectionString.trim();
  if (value.length === 0) {
    throw new Error('A non-empty PostgreSQL connection string is required.');
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('A valid PostgreSQL connection string is required.');
  }

  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('A PostgreSQL connection string is required.');
  }

  if (parsed.hostname.length === 0 || parsed.username.length === 0) {
    throw new Error(
      'The PostgreSQL connection string must include an explicit hostname and username.',
    );
  }

  return new PrismaPg({ connectionString: value });
}

/**
 * Creates a lazy Prisma client without reading ambient connection variables.
 * The returned handle owns the client lifecycle and must be disposed by its
 * process composition root.
 */
export function createDatabaseClient(
  options: DatabaseClientOptions,
): DatabaseClientHandle {
  if (
    options === undefined ||
    options === null ||
    typeof options !== 'object'
  ) {
    throw new Error(
      'Database client construction requires an explicit connection string or adapter.',
    );
  }

  let adapter: DatabaseAdapter;
  if ('adapter' in options && options.adapter !== undefined) {
    adapter = options.adapter;
  } else if (
    'connectionString' in options &&
    typeof options.connectionString === 'string'
  ) {
    adapter = createPostgresAdapter(options.connectionString);
  } else {
    throw new Error(
      'Database client construction requires an explicit connection string or adapter.',
    );
  }
  const client = new PrismaClient({ adapter });

  return {
    client,
    dispose: () => client.$disconnect(),
  };
}
