import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getTestDb, resetDatabase, createTestUser } from '../db/setup.js';
import { createDatabase } from '../../src/db/client.js';
import { BookRepository } from '../../src/repositories/BookRepository.js';
import { ChapterRepository } from '../../src/repositories/ChapterRepository.js';
import { TextSegmentRepository } from '../../src/repositories/TextSegmentRepository.js';
import { VoiceRepository } from '../../src/repositories/VoiceRepository.js';
import { AudioSegmentRepository } from '../../src/repositories/AudioSegmentRepository.js';
import { NarrationAttemptRepository } from '../../src/repositories/NarrationAttemptRepository.js';
import { ListeningProgressRepository } from '../../src/repositories/ListeningProgressRepository.js';
import { ReadingProgressRepository } from '../../src/repositories/ReadingProgressRepository.js';
import {
  updateListeningProgress,
  updateReadingProgress,
  resolveEffectiveListeningAudio,
  computeChapterPositionSummary,
} from '../../src/progress/ProgressService.js';
import { ProcessingError } from '../../src/processing/errors/ProcessingErrors.js';

describe('Phase 6: Progress (live Postgres)', () => {
  const db = getTestDb();
  const bookRepo = new BookRepository(db);
  const chapterRepo = new ChapterRepository(db);
  const textSegmentRepo = new TextSegmentRepository(db);
  const voiceRepo = new VoiceRepository(db);
  const audioSegmentRepo = new AudioSegmentRepository(db);
  const narrationAttemptRepo = new NarrationAttemptRepository(db);
  const listeningProgressRepo = new ListeningProgressRepository(db);
  const readingProgressRepo = new ReadingProgressRepository(db);

  const deps = { bookRepo, chapterRepo, textSegmentRepo, audioSegmentRepo, listeningProgressRepo, readingProgressRepo };

  beforeEach(async () => {
    await resetDatabase();
  });

  async function makeBookWithTwoChapters() {
    const user = await createTestUser(db, `progress-${Date.now()}-${Math.random()}@example.com`);
    const voice = await voiceRepo.create({ displayName: 'Narrator', role: 'narrator', language: 'en' });
    const book = await bookRepo.create({ userId: user.id, title: 'Progress Book', language: 'en' });
    const chapter1 = await chapterRepo.create({ bookId: book.id, orderIndex: 0, sourceLocation: 'ch1' });
    const chapter2 = await chapterRepo.create({ bookId: book.id, orderIndex: 1, sourceLocation: 'ch2' });
    const segment1 = await textSegmentRepo.create({
      chapterId: chapter1.id,
      orderIndex: 0,
      sourceText: 'A.',
      normalizedText: 'A.',
      charCount: 2,
      sourceReference: 'p[0]',
      contentHash: 'h1',
      narratorVoiceId: voice.id,
    });
    return { user, voice, book, chapter1, chapter2, segment1 };
  }

  async function makeCompletedAttempt(segmentId: string) {
    const existing = await narrationAttemptRepo.listByTextSegment(segmentId);
    const attempt = await narrationAttemptRepo.create({
      textSegmentId: segmentId,
      attemptNumber: existing.length + 1,
      provider: 'elevenlabs',
      requestId: randomUUID(),
      requestSignature: 'sig-' + randomUUID(),
    });
    await narrationAttemptRepo.complete(attempt.id, { status: 'succeeded' });
    return attempt;
  }

  it('A + B: creates then updates listening progress', async () => {
    const { user, book, chapter1 } = await makeBookWithTwoChapters();

    await updateListeningProgress(deps, {
      userId: user.id,
      bookId: book.id,
      chapterId: chapter1.id,
      playbackPositionMs: 1000,
      completionPct: '5.00',
    });

    const updated = await updateListeningProgress(deps, {
      userId: user.id,
      bookId: book.id,
      chapterId: chapter1.id,
      playbackPositionMs: 5000,
      completionPct: '20.00',
    });

    expect(updated.playbackPositionMs).toBe(5000);
    expect(updated.completionPct).toBe('20.00');
  });

  it('C: resumes from the saved position', async () => {
    const { user, book, chapter1 } = await makeBookWithTwoChapters();
    await updateListeningProgress(deps, {
      userId: user.id,
      bookId: book.id,
      chapterId: chapter1.id,
      playbackPositionMs: 42000,
      completionPct: '10.00',
    });

    const resumed = await listeningProgressRepo.findByUserAndBook(user.id, book.id);
    expect(resumed!.playbackPositionMs).toBe(42000);
    expect(resumed!.chapterId).toBe(chapter1.id);
  });

  it('D: chapter transition updates the stored current chapter', async () => {
    const { user, book, chapter1, chapter2 } = await makeBookWithTwoChapters();
    await updateListeningProgress(deps, {
      userId: user.id,
      bookId: book.id,
      chapterId: chapter1.id,
      playbackPositionMs: 100,
      completionPct: '5.00',
    });
    await updateListeningProgress(deps, {
      userId: user.id,
      bookId: book.id,
      chapterId: chapter2.id,
      playbackPositionMs: 0,
      completionPct: '50.00',
    });

    const progress = await listeningProgressRepo.findByUserAndBook(user.id, book.id);
    expect(progress!.chapterId).toBe(chapter2.id);
  });

  it('E + K: book completion via chapter position aggregation', async () => {
    const { chapter1, chapter2 } = await makeBookWithTwoChapters();
    const chapters = [chapter1, chapter2];

    const midSummary = computeChapterPositionSummary(chapters, chapter1.id);
    expect(midSummary).toEqual({ currentChapterIndex: 0, totalChapters: 2, isLastChapter: false });

    const lastSummary = computeChapterPositionSummary(chapters, chapter2.id);
    expect(lastSummary).toEqual({ currentChapterIndex: 1, totalChapters: 2, isLastChapter: true });
  });

  it('F: repeated identical updates are safe (idempotent upsert, one row)', async () => {
    const { user, book, chapter1 } = await makeBookWithTwoChapters();
    for (let i = 0; i < 3; i += 1) {
      await updateListeningProgress(deps, {
        userId: user.id,
        bookId: book.id,
        chapterId: chapter1.id,
        playbackPositionMs: 1000,
        completionPct: '5.00',
      });
    }
    const result: any = await db.execute(
      sql`SELECT count(*)::int as count FROM listening_progress WHERE user_id = ${user.id} AND book_id = ${book.id}`,
    );
    const rows = result.rows ?? result;
    expect(rows[0].count).toBe(1);
  });

  it('G: cross-user isolation — another user cannot read or write this progress', async () => {
    const { user, book, chapter1 } = await makeBookWithTwoChapters();
    await updateListeningProgress(deps, {
      userId: user.id,
      bookId: book.id,
      chapterId: chapter1.id,
      playbackPositionMs: 1000,
      completionPct: '5.00',
    });

    const otherUser = await createTestUser(db, `other-${Date.now()}@example.com`);
    const asOther = await listeningProgressRepo.findByUserAndBook(otherUser.id, book.id);
    expect(asOther).toBeNull();

    await expect(
      updateListeningProgress(deps, {
        userId: otherUser.id,
        bookId: book.id,
        chapterId: chapter1.id,
        playbackPositionMs: 1,
        completionPct: '1.00',
      }),
    ).rejects.toBeInstanceOf(ProcessingError);
  });

  it('H: invalid segment/chapter reference is rejected', async () => {
    const { user, book } = await makeBookWithTwoChapters();
    const otherBookOwner = await createTestUser(db, `otherbook-${Date.now()}@example.com`);
    const otherBook = await bookRepo.create({ userId: otherBookOwner.id, title: 'Other Book', language: 'en' });
    const otherChapter = await chapterRepo.create({ bookId: otherBook.id, orderIndex: 0, sourceLocation: 'x' });

    await expect(
      updateListeningProgress(deps, {
        userId: user.id,
        bookId: book.id,
        chapterId: otherChapter.id,
        playbackPositionMs: 0,
        completionPct: '0.00',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PROGRESS_REFERENCE' });
  });

  it('I: progress survives audio regeneration — resolves to the CURRENT active audio, not the stale stored one', async () => {
    const { user, book, chapter1, segment1 } = await makeBookWithTwoChapters();

    const attempt1 = await makeCompletedAttempt(segment1.id);
    const firstAudio = await audioSegmentRepo.activateAudioSegment({
      textSegmentId: segment1.id,
      producedByAttemptId: attempt1.id,
      storageRef: 'local://a-v1.mp3',
      provider: 'elevenlabs',
      modelUsed: 'm',
      providerVoiceId: 'v',
      durationMs: 1000,
      format: 'mp3',
      sampleRateHz: 44100,
      fileSizeBytes: 100,
      checksum: 'c1',
      estimatedCost: '0.01',
      generationSignature: 'sig-v1',
    });

    await updateListeningProgress(deps, {
      userId: user.id,
      bookId: book.id,
      chapterId: chapter1.id,
      audioSegmentId: firstAudio.id,
      playbackPositionMs: 500,
      completionPct: '10.00',
    });

    const attempt2 = await makeCompletedAttempt(segment1.id);
    const secondAudio = await audioSegmentRepo.activateAudioSegment({
      textSegmentId: segment1.id,
      producedByAttemptId: attempt2.id,
      storageRef: 'local://a-v2.mp3',
      provider: 'elevenlabs',
      modelUsed: 'm',
      providerVoiceId: 'v',
      durationMs: 1200,
      format: 'mp3',
      sampleRateHz: 44100,
      fileSizeBytes: 120,
      checksum: 'c2',
      estimatedCost: '0.01',
      generationSignature: 'sig-v2',
    });

    const rawProgress = await listeningProgressRepo.findByUserAndBook(user.id, book.id);
    expect(rawProgress!.audioSegmentId).toBe(firstAudio.id);

    const resolved = await resolveEffectiveListeningAudio(deps, user.id, book.id);
    expect(resolved!.currentAudioSegmentId).toBe(secondAudio.id);
    expect(resolved!.currentAudioSegmentId).not.toBe(firstAudio.id);
  });

  it('J: persists across a fresh database connection (not held only in memory)', async () => {
    const { user, book, chapter1 } = await makeBookWithTwoChapters();
    await updateListeningProgress(deps, {
      userId: user.id,
      bookId: book.id,
      chapterId: chapter1.id,
      playbackPositionMs: 7777,
      completionPct: '33.00',
    });

    const freshDb = createDatabase(
      process.env.TEST_DATABASE_URL ?? 'postgresql://lumen:lumen@localhost:5432/lumen_test',
    );
    const freshRepo = new ListeningProgressRepository(freshDb);
    const reread = await freshRepo.findByUserAndBook(user.id, book.id);
    expect(reread!.playbackPositionMs).toBe(7777);
  });

  it('reading progress: create, update, resume, cross-user isolation, invalid reference', async () => {
    const { user, book, chapter1, segment1 } = await makeBookWithTwoChapters();

    await updateReadingProgress(deps, {
      userId: user.id,
      bookId: book.id,
      chapterId: chapter1.id,
      textSegmentId: segment1.id,
      readingPositionOffset: 12,
      completionPct: '2.00',
    });

    const resumed = await readingProgressRepo.findByUserAndBook(user.id, book.id);
    expect(resumed!.textSegmentId).toBe(segment1.id);
    expect(resumed!.readingPositionOffset).toBe(12);

    const otherUser = await createTestUser(db, `reader-other-${Date.now()}@example.com`);
    expect(await readingProgressRepo.findByUserAndBook(otherUser.id, book.id)).toBeNull();

    await expect(
      updateReadingProgress(deps, {
        userId: user.id,
        bookId: book.id,
        chapterId: chapter1.id,
        textSegmentId: '00000000-0000-0000-0000-000000000000',
        completionPct: '0.00',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PROGRESS_REFERENCE' });
  });
});
