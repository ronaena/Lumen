import { pgTable, uuid, varchar, numeric, jsonb, timestamp } from 'drizzle-orm/pg-core';
import { chapters } from './chapters';
import { textSegments } from './textSegments';

/**
 * Scene / SceneDirection — FUTURE-READY SCHEMA ONLY. No scene detection or emotional
 * classification logic exists anywhere in this codebase.
 *
 * Per corrections §7 (B / CDC-3): once populated, Scene.direction is authoritative over
 * TextSegment.deliveryDirection (which becomes a resolved/cached value). That resolution
 * logic is NOT implemented here — this table cannot be written or read by any MVP code
 * path in this phase.
 */
export const scenes = pgTable('scenes', {
  id: uuid('id').primaryKey().defaultRandom(),
  chapterId: uuid('chapter_id')
    .notNull()
    .references(() => chapters.id),
  startSegmentId: uuid('start_segment_id')
    .notNull()
    .references(() => textSegments.id),
  endSegmentId: uuid('end_segment_id')
    .notNull()
    .references(() => textSegments.id),
  sceneType: varchar('scene_type', { length: 50 }),
  emotionalClassification: varchar('emotional_classification', { length: 100 }),
  intensity: numeric('intensity', { precision: 3, scale: 2 }),
  confidence: numeric('confidence', { precision: 3, scale: 2 }),
  /** Reserved shape for future music/ambience cues — deliberately unshaped in MVP. */
  direction: jsonb('direction'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
