import { pgTable, uuid, varchar, timestamp, jsonb } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * Admin Audit Log v1 (approved workstream). Append-only -- deliberately no update/delete
 * repository method exists anywhere (see AdminAuditLogRepository), and no route ever
 * exposes a way to mutate a historical entry. metadata must contain only explicitly
 * safe, non-secret contextual fields -- this is enforced by discipline at every call
 * site that writes here, not by the column type itself; never a raw request body, never
 * a credential, never a providerVoiceId (per the explicit approved restriction).
 */
export const adminAuditLogEntries = pgTable('admin_audit_log_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  adminUserId: uuid('admin_user_id')
    .notNull()
    .references(() => users.id),
  action: varchar('action', { length: 100 }).notNull(),
  targetType: varchar('target_type', { length: 50 }).notNull(),
  targetId: uuid('target_id'),
  result: varchar('result', { length: 20 }).notNull(),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
