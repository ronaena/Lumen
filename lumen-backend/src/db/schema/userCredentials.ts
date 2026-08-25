import { pgTable, uuid, varchar, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './users.js';

/**
 * user_credentials — password credential material, deliberately kept in its own table
 * separate from `users` (which is read constantly for ordinary ownership checks
 * throughout the codebase). Never returned by any repository method as plaintext,
 * because plaintext is never stored — only the scrypt-derived hash and its salt.
 *
 * Scrypt parameters (N=16384, r=8, p=1, keyLength=64) are fixed constants in
 * AuthService, not stored per-row — Phase 12 explicitly excludes password reset/rotation,
 * so there's no current need for per-credential parameter versioning. If parameters ever
 * need to change, that's a deliberate future migration, not something this schema
 * needs to anticipate now.
 */
export const userCredentials = pgTable(
  'user_credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    /** hex-encoded scrypt-derived key */
    passwordHash: varchar('password_hash', { length: 256 }).notNull(),
    /** hex-encoded random salt, unique per credential */
    passwordSalt: varchar('password_salt', { length: 256 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // One credential record per user.
    userIdUnique: uniqueIndex('user_credentials_user_id_unique').on(table.userId),
  }),
);
