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
} from 'drizzle-orm/pg-core';
import { chapterStatusEnum } from './enums';
import { books } from './books';

export const chapters = pgTable(
  'chapters',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bookId: uuid('book_id')
      .notNull()
      .references(() => books.id),
    orderIndex: integer('order_index').notNull(),
    title: varchar('title', { length: 500 }),
    sourceLocation: text('source_location').notNull(),
    status: chapterStatusEnum('status').notNull().default('pending'),
    textCharCount: integer('text_char_count').notNull().default(0),
    segmentCount: integer('segment_count').notNull().default(0),
    audioDurationMs: bigint('audio_duration_ms', { mode: 'number' }).notNull().default(0),
    processingProgressPct: numeric('processing_progress_pct', { precision: 5, scale: 2 })
      .notNull()
      .default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    bookOrderUnique: uniqueIndex('chapters_book_order_unique').on(table.bookId, table.orderIndex),
  }),
);
