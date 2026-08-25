import { assertDefined } from './assertDefined';
import { eq, and, asc } from 'drizzle-orm';
import type { Database } from '../db/client';
import { chapters } from '../db/schema/index';

export interface CreateChapterInput {
  bookId: string;
  orderIndex: number;
  title?: string;
  sourceLocation: string;
}

export class ChapterRepository {
  constructor(private readonly db: Database) {}

  async create(input: CreateChapterInput) {
    const [chapter] = await this.db.insert(chapters).values(input).returning();
    return assertDefined(chapter, "ChapterRepository.create");
  }

  async findById(chapterId: string) {
    const [chapter] = await this.db.select().from(chapters).where(eq(chapters.id, chapterId));
    return chapter ?? null;
  }

  async listByBook(bookId: string) {
    return this.db
      .select()
      .from(chapters)
      .where(eq(chapters.bookId, bookId))
      .orderBy(asc(chapters.orderIndex));
  }

  async findByBookAndOrder(bookId: string, orderIndex: number) {
    const [chapter] = await this.db
      .select()
      .from(chapters)
      .where(and(eq(chapters.bookId, bookId), eq(chapters.orderIndex, orderIndex)));
    return chapter ?? null;
  }

  async update(
    chapterId: string,
    update: Partial<{
      title: string | null;
      status: (typeof chapters.$inferInsert)['status'];
      textCharCount: number;
      segmentCount: number;
    }>,
  ) {
    const [chapter] = await this.db
      .update(chapters)
      .set({ ...update, updatedAt: new Date() })
      .where(eq(chapters.id, chapterId))
      .returning();
    return chapter ?? null;
  }
}
