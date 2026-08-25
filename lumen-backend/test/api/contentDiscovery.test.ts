import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestDb, resetDatabase } from '../db/setup.js';
import { LocalFilesystemStorageProvider } from '../../src/processing/storage/LocalFilesystemStorageProvider.js';
import { ProviderRegistry } from '../../src/tts/ProviderRegistry.js';
import { createApiServer } from '../../src/api/server.js';
import { RateLimiter } from '../../src/api/security/RateLimiter.js';
import { ManualClock } from '../api/manualClock.js';
import { createSessionIdentityResolver } from '../../src/api/identity/sessionIdentityResolver.js';
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

describe('Content Discovery API: GET /books/:bookId/chapters, GET /chapters/:chapterId/segments, GET /books/:bookId/characters', () => {
  const db = getTestDb();
  const userRepo = new UserRepository(db);
  const userCredentialRepo = new UserCredentialRepository(db);
  const sessionRepo = new SessionRepository(db);
  const bookRepo = new BookRepository(db);
  const chapterRepo = new ChapterRepository(db);
  const textSegmentRepo = new TextSegmentRepository(db);
  const voiceRepo = new VoiceRepository(db);
  const characterRepo = new CharacterRepository(db);

  let storageDir: string;
  let server: Server;
  let baseUrl: string;
  let clock: ManualClock;

  beforeAll(async () => {
    storageDir = await mkdtemp(join(tmpdir(), 'lumen-content-test-'));
    const storage = new LocalFilesystemStorageProvider(storageDir);
    const registry = new ProviderRegistry();
    const authService = new AuthService({ userRepo, userCredentialRepo, sessionRepo });

    const deps = {
      storage,
      registry,
      bookRepo,
      chapterRepo,
      textSegmentRepo,
      voiceRepo,
      audioSegmentRepo: new AudioSegmentRepository(db),
      narrationAttemptRepo: new NarrationAttemptRepository(db),
      providerUsageRepo: new ProviderUsageRepository(db),
      jobRepo: new ProcessingJobRepository(db),
      listeningProgressRepo: new ListeningProgressRepository(db),
      readingProgressRepo: new ReadingProgressRepository(db),
      characterRepo,
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
    // This file registers many users across many tests, all from the same loopback IP
    // against one shared server instance -- advancing the rate-limit clock well past the
    // 15-minute window before every test keeps these tests from being incidentally
    // throttled by the (unrelated, already-verified) Workstream 13B rate limiter.
    clock.advance(16 * 60 * 1000);
  });

  function uniqueEmail(label: string): string {
    return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  }

  async function registerAndLogin(label: string) {
    const email = uniqueEmail(label);
    const registerResponse = await fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'correct-horse-battery' }),
    });
    const { id: userId } = (await registerResponse.json()) as any;
    const loginResponse = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'correct-horse-battery' }),
    });
    const { token } = (await loginResponse.json()) as any;
    return { userId, token };
  }

  async function makeBookWithChapters(userId: string) {
    const book = await bookRepo.create({ userId, title: 'Content Test Book', language: 'en' });
    const chapter1 = await chapterRepo.create({ bookId: book.id, orderIndex: 0, sourceLocation: 'ch1', title: 'Chapter One' });
    const chapter2 = await chapterRepo.create({ bookId: book.id, orderIndex: 1, sourceLocation: 'ch2', title: 'Chapter Two' });
    return { book, chapter1, chapter2 };
  }

  // ============================== GET /books/:bookId/chapters ==============================

  it('chapters: authenticated owner receives the correct chapters in order', async () => {
    const { userId, token } = await registerAndLogin('chapters-owner');
    const { book } = await makeBookWithChapters(userId);

    const response = await fetch(`${baseUrl}/books/${book.id}/chapters`, { headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    const body = (await response.json()) as any[];
    expect(body).toHaveLength(2);
    expect(body[0].title).toBe('Chapter One');
    expect(body[1].title).toBe('Chapter Two');
    expect(body[0].orderIndex).toBeLessThan(body[1].orderIndex);
  });

  it('chapters: another authenticated user cannot retrieve the book\'s chapters', async () => {
    const owner = await registerAndLogin('chapters-owner-2');
    const other = await registerAndLogin('chapters-other');
    const { book } = await makeBookWithChapters(owner.userId);

    const response = await fetch(`${baseUrl}/books/${book.id}/chapters`, { headers: { Authorization: `Bearer ${other.token}` } });
    expect(response.status).toBe(404);
  });

  it('chapters: unknown book returns 404', async () => {
    const { token } = await registerAndLogin('chapters-unknown');
    const response = await fetch(`${baseUrl}/books/00000000-0000-0000-0000-000000000000/chapters`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(404);
  });

  it('chapters: unauthenticated request returns 401', async () => {
    const response = await fetch(`${baseUrl}/books/00000000-0000-0000-0000-000000000000/chapters`);
    expect(response.status).toBe(401);
  });

  // ============================== GET /chapters/:chapterId/segments ==============================

  it('segments: authenticated owner receives the correct segments in order', async () => {
    const { userId, token } = await registerAndLogin('segments-owner');
    const { chapter1 } = await makeBookWithChapters(userId);
    const voice = await voiceRepo.create({ displayName: 'Narrator', role: 'narrator', language: 'en' });
    await textSegmentRepo.create({
      chapterId: chapter1.id, orderIndex: 0, sourceText: 'First.', normalizedText: 'First.',
      charCount: 6, sourceReference: 'p[0]', contentHash: 'h1', narratorVoiceId: voice.id,
    });
    await textSegmentRepo.create({
      chapterId: chapter1.id, orderIndex: 1, sourceText: 'Second.', normalizedText: 'Second.',
      charCount: 7, sourceReference: 'p[1]', contentHash: 'h2', narratorVoiceId: voice.id,
    });

    const response = await fetch(`${baseUrl}/chapters/${chapter1.id}/segments`, { headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    const body = (await response.json()) as any[];
    expect(body).toHaveLength(2);
    expect(body[0].sourceText).toBe('First.');
    expect(body[1].sourceText).toBe('Second.');
  });

  it('segments: another authenticated user cannot retrieve the segments', async () => {
    const owner = await registerAndLogin('segments-owner-2');
    const other = await registerAndLogin('segments-other');
    const { chapter1 } = await makeBookWithChapters(owner.userId);

    const response = await fetch(`${baseUrl}/chapters/${chapter1.id}/segments`, { headers: { Authorization: `Bearer ${other.token}` } });
    expect(response.status).toBe(404);
  });

  it('segments: unknown chapter returns 404', async () => {
    const { token } = await registerAndLogin('segments-unknown');
    const response = await fetch(`${baseUrl}/chapters/00000000-0000-0000-0000-000000000000/segments`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(404);
  });

  it('segments: unauthenticated request returns 401', async () => {
    const response = await fetch(`${baseUrl}/chapters/00000000-0000-0000-0000-000000000000/segments`);
    expect(response.status).toBe(401);
  });

  // ============================== GET /books/:bookId/characters ==============================

  it('characters: authenticated owner receives the correct characters', async () => {
    const { userId, token } = await registerAndLogin('characters-owner');
    const { book } = await makeBookWithChapters(userId);
    await characterRepo.create({ bookId: book.id, name: 'Alice' });
    await characterRepo.create({ bookId: book.id, name: 'Bob' });

    const response = await fetch(`${baseUrl}/books/${book.id}/characters`, { headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    const body = (await response.json()) as any[];
    expect(body).toHaveLength(2);
    expect(body.map((c) => c.name).sort()).toEqual(['Alice', 'Bob']);
  });

  it('characters: another authenticated user cannot retrieve the characters', async () => {
    const owner = await registerAndLogin('characters-owner-2');
    const other = await registerAndLogin('characters-other');
    const { book } = await makeBookWithChapters(owner.userId);
    await characterRepo.create({ bookId: book.id, name: 'Alice' });

    const response = await fetch(`${baseUrl}/books/${book.id}/characters`, { headers: { Authorization: `Bearer ${other.token}` } });
    expect(response.status).toBe(404);
  });

  it('characters: unknown book returns 404', async () => {
    const { token } = await registerAndLogin('characters-unknown');
    const response = await fetch(`${baseUrl}/books/00000000-0000-0000-0000-000000000000/characters`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(404);
  });

  it('characters: unauthenticated request returns 401', async () => {
    const response = await fetch(`${baseUrl}/books/00000000-0000-0000-0000-000000000000/characters`);
    expect(response.status).toBe(401);
  });

  it('characters: a book with no characters returns an empty list', async () => {
    const { userId, token } = await registerAndLogin('characters-empty');
    const { book } = await makeBookWithChapters(userId);

    const response = await fetch(`${baseUrl}/books/${book.id}/characters`, { headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    const body = (await response.json()) as any[];
    expect(body).toEqual([]);
  });
});
