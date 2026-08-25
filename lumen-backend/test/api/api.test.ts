import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestDb, resetDatabase, createTestUser } from '../db/setup.js';
import { LocalFilesystemStorageProvider } from '../../src/processing/storage/LocalFilesystemStorageProvider.js';
import { ProviderRegistry } from '../../src/tts/ProviderRegistry.js';
import { ElevenLabsProvider } from '../../src/tts/providers/elevenlabs/ElevenLabsProvider.js';
import { createApiServer } from '../../src/api/server.js';
import { unauthenticatedIdentityResolver } from '../../src/api/identity/unauthenticatedIdentityResolver.js';
import { testIdentityResolver } from './testIdentityResolver.js';
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
import { UserRepository } from '../../src/repositories/UserRepository.js';
import { UserCredentialRepository } from '../../src/repositories/UserCredentialRepository.js';
import { SessionRepository } from '../../src/repositories/SessionRepository.js';
import { AuthService } from '../../src/auth/AuthService.js';
import { buildValidEpub, buildCorruptZip } from '../fixtures/buildEpub.js';

function fakeHttpClient(handler: (url: string) => Response): typeof fetch {
  return (async (input: string | URL | Request) => handler(String(input))) as typeof fetch;
}
const FAKE_MP3 = Buffer.from('fake-mp3-bytes');

