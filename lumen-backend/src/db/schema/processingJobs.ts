import { pgTable, uuid, integer, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import {
  processingJobTypeEnum,
  processingJobStatusEnum,
  processingJobStepTypeEnum,
  jobStepScopeTypeEnum,
} from './enums';
import { books } from './books';
import { users } from './users';

/**
 * ProcessingJob concurrency — DB-2 / PIPE-2 correction.
 *
 * A single flat unique constraint on (bookId, status) would block a chapter-scoped retry
 * job from running while a full-book job is active — a required pipeline capability.
 * The fix uses TWO partial unique indexes rather than one flat
 * (bookId, jobType, scopeId, status) constraint, because standard SQL treats NULL values
 * in a unique index as distinct from one another: a naive combined constraint would
 * silently fail to block duplicate *book-level* jobs, whose scopeId is always NULL.
 *
 *  - Book-level jobs (scopeId IS NULL): only one active per (bookId, jobType).
 *  - Chapter-scoped jobs (scopeId IS NOT NULL): only one active per (bookId, jobType, scopeId).
 *
 * This allows a full_processing job and a single_chapter_retry job (on a different scope)
 * to be active simultaneously, while still preventing duplicates within either scope.
 */
export const processingJobs = pgTable(
  'processing_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bookId: uuid('book_id')
      .notNull()
      .references(() => books.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    jobType: processingJobTypeEnum('job_type').notNull(),
    /** NULL for book-level jobs; the chapter ID for single_chapter_retry jobs. */
    scopeId: uuid('scope_id'),
    status: processingJobStatusEnum('status').notNull().default('queued'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => ({
    bookLevelActiveUnique: uniqueIndex('processing_jobs_book_level_active_unique')
      .on(table.bookId, table.jobType)
      .where(sql`${table.scopeId} IS NULL AND ${table.status} IN ('queued','processing')`),
    scopedActiveUnique: uniqueIndex('processing_jobs_scoped_active_unique')
      .on(table.bookId, table.jobType, table.scopeId)
      .where(sql`${table.scopeId} IS NOT NULL AND ${table.status} IN ('queued','processing')`),
  }),
);

export const processingJobSteps = pgTable('processing_job_steps', {
  id: uuid('id').primaryKey().defaultRandom(),
  processingJobId: uuid('processing_job_id')
    .notNull()
    .references(() => processingJobs.id),
  stepType: processingJobStepTypeEnum('step_type').notNull(),
  scopeType: jobStepScopeTypeEnum('scope_type').notNull(),
  scopeId: uuid('scope_id'),
  status: processingJobStatusEnum('status').notNull().default('queued'),
  attemptCount: integer('attempt_count').notNull().default(0),
  /** User-safe summary only — never a raw provider payload. */
  lastError: text('last_error'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});
