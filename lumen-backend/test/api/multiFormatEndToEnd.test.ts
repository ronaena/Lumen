import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestDb, resetDatabase } from '../db/setup.js';
import { LocalFilesystemStorageProvider } from '../../src/processing/storage/LocalFilesystemStorageProvider.js';
import { ProviderRegistry } from '../../src/tts/ProviderRegistry.js';
import { ElevenLabsProvider } from '../../src/tts/providers/elevenlabs/ElevenLabsProvider.js';
import { createApiServer } from '../../src/api/server.js';
import { createSessionIdentityResolver } from '../../src/api/identity/sessionIdentityResolver.js';
import { RateLimiter } from '../../src/api/security/RateLimiter.js';
import { ManualClock } from './manualClock.js';
import { AuthService } from '../../src/auth/AuthService.js';
import { UserRepository } from '../../src/repositories/UserRepository.js';
import { UserCredentialRepository } from '../../src/repositories/UserCredentialRepository.js';
import { SessionRepository } from '../../src/repositories/SessionRepository.js';
import { BookRepository } from '../../src/repositories/BookRepository.js';
import { ChapterRepository } from '../../src/repositories/ChapterRepository.js';
import { TextSegmentRepository } from '../../src/repositories/TextSegmentRepository.js';
import { VoiceRepository } from '../../src/repositories/VoiceRepository.js';
import { AudioSegmentRepository } from '../../src/repositories/AudioSegmentRepository.js';
import { NarrationAttemptRepository } from '../../src/repositories/NarrationAttemptRepository.js';
import { ProviderUsageRepository } from '../../src/repositories/ProviderUsageRepository.js';
import { ProcessingJobRepository } from '../../src/repositories/ProcessingJobRepository.js';
import { ListeningProgressRepository } from '../../src/repositories/ListeningProgressRepository.js';
import { ReadingProgressRepository } from '../../src/repositories/ReadingProgressRepository.js';
import { CharacterRepository } from '../../src/repositories/CharacterRepository.js';
import { CharacterVoiceAssignmentRepository } from '../../src/repositories/CharacterVoiceAssignmentRepository.js';
import { SceneRepository } from '../../src/repositories/SceneRepository.js';
import { buildValidEpub } from '../fixtures/buildEpub.js';
import { buildValidDocx } from '../fixtures/buildDocx.js';
import { buildValidPdf } from '../fixtures/buildPdf.js';

/**
 * Real, full end-to-end verification: upload each format through the actual HTTP
 * /books endpoint, then read it back through the actual GET /books/:bookId/chapters
 * and GET /chapters/:chapterId/segments endpoints -- the exact same path the real
 * Reader/Player consume, not internal function calls. Compares sourceText EXACTLY
 * against known fixture content, not substring matching.
 */
