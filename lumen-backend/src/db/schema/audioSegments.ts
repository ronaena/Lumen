import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  bigint,
  numeric,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { audioSegmentStatusEnum, audioFormatEnum } from './enums';
import { textSegments } from './textSegments';
import { narrationAttempts } from './narrationAttempts';

/**
 * AudioSegment — a generated audio artifact. Never overwritten in place: a regeneration
 * inserts a NEW row and flips the prior one to 'superseded' (see repositories/AudioSegmentRepository.ts
 * for the atomic activation transaction implementing this).
 *
 * `producedByAttemptId` traces every artifact back to the exact NarrationAttempt — and
 * transitively, via that attempt, to the exact text version, voice, provider, and model
 * that produced it.
 */
export const audioSegments = pgTable(
  'audio_segments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    textSegmentId: uuid('text_segment_id')
      .notNull()
      .references(() => textSegments.id),
    producedByAttemptId: uuid('produced_by_attempt_id')
      .notNull()
      .references(() => narrationAttempts.id),
    storageRef: text('storage_ref').notNull(),
    /** Metadata only — never a join key. Vendor identity lives in VoiceProviderMapping. */
    provider: varchar('provider', { length: 50 }).notNull(),
    providerJobId: varchar('provider_job_id', { length: 200 }),
    modelUsed: varchar('model_used', { length: 100 }).notNull(),
    /** Vendor voice ID — audit/debug field only. */
    providerVoiceId: varchar('provider_voice_id', { length: 200 }).notNull(),
    durationMs: integer('duration_ms').notNull(),
    format: audioFormatEnum('format').notNull(),
    sampleRateHz: integer('sample_rate_hz').notNull(),
    fileSizeBytes: bigint('file_size_bytes', { mode: 'number' }).notNull(),
    checksum: varchar('checksum', { length: 64 }).notNull(),
    estimatedCost: numeric('estimated_cost', { precision: 12, scale: 6 }).notNull(),
    actualCost: numeric('actual_cost', { precision: 12, scale: 6 }),
    currency: varchar('currency', { length: 3 }).notNull().default('USD'),
    /** hash(contentHash, narratorVoiceId, deliveryDirectionVersion, provider, modelUsed) */
    generationSignature: varchar('generation_signature', { length: 64 }).notNull(),
    status: audioSegmentStatusEnum('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    producedByUnique: uniqueIndex('audio_segments_produced_by_unique').on(
      table.producedByAttemptId,
    ),
    textSegmentStatusIdx: index('audio_segments_text_segment_status_idx').on(
      table.textSegmentId,
      table.status,
    ),
  }),
);
