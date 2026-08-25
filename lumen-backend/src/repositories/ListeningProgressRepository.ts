import { eq, and } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { listeningProgress } from '../db/schema/index.js';
import { assertDefined } from './assertDefined.js';

export interface UpsertListeningProgressInput {
  userId: string;
  bookId: string;
  chapterId: string;
  audioSegmentId?: string;
  playbackPositionMs: number;
  completionPct: string;
}

/**
 * ListeningProgressRepository — every read is scoped by userId in the WHERE clause, so a
 * different user's query for the same bookId simply returns null. There is no method
 * here that can return another user's progress row.
 */
export class ListeningProgressRepository {
  constructor(private readonly db: Database) {}

  /**
   * Safe to call repeatedly — upserts on the (userId, bookId) unique constraint, so a
   * repeated identical update is a no-op write, never a duplicate row or an error.
   */
  async upsert(input: UpsertListeningProgressInput) {
    const [row] = await this.db
      .insert(listeningProgress)
      .values({ ...input, lastListenedAt: new Date() })
      .onConflictDoUpdate({
        target: [listeningProgress.userId, listeningProgress.bookId],
        set: {
          chapterId: input.chapterId,
          audioSegmentId: input.audioSegmentId,
          playbackPositionMs: input.playbackPositionMs,
          completionPct: input.completionPct,
          lastListenedAt: new Date(),
        },
      })
      .returning();
    return assertDefined(row, 'ListeningProgressRepository.upsert');
  }

  async findByUserAndBook(userId: string, bookId: string) {
    const [row] = await this.db
      .select()
      .from(listeningProgress)
      .where(and(eq(listeningProgress.userId, userId), eq(listeningProgress.bookId, bookId)));
    return row ?? null;
  }
}