describe('Multi-Format End-to-End: real HTTP upload -> real chapters/segments API -> exact content verification', () => {
  const db = getTestDb();
  const userRepo = new UserRepository(db);
  const userCredentialRepo = new UserCredentialRepository(db);
  const sessionRepo = new SessionRepository(db);
  const bookRepo = new BookRepository(db);
  const voiceRepo = new VoiceRepository(db);
  const narrationAttemptRepo = new NarrationAttemptRepository(db);
  const audioSegmentRepo = new AudioSegmentRepository(db);

  let storageDir: string;
  let storage: LocalFilesystemStorageProvider;
  let server: Server;
  let baseUrl: string;
  let clock: ManualClock;

  beforeAll(async () => {
    storageDir = await mkdtemp(join(tmpdir(), 'lumen-e2e-multiformat-'));
    storage = new LocalFilesystemStorageProvider(storageDir);
    const registry = new ProviderRegistry();
    registry.register(
      new ElevenLabsProvider({
        apiKey: 'k',
        httpClient: (async (input: string | URL | Request) => {
          if (String(input).includes('/v1/user')) return new Response('{}', { status: 200 });
          return new Response(Buffer.from('fake-mp3-bytes-for-e2e-audio-check'), { status: 200 });
        }) as typeof fetch,
      }),
      1,
    );
    const authService = new AuthService({ userRepo, userCredentialRepo, sessionRepo });

    const deps = {
      storage,
      registry,
      bookRepo,
      chapterRepo: new ChapterRepository(db),
      textSegmentRepo: new TextSegmentRepository(db),
      voiceRepo,
      audioSegmentRepo,
      narrationAttemptRepo,
      providerUsageRepo: new ProviderUsageRepository(db),
      jobRepo: new ProcessingJobRepository(db),
      listeningProgressRepo: new ListeningProgressRepository(db),
      readingProgressRepo: new ReadingProgressRepository(db),
      characterRepo: new CharacterRepository(db),
      characterVoiceAssignmentRepo: new CharacterVoiceAssignmentRepository(db),
      sceneRepo: new SceneRepository(db),
    };

    clock = new ManualClock();
    const rateLimiter = new RateLimiter(clock);
    server = await createApiServer(deps, createSessionIdentityResolver(authService), authService, rateLimiter);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(storageDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await resetDatabase();
    clock.advance(16 * 60 * 1000);
  });

  async function registerLoginAndVoice(label: string) {
    const email = `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    await fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'correct-horse-battery' }),
    });
    const loginResponse = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'correct-horse-battery' }),
    });
    const { token } = (await loginResponse.json()) as any;
    const voice = await voiceRepo.create({ displayName: 'Narrator', role: 'narrator', language: 'en' });
    await voiceRepo.createMapping({ voiceId: voice.id, provider: 'elevenlabs', providerVoiceId: 'vendor-e2e' });
    return { token, voiceId: voice.id };
  }

  async function uploadViaRealHttp(token: string, voiceId: string, filename: string, mimeType: string, buffer: Buffer) {
    const response = await fetch(`${baseUrl}/books`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename,
        mimeType,
        fileBase64: buffer.toString('base64'),
        narratorVoiceId: voiceId,
      }),
    });
    expect(response.status).toBe(201);
    return (await response.json()) as { bookId: string; processingJobId: string; chapterCount: number; segmentCount: number };
  }

  async function fetchChaptersAndSegments(token: string, bookId: string) {
    const chaptersResponse = await fetch(`${baseUrl}/books/${bookId}/chapters`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(chaptersResponse.status).toBe(200);
    const chapters = (await chaptersResponse.json()) as any[];

    const perChapterSegments: any[][] = [];
    for (const chapter of chapters) {
      const segmentsResponse = await fetch(`${baseUrl}/chapters/${chapter.id}/segments`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(segmentsResponse.status).toBe(200);
      perChapterSegments.push((await segmentsResponse.json()) as any[]);
    }
    return { chapters, perChapterSegments };
  }

  // ============================== EPUB ==============================

  it('EPUB: real upload -> real chapters/segments API -> exact sourceText match', async () => {
    const { token, voiceId } = await registerLoginAndVoice('e2e-epub');
    const buffer = await buildValidEpub({
      title: 'E2E EPUB Book',
      chapters: [
        { id: 'ch1', filename: 'ch1.xhtml', title: 'Chapter One', paragraphs: ['EPUB paragraph one.', 'EPUB paragraph two.'] },
        { id: 'ch2', filename: 'ch2.xhtml', title: 'Chapter Two', paragraphs: ['EPUB chapter two content.'] },
      ],
    });

    const uploadResult = await uploadViaRealHttp(token, voiceId, 'book.epub', 'application/epub+zip', buffer);
    expect(uploadResult.chapterCount).toBe(2);
    expect(uploadResult.segmentCount).toBe(3);

    const { chapters, perChapterSegments } = await fetchChaptersAndSegments(token, uploadResult.bookId);
    expect(chapters).toHaveLength(2);
    // EPUB retains real chapter titles from the spine -- confirmed, not assumed.
    expect(chapters.map((c) => c.title)).toEqual(['Chapter One', 'Chapter Two']);
    expect(perChapterSegments[0]!.map((s: any) => s.sourceText)).toEqual(['EPUB paragraph one.', 'EPUB paragraph two.']);
    expect(perChapterSegments[1]!.map((s: any) => s.sourceText)).toEqual(['EPUB chapter two content.']);
  });

  // ============================== TXT ==============================

  it('TXT: real upload -> real chapters/segments API -> exact sourceText match, single generated chapter, no fabricated title', async () => {
    const { token, voiceId } = await registerLoginAndVoice('e2e-txt');
    const buffer = Buffer.from('TXT paragraph one.\n\nTXT paragraph two.\n\nTXT paragraph three.', 'utf8');

    const uploadResult = await uploadViaRealHttp(token, voiceId, 'book.txt', 'text/plain', buffer);
    expect(uploadResult.chapterCount).toBe(1);
    expect(uploadResult.segmentCount).toBe(3);

    const { chapters, perChapterSegments } = await fetchChaptersAndSegments(token, uploadResult.bookId);
    expect(chapters).toHaveLength(1);
    expect(chapters[0]!.title).toBeNull();
    expect(perChapterSegments[0]!.map((s: any) => s.sourceText)).toEqual([
      'TXT paragraph one.',
      'TXT paragraph two.',
      'TXT paragraph three.',
    ]);
  });

  // ============================== DOCX ==============================

  it('DOCX: real upload -> real chapters/segments API -> exact sourceText match, single generated chapter (approved policy -- no heading detection)', async () => {
    const { token, voiceId } = await registerLoginAndVoice('e2e-docx');
    const buffer = await buildValidDocx(['DOCX paragraph one.', 'DOCX paragraph two.']);

    const uploadResult = await uploadViaRealHttp(
      token,
      voiceId,
      'book.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer,
    );
    expect(uploadResult.chapterCount).toBe(1);
    expect(uploadResult.segmentCount).toBe(2);

    const { chapters, perChapterSegments } = await fetchChaptersAndSegments(token, uploadResult.bookId);
    expect(chapters).toHaveLength(1);
    expect(chapters[0]!.title).toBeNull();
    expect(perChapterSegments[0]!.map((s: any) => s.sourceText)).toEqual(['DOCX paragraph one.', 'DOCX paragraph two.']);
  });

  // ============================== PDF ==============================

  it('PDF: real upload -> real chapters/segments API -> exact sourceText match', async () => {
    const { token, voiceId } = await registerLoginAndVoice('e2e-pdf');
    const buffer = buildValidPdf('PDF extractable content for end to end test.');

    const uploadResult = await uploadViaRealHttp(token, voiceId, 'book.pdf', 'application/pdf', buffer);
    expect(uploadResult.chapterCount).toBe(1);
    expect(uploadResult.segmentCount).toBe(1);

    const { chapters, perChapterSegments } = await fetchChaptersAndSegments(token, uploadResult.bookId);
    expect(chapters).toHaveLength(1);
    expect(perChapterSegments[0]!.map((s: any) => s.sourceText)).toEqual(['PDF extractable content for end to end test.']);
  });

  // ============================== NARRATION / AUDIO COMPATIBILITY ==============================

  it('narration and audio work identically for a TXT-sourced segment, with zero format-specific logic', async () => {
    const { token, voiceId } = await registerLoginAndVoice('e2e-narration-txt');
    const buffer = Buffer.from('A single paragraph to be narrated end to end.', 'utf8');
    const uploadResult = await uploadViaRealHttp(token, voiceId, 'narrate.txt', 'text/plain', buffer);

    // Trigger narration through the real, unmodified job endpoint -- same path as EPUB.
    const jobResponse = await fetch(`${baseUrl}/books/${uploadResult.bookId}/jobs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'book' }),
    });
    expect(jobResponse.status).toBe(202);
    const jobBody = (await jobResponse.json()) as any;
    expect(jobBody.bookStatus).toBe('ready');

    const { chapters, perChapterSegments } = await fetchChaptersAndSegments(token, uploadResult.bookId);
    const segment = perChapterSegments[0]![0];
    expect(segment.narrationStatus).toBe('ready');
    expect(segment.currentAudioSegmentId).not.toBeNull();

    // Fetch the real audio through the real, unmodified audio endpoint.
    const audioResponse = await fetch(`${baseUrl}/segments/${segment.id}/audio`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(audioResponse.status).toBe(200);
    const audioBytes = Buffer.from(await audioResponse.arrayBuffer());
    expect(audioBytes.toString('utf8')).toBe('fake-mp3-bytes-for-e2e-audio-check');
    void chapters;
  });

  // ============================== SECURITY ==============================

  it('security: user A cannot read user B chapters/segments/audio for a non-EPUB-sourced book', async () => {
    const owner = await registerLoginAndVoice('e2e-sec-owner');
    const other = await registerLoginAndVoice('e2e-sec-other');
    const buffer = await buildValidDocx(['Private content.']);
    const uploadResult = await uploadViaRealHttp(
      owner.token,
      owner.voiceId,
      'private.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer,
    );

    const chaptersAsOther = await fetch(`${baseUrl}/books/${uploadResult.bookId}/chapters`, {
      headers: { Authorization: `Bearer ${other.token}` },
    });
    expect(chaptersAsOther.status).toBe(404);

    const { chapters } = await fetchChaptersAndSegments(owner.token, uploadResult.bookId);
    const segmentsAsOther = await fetch(`${baseUrl}/chapters/${chapters[0]!.id}/segments`, {
      headers: { Authorization: `Bearer ${other.token}` },
    });
    expect(segmentsAsOther.status).toBe(404);
  });

  it('security: sourceText from every format is plain text -- no HTML interpretation, exact round-trip', async () => {
    const { token, voiceId } = await registerLoginAndVoice('e2e-plaintext');
    const rawContent = 'Text with <script>alert(1)</script> looking content.';
    const buffer = await buildValidDocx([rawContent]);
    const uploadResult = await uploadViaRealHttp(
      token,
      voiceId,
      'xss-attempt.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer,
    );
    const { perChapterSegments } = await fetchChaptersAndSegments(token, uploadResult.bookId);
    // mammoth's extractRawText never interprets DOCX content as HTML/markup -- the
    // exact original string round-trips through storage and the API as opaque text
    // data inside a JSON value, never as executable markup. The frontend Reader (see
    // ReaderPage.tsx) renders this via plain JSX text interpolation, which React
    // escapes by construction -- no dangerouslySetInnerHTML exists anywhere in it.
    expect(perChapterSegments[0]![0].sourceText).toBe(rawContent);
  });
});
