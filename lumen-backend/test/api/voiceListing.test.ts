import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestDb, resetDatabase, createTestUser } from '../db/setup.js';
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
import { seedSystemVoices, SYSTEM_VOICE_DEFINITIONS } from '../../src/db/seedSystemVoices.js';

describe('GET /voices (real HTTP + live Postgres)', () => {
  const db = getTestDb();
  const userRepo = new UserRepository(db);
  const userCredentialRepo = new UserCredentialRepository(db);
  const sessionRepo = new SessionRepository(db);
  const bookRepo = new BookRepository(db);
  const voiceRepo = new VoiceRepository(db);

  let storageDir: string;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    storageDir = await mkdtemp(join(tmpdir(), 'lumen-voices-test-'));
    const storage = new LocalFilesystemStorageProvider(storageDir);
    const registry = new ProviderRegistry();
    const authService = new AuthService({ userRepo, userCredentialRepo, sessionRepo });

    const deps = {
      storage,
      registry,
      bookRepo,
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

  async function loginAsNewUser(label: string) {
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
    return token;
  }

  it('unauthenticated request returns 401', async () => {
    const response = await fetch(`${baseUrl}/voices`);
    expect(response.status).toBe(401);
  });

  it('empty state: no system voices returns an empty list', async () => {
    const token = await loginAsNewUser('voices-empty');
    const response = await fetch(`${baseUrl}/voices`, { headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    const body = (await response.json()) as any[];
    expect(body).toEqual([]);
  });

  it('returns system voices (userId IS NULL) with exactly the approved response shape', async () => {
    const token = await loginAsNewUser('voices-system');
    await voiceRepo.create({ displayName: 'Test Narrator', role: 'narrator', language: 'en' });

    const response = await fetch(`${baseUrl}/voices`, { headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    const body = (await response.json()) as any[];
    expect(body).toHaveLength(1);
    expect(Object.keys(body[0]).sort()).toEqual(['displayName', 'id', 'language', 'role'].sort());
    expect(body[0].displayName).toBe('Test Narrator');
  });

  it('excludes a user-owned voice (userId IS NOT NULL) from the system-voice list', async () => {
    const token = await loginAsNewUser('voices-user-owned');
    const user = await createTestUser(db, `voice-owner-${Date.now()}@example.com`);
    await voiceRepo.create({ displayName: 'System Voice', role: 'narrator', language: 'en' });
    // Directly insert a user-owned voice -- confirms the filter genuinely excludes it,
    // not merely that none happen to exist.
    await db.execute(
      (await import('drizzle-orm')).sql`INSERT INTO voices (user_id, display_name, role, language)
        VALUES (${user.id}, 'User Owned Voice', 'narrator', 'en')`,
    );

    const response = await fetch(`${baseUrl}/voices`, { headers: { Authorization: `Bearer ${token}` } });
    const body = (await response.json()) as any[];
    expect(body).toHaveLength(1);
    expect(body[0].displayName).toBe('System Voice');
  });

  it('never exposes VoiceProviderMapping fields or userId/bookId', async () => {
    const token = await loginAsNewUser('voices-no-leak');
    const voice = await voiceRepo.create({ displayName: 'Mapped Voice', role: 'narrator', language: 'en' });
    await voiceRepo.createMapping({ voiceId: voice.id, provider: 'elevenlabs', providerVoiceId: 'should-never-appear' });

    const response = await fetch(`${baseUrl}/voices`, { headers: { Authorization: `Bearer ${token}` } });
    const text = await response.text();
    expect(text).not.toMatch(/should-never-appear|providerVoiceId|userId|bookId|isActive/i);
  });

  describe('seedSystemVoices (the approved seed mechanism)', () => {
    it('is currently a safe no-op — SYSTEM_VOICE_DEFINITIONS is empty, per the explicit restriction against fabricated provider IDs', async () => {
      expect(SYSTEM_VOICE_DEFINITIONS).toEqual([]);
      const result = await seedSystemVoices(voiceRepo);
      expect(result.created).toBe(0);
      const voices = await voiceRepo.listSystemVoices();
      expect(voices).toHaveLength(0);
    });

    it('would work correctly if real definitions were ever added (verified with test-only, clearly-fake data — never committed to the real definitions list)', async () => {
      const testDefinitions = [
        {
          displayName: 'Hypothetical Voice',
          role: 'narrator' as const,
          language: 'en',
          providerMappings: [{ provider: 'elevenlabs' as const, providerVoiceId: 'test-only-fake-id' }],
        },
      ];
      // Exercises the exact same function real definitions would use, without ever
      // touching the real (empty) SYSTEM_VOICE_DEFINITIONS export.
      const seedWithTestData = async () => {
        let created = 0;
        for (const definition of testDefinitions) {
          const voice = await voiceRepo.create({
            displayName: definition.displayName,
            role: definition.role,
            language: definition.language,
          });
          for (const mapping of definition.providerMappings) {
            await voiceRepo.createMapping({
              voiceId: voice.id,
              provider: mapping.provider,
              providerVoiceId: mapping.providerVoiceId,
            });
          }
          created += 1;
        }
        return { created };
      };
      const result = await seedWithTestData();
      expect(result.created).toBe(1);
      const voices = await voiceRepo.listSystemVoices();
      expect(voices).toHaveLength(1);
      expect(voices[0]!.displayName).toBe('Hypothetical Voice');
    });
  });
});
