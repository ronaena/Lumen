import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getTestDb, resetDatabase, createTestUser } from '../db/setup.js';
import { reconcileOrphanedWork } from '../../src/narration/reconcileOrphanedWork.js';
import { NarrationAttemptRepository } from '../../src/repositories/NarrationAttemptRepository.js';
import { ProcessingJobRepository } from '../../src/repositories/ProcessingJobRepository.js';
import { BookRepository } from '../../src/repositories/BookRepository.js';
import { ChapterRepository } from '../../src/repositories/ChapterRepository.js';
import { TextSegmentRepository } from '../../src/repositories/TextSegmentRepository.js';
import { VoiceRepository } from '../../src/repositories/VoiceRepository.js';

describe('Workstream 13D: orphaned processing-state reconciliation (real Postgres)', () => {
  const db = getTestDb();
  const narrationAttemptRepo = new NarrationAttemptRepository(db);
  const jobRepo = new ProcessingJobRepository(db);
  const bookRepo = new BookRepository(db);
  const chapterRepo = new ChapterRepository(db);
  const textSegmentRepo = new TextSegmentRepository(db);
  const voiceRepo = new VoiceRepository(db);

  beforeEach(async () => {
    await resetDatabase();
  });

  async function makeSegment() {
    const user = await createTestUser(db, `13d-${Date.now()}-${Math.random()}@example.com`);
    const voice = await voiceRepo.create({ displayName: 'Narrator', role: 'narrator', language: 'en' });
    const book = await bookRepo.create({ userId: user.id, title: '13D Test Book', language: 'en' });
    const chapter = await chapterRepo.create({ bookId: book.id, orderIndex: 0, sourceLocation: 'ch1' });
    const segment = await textSegmentRepo.create({
      chapterId: chapter.id,
      orderIndex: 0,
      sourceText: 'Test.',
      normalizedText: 'Test.',
      charCount: 5,
      sourceReference: 'p[0]',
      contentHash: 'h1',
      narratorVoiceId: voice.id,
    });
    return { user, voice, book, chapter, segment };
  }

  async function seedProcessingAttempt(segmentId: string, requestSuffix: string, attemptNumber = 1) {
    return narrationAttemptRepo.create({
      textSegmentId: segmentId,
      attemptNumber,
      provider: 'elevenlabs',
      requestId: randomUUID(),
      requestSignature: `sig-${requestSuffix}`,
    });
  }

  async function seedProcessingJob(bookId: string, userId: string) {
    const job = await jobRepo.create({ bookId, userId, jobType: 'full_processing' });
    await jobRepo.updateJobStatus(job.id, { status: 'processing', startedAt: new Date() });
    return job;
  }

  it('TEST 1: an orphaned NarrationAttempt (status=processing) is reconciled to failed', async () => {
    const { segment } = await makeSegment();
    const attempt = await seedProcessingAttempt(segment.id, '1');
    expect(attempt.status).toBe('processing');

    const result = await reconcileOrphanedWork({ narrationAttemptRepo, jobRepo });
    expect(result.reconciledAttempts).toBe(1);

    const reconciled = await narrationAttemptRepo.findById(attempt.id);
    expect(reconciled!.status).toBe('failed');
    expect(reconciled!.respondedAt).not.toBeNull();
  });

  it('TEST 2: an orphaned ProcessingJob (status=processing) is reconciled to failed', async () => {
    const { user, book } = await makeSegment();
    const job = await seedProcessingJob(book.id, user.id);
    const beforeReconcile = await jobRepo.findById(job.id);
    expect(beforeReconcile!.status).toBe('processing');

    const result = await reconcileOrphanedWork({ narrationAttemptRepo, jobRepo });
    expect(result.reconciledJobs).toBe(1);

    const reconciled = await jobRepo.findById(job.id);
    expect(reconciled!.status).toBe('failed');
    expect(reconciled!.completedAt).not.toBeNull();
  });

  it('TEST 3: terminal NarrationAttempts (completed/failed) are left completely untouched', async () => {
    const { segment } = await makeSegment();
    const completedAttempt = await seedProcessingAttempt(segment.id, 'completed');
    await narrationAttemptRepo.complete(completedAttempt.id, { status: 'succeeded', actualCost: '0.01' });
    const beforeCompleted = await narrationAttemptRepo.findById(completedAttempt.id);

    const failedAttempt = await seedProcessingAttempt(segment.id, 'failed', 2);
    await narrationAttemptRepo.complete(failedAttempt.id, {
      status: 'failed',
      normalizedErrorCode: 'PROVIDER_UNAVAILABLE',
      errorMessage: 'a genuine pre-existing failure, unrelated to 13D',
    });
    const beforeFailed = await narrationAttemptRepo.findById(failedAttempt.id);

    await reconcileOrphanedWork({ narrationAttemptRepo, jobRepo });

    const afterCompleted = await narrationAttemptRepo.findById(completedAttempt.id);
    const afterFailed = await narrationAttemptRepo.findById(failedAttempt.id);
    expect(afterCompleted).toEqual(beforeCompleted);
    expect(afterFailed).toEqual(beforeFailed);
  });

  it('TEST 4: terminal ProcessingJobs (completed/failed/cancelled) are left completely untouched', async () => {
    const { user, book } = await makeSegment();

    const completedJob = await jobRepo.create({ bookId: book.id, userId: user.id, jobType: 'full_processing' });
    await jobRepo.updateJobStatus(completedJob.id, { status: 'completed', completedAt: new Date() });
    const beforeCompleted = await jobRepo.findById(completedJob.id);

    const chapter2 = await chapterRepo.create({ bookId: book.id, orderIndex: 1, sourceLocation: 'ch2' });
    const failedJob = await jobRepo.create({
      bookId: book.id,
      userId: user.id,
      jobType: 'single_chapter_retry',
      scopeId: chapter2.id,
    });
    await jobRepo.updateJobStatus(failedJob.id, { status: 'failed', completedAt: new Date() });
    const beforeFailed = await jobRepo.findById(failedJob.id);

    const chapter3 = await chapterRepo.create({ bookId: book.id, orderIndex: 2, sourceLocation: 'ch3' });
    const cancelledJob = await jobRepo.create({
      bookId: book.id,
      userId: user.id,
      jobType: 'single_chapter_retry',
      scopeId: chapter3.id,
    });
    await jobRepo.updateJobStatus(cancelledJob.id, { status: 'cancelled', completedAt: new Date() });
    const beforeCancelled = await jobRepo.findById(cancelledJob.id);

    await reconcileOrphanedWork({ narrationAttemptRepo, jobRepo });

    expect(await jobRepo.findById(completedJob.id)).toEqual(beforeCompleted);
    expect(await jobRepo.findById(failedJob.id)).toEqual(beforeFailed);
    expect(await jobRepo.findById(cancelledJob.id)).toEqual(beforeCancelled);
  });

  it('TEST 5: running reconciliation twice is idempotent — the second run reconciles nothing further and corrupts nothing', async () => {
    const { segment, user, book } = await makeSegment();
    const attempt = await seedProcessingAttempt(segment.id, 'idempotent');
    const job = await seedProcessingJob(book.id, user.id);

    const first = await reconcileOrphanedWork({ narrationAttemptRepo, jobRepo });
    expect(first.reconciledAttempts).toBe(1);
    expect(first.reconciledJobs).toBe(1);

    const afterFirstAttempt = await narrationAttemptRepo.findById(attempt.id);
    const afterFirstJob = await jobRepo.findById(job.id);

    const second = await reconcileOrphanedWork({ narrationAttemptRepo, jobRepo });
    expect(second.reconciledAttempts).toBe(0);
    expect(second.reconciledJobs).toBe(0);

    const afterSecondAttempt = await narrationAttemptRepo.findById(attempt.id);
    const afterSecondJob = await jobRepo.findById(job.id);
    expect(afterSecondAttempt).toEqual(afterFirstAttempt);
    expect(afterSecondJob).toEqual(afterFirstJob);
  });

  it('TEST 6: after reconciliation, a new legitimate NarrationAttempt for the same segment can be created (retry unblocked)', async () => {
    const { segment } = await makeSegment();
    const orphaned = await seedProcessingAttempt(segment.id, 'retry-check');

    await expect(
      narrationAttemptRepo.create({
        textSegmentId: segment.id,
        attemptNumber: 2,
        provider: 'elevenlabs',
        requestId: randomUUID(),
        requestSignature: 'sig-blocked',
      }),
    ).rejects.toBeTruthy();

    await reconcileOrphanedWork({ narrationAttemptRepo, jobRepo });

    const retried = await narrationAttemptRepo.create({
      textSegmentId: segment.id,
      attemptNumber: 2,
      provider: 'elevenlabs',
      requestId: randomUUID(),
      requestSignature: 'sig-retry',
    });
    expect(retried.status).toBe('processing');
    expect(retried.id).not.toBe(orphaned.id);
  });

  it('TEST 7: after reconciliation, a new legitimate ProcessingJob for the same book/scope can be created (retry unblocked)', async () => {
    const { user, book } = await makeSegment();
    const orphaned = await seedProcessingJob(book.id, user.id);

    await expect(
      (async () => {
        const blocked = await jobRepo.create({ bookId: book.id, userId: user.id, jobType: 'full_processing' });
        await jobRepo.updateJobStatus(blocked.id, { status: 'processing' });
      })(),
    ).rejects.toBeTruthy();

    await reconcileOrphanedWork({ narrationAttemptRepo, jobRepo });

    const retriedJob = await jobRepo.create({ bookId: book.id, userId: user.id, jobType: 'full_processing' });
    await jobRepo.updateJobStatus(retriedJob.id, { status: 'processing' });
    const confirmed = await jobRepo.findById(retriedJob.id);
    expect(confirmed!.status).toBe('processing');
    expect(retriedJob.id).not.toBe(orphaned.id);
  });

  it('TEST 8: multiple orphaned attempts and jobs across different segments/books are all reconciled', async () => {
    const seg1 = await makeSegment();
    const seg2 = await makeSegment();
    const seg3 = await makeSegment();

    const attempt1 = await seedProcessingAttempt(seg1.segment.id, 'multi-1');
    const attempt2 = await seedProcessingAttempt(seg2.segment.id, 'multi-2');
    const job1 = await seedProcessingJob(seg1.book.id, seg1.user.id);
    const job2 = await seedProcessingJob(seg3.book.id, seg3.user.id);

    const result = await reconcileOrphanedWork({ narrationAttemptRepo, jobRepo });
    expect(result.reconciledAttempts).toBe(2);
    expect(result.reconciledJobs).toBe(2);

    for (const id of [attempt1.id, attempt2.id]) {
      const row = await narrationAttemptRepo.findById(id);
      expect(row!.status).toBe('failed');
    }
    for (const id of [job1.id, job2.id]) {
      const row = await jobRepo.findById(id);
      expect(row!.status).toBe('failed');
    }
  });

  it('reconciliation does not itself re-trigger narration or job execution — it only clears state', async () => {
    const { segment } = await makeSegment();
    await seedProcessingAttempt(segment.id, 'no-auto-retry');

    const result = await reconcileOrphanedWork({ narrationAttemptRepo, jobRepo });
    expect(result.reconciledAttempts).toBe(1);

    const allAttempts = await narrationAttemptRepo.listByTextSegment(segment.id);
    expect(allAttempts).toHaveLength(1);
    expect(allAttempts[0]!.status).toBe('failed');
  });
});
