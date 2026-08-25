import {
  pgTable,
  uuid,
  varchar,
  text,
  jsonb,
  numeric,
  boolean,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { books } from './books';
import { voices } from './voices';

/**
 * Character — FUTURE-READY SCHEMA ONLY. No dialogue attribution or character detection
 * logic exists anywhere in this codebase. This table exists so Phase 2 extends the
 * schema rather than replacing it — nothing here is queried or written by MVP code.
 */
export const characters = pgTable('characters', {
  id: uuid('id').primaryKey().defaultRandom(),
  bookId: uuid('book_id')
    .notNull()
    .references(() => books.id),
  name: varchar('name', { length: 200 }).notNull(),
  description: text('description'),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** FUTURE-READY SCHEMA ONLY — see characters.ts comment above. */
export const characterVoiceAssignments = pgTable(
  'character_voice_assignments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    characterId: uuid('character_id')
      .notNull()
      .references(() => characters.id),
    voiceId: uuid('voice_id')
      .notNull()
      .references(() => voices.id),
    confidence: numeric('confidence', { precision: 3, scale: 2 }),
    isUserConfirmed: boolean('is_user_confirmed').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    characterUnique: uniqueIndex('character_voice_assignments_character_unique').on(
      table.characterId,
    ),
  }),
);
