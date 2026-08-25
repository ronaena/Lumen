import {
  pgTable,
  uuid,
  varchar,
  integer,
  numeric,
  text,
  jsonb,
  boolean,
  timestamp,
  uniqueIndex,
  index,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { narrationAttemptStatusEnum } from './enums';
import { textSegments } from './textSegments';

/**
 * NarrationAttempt — append-only audit history of every TTS generation attempt.
 * Rows are never updated after `respondedAt` is set; corrections happen via a new attempt.
 *
 * `requestId` and `requestSignature` are deliberately distinct (corrections §5 / §4):
 *  - requestId: the invocation/idempotency identity. One value per actual call the engine
 *    made. Unique. Prevents double-submission of the same call.
 *  - requestSignature: the logical/content-addressable identity (see
 *    domain/narration/requestSignature.ts). Shared across attempts representing the same
 *    narration configuration. NOT unique by design — used to detect "already tried this
 *    exact configuration," not "already made this exact call."
 */
export const narrationAttempts = pgTable(
  'narration_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    textSegmentId: uuid('text_segment_id')
      .notNull()
      .references(() => textSegments.id),
    attemptNumber: integer('attempt_number').notNull(),
    provider: varchar('provider', { length: 50 }).notNull(),
    providerJobId: varchar('provider_job_id', { length: 200 }),

    /** Idempotency identity — verbatim NarrationRequest.requestId. Unique. */
    requestId: uuid('request_id').notNull(),
    /** Content-addressable identity — see requestSignature composition rule. */
    requestSignature: varchar('request_signature', { length: 64 }).notNull(),

    status: narrationAttemptStatusEnum('status').notNull().default('queued'),
    normalizedErrorCode: varchar('normalized_error_code', { length: 50 }),
    errorMessage: text('error_message'),
    /** Non-fatal provider warnings — corrections §9 (D / CDC-5). */
    warnings: jsonb('warnings'),

    isFallbackAttempt: boolean('is_fallback_attempt').notNull().default(false),
    /** Self-referential — reconstructs the fallback chain (ElevenLabs -> Google, etc). */
    triggeringAttemptId: uuid('triggering_attempt_id').references(
      (): AnyPgColumn => narrationAttempts.id,
    ),

    estimatedCost: numeric('estimated_cost', { precision: 12, scale: 6 }),
    actualCost: numeric('actual_cost', { precision: 12, scale: 6 }),
    /** The cost ceiling in effect when this attempt's routing decision was made. */
    costCeilingAtRequest: numeric('cost_ceiling_at_request', { precision: 12, scale: 6 }),

    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    respondedAt: timestamp('responded_at', { withTimezone: true }),
  },
  (table) => ({
    requestIdUnique: uniqueIndex('narration_attempts_request_id_unique').on(table.requestId),
    segmentAttemptUnique: uniqueIndex('narration_attempts_segment_attempt_unique').on(
      table.textSegmentId,
      table.attemptNumber,
    ),
    // DB-5 correction: DB-enforced guard against two simultaneous in-flight attempts
    // for the same segment — not left to application-layer discipline alone.
    onlyOneProcessingUnique: uniqueIndex('narration_attempts_one_processing_unique')
      .on(table.textSegmentId)
      .where(sql`${table.status} = 'processing'`),
    statusProviderIdx: index('narration_attempts_status_provider_idx').on(
      table.status,
      table.provider,
    ),
  }),
);
