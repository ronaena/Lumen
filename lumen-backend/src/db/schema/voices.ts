import { pgTable, uuid, varchar, boolean, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { voiceRoleEnum } from './enums';
import { users } from './users';
import { books } from './books';

/**
 * Voice — the Lumen-level voice identity. `userId` null = system/shared voice.
 * `bookId` null = reusable across books; set = book-scoped (e.g. a future character voice).
 * Never a vendor voice ID — see VoiceProviderMapping below for that boundary.
 */
export const voices = pgTable('voices', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id),
  bookId: uuid('book_id').references(() => books.id),
  displayName: varchar('display_name', { length: 200 }).notNull(),
  role: voiceRoleEnum('role').notNull().default('narrator'),
  language: varchar('language', { length: 20 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * VoiceProviderMapping — the ONLY place a vendor voice ID is allowed to live. No other
 * table's primary or foreign key is ever derived from a vendor voice identifier.
 *
 * UPDATED by Voice Management v1 (approved workstream): the original MVP restriction
 * ("no end-user-facing mutation path") is now intentionally superseded. Writes here are
 * reachable via the admin-only /admin/voices API, gated by the centralized adminOnly
 * router guard (see ApiRouter.ts). Ordinary (non-admin) users still have zero mutation
 * capability — this was never opened to them, only to authenticated admins.
 */
export const voiceProviderMappings = pgTable(
  'voice_provider_mappings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    voiceId: uuid('voice_id')
      .notNull()
      .references(() => voices.id),
    provider: varchar('provider', { length: 50 }).notNull(),
    providerVoiceId: varchar('provider_voice_id', { length: 200 }).notNull(),
    providerModel: varchar('provider_model', { length: 100 }),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // One active mapping per voice per provider.
    activeMappingUnique: uniqueIndex('voice_provider_mappings_active_unique')
      .on(table.voiceId, table.provider)
      .where(sql`${table.isActive} = true`),
  }),
);
