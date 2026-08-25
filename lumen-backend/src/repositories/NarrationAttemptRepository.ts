import { assertDefined } from './assertDefined';
import { eq, and, asc, isNull } from 'drizzle-orm';
import type { Database } from '../db/client';
import { narrationAttempts } from '../db/schema/index';

export interface CreateNarrationAttemptInput {
  textSegmentId: string;
  attemptNumber: number;
  provider: string;
  requestId: string;
  requestSignature: string;
  isFallbackAttempt?: boolean;
  triggeringAttemptId?: string;
  estimatedCost?: string;
  costCeilingAtRequest?: string;
}

export interface CompleteNarrationAttemptInput {
  status: (typeof narrationAttempts.$inferInsert)['status'];
  normalizedErrorCode?: string;
  errorMessage?: string;
  warnings?: unknown;
  actualCost?: string;
  providerJobId?: string;
}

/**
 * NarrationAttemptRepository — deliberately exposes NO generic update method. This is
 * the code-boundary enforcement of "NarrationAttempt is append-only": the only ways to
 * change a row are `create` (a new attempt) and `complete` (the one-time transition from
 * in-flight to a terminal status), and `complete` is itself guarded to be a no-op against
 * any attempt that has already been completed — see the WHERE respondedAt IS NULL clause.
 */
export class NarrationAttemptRepository {
  constructor(private readonly db: Database) {}

  async create(input: CreateNarrationAttemptInput) {
    const [attempt] = await this.db
      .insert(narrationAttempts)
      .values({ ...input, status: 'processing' })
      .returning();
    return assertDefined(attempt, "NarrationAttemptRepository");
  }

  async findById(attemptId: string) {
    const [attempt] = await this.db
      .select()
      .from(narrationAttempts)
      .where(eq(narrationAttempts.id, attemptId));
    return attempt ?? null;
  }

  async findByRequestId(requestId: string) {
    const [attempt] = await this.db
      .select()
      .from(narrationAttempts)
      .where(eq(narrationAttempts.requestId, requestId));
    return attempt ?? null;
  }

  async listByTextSegment(textSegmentId: string) {
    return this.db
      .select()
      .from(narrationAttempts)
      .where(eq(narrationAttempts.textSegmentId, textSegmentId))
      .orderBy(asc(narrationAttempts.attemptNumber));
  }

  /**
   * One-time completion of an in-flight attempt. Guarded by `respondedAt IS NULL` so a
   * second call against an already-completed attempt affects zero rows rather than
   * silently overwriting history — the database enforces the append-only guarantee here,
   * not just application discipline.
   */
  async complete(attemptId: string, input: CompleteNarrationAttemptInput) {
    const [updated] = await this.db
      .update(narrationAttempts)
      .set({ ...input, respondedAt: new Date() })
      .where(and(eq(narrationAttempts.id, attemptId), isNull(narrationAttempts.respondedAt)))
      .returning();
    return updated ?? null;
  }

  /** Reconstructs a fallback chain by walking triggeringAttemptId backward. */
  async getFallbackChain(attemptId: string) {
    const chain: Array<typeof narrationAttempts.$inferSelect> = [];
    let currentId: string | null = attemptId;

    while (currentId) {
      const attempt = await this.findById(currentId);
      if (!attempt) break;
      chain.unshift(attempt);
      currentId = attempt.triggeringAttemptId;
    }

    return chain;
  }

  /**
   * Workstream 13D: finds every attempt still `processing`, regardless of segment —
   * used only by the startup reconciliation pass. In this single-process architecture,
   * any row still in this state when a NEW process starts belonged to a process that no
   * longer exists.
   */
  async listAllProcessing() {
    return this.db.select().from(narrationAttempts).where(eq(narrationAttempts.status, 'processing'));
  }
}
