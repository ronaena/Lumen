import { describe, it, expect, beforeEach } from 'vitest';
import { getTestDb, resetDatabase, createTestUser } from './setup.js';
import { BookRepository } from '../../src/repositories/BookRepository.js';
import { ChapterRepository } from '../../src/repositories/ChapterRepository.js';
import { ProcessingJobRepository } from '../../src/repositories/ProcessingJobRepository.js';

describe('ProcessingJob concurrency (DB-2 / PIPE-2)', () => {
  const db = getTestDb();
  const bookRepo = new BookRepository(db);
  const chapterRepo = new ChapterRepository(db);
  const jobRepo = new ProcessingJobRepository(db);

  beforeEach(async () => {
    await resetDatabase();
  });

  async function makeBookWithChapters() {
    const user = await createTestUser(db, 'jobs@example.com');
    const book = await bookRepo.create({ userId: user.id, title: 'Job Test Book', language: 'en' });
    const chapter1 = await chapterRepo.create({ bookId: book.id, orderIndex: 0, sourceLocation: 'ch1' });
    const chapter2 = await chapterRepo.create({ bookId: book.id, orderIndex: 1, sourceLocation: 'ch2' });
    return { user, book, chapter1, chapter2 };
  }

  it('rejects two active book-level jobs for the same book/jobType', async () => {
    const { book, user } = await makeBookWithChapters();
    await jobRepo.create({ bookId: book.id, userId: user.id, jobType: 'full_processing' });

    await expect(
      jobRepo.create({ bookId: book.id, userId: user.id, jobType: 'full_processing' }),
    ).rejects.toMatchObject({ cause: { code: '23505' } });
  });

  it('allows a book-level job and a chapter-scoped retry to coexist', async () => {
    const { book, user, chapter1 } = await makeBookWithChapters();
    const bookJob = await jobRepo.create({ bookId: book.id, userId: user.id, jobType: 'full_processing' });
    const chapterJob = await jobRepo.create({
      bookId: book.id,
      userId: user.id,
      jobType: 'single_chapter_retry',
      scopeId: chapter1.id,
    });

    expect(bookJob.status).toBe('queued');
    expect(chapterJob.status).toBe('queued');
    expect(chapterJob.scopeId).toBe(chapter1.id);
  });

  it('rejects two active jobs for the same book/jobType/scopeId', async () => {
    const { book, user, chapter1 } = await makeBookWithChapters();
    await jobRepo.create({
      bookId: book.id,
      userId: user.id,
      jobType: 'single_chapter_retry',
      scopeId: chapter1.id,
    });

    await expect(
      jobRepo.create({
        bookId: book.id,
        userId: user.id,
        jobType: 'single_chapter_retry',
        scopeId: chapter1.id,
      }),
    ).rejects.toMatchObject({ cause: { code: '23505' } });
  });

  it('allows two different chapter scopes to have active retries simultaneously', async () => {
    const { book, user, chapter1, chapter2 } = await makeBookWithChapters();
    const jobChapter1 = await jobRepo.create({
      bookId: book.id,
      userId: user.id,
      jobType: 'single_chapter_retry',
      scopeId: chapter1.id,
    });
    const jobChapter2 = await jobRepo.create({
      bookId: book.id,
      userId: user.id,
      jobType: 'single_chapter_retry',
      scopeId: chapter2.id,
    });

    expect(jobChapter1.scopeId).toBe(chapter1.id);
    expect(jobChapter2.scopeId).toBe(chapter2.id);
  });
});
