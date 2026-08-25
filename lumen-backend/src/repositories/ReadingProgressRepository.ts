import { eq, and } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { readingProgress } from '../db/schema/index.js';
import { assertDefined } from './assertDefined.js';

export interface UpsertReadingProgressInput {
  userId: string;
  bookId: string;
  chapterId: string;
  textSegmentId?: string;
  readingPositionOffset?: number;
  completionPct: string;
}

export class ReadingProgressRepository {
  constructor(private readonly db: Database) {}

  async upsert(input: UpsertReadingProgressInput) {
    const [row] = await this.db
      .insert(readingProgress)
      .values({ ...input, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [readingProgress.userId, readingProgress.bookId],
        set: {
          chapterId: input.chapterId,
          textSegmentId: input.textSegmentId,
          readingPositionOffset: input.readingPositionOffset,
          completionPct: input.completionPct,
          updatedAt: new Date(),
        },
      })
      .returning();
    return assertDefined(row, 'ReadingProgressRepository.upsert');
  }

  async findByUserAndBook(userId: string, bookId: string) {
    const [row] = await this.db
      .select()
      .from(readingProgress)
      .where(and(eq(readingProgress.userId, userId), eq(readingProgress.bookId, bookId)));
    return row ?? null;
  }
}
