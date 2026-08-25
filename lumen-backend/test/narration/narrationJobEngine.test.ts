import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestDb, resetDatabase, createTestUser } from '../db/setup.js';
import { LocalFilesystemStorageProvider } from '../../src/processing/storage/LocalFilesystemStorageProvider.js';
import { ProviderRegistry } from '../../src/tts/ProviderRegistry.js';
import { ElevenLabsProvider } from '../../src/tts/providers/elevenlabs/ElevenLabsProvider.js';
import { GoogleCloudTtsProvider } from '../../src/tts/providers/google/GoogleCloudTtsProvider.js';
import { runNarrationJob } from '../../src/narration/NarrationJobEngine.js';
import { BookRepository } from '../../src/repositories/BookRepository.js';
import { ChapterRepository } from '../../src/repositories/ChapterRepository.js';
import { TextSegmentRepository } from '../../src/repositories/TextSegmentRepository.js';
import { VoiceRepository } from '../../src/repositories/VoiceRepository.js';
import { NarrationAttemptRepository } from '../../src/repositories/NarrationAttemptRepository.js';
import { AudioSegmentRepository } from '../../src/repositories/AudioSegmentRepository.js';
import { ProviderUsageRepository } from '../../src/repositories/ProviderUsageRepository.js';
import { ProcessingJobRepository } from '../../src/repositories/ProcessingJobRepository.js';

function fakeHttpClient(
  handler: (url: string, init?: RequestInit) => Promise<Response> | Response,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => handler(String(input), init)) as typeof fetch;
}
const FAKE_MP3 = Buffer.from('fake-mp3-bytes');

function elevenLabsSuccess() {
  return new ElevenLabsProvider({ apiKey: 'k', httpClient: fakeHttpClient(() => new Response(FAKE_MP3, { status: 200 })) });
}
function elevenLabsFailing(status: number) {
  return new ElevenLabsProvider({
    apiKey: 'k',
    httpClient: fakeHttpClient((url) =>
      url.includes('/v1/user') ? new Response('{}', { status: 200 }) : new Response('fail', { status }),
    ),
  });
}
function googleSuccess() {
  return new GoogleCloudTtsProvider({
    apiKey: 'k',
    httpClient: fakeHttpClient(
      () => new Response(JSON.stringify({ audioContent: FAKE_MP3.toString('base64') }), { status: 200 }),
    ),
  });
}
function googleFailing(status: number) {
  return new GoogleCloudTtsProvider({
    apiKey: 'k',
    httpClient: fakeHttpClient((url) =>
      url.includes('/v1/voices') ? new Response('{}', { status: 200 }) : new Response('fail', { status }),
    ),
  });
}

