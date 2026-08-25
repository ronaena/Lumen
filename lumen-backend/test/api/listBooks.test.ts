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

describe('GET /books (real HTTP + live Postgres)', () => {
  const db = getTestDb();
  const userRepo = new UserRepository(db);
  const userCredentialRepo = new UserCredentialRepository(db);
  const sessionRepo = new SessionRepository(db);
  const bookRepo = new BookRepository(db);

  let storageDir: string;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    storageDir = await mkdtemp(join(tmpdir(), 'lumen-listbooks-test-'));
    const storage = new LocalFilesystemStorageProvider(storageDir);
    const registry = new ProviderRegistry();
    const authService = new AuthService({ userRepo, userCredentialRepo, sessionRepo });

    const deps = {
      storage,
      registry,
      bookRepo,
      chapterRepo: new ChapterRepository(db),
      textSegmentRepo: new TextSegmentRepository(db),
      voiceRepo: new VoiceRepository(db),
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

    server = await createApiServer(deps, createSessionIdentityResolver(authService), authService);
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

  it('a: an authenticated user sees all of their own books', async () => {
    const { userId, token } = await registerAndLogin('list-own');
    await bookRepo.create({ userId, title: 'Book One', language: 'en' });
    await bookRepo.create({ userId, title: 'Book Two', language: 'en' });

    const response = await fetch(`${baseUrl}/books`, { headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    const body = (await response.json()) as any[];
    expect(body).toHaveLength(2);
    const titles = body.map((b) => b.title).sort();
    expect(titles).toEqual(['Book One', 'Book Two']);
    expect(Object.keys(body[0]).sort()).toEqual(
      ['id', 'title', 'author', 'status', 'chapterCount', 'segmentCount', 'createdAt'].sort(),
    );
  });

  it("b: a second user cannot see the first user's books", async () => {
    const userA = await registerAndLogin('list-cross-a');
    const userB = await registerAndLogin('list-cross-b');
    await bookRepo.create({ userId: userA.userId, title: "A's Book", language: 'en' });

    const responseB = await fetch(`${baseUrl}/books`, { headers: { Authorization: `Bearer ${userB.token}` } });
    expect(responseB.status).toBe(200);
    const bodyB = (await responseB.json()) as any[];
    expect(bodyB).toHaveLength(0);

    const responseA = await fetch(`${baseUrl}/books`, { headers: { Authorization: `Bearer ${userA.token}` } });
    const bodyA = (await responseA.json()) as any[];
    expect(bodyA).toHaveLength(1);
  });

  it('c: a user with no books receives an empty array', async () => {
    const { token } = await registerAndLogin('list-empty');
    const response = await fetch(`${baseUrl}/books`, { headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    const body = (await response.json()) as any[];
    expect(body).toEqual([]);
  });

  it('d: an unauthenticated request receives 401', async () => {
    const response = await fetch(`${baseUrl}/books`);
    expect(response.status).toBe(401);
    const body = (await response.json()) as any;
    expect(body.error.code).toBe('IDENTITY_UNAVAILABLE');
  });
});
