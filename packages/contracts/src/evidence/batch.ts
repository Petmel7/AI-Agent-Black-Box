import { z } from 'zod';

import { EvidenceEventSchema } from './events.js';
import {
  MAX_BATCH_EVENTS,
  SchemaVersionSchema,
  UtcTimestampSchema,
  UuidSchema,
} from './primitives.js';

export const EvidenceBatchSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    batchId: UuidSchema,
    runId: UuidSchema,
    sentAt: UtcTimestampSchema,
    events: z.array(EvidenceEventSchema).min(1).max(MAX_BATCH_EVENTS),
  })
  .strict()
  .superRefine((batch, context) => {
    const eventIds = new Set<string>();
    const sequences = new Set<number>();

    batch.events.forEach((event, index) => {
      if (event.runId !== batch.runId) {
        context.addIssue({
          code: 'custom',
          message: 'Event runId must match batch runId',
          path: ['events', index, 'runId'],
        });
      }

      if (eventIds.has(event.eventId)) {
        context.addIssue({
          code: 'custom',
          message: 'Event IDs must be unique within a batch',
          path: ['events', index, 'eventId'],
        });
      }
      eventIds.add(event.eventId);

      if (sequences.has(event.sequence)) {
        context.addIssue({
          code: 'custom',
          message: 'Event sequences must be unique within a batch',
          path: ['events', index, 'sequence'],
        });
      }
      sequences.add(event.sequence);
    });
  });

export type EvidenceBatch = z.infer<typeof EvidenceBatchSchema>;
