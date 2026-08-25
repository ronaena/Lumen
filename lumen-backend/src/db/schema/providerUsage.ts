import {
  pgTable,
  uuid,
  varchar,
  integer,
  numeric,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { providerUsageOutcomeEnum } from './enums';
import { narrationAttempts } from './narrationAttempts';
import { users } from './users';
import { books } from './books';
import { chapters } from './chapters';
import { textSegments } from './textSegments';

/**
 * ProviderUsage — append-only usage ledger. One row per billable attempt (success OR
 * failure — quota consumed by a failed call is never invisible). Answers both:
 *   "how much did this book cost?"      -> SUM(actualCost) WHERE bookId = ?
 *   "how much did this user consume?"   -> SUM(actualCost) WHERE userId = ?
 */
export const providerUsage = pgTable(
  'provider_usage',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    narrationAttemptId: uuid('narration_attempt_id')
      .notNull()
      .references(() => narrationAttempts.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    bookId: uuid('book_id')
      .notNull()
      .references(() => books.id),
    chapterId: uuid('chapter_id')
      .notNull()
      .references(() => chapters.id),
    textSegmentId: uuid('text_segment_id')
      .notNull()
      .references(() => textSegments.id),
    provider: varchar('provider', { length: 50 }).notNull(),
    model: varchar('model', { length: 100 }).notNull(),
    charCount: integer('char_count').notNull(),
    estimatedCost: numeric('estimated_cost', { precision: 12, scale: 6 }).notNull(),
    actualCost: numeric('actual_cost', { precision: 12, scale: 6 }),
    currency: varchar('currency', { length: 3 }).notNull().default('USD'),
    outcome: providerUsageOutcomeEnum('outcome').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    attemptUnique: uniqueIndex('provider_usage_attempt_unique').on(table.narrationAttemptId),
    userRecordedIdx: index('provider_usage_user_recorded_idx').on(table.userId, table.recordedAt),
    bookRecordedIdx: index('provider_usage_book_recorded_idx').on(table.bookId, table.recordedAt),
  }),
);
