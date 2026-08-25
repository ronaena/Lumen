import { desc, and, eq, gte, lte, type SQL } from 'drizzle-orm';
import type { Database } from '../db/client';
import { adminAuditLogEntries } from '../db/schema/index';
import { assertDefined } from './assertDefined';

export interface RecordAuditEntryInput {
  adminUserId: string;
  action: string;
  targetType: string;
  targetId: string | null;
  result: 'success' | 'failure';
  metadata?: Record<string, unknown>;
}

/** Admin Audit Log Filtering v1 (approved workstream). Every field optional -- an absent filter simply isn't applied, matching the existing unfiltered list() behavior exactly when none are supplied. */
export interface AuditLogFilters {
  adminUserId?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  result?: 'success' | 'failure';
  from?: Date;
  to?: Date;
}

/**
 * Admin Audit Log v1 (approved workstream). Append-only by design: this class
 * deliberately has no update/delete method, and no route anywhere exposes a way to
 * mutate a historical entry -- the only operations are record() and list().
 */
export class AdminAuditLogRepository {
  constructor(private readonly db: Database) {}

  async record(input: RecordAuditEntryInput) {
    const [row] = await this.db
      .insert(adminAuditLogEntries)
      .values({
        adminUserId: input.adminUserId,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId,
        result: input.result,
        metadata: input.metadata ?? null,
      })
      .returning();
    return assertDefined(row, 'AdminAuditLogRepository.record');
  }

  /**
   * Newest-first, per the approved response contract. filters is optional and every
   * field within it is optional -- calling list(limit, offset) with no filters object
   * (or {}) behaves identically to the original unfiltered v1 implementation.
   */
  async list(limit: number, offset: number, filters: AuditLogFilters = {}) {
    const conditions: SQL[] = [];
    if (filters.adminUserId) conditions.push(eq(adminAuditLogEntries.adminUserId, filters.adminUserId));
    if (filters.action) conditions.push(eq(adminAuditLogEntries.action, filters.action));
    if (filters.targetType) conditions.push(eq(adminAuditLogEntries.targetType, filters.targetType));
    if (filters.targetId) conditions.push(eq(adminAuditLogEntries.targetId, filters.targetId));
    if (filters.result) conditions.push(eq(adminAuditLogEntries.result, filters.result));
    if (filters.from) conditions.push(gte(adminAuditLogEntries.createdAt, filters.from));
    if (filters.to) conditions.push(lte(adminAuditLogEntries.createdAt, filters.to));

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    return this.db
      .select()
      .from(adminAuditLogEntries)
      .where(whereClause)
      .orderBy(desc(adminAuditLogEntries.createdAt))
      .limit(limit)
      .offset(offset);
  }
}
