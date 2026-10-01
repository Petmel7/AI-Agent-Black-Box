import { Prisma } from './generated/client/client.js';
import type { DatabaseClient } from './client.js';
import type { ProcessingQueue } from './processing-queue.js';

export interface RelayOptions {
  batchSize: number;
  leaseSeconds: number;
  maxAttempts: number;
  retryBaseSeconds: number;
  retryMaxSeconds: number;
}

export interface ClaimedIntent {
  intentId: string;
  leaseId: string;
  attemptCount: number;
}

export interface RelayFailureHooks {
  afterClaim?(claim: ClaimedIntent): void | Promise<void>;
  beforeSend?(claim: ClaimedIntent): void | Promise<void>;
  afterSend?(claim: ClaimedIntent, messageId: number): void | Promise<void>;
  beforeDelivered?(
    claim: ClaimedIntent,
    messageId: number,
  ): void | Promise<void>;
}

function validate(options: RelayOptions) {
  for (const value of Object.values(options))
    if (!Number.isSafeInteger(value) || value < 1)
      throw new TypeError('Relay bounds must be positive safe integers.');
}

export async function claimProcessingIntents(
  client: DatabaseClient,
  options: RelayOptions,
): Promise<ClaimedIntent[]> {
  validate(options);
  return client.$queryRaw<
    Array<{ intentId: string; leaseId: string; attemptCount: number }>
  >(Prisma.sql`
    WITH candidates AS (
      SELECT id FROM processing_intents
       WHERE ((state = 'pending' AND available_at <= clock_timestamp()) OR (state = 'leased' AND lease_expires_at <= clock_timestamp()))
       ORDER BY available_at, id FOR UPDATE SKIP LOCKED LIMIT ${options.batchSize}
    )
    UPDATE processing_intents AS intent
       SET state = 'leased', lease_id = gen_random_uuid(), lease_expires_at = clock_timestamp() + make_interval(secs => ${options.leaseSeconds}),
           attempt_count = attempt_count + 1, last_attempt_at = clock_timestamp(), last_error_code = NULL
      FROM candidates WHERE intent.id = candidates.id
    RETURNING intent.id AS "intentId", intent.lease_id AS "leaseId", intent.attempt_count AS "attemptCount"
  `);
}

export async function completeIntentDelivery(
  client: DatabaseClient,
  claim: ClaimedIntent,
  messageId: number,
): Promise<boolean> {
  const changed = await client.$executeRaw(Prisma.sql`
    UPDATE processing_intents SET state = 'delivered', queue_message_id = ${BigInt(messageId)}, delivered_at = clock_timestamp(), lease_id = NULL, lease_expires_at = NULL, last_error_code = NULL
     WHERE id = ${claim.intentId}::uuid AND state = 'leased' AND lease_id = ${claim.leaseId}::uuid AND lease_expires_at > clock_timestamp()
  `);
  return changed === 1;
}

export async function failIntentDelivery(
  client: DatabaseClient,
  claim: ClaimedIntent,
  code: string,
  options: RelayOptions,
  retryable: boolean,
): Promise<boolean> {
  const exhausted = claim.attemptCount >= options.maxAttempts;
  const blocked = !retryable || exhausted;
  const delay = Math.min(
    options.retryMaxSeconds,
    options.retryBaseSeconds * 2 ** Math.max(0, claim.attemptCount - 1),
  );
  const changed = await client.$executeRaw(Prisma.sql`
    UPDATE processing_intents
       SET state = ${blocked ? 'blocked' : 'pending'}::"ProcessingIntentState", available_at = clock_timestamp() + make_interval(secs => ${blocked ? 0 : delay}),
           lease_id = NULL, lease_expires_at = NULL, last_error_code = ${code}
     WHERE id = ${claim.intentId}::uuid AND state = 'leased' AND lease_id = ${claim.leaseId}::uuid AND lease_expires_at > clock_timestamp()
  `);
  return changed === 1;
}

export async function relayProcessingCycle(
  client: DatabaseClient,
  queue: ProcessingQueue,
  options: RelayOptions,
  hooks: RelayFailureHooks = {},
): Promise<number> {
  const claims = await claimProcessingIntents(client, options);
  for (const claim of claims) {
    try {
      await hooks.afterClaim?.(claim);
      await hooks.beforeSend?.(claim);
      const messageId = await queue.send({
        schemaVersion: 1,
        intentId: claim.intentId,
      });
      await hooks.afterSend?.(claim, messageId);
      await hooks.beforeDelivered?.(claim, messageId);
      await completeIntentDelivery(client, claim, messageId);
    } catch {
      await failIntentDelivery(
        client,
        claim,
        'queue_send_failed',
        options,
        true,
      );
    }
  }
  return claims.length;
}
