import { Prisma } from './generated/client/client.js';

/** Serializes every mutation or publication derived from one run's source set. */
export async function lockRunSourceSet(
  transaction: Prisma.TransactionClient,
  runId: string,
): Promise<void> {
  const rows = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id FROM runs WHERE id = ${runId}::uuid FOR UPDATE
  `);
  if (!rows[0]) throw new Error('Run source-set lock target was not found.');
}
