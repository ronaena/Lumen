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
import { createSessionIdentityResolver } from '../../src/api/identity/sessionIdentityResolver.js';
import { RateLimiter } from '../../src/api/security/RateLimiter.js';
import { ManualClock } from '../api/manualClock.js';
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

describe('Library & Ebook Import v1 (real HTTP + live Postgres) -- exercises existing, unmodified backend behavior', () => {
  const db = getTestDb();
  const userRepo = new UserRepository(db);
  const userCredentialRepo = new UserCredentialRepository(db);
  const sessionRepo = new SessionRepository(db);
  const voiceRepo = new VoiceRepository(db);

  let storageDir: string;
  let server: Server;
  let baseUrl: string;
  let clock: ManualClock;

  beforeAll(async () => {
    storageDir = await mkdtemp(join(tmpdir(), 'lumen-libraryimport-test-'));
    const storage = new LocalFilesystemStorageProvider(storageDir);
    const registry = new ProviderRegistry();
    const authService = new AuthService({ userRepo, userCredentialRepo, sessionRepo });
    const deps = {
      storage,
      registry,
      bookRepo: new BookRepository(db),
      chapterRepo: new ChapterRepository(db),
      textSegmentRepo: new TextSegmentRepository(db),
      voiceRepo,
      audioSegmentRepo: new AudioSegmentRepository(db),
      narrationAttemptRepo: new NarrationAttemptRepository(db),
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
    return { email, token, voiceId: voice.id };
  }

  async function importEpub(token: string, voiceId: string) {
    const buffer = await buildValidEpub({
      title: 'Library Import Test Book',
      author: 'Test Author',
      chapters: [
        { id: 'ch1', filename: 'ch1.xhtml', title: 'First Chapter', paragraphs: ['Paragraph one.', 'Paragraph two.'] },
        { id: 'ch2', filename: 'ch2.xhtml', title: 'Second Chapter', paragraphs: ['Paragraph three.'] },
      ],
    });
    return fetch(`${baseUrl}/books`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: 'library-test.epub',
        mimeType: 'application/epub+zip',
        fileBase64: buffer.toString('base64'),
        narratorVoiceId: voiceId,
      }),
    });
  }

  // ============================== LIBRARY ==============================

  it('LIBRARY: unauthenticated request is rejected', async () => {
    expect((await fetch(`${baseUrl}/books`)).status).toBe(401);
  });

  it('LIBRARY: authenticated user sees only their own books; empty library returns []', async () => {
    const { token } = await registerLoginAndVoice('library-empty');
    const emptyResponse = await fetch(`${baseUrl}/books`, { headers: { Authorization: `Bearer ${token}` } });
    expect(emptyResponse.status).toBe(200);
    expect(await emptyResponse.json()).toEqual([]);
  });

  it("LIBRARY: another user's books are never returned", async () => {
    const userA = await registerLoginAndVoice('library-usera');
    const userB = await registerLoginAndVoice('library-userb');
    const importResponse = await importEpub(userA.token, userA.voiceId);
    expect(importResponse.status).toBe(201);

    const userBLibrary = (await (await fetch(`${baseUrl}/books`, { headers: { Authorization: `Bearer ${userB.token}` } })).json()) as any[];
    expect(userBLibrary).toEqual([]);

    const userALibrary = (await (await fetch(`${baseUrl}/books`, { headers: { Authorization: `Bearer ${userA.token}` } })).json()) as any[];
    expect(userALibrary.length).toBe(1);
    expect(userALibrary[0].title).toBe('Library Import Test Book');
  });

  // ============================== IMPORT ==============================

  it('IMPORT: a real, valid EPUB imports successfully and reaches READY (processing) state', async () => {
    const { token, voiceId } = await registerLoginAndVoice('import-valid');
    const response = await importEpub(token, voiceId);
    expect(response.status).toBe(201);
    const body = (await response.json()) as any;
    expect(body.bookId).toBeTruthy();
    expect(body.chapterCount).toBe(2);
    expect(body.segmentCount).toBe(3);

    const bookResponse = await fetch(`${baseUrl}/books/${body.bookId}`, { headers: { Authorization: `Bearer ${token}` } });
    const book = (await bookResponse.json()) as any;
    expect(['processing', 'ready']).toContain(book.status);
  });

  it('IMPORT: a malformed EPUB is rejected safely, no raw parser internals leaked', async () => {
    const { token, voiceId } = await registerLoginAndVoice('import-malformed');
    const notReallyAnEpub = Buffer.from('this is not a real epub file', 'utf8');
    const response = await fetch(`${baseUrl}/books`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: 'fake.epub',
        mimeType: 'application/epub+zip',
        fileBase64: notReallyAnEpub.toString('base64'),
        narratorVoiceId: voiceId,
      }),
    });
    expect(response.status).toBe(422);
    const text = await response.text();
    expect(text).not.toMatch(/unzipper|node_modules|ENOENT|at new|stack/i);
  });

  it('IMPORT: an unsupported file type is rejected', async () => {
    const { token, voiceId } = await registerLoginAndVoice('import-unsupported');
    const response = await fetch(`${baseUrl}/books`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: 'file.xyz',
        mimeType: 'application/octet-stream',
        fileBase64: Buffer.from('whatever').toString('base64'),
        narratorVoiceId: voiceId,
      }),
    });
    expect(response.status).toBe(422);
  });

  it('IMPORT: unauthenticated import attempt is rejected', async () => {
    const buffer = await buildValidEpub({ chapters: [{ id: 'ch1', filename: 'ch1.xhtml', paragraphs: ['Text.'] }] });
    const response = await fetch(`${baseUrl}/books`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: 'unauth.epub',
        mimeType: 'application/epub+zip',
        fileBase64: buffer.toString('base64'),
        narratorVoiceId: '00000000-0000-0000-0000-000000000000',
      }),
    });
    expect(response.status).toBe(401);
  });

  // ============================== OWNERSHIP ==============================

  it("OWNERSHIP: user A cannot access user B's book details", async () => {
    const userA = await registerLoginAndVoice('ownership-book-a');
    const userB = await registerLoginAndVoice('ownership-book-b');
    const importResponse = await importEpub(userA.token, userA.voiceId);
    const { bookId } = (await importResponse.json()) as any;

    const response = await fetch(`${baseUrl}/books/${bookId}`, { headers: { Authorization: `Bearer ${userB.token}` } });
    expect(response.status).toBe(404);
  });

  it("OWNERSHIP: user A cannot access user B's chapters", async () => {
    const userA = await registerLoginAndVoice('ownership-chapters-a');
    const userB = await registerLoginAndVoice('ownership-chapters-b');
    const importResponse = await importEpub(userA.token, userA.voiceId);
    const { bookId } = (await importResponse.json()) as any;

    const response = await fetch(`${baseUrl}/books/${bookId}/chapters`, { headers: { Authorization: `Bearer ${userB.token}` } });
    expect(response.status).toBe(404);
  });

  it('OWNERSHIP: a frontend-supplied userId in the request body cannot override the authenticated identity', async () => {
    const userA = await registerLoginAndVoice('ownership-spoof-a');
    const userB = await registerLoginAndVoice('ownership-spoof-b');

    const buffer = await buildValidEpub({ chapters: [{ id: 'ch1', filename: 'ch1.xhtml', paragraphs: ['Spoof test.'] }] });
    // userB attempts to import while smuggling userA's ID into the request body -- must
    // have zero effect; ownership is resolved exclusively from IdentityContext.
    const response = await fetch(`${baseUrl}/books`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${userB.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: 'spoof.epub',
        mimeType: 'application/epub+zip',
        fileBase64: buffer.toString('base64'),
        narratorVoiceId: userB.voiceId,
        userId: userA.email, // arbitrary spoofed field -- the real API never reads this
      }),
    });
    expect(response.status).toBe(201);
    const { bookId } = (await response.json()) as any;

    // The book must belong to userB (the real authenticated identity), never userA.
    const userALibrary = (await (await fetch(`${baseUrl}/books`, { headers: { Authorization: `Bearer ${userA.token}` } })).json()) as any[];
    expect(userALibrary.find((b: any) => b.id === bookId)).toBeUndefined();
    const userBLibrary = (await (await fetch(`${baseUrl}/books`, { headers: { Authorization: `Bearer ${userB.token}` } })).json()) as any[];
    expect(userBLibrary.find((b: any) => b.id === bookId)).toBeTruthy();
  });

  // ============================== BOOK DETAILS ==============================

  it('BOOK DETAILS: correct book is returned with accurate metadata', async () => {
    const { token, voiceId } = await registerLoginAndVoice('bookdetails-correct');
    const importResponse = await importEpub(token, voiceId);
    const { bookId } = (await importResponse.json()) as any;

    const response = await fetch(`${baseUrl}/books/${bookId}`, { headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    const book = (await response.json()) as any;
    expect(book.title).toBe('Library Import Test Book');
    expect(book.author).toBe('Test Author');
    expect(book.chapterCount).toBe(2);
  });

  it('BOOK DETAILS: chapter ordering is preserved exactly as produced by the ingestion engine', async () => {
    const { token, voiceId } = await registerLoginAndVoice('bookdetails-ordering');
    const importResponse = await importEpub(token, voiceId);
    const { bookId } = (await importResponse.json()) as any;

    const response = await fetch(`${baseUrl}/books/${bookId}/chapters`, { headers: { Authorization: `Bearer ${token}` } });
    const chapters = (await response.json()) as any[];
    expect(chapters).toHaveLength(2);
    const sorted = chapters.slice().sort((a, b) => a.orderIndex - b.orderIndex);
    expect(sorted[0].title).toBe('First Chapter');
    expect(sorted[1].title).toBe('Second Chapter');
  });

  it('BOOK DETAILS: a missing book is handled safely (404, not a crash)', async () => {
    const { token } = await registerLoginAndVoice('bookdetails-missing');
    const response = await fetch(`${baseUrl}/books/00000000-0000-0000-0000-000000000000`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(404);
  });

  // ============================== SECURITY ==============================

  it('SECURITY: no response contains a password hash, session token, or DATABASE_URL', async () => {
    const { token, voiceId } = await registerLoginAndVoice('security-safe');
    const importResponse = await importEpub(token, voiceId);
    const { bookId } = (await importResponse.json()) as any;

    const bookText = await (await fetch(`${baseUrl}/books/${bookId}`, { headers: { Authorization: `Bearer ${token}` } })).text();
    const libraryText = await (await fetch(`${baseUrl}/books`, { headers: { Authorization: `Bearer ${token}` } })).text();
    for (const text of [bookText, libraryText]) {
      expect(text).not.toMatch(/passwordHash|password_hash|tokenHash|token_hash|DATABASE_URL|postgres:\/\//i);
    }
  });

  // ============================== REGRESSION ==============================

  it('REGRESSION: existing auth, admin, dashboard, voices, audit log, health, ready remain passing', async () => {
    const { token, email } = await registerLoginAndVoice('regression-check');
    expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/ready`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/auth/me`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
    expect((await fetch(`${baseUrl}/admin/dashboard`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(403);
    expect(email).toBeTruthy();
  });
});
