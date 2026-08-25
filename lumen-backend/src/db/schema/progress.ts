import { pgTable, uuid, integer, numeric, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './users';
import { books } from './books';
import { chapters } from './chapters';
import { audioSegments } from './audioSegments';
import { textSegments } from './textSegments';

export const listeningProgress = pgTable(
  'listening_progress',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    bookId: uuid('book_id')
      .notNull()
      .references(() => books.id),
    chapterId: uuid('chapter_id')
      .notNull()
      .references(() => chapters.id),
    audioSegmentId: uuid('audio_segment_id').references(() => audioSegments.id),
    playbackPositionMs: integer('playback_position_ms').notNull().default(0),
    completionPct: numeric('completion_pct', { precision: 5, scale: 2 }).notNull().default('0'),
    lastListenedAt: timestamp('last_listened_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userBookUnique: uniqueIndex('listening_progress_user_book_unique').on(
      table.userId,
      table.bookId,
    ),
  }),
);

export const readingProgress = pgTable(
  'reading_progress',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    bookId: uuid('book_id')
      .notNull()
      .references(() => books.id),
    chapterId: uuid('chapter_id')
      .notNull()
      .references(() => chapters.id),
    textSegmentId: uuid('text_segment_id').references(() => textSegments.id),
    readingPositionOffset: integer('reading_position_offset'),
    completionPct: numeric('completion_pct', { precision: 5, scale: 2 }).notNull().default('0'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userBookUnique: uniqueIndex('reading_progress_user_book_unique').on(
      table.userId,
      table.bookId,
    ),
  }),
);
