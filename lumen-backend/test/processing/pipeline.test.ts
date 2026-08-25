import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestDb, resetDatabase, createTestUser } from '../db/setup.js';
import { LocalFilesystemStorageProvider } from '../../src/processing/storage/LocalFilesystemStorageProvider.js';
import { ingestBook, resumeBookProcessing } from '../../src/processing/pipeline/processBook.js';
import { DuplicateBookError, ProcessingError } from '../../src/processing/errors/ProcessingErrors.js';
import { BookRepository } from '../../src/repositories/BookRepository.js';
import { ChapterRepository } from '../../src/repositories/ChapterRepository.js';
import { TextSegmentRepository } from '../../src/repositories/TextSegmentRepository.js';
import { ProcessingJobRepository } from '../../src/repositories/ProcessingJobRepository.js';
import { VoiceRepository } from '../../src/repositories/VoiceRepository.js';
import { buildValidEpub, buildCorruptZip } from '../fixtures/buildEpub.js';

const threeChapters = [
  { id: 'ch1', filename: 'ch1.xhtml', title: 'One', paragraphs: ['Para one A.', 'Para one B.'] },
  { id: 'ch2', filename: 'ch2.xhtml', title: 'Two', paragraphs: ['Para two A.'] },
  { id: 'ch3', filename: 'ch3.xhtml', title: 'Three', paragraphs: ['Para three A.', 'Para three B.', 'Para three C.'] },
];

