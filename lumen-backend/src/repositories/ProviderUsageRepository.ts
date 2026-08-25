import { assertDefined } from './assertDefined';
import { eq, sql } from 'drizzle-orm';
import type { Database } from '../db/client';
import { providerUsage } from '../db/schema/index';

export interface RecordUsageInput {
  narrationAttemptId: string;
  userId: string;
  bookId: string;
  chapterId: string;
  textSegmentId: string;
  provider: string;
  model: string;
  charCount: number;
  estimatedCost: string;
  actualCost?: string;
  outcome: (typeof providerUsage.$inferInsert)['outcome'];
}

/**
 * ProviderUsageRepository — append-only. No update method exists at all; this ledger is
 * write-once per attempt (enforced by the DB's unique(narrationAttemptId) constraint) and
 * read via aggregation.
 */
export class ProviderUsageRepository {
  constructor(private readonly db: Database) {}

  async record(input: RecordUsageInput) {
    const [usage] = await this.db.insert(providerUsage).values(input).returning();
    return assertDefined(usage, "ProviderUsageRepository.record");
  }

  async totalCostForBook(bookId: string): Promise<string> {
    const [row] = await this.db
      .select({ total: sql<string>`COALESCE(SUM(COALESCE(${providerUsage.actualCost}, ${providerUsage.estimatedCost})), 0)` })
      .from(providerUsage)
      .where(eq(providerUsage.bookId, bookId));
    return row?.total ?? '0';
  }

  async totalCostForUser(userId: string): Promise<string> {
    const [row] = await this.db
      .select({ total: sql<string>`COALESCE(SUM(COALESCE(${providerUsage.actualCost}, ${providerUsage.estimatedCost})), 0)` })
      .from(providerUsage)
      .where(eq(providerUsage.userId, userId));
    return row?.total ?? '0';
  }
}
