import { pgTable, uuid, text, integer, varchar, jsonb, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { narrationStatusEnum } from './enums';
import { chapters } from './chapters';
import { voices } from './voices';

/**
 * TextSegment — the smallest practical narration unit, and the unit of retry, provider
 * fallback, and regeneration throughout the entire architecture.
 *
 * `currentAudioSegmentId` intentionally has NO in-schema `.references()` here: it points
 * at audio_segments.id, and audio_segments.text_segment_id points back at this table —
 * a genuine circular reference. Adding a cross-file `.references()` here would require
 * audioSegments.ts and textSegments.ts to import each other, which is not resolvable.
 * The actual foreign key constraint is added via a hand-written follow-up migration once
 * both tables exist (see drizzle/<next>_add_text_segment_audio_fk.sql) — this is the
 * standard, documented pattern for circular FKs under a schema-diffing migration tool,
 * and matches the write-order already specified in corrections §11 (F / DB-6).
 */
export const textSegments = pgTable(
  'text_segments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chapterId: uuid('chapter_id')
      .notNull()
      .references(() => chapters.id),
    orderIndex: integer('order_index').notNull(),
    sourceText: text('source_text').notNull(),
    normalizedText: text('normalized_text').notNull(),
    charCount: integer('char_count').notNull(),
    sourceReference: text('source_reference').notNull(),
    /** sha256 hex digest of normalizedText — the regeneration decision key. */
    contentHash: varchar('content_hash', { length: 64 }).notNull(),
    narratorVoiceId: uuid('narrator_voice_id')
      .notNull()
      .references(() => voices.id),
    /** Phase 2+ only — populated for attributed dialogue. Absent in MVP. */
    characterVoiceId: uuid('character_voice_id').references(() => voices.id),
    /**
     * Resolved/cached delivery direction. Per corrections §7 (B / CDC-3): once Scene
     * exists (Phase 3), Scene.direction is authoritative and this becomes the cached
     * result of resolving it — that logic is not implemented in this phase.
     */
    deliveryDirection: jsonb('delivery_direction'),
    deliveryDirectionVersion: integer('delivery_direction_version').notNull().default(1),
    narrationStatus: narrationStatusEnum('narration_status').notNull().default('pending'),
    textVersion: integer('text_version').notNull().default(1),
    /** FK to audio_segments.id — added via follow-up migration, see comment above. */
    currentAudioSegmentId: uuid('current_audio_segment_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    chapterOrderUnique: uniqueIndex('text_segments_chapter_order_unique').on(
      table.chapterId,
      table.orderIndex,
    ),
    contentHashIdx: index('text_segments_content_hash_idx').on(table.contentHash),
  }),
);