describe('Phase 2 pipeline integration', () => {
  const db = getTestDb();
  const bookRepo = new BookRepository(db);
  const chapterRepo = new ChapterRepository(db);
  const textSegmentRepo = new TextSegmentRepository(db);
  const jobRepo = new ProcessingJobRepository(db);
  const voiceRepo = new VoiceRepository(db);

  let storageDir: string;
  let storage: LocalFilesystemStorageProvider;

  beforeAll(async () => {
    storageDir = await mkdtemp(join(tmpdir(), 'lumen-test-storage-'));
  });

  afterAll(async () => {
    await rm(storageDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await resetDatabase();
    storage = new LocalFilesystemStorageProvider(storageDir);
  });

  async function makeUserAndVoice() {
    const user = await createTestUser(db, `pipeline-${Date.now()}-${Math.random()}@example.com`);
    const voice = await voiceRepo.create({ displayName: 'Narrator', role: 'narrator', language: 'en' });
    return { user, voice };
  }

  const deps = () => ({ storage, bookRepo, chapterRepo, textSegmentRepo, jobRepo, voiceRepo });

  it('Q + R + full happy path: ingests a valid EPUB end to end with real storage round-trip', async () => {
    const { user, voice } = await makeUserAndVoice();
    const buffer = await buildValidEpub({ chapters: threeChapters, title: 'Full Test Book' });

    const result = await ingestBook(deps(), {
      userId: user.id,
      buffer,
      filename: 'book.epub',
      mimeType: 'application/epub+zip',
      narratorVoiceId: voice.id,
    });

    expect(result.chapterCount).toBe(3);
    expect(result.segmentCount).toBe(6); // 2 + 1 + 3 paragraphs

    // R: storage round-trip — the stored bytes match what was uploaded.
    const source = await bookRepo.findSourceByBookId(result.bookId);
    expect(source).not.toBeNull();
    const roundTripped = await storage.read(source!.originalFileStorageRef);
    expect(Buffer.compare(roundTripped, buffer)).toBe(0);

    // Book metadata extracted from OPF.
    const book = await bookRepo.findById(result.bookId, user.id);
    expect(book!.title).toBe('Full Test Book');
    expect(book!.chapterCount).toBe(3);
    expect(book!.segmentCount).toBe(6);
    expect(book!.status).toBe('processing');

    // Chapters in deterministic spine order, each segmented.
    const chapters = await chapterRepo.listByBook(result.bookId);
    expect(chapters.map((c) => c.orderIndex)).toEqual([0, 1, 2]);
    expect(chapters.every((c) => c.status === 'segmented')).toBe(true);
    expect(chapters.map((c) => c.title)).toEqual(['One', 'Two', 'Three']);

    // TextSegments carry the resolved narratorVoiceId, deterministic order, and contentHash.
    const chapter1Segments = await textSegmentRepo.listByChapter(chapters[0]!.id);
    expect(chapter1Segments).toHaveLength(2);
    expect(chapter1Segments.every((s) => s.narratorVoiceId === voice.id)).toBe(true);
    expect(chapter1Segments.map((s) => s.orderIndex)).toEqual([0, 1]);
    expect(chapter1Segments[0]!.contentHash).toMatch(/^[a-f0-9]{64}$/);

    // Job completed, all steps recorded.
    const job = await jobRepo.findById(result.processingJobId);
    expect(job!.status).toBe('completed');
    const steps = await jobRepo.listStepsByJob(result.processingJobId);
    const stepTypes = steps.map((s) => s.stepType).sort();
    expect(stepTypes).toEqual(
      ['chapter_detection', 'extraction', 'segmentation', 'segmentation', 'segmentation', 'upload', 'validation'].sort(),
    );
    expect(steps.every((s) => s.status === 'completed')).toBe(true);
  });

  it('Q: duplicate upload (same user, same file) is rejected as DuplicateBookError, not a raw DB error', async () => {
    const { user, voice } = await makeUserAndVoice();
    const buffer = await buildValidEpub({ chapters: threeChapters, title: 'Dup Test' });

    await ingestBook(deps(), {
      userId: user.id,
      buffer,
      filename: 'book.epub',
      mimeType: 'application/epub+zip',
      narratorVoiceId: voice.id,
    });

    await expect(
      ingestBook(deps(), {
        userId: user.id,
        buffer,
        filename: 'book-again.epub',
        mimeType: 'application/epub+zip',
        narratorVoiceId: voice.id,
      }),
    ).rejects.toBeInstanceOf(DuplicateBookError);
  });

  it('S: ownership — a user cannot retrieve a book belonging to another user', async () => {
    const { user: userA, voice } = await makeUserAndVoice();
    const userB = await createTestUser(db, `other-${Date.now()}@example.com`);
    const buffer = await buildValidEpub({ chapters: threeChapters });

    const result = await ingestBook(deps(), {
      userId: userA.id,
      buffer,
      filename: 'book.epub',
      mimeType: 'application/epub+zip',
      narratorVoiceId: voice.id,
    });

    const asOwner = await bookRepo.findById(result.bookId, userA.id);
    const asOtherUser = await bookRepo.findById(result.bookId, userB.id);

    expect(asOwner).not.toBeNull();
    expect(asOtherUser).toBeNull();
  });

  it('T: a validation failure marks the job/step failed with a safe error, and the book is marked failed', async () => {
    const { user, voice } = await makeUserAndVoice();
    const buffer = await buildCorruptZip();

    await expect(
      ingestBook(deps(), {
        userId: user.id,
        buffer,
        filename: 'book.epub',
        mimeType: 'application/epub+zip',
        narratorVoiceId: voice.id,
      }),
    ).rejects.toMatchObject({ code: 'CORRUPT_ZIP' });

    const books = await bookRepo.listByUser(user.id);
    expect(books).toHaveLength(1);
    expect(books[0]!.status).toBe('failed');

    const jobs = await jobRepo.listByBook(books[0]!.id);
    expect(jobs[0]!.status).toBe('failed');
    const steps = await jobRepo.listStepsByJob(jobs[0]!.id);
    const validationStep = steps.find((s) => s.stepType === 'validation');
    expect(validationStep!.status).toBe('failed');
    // Safe message only — never a raw parser/zip exception string.
    expect(validationStep!.lastError).not.toMatch(/unzipper|ENOENT|stack/i);
    expect(validationStep!.lastError).toMatch(/corrupted/i);
  });

  it('T + Q: resume behavior — reprocessing after a segmentation failure only redoes the failed chapter', async () => {
    const { user, voice } = await makeUserAndVoice();
    const buffer = await buildValidEpub({ chapters: threeChapters, title: 'Resume Test' });

    const result = await ingestBook(deps(), {
      userId: user.id,
      buffer,
      filename: 'book.epub',
      mimeType: 'application/epub+zip',
      narratorVoiceId: voice.id,
    });

    // Simulate a chapter that never finished segmenting (e.g. crash mid-pipeline): revert
    // chapter 3 back to 'pending' and delete its segments, leaving 1 and 2 untouched.
    const chapters = await chapterRepo.listByBook(result.bookId);
    const chapter3 = chapters[2]!;
    await chapterRepo.update(chapter3.id, { status: 'pending', segmentCount: 0, textCharCount: 0 });
    await db.execute(
      (await import('drizzle-orm')).sql`DELETE FROM text_segments WHERE chapter_id = ${chapter3.id}`,
    );

    const before1 = await textSegmentRepo.listByChapter(chapters[0]!.id);
    const before2 = await textSegmentRepo.listByChapter(chapters[1]!.id);
    expect(before1).toHaveLength(2); // untouched
    expect(before2).toHaveLength(1); // untouched

    const resumeResult = await resumeBookProcessing(deps(), {
      bookId: result.bookId,
      userId: user.id,
      narratorVoiceId: voice.id,
    });

    expect(resumeResult.chapterCount).toBe(3);
    expect(resumeResult.segmentCount).toBe(6); // fully recovered

    const after3 = await textSegmentRepo.listByChapter(chapter3.id);
    expect(after3).toHaveLength(3); // re-segmented correctly

    // Chapters 1 and 2 were never re-touched: same segment IDs as before resume.
    const after1 = await textSegmentRepo.listByChapter(chapters[0]!.id);
    expect(after1.map((s) => s.id)).toEqual(before1.map((s) => s.id));

    // The resume job only recorded a segmentation step for the chapter that needed it.
    const resumeSteps = await jobRepo.listStepsByJob(resumeResult.processingJobId);
    const segmentationSteps = resumeSteps.filter((s) => s.stepType === 'segmentation');
    expect(segmentationSteps).toHaveLength(1);
    expect(segmentationSteps[0]!.scopeId).toBe(chapter3.id);
  });

  it('rejects ingestion when narratorVoiceId does not resolve to a real Voice', async () => {
    const { user } = await makeUserAndVoice();
    const buffer = await buildValidEpub({ chapters: threeChapters });

    await expect(
      ingestBook(deps(), {
        userId: user.id,
        buffer,
        filename: 'book.epub',
        mimeType: 'application/epub+zip',
        narratorVoiceId: '00000000-0000-0000-0000-000000000000',
      }),
    ).rejects.toBeInstanceOf(ProcessingError);
  });
});