describe('Phase 5: NarrationJobEngine (live Postgres + real storage, offline provider fixtures)', () => {
  const db = getTestDb();
  const bookRepo = new BookRepository(db);
  const chapterRepo = new ChapterRepository(db);
  const textSegmentRepo = new TextSegmentRepository(db);
  const voiceRepo = new VoiceRepository(db);
  const narrationAttemptRepo = new NarrationAttemptRepository(db);
  const audioSegmentRepo = new AudioSegmentRepository(db);
  const providerUsageRepo = new ProviderUsageRepository(db);
  const jobRepo = new ProcessingJobRepository(db);

  let storageDir: string;
  let storage: LocalFilesystemStorageProvider;

  beforeAll(async () => {
    storageDir = await mkdtemp(join(tmpdir(), 'lumen-job-test-'));
  });
  afterAll(async () => {
    await rm(storageDir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await resetDatabase();
    storage = new LocalFilesystemStorageProvider(storageDir);
  });

  function deps(registry: ProviderRegistry) {
    return {
      storage,
      registry,
      textSegmentRepo,
      voiceRepo,
      narrationAttemptRepo,
      audioSegmentRepo,
      providerUsageRepo,
      bookRepo,
      chapterRepo,
      jobRepo,
    };
  }

  async function makeBook() {
    const user = await createTestUser(db, `job-${Date.now()}-${Math.random()}@example.com`);
    const voice = await voiceRepo.create({ displayName: 'Narrator', role: 'narrator', language: 'en' });
    const book = await bookRepo.create({ userId: user.id, title: 'Job Test Book', language: 'en' });
    const chapters = [];
    for (let c = 0; c < 2; c += 1) {
      const chapter = await chapterRepo.create({ bookId: book.id, orderIndex: c, sourceLocation: `ch${c}.xhtml` });
      await chapterRepo.update(chapter.id, { status: 'segmented' });
      for (let s = 0; s < 2; s += 1) {
        await textSegmentRepo.create({
          chapterId: chapter.id,
          orderIndex: s,
          sourceText: `Paragraph ${c}-${s}.`,
          normalizedText: `Paragraph ${c}-${s}.`,
          charCount: 12,
          sourceReference: `p[${s}]`,
          contentHash: `hash-${c}-${s}`,
          narratorVoiceId: voice.id,
        });
      }
      chapters.push(chapter);
    }
    return { user, voice, book, chapters };
  }

  it('A: successful full-book job narrates every segment and marks the book ready', async () => {
    const { user, voice, book } = await makeBook();
    await voiceRepo.createMapping({ voiceId: voice.id, provider: 'elevenlabs', providerVoiceId: 'vendor-1' });
    const registry = new ProviderRegistry();
    registry.register(elevenLabsSuccess(), 1);

    const result = await runNarrationJob(deps(registry), { bookId: book.id, userId: user.id, scope: { type: 'book' } });

    expect(result.jobStatus).toBe('completed');
    expect(result.bookStatus).toBe('ready');
    expect(result.chapterOutcomes).toHaveLength(2);
    expect(result.chapterOutcomes.every((c) => c.segmentsSucceeded === 2 && c.segmentsFailed === 0)).toBe(true);

    const chapters = await chapterRepo.listByBook(book.id);
    expect(chapters.every((c) => c.status === 'ready')).toBe(true);
    const finalBook = await bookRepo.findById(book.id, user.id);
    expect(finalBook!.status).toBe('ready');
  });

  it('B + K: a failed segment can be retried after fixing the cause, without losing history', async () => {
    const { user, voice, book, chapters } = await makeBook();
    await voiceRepo.createMapping({ voiceId: voice.id, provider: 'elevenlabs', providerVoiceId: 'vendor-1' });
    const registry = new ProviderRegistry();
    registry.register(elevenLabsFailing(401), 1);

    const first = await runNarrationJob(deps(registry), { bookId: book.id, userId: user.id, scope: { type: 'book' } });
    expect(first.chapterOutcomes.every((c) => c.segmentsFailed === 2)).toBe(true);
    expect(first.bookStatus).toBe('processing');

    const firstSegment = (await textSegmentRepo.listByChapter(chapters[0]!.id))[0]!;
    const attemptsBefore = await narrationAttemptRepo.listByTextSegment(firstSegment.id);
    expect(attemptsBefore).toHaveLength(1);

    const workingRegistry = new ProviderRegistry();
    workingRegistry.register(elevenLabsSuccess(), 1);
    const second = await runNarrationJob(deps(workingRegistry), { bookId: book.id, userId: user.id, scope: { type: 'book' } });

    expect(second.bookStatus).toBe('ready');
    const attemptsAfter = await narrationAttemptRepo.listByTextSegment(firstSegment.id);
    expect(attemptsAfter).toHaveLength(2);
    expect(attemptsAfter[0]!.status).toBe('failed');
    expect(attemptsAfter[1]!.status).toBe('succeeded');
  });

  it('C + D + J: a chapter-scoped retry coexists with an active full-book job; a duplicate full-book job is rejected', async () => {
    const { user, book, chapters } = await makeBook();
    const activeBookJob = await jobRepo.create({ bookId: book.id, userId: user.id, jobType: 'full_processing' });
    await jobRepo.updateJobStatus(activeBookJob.id, { status: 'processing' });

    const registry = new ProviderRegistry();
    registry.register(elevenLabsSuccess(), 1);
    const voiceId = (await textSegmentRepo.listByChapter(chapters[0]!.id))[0]!.narratorVoiceId;
    await voiceRepo.createMapping({ voiceId, provider: 'elevenlabs', providerVoiceId: 'vendor-1' });

    const chapterRetry = await runNarrationJob(deps(registry), {
      bookId: book.id,
      userId: user.id,
      scope: { type: 'chapter', chapterId: chapters[0]!.id },
    });
    expect(chapterRetry.jobStatus).toBe('completed');

    // drizzle-orm >=0.45 wraps the raw pg error at .cause rather than the top level
    // (see the isUniqueViolation fix in processBook.ts for the same discovery).
    await expect(
      runNarrationJob(deps(registry), { bookId: book.id, userId: user.id, scope: { type: 'book' } }),
    ).rejects.toMatchObject({ cause: { code: '23505' } });
  });

  it('E: rerunning a completed job does not create new attempts for already-narrated segments', async () => {
    const { user, voice, book } = await makeBook();
    await voiceRepo.createMapping({ voiceId: voice.id, provider: 'elevenlabs', providerVoiceId: 'vendor-1' });
    const registry = new ProviderRegistry();
    registry.register(elevenLabsSuccess(), 1);

    await runNarrationJob(deps(registry), { bookId: book.id, userId: user.id, scope: { type: 'book' } });
    const second = await runNarrationJob(deps(registry), { bookId: book.id, userId: user.id, scope: { type: 'book' } });

    expect(second.chapterOutcomes.every((c) => c.segmentsSkipped === 2 && c.segmentsSucceeded === 0)).toBe(true);
  });

  it('F + O: provider fallback within a job is fully traceable per segment', async () => {
    const { user, voice, book } = await makeBook();
    await voiceRepo.createMapping({ voiceId: voice.id, provider: 'elevenlabs', providerVoiceId: 'eleven-1' });
    await voiceRepo.createMapping({ voiceId: voice.id, provider: 'google_cloud_tts', providerVoiceId: 'google-1' });
    const registry = new ProviderRegistry();
    registry.register(elevenLabsFailing(503), 1);
    registry.register(googleSuccess(), 2);

    const result = await runNarrationJob(deps(registry), { bookId: book.id, userId: user.id, scope: { type: 'book' } });

    expect(result.bookStatus).toBe('ready');
    expect(result.chapterOutcomes.every((c) => c.segmentsSucceeded === 2)).toBe(true);

    for (const chapterOutcome of result.chapterOutcomes) {
      const segments = await textSegmentRepo.listByChapter(chapterOutcome.chapterId);
      for (const segment of segments) {
        const attempts = await narrationAttemptRepo.listByTextSegment(segment.id);
        expect(attempts).toHaveLength(2);
        expect(attempts[0]!.provider).toBe('elevenlabs');
        expect(attempts[0]!.status).toBe('failed');
        expect(attempts[1]!.provider).toBe('google_cloud_tts');
        expect(attempts[1]!.status).toBe('succeeded');
        expect(attempts[1]!.triggeringAttemptId).toBe(attempts[0]!.id);
      }
    }
  });

  it('G + H: both providers failing on some segments does not abort the rest of the book', async () => {
    const { user, voice, book } = await makeBook();
    await voiceRepo.createMapping({ voiceId: voice.id, provider: 'elevenlabs', providerVoiceId: 'eleven-1' });
    await voiceRepo.createMapping({ voiceId: voice.id, provider: 'google_cloud_tts', providerVoiceId: 'google-1' });
    const registry = new ProviderRegistry();
    registry.register(elevenLabsFailing(503), 1);
    registry.register(googleFailing(503), 2);

    const result = await runNarrationJob(deps(registry), { bookId: book.id, userId: user.id, scope: { type: 'book' } });

    expect(result.jobStatus).toBe('completed');
    expect(result.chapterOutcomes).toHaveLength(2);
    expect(result.chapterOutcomes.every((c) => c.segmentsFailed === 2)).toBe(true);
    expect(result.bookStatus).toBe('processing');
  });

  it('I: an interrupted job resumes — only untouched segments are attempted on the next run', async () => {
    const { user, voice, book, chapters } = await makeBook();
    await voiceRepo.createMapping({ voiceId: voice.id, provider: 'elevenlabs', providerVoiceId: 'vendor-1' });
    const registry = new ProviderRegistry();
    registry.register(elevenLabsSuccess(), 1);

    await runNarrationJob(deps(registry), {
      bookId: book.id,
      userId: user.id,
      scope: { type: 'chapter', chapterId: chapters[0]!.id },
    });

    const chapter2SegmentsBefore = await textSegmentRepo.listByChapter(chapters[1]!.id);
    expect(chapter2SegmentsBefore.every((s) => s.narrationStatus === 'pending')).toBe(true);

    const resumed = await runNarrationJob(deps(registry), { bookId: book.id, userId: user.id, scope: { type: 'book' } });

    expect(resumed.bookStatus).toBe('ready');
    const chapter1Outcome = resumed.chapterOutcomes.find((c) => c.chapterId === chapters[0]!.id)!;
    const chapter2Outcome = resumed.chapterOutcomes.find((c) => c.chapterId === chapters[1]!.id)!;
    expect(chapter1Outcome.segmentsSkipped).toBe(2);
    expect(chapter2Outcome.segmentsSucceeded).toBe(2);
  });

  it('L + M: job completion vs failure states are correct', async () => {
    const { user, voice, book } = await makeBook();
    await voiceRepo.createMapping({ voiceId: voice.id, provider: 'elevenlabs', providerVoiceId: 'vendor-1' });
    const registry = new ProviderRegistry();
    registry.register(elevenLabsSuccess(), 1);

    const success = await runNarrationJob(deps(registry), { bookId: book.id, userId: user.id, scope: { type: 'book' } });
    const successJob = await jobRepo.findById(success.processingJobId);
    expect(successJob!.status).toBe('completed');

    const emptyUser = await createTestUser(db, `empty-${Date.now()}@example.com`);
    const emptyBook = await bookRepo.create({ userId: emptyUser.id, title: 'Empty', language: 'en' });
    await expect(
      runNarrationJob(deps(registry), { bookId: emptyBook.id, userId: emptyUser.id, scope: { type: 'book' } }),
    ).rejects.toMatchObject({ code: 'CHAPTER_DETECTION_FAILED' });

    const jobs = await jobRepo.listByBook(emptyBook.id);
    expect(jobs[0]!.status).toBe('failed');
  });

  it('N: cancellation stops the job cleanly, leaving untouched segments alone', async () => {
    const { user, voice, book, chapters } = await makeBook();
    await voiceRepo.createMapping({ voiceId: voice.id, provider: 'elevenlabs', providerVoiceId: 'vendor-1' });
    const registry = new ProviderRegistry();
    registry.register(elevenLabsSuccess(), 1);

    const cancellationToken = { cancelled: true }; // pre-cancelled: proves the FIRST check point is honored
    const result = await runNarrationJob(deps(registry), {
      bookId: book.id,
      userId: user.id,
      scope: { type: 'book' },
      cancellationToken,
    });

    expect(result.jobStatus).toBe('cancelled');
    const job = await jobRepo.findById(result.processingJobId);
    expect(job!.status).toBe('cancelled');
    expect(result.chapterOutcomes).toHaveLength(0); // no chapter was even started

    for (const chapter of chapters) {
      const segments = await textSegmentRepo.listByChapter(chapter.id);
      expect(segments.every((s) => s.narrationStatus === 'pending')).toBe(true); // nothing touched
    }
  });
});