describe('Phase 11: API layer (real HTTP server + live Postgres)', () => {
  const db = getTestDb();
  const bookRepo = new BookRepository(db);
  const chapterRepo = new ChapterRepository(db);
  const textSegmentRepo = new TextSegmentRepository(db);
  const voiceRepo = new VoiceRepository(db);
  const audioSegmentRepo = new AudioSegmentRepository(db);
  const narrationAttemptRepo = new NarrationAttemptRepository(db);
  const providerUsageRepo = new ProviderUsageRepository(db);
  const jobRepo = new ProcessingJobRepository(db);
  const listeningProgressRepo = new ListeningProgressRepository(db);
  const readingProgressRepo = new ReadingProgressRepository(db);
  const characterRepo = new CharacterRepository(db);
  const characterVoiceAssignmentRepo = new CharacterVoiceAssignmentRepository(db);
  const sceneRepo = new SceneRepository(db);

  let storageDir: string;
  let server: Server;
  let baseUrl: string;
  let authedServer: Server;
  let authedBaseUrl: string;

  beforeAll(async () => {
    storageDir = await mkdtemp(join(tmpdir(), 'lumen-api-test-'));
    const storage = new LocalFilesystemStorageProvider(storageDir);
    const registry = new ProviderRegistry();
    registry.register(
      new ElevenLabsProvider({
        apiKey: 'k',
        httpClient: fakeHttpClient((url) =>
          url.includes('/v1/user') ? new Response('{}', { status: 200 }) : new Response(FAKE_MP3, { status: 200 }),
        ),
      }),
      1,
    );
    const deps = {
      storage,
      registry,
      bookRepo,
      chapterRepo,
      textSegmentRepo,
      voiceRepo,
      audioSegmentRepo,
      narrationAttemptRepo,
      providerUsageRepo,
      jobRepo,
      listeningProgressRepo,
      readingProgressRepo,
      characterRepo,
      characterVoiceAssignmentRepo,
      sceneRepo,
    };
    // Phase 11's own tests don't exercise auth — a real AuthService is still required to
    // construct the server (it now always registers /auth/* routes), backed by the same
    // real repositories/database as everything else in this suite.
    const authService = new AuthService({
      userRepo: new UserRepository(db),
      userCredentialRepo: new UserCredentialRepository(db),
      sessionRepo: new SessionRepository(db),
    });

    server = await createApiServer(deps, unauthenticatedIdentityResolver, authService);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;

    authedServer = await createApiServer(deps, testIdentityResolver, authService);
    await new Promise<void>((resolve) => authedServer.listen(0, resolve));
    const authedAddr = authedServer.address() as AddressInfo;
    authedBaseUrl = `http://127.0.0.1:${authedAddr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => authedServer.close(() => resolve()));
    await rm(storageDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  function authed(userId: string, init: RequestInit = {}): RequestInit {
    return {
      ...init,
      headers: { ...(init.headers ?? {}), 'x-test-user-id': userId, 'Content-Type': 'application/json' },
    };
  }

  async function makeUserBookAndChapter() {
    const user = await createTestUser(db, `api-${Date.now()}-${Math.random()}@example.com`);
    const voice = await voiceRepo.create({ displayName: 'Narrator', role: 'narrator', language: 'en' });
    await voiceRepo.createMapping({ voiceId: voice.id, provider: 'elevenlabs', providerVoiceId: 'vendor-1' });
    const book = await bookRepo.create({ userId: user.id, title: 'API Test Book', language: 'en' });
    const chapter = await chapterRepo.create({ bookId: book.id, orderIndex: 0, sourceLocation: 'ch1' });
    await chapterRepo.update(chapter.id, { status: 'segmented' });
    const segment1 = await textSegmentRepo.create({
      chapterId: chapter.id,
      orderIndex: 0,
      sourceText: 'A.',
      normalizedText: 'A.',
      charCount: 2,
      sourceReference: 'p[0]',
      contentHash: 'h1',
      narratorVoiceId: voice.id,
    });
    const segment2 = await textSegmentRepo.create({
      chapterId: chapter.id,
      orderIndex: 1,
      sourceText: 'B.',
      normalizedText: 'B.',
      charCount: 2,
      sourceReference: 'p[1]',
      contentHash: 'h2',
      narratorVoiceId: voice.id,
    });
    return { user, voice, book, chapter, segment1, segment2 };
  }

  it('rejects an unauthenticated request with 401 IDENTITY_UNAVAILABLE — never invents a userId', async () => {
    const response = await fetch(`${baseUrl}/books/00000000-0000-0000-0000-000000000000`);
    expect(response.status).toBe(401);
    const body = (await response.json()) as any;
    expect(body.error.code).toBe('IDENTITY_UNAVAILABLE');
  });

  it('the test identity header is IGNORED by the production identity resolver (not a backdoor)', async () => {
    const user = await createTestUser(db, `noheader-${Date.now()}@example.com`);
    const response = await fetch(`${baseUrl}/books/00000000-0000-0000-0000-000000000000`, {
      headers: { 'x-test-user-id': user.id },
    });
    expect(response.status).toBe(401);
  });

  it('POST /books: successful ingestion end to end through the real HTTP layer', async () => {
    const user = await createTestUser(db, `ingest-${Date.now()}@example.com`);
    const voice = await voiceRepo.create({ displayName: 'Narrator', role: 'narrator', language: 'en' });
    const epubBuffer = await buildValidEpub({
      chapters: [{ id: 'ch1', filename: 'ch1.xhtml', paragraphs: ['Hello world.'] }],
      title: 'HTTP Test Book',
    });

    const response = await fetch(
      `${authedBaseUrl}/books`,
      authed(user.id, {
        method: 'POST',
        body: JSON.stringify({
          filename: 'book.epub',
          mimeType: 'application/epub+zip',
          fileBase64: epubBuffer.toString('base64'),
          narratorVoiceId: voice.id,
        }),
      }),
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as any;
    expect(body.bookId).toBeTruthy();
    expect(body.chapterCount).toBe(1);
    expect(body.segmentCount).toBe(1);

    const getResponse = await fetch(`${authedBaseUrl}/books/${body.bookId}`, authed(user.id));
    expect(getResponse.status).toBe(200);
    const getBody = (await getResponse.json()) as any;
    expect(getBody.title).toBe('HTTP Test Book');
  });

  it('POST /books: malformed JSON body returns 400, never a raw parser exception', async () => {
    const user = await createTestUser(db, `malformed-${Date.now()}@example.com`);
    const response = await fetch(
      `${authedBaseUrl}/books`,
      authed(user.id, { method: 'POST', body: '{not valid json' }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as any;
    expect(body.error.code).toBe('MALFORMED_JSON');
  });

  it('POST /books: missing required field returns 400 with a validation error, not a 500', async () => {
    const user = await createTestUser(db, `missing-field-${Date.now()}@example.com`);
    const response = await fetch(
      `${authedBaseUrl}/books`,
      authed(user.id, { method: 'POST', body: JSON.stringify({ filename: 'x.epub' }) }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as any;
    expect(body.error.code).toBe('VALIDATION_FAILED');
  });

  it('POST /books: a corrupt EPUB surfaces a safe 422 error, never a raw zip/parser exception', async () => {
    const user = await createTestUser(db, `corrupt-${Date.now()}@example.com`);
    const voice = await voiceRepo.create({ displayName: 'Narrator', role: 'narrator', language: 'en' });
    const corrupt = await buildCorruptZip();

    const response = await fetch(
      `${authedBaseUrl}/books`,
      authed(user.id, {
        method: 'POST',
        body: JSON.stringify({
          filename: 'bad.epub',
          mimeType: 'application/epub+zip',
          fileBase64: corrupt.toString('base64'),
          narratorVoiceId: voice.id,
        }),
      }),
    );

    expect(response.status).toBe(422);
    const body = (await response.json()) as any;
    expect(body.error.code).toBe('CORRUPT_ZIP');
    expect(JSON.stringify(body)).not.toMatch(/unzipper|ENOENT|stack/i);
  });

  it('GET /books/:bookId: missing resource returns 404', async () => {
    const user = await createTestUser(db, `missing-${Date.now()}@example.com`);
    const response = await fetch(`${authedBaseUrl}/books/00000000-0000-0000-0000-000000000000`, authed(user.id));
    expect(response.status).toBe(404);
  });

  it('GET /books/:bookId: ownership violation — another user gets 404, not the real data', async () => {
    const { book, user } = await makeUserBookAndChapter();
    const otherUser = await createTestUser(db, `other-${Date.now()}@example.com`);

    const asOwner = await fetch(`${authedBaseUrl}/books/${book.id}`, authed(user.id));
    expect(asOwner.status).toBe(200);

    const asOther = await fetch(`${authedBaseUrl}/books/${book.id}`, authed(otherUser.id));
    expect(asOther.status).toBe(404);
  });

  it('POST /books/:bookId/jobs: triggers narration through the real API and reflects it in job status', async () => {
    const { user, book } = await makeUserBookAndChapter();

    const triggerResponse = await fetch(
      `${authedBaseUrl}/books/${book.id}/jobs`,
      authed(user.id, { method: 'POST', body: JSON.stringify({ scope: 'book' }) }),
    );
    expect(triggerResponse.status).toBe(202);
    const triggerBody = (await triggerResponse.json()) as any;
    expect(triggerBody.bookStatus).toBe('ready');

    const jobResponse = await fetch(
      `${authedBaseUrl}/books/${book.id}/jobs/${triggerBody.processingJobId}`,
      authed(user.id),
    );
    expect(jobResponse.status).toBe(200);
    const jobBody = (await jobResponse.json()) as any;
    expect(jobBody.status).toBe('completed');
    expect(jobBody.steps.length).toBeGreaterThan(0);
  });

  it('POST /books/:bookId/jobs: duplicate/retry request is idempotent', async () => {
    const { user, book } = await makeUserBookAndChapter();

    const first = await fetch(
      `${authedBaseUrl}/books/${book.id}/jobs`,
      authed(user.id, { method: 'POST', body: JSON.stringify({ scope: 'book' }) }),
    );
    const firstBody = (await first.json()) as any;
    expect(firstBody.chapterOutcomes[0].segmentsSucceeded).toBe(2);

    const second = await fetch(
      `${authedBaseUrl}/books/${book.id}/jobs`,
      authed(user.id, { method: 'POST', body: JSON.stringify({ scope: 'book' }) }),
    );
    const secondBody = (await second.json()) as any;
    expect(secondBody.chapterOutcomes[0].segmentsSkipped).toBe(2);
    expect(secondBody.chapterOutcomes[0].segmentsSucceeded).toBe(0);
  });

  it('POST /books/:bookId/jobs: invalid state — a duplicate ACTIVE full-book job returns a safe error, never a raw DB error', async () => {
    const { user, book } = await makeUserBookAndChapter();
    await jobRepo.updateJobStatus(
      (await jobRepo.create({ bookId: book.id, userId: user.id, jobType: 'full_processing' })).id,
      { status: 'processing' },
    );

    const response = await fetch(
      `${authedBaseUrl}/books/${book.id}/jobs`,
      authed(user.id, { method: 'POST', body: JSON.stringify({ scope: 'book' }) }),
    );
    expect(response.status).toBe(500);
    const body = (await response.json()) as any;
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(body)).not.toMatch(/duplicate key value violates|constraint|pg_/i);
  });

  it('PUT /books/:bookId/progress/listening + GET: round-trips through the real API', async () => {
    const { user, book, chapter } = await makeUserBookAndChapter();

    const putResponse = await fetch(
      `${authedBaseUrl}/books/${book.id}/progress/listening`,
      authed(user.id, {
        method: 'PUT',
        body: JSON.stringify({ chapterId: chapter.id, playbackPositionMs: 4200, completionPct: '10.00' }),
      }),
    );
    expect(putResponse.status).toBe(200);

    const getResponse = await fetch(`${authedBaseUrl}/books/${book.id}/progress/listening`, authed(user.id));
    expect(getResponse.status).toBe(200);
    const body = (await getResponse.json()) as any;
    expect(body.playbackPositionMs).toBe(4200);
  });

  it('PUT progress: invalid cross-book chapter reference returns a safe 422, not a raw DB error', async () => {
    const { user, book } = await makeUserBookAndChapter();
    const otherBook = await bookRepo.create({ userId: user.id, title: 'Other', language: 'en' });
    const otherChapter = await chapterRepo.create({ bookId: otherBook.id, orderIndex: 0, sourceLocation: 'x' });

    const response = await fetch(
      `${authedBaseUrl}/books/${book.id}/progress/listening`,
      authed(user.id, {
        method: 'PUT',
        body: JSON.stringify({ chapterId: otherChapter.id, playbackPositionMs: 0, completionPct: '0.00' }),
      }),
    );
    expect(response.status).toBe(422);
    const body = (await response.json()) as any;
    expect(body.error.code).toBe('INVALID_PROGRESS_REFERENCE');
  });

  it('character routes: create + assign voice through the real API, ownership enforced', async () => {
    const { user, book } = await makeUserBookAndChapter();
    const characterVoice = await voiceRepo.create({ displayName: 'Wizard', role: 'character', language: 'en' });

    const createResponse = await fetch(
      `${authedBaseUrl}/books/${book.id}/characters`,
      authed(user.id, { method: 'POST', body: JSON.stringify({ name: 'The Wizard' }) }),
    );
    expect(createResponse.status).toBe(201);
    const character = (await createResponse.json()) as any;

    const assignResponse = await fetch(
      `${authedBaseUrl}/characters/${character.id}/voice`,
      authed(user.id, { method: 'PUT', body: JSON.stringify({ voiceId: characterVoice.id }) }),
    );
    expect(assignResponse.status).toBe(200);

    const otherUser = await createTestUser(db, `char-other-${Date.now()}@example.com`);
    const otherAssign = await fetch(
      `${authedBaseUrl}/characters/${character.id}/voice`,
      authed(otherUser.id, { method: 'PUT', body: JSON.stringify({ voiceId: characterVoice.id }) }),
    );
    expect(otherAssign.status).toBe(404);
  });

  it('scene routes: create + set direction cascades to segments, through the real API', async () => {
    const { user, chapter, segment1, segment2 } = await makeUserBookAndChapter();

    const createResponse = await fetch(
      `${authedBaseUrl}/chapters/${chapter.id}/scenes`,
      authed(user.id, {
        method: 'POST',
        body: JSON.stringify({ startSegmentId: segment1.id, endSegmentId: segment2.id, sceneType: 'suspense' }),
      }),
    );
    expect(createResponse.status).toBe(201);
    const scene = (await createResponse.json()) as any;

    const directionResponse = await fetch(
      `${authedBaseUrl}/scenes/${scene.id}/direction`,
      authed(user.id, { method: 'PUT', body: JSON.stringify({ direction: { emotion: 'tense' } }) }),
    );
    expect(directionResponse.status).toBe(200);

    const updatedSegment = await textSegmentRepo.findById(segment1.id);
    expect(updatedSegment!.deliveryDirection).toEqual({ emotion: 'tense' });
  });

  it('unknown route returns 404 ROUTE_NOT_FOUND', async () => {
    const user = await createTestUser(db, `route-${Date.now()}@example.com`);
    const response = await fetch(`${authedBaseUrl}/this/route/does/not/exist`, authed(user.id));
    expect(response.status).toBe(404);
    const body = (await response.json()) as any;
    expect(body.error.code).toBe('ROUTE_NOT_FOUND');
  });

  it('no vendor SDK leakage in the API layer', async () => {
    const fs = await import('node:fs');
    const apiFiles = ['src/api/server.ts', 'src/api/http/ApiRouter.ts', 'src/api/routes/books.ts', 'src/api/routes/jobs.ts'];
    for (const file of apiFiles) {
      const content = fs.readFileSync(file, 'utf8');
      expect(content).not.toMatch(/elevenlabs\.io|texttospeech\.googleapis/i);
    }
  });
});
