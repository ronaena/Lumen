import { assertDefined } from './assertDefined';
import { eq, and } from 'drizzle-orm';
import type { Database } from '../db/client';
import { books, bookSources } from '../db/schema/index';

export interface CreateBookInput {
  userId: string;
  title: string;
  author?: string;
  description?: string;
  language: string;
}

export interface CreateBookSourceInput {
  bookId: string;
  userId: string;
  originalFileStorageRef: string;
  originalFilename: string;
  fileSizeBytes: number;
  checksum: string;
  mimeType: string;
}

/**
 * BookRepository — every query here must be scoped by the caller-provided userId; this
 * repository never trusts a client-supplied ownership claim on its own (that enforcement
 * happens at the not-yet-built API layer, which must always pass an authenticated userId
 * into these methods rather than accepting one from request input unchecked).
 */
export class BookRepository {
  constructor(private readonly db: Database) {}

  async create(input: CreateBookInput) {
    const [book] = await this.db.insert(books).values(input).returning();
    return assertDefined(book, "BookRepository.create");
  }

  async findById(bookId: string, userId: string) {
    const [book] = await this.db
      .select()
      .from(books)
      .where(and(eq(books.id, bookId), eq(books.userId, userId)));
    return book ?? null;
  }

  async listByUser(userId: string) {
    return this.db.select().from(books).where(eq(books.userId, userId));
  }

  /**
   * Creates a BookSource row. Duplicate detection (DB-1 correction) is enforced by the
   * database's unique(userId, checksum) constraint — this method does not pre-check; it
   * relies on the constraint and lets the caller handle the resulting conflict error.
   */
  async createSource(input: CreateBookSourceInput) {
    const [source] = await this.db.insert(bookSources).values(input).returning();
    return assertDefined(source, "BookRepository.createSource");
  }

  async findSourceByBookId(bookId: string) {
    const [source] = await this.db.select().from(bookSources).where(eq(bookSources.bookId, bookId));
    return source ?? null;
  }

  /** findById without an ownership filter — for internal pipeline use only (trusted caller). */
  async findByIdUnscoped(bookId: string) {
    const [book] = await this.db.select().from(books).where(eq(books.id, bookId));
    return book ?? null;
  }

  async update(
    bookId: string,
    update: Partial<{
      title: string;
      author: string | null;
      language: string;
      status: (typeof books.$inferInsert)['status'];
      chapterCount: number;
      segmentCount: number;
    }>,
  ) {
    const [book] = await this.db
      .update(books)
      .set({ ...update, updatedAt: new Date() })
      .where(eq(books.id, bookId))
      .returning();
    return book ?? null;
  }
}
