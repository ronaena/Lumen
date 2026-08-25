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
import { bookStatusEnum } from './enums';
import { users } from './users';

export const books = pgTable(
  'books',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    title: varchar('title', { length: 500 }).notNull(),
    author: varchar('author', { length: 300 }),
    description: text('description'),
    language: varchar('language', { length: 20 }).notNull(),
    coverStorageRef: text('cover_storage_ref'),
    status: bookStatusEnum('status').notNull().default('uploaded'),
    chapterCount: integer('chapter_count').notNull().default(0),
    segmentCount: integer('segment_count').notNull().default(0),
    audioDurationMs: bigint('audio_duration_ms', { mode: 'number' }).notNull().default(0),
    processingProgressPct: numeric('processing_progress_pct', { precision: 5, scale: 2 })
      .notNull()
      .default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => ({
    userStatusIdx: index('books_user_status_idx').on(table.userId, table.status),
  }),
);

/**
 * BookSource — the original uploaded EPUB file reference (never the bytes themselves).
 *
 * `userId` is denormalized from Book.userId (write-once, never independently editable) —
 * this is the DB-1 correction from the architecture review: a unique constraint cannot
 * span Book and BookSource through a join, so userId is duplicated here specifically to
 * make `(userId, checksum)` a real, single-table, database-enforced constraint.
 * Book.userId remains the canonical ownership record everywhere else in the schema.
 */
export const bookSources = pgTable(
  'book_sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bookId: uuid('book_id')
      .notNull()
      .references(() => books.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    originalFileStorageRef: text('original_file_storage_ref').notNull(),
    originalFilename: varchar('original_filename', { length: 500 }).notNull(),
    fileSizeBytes: bigint('file_size_bytes', { mode: 'number' }).notNull(),
    /** sha256 hex digest of the uploaded file. */
    checksum: varchar('checksum', { length: 64 }).notNull(),
    mimeType: varchar('mime_type', { length: 100 }).notNull(),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    bookUnique: uniqueIndex('book_sources_book_id_unique').on(table.bookId),
    // DB-1 correction: duplicate-upload prevention, enforced within one table.
    userChecksumUnique: uniqueIndex('book_sources_user_checksum_unique').on(
      table.userId,
      table.checksum,
    ),
  }),
);
