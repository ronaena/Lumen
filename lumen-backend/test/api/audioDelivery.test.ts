import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, unlink } from 'node:fs/promises';
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

describe('GET /segments/:textSegmentId/audio (real HTTP + live Postgres + real filesystem)', () => {
  const db = getTestDb();
  const userRepo = new UserRepository(db);
  const userCredentialRepo = new UserCredentialRepository(db);
  const sessionRepo = new SessionRepository(db);
  const bookRepo = new BookRepository(db);
  const chapterRepo = new ChapterRepository(db);
  const textSegmentRepo = new TextSegmentRepository(db);
  const voiceRepo = new VoiceRepository(db);
  const audioSegmentRepo = new AudioSegmentRepository(db);
  const narrationAttemptRepo = new NarrationAttemptRepository(db);

  let storageDir: string;
  let storage: LocalFilesystemStorageProvider;
  let server: Server;
  let baseUrl: string;
  let clock: ManualClock;

  beforeAll(async () => {
    storageDir = await mkdtemp(join(tmpdir(), 'lumen-audio-test-'));
    storage = new LocalFilesystemStorageProvider(storageDir);
    const registry = new ProviderRegistry();
    const authService = new AuthService({ userRepo, userCredentialRepo, sessionRepo });

    const deps = {
      storage,
      registry,
      bookRepo,
      chapterRepo,
      textSegmentRepo,
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

  async function makeSegment(userId: string) {
    const book = await bookRepo.create({ userId, title: 'Audio Test Book', language: 'en' });
    const chapter = await chapterRepo.create({ bookId: book.id, orderIndex: 0, sourceLocation: 'ch1' });
    const voice = await voiceRepo.create({ displayName: 'Narrator', role: 'narrator', language: 'en' });
    const segment = await textSegmentRepo.create({
      chapterId: chapter.id,
      orderIndex: 0,
      sourceText: 'Test segment.',
      normalizedText: 'Test segment.',
      charCount: 13,
      sourceReference: 'p[0]',
      contentHash: 'h1',
      narratorVoiceId: voice.id,
    });
    return { book, chapter, voice, segment };
  }

  /** Seeds a real, active AudioSegment backed by real bytes written through the real storage provider. */
  async function seedActiveAudio(segmentId: string, bytes: Buffer, format: 'mp3' | 'wav' | 'ogg_opus' = 'mp3') {
    const storageRef = await storage.write(`test-audio/${segmentId}.${format}`, bytes);
    const attempt = await narrationAttemptRepo.create({
      textSegmentId: segmentId,
      attemptNumber: 1,
      provider: 'elevenlabs',
      requestId: randomUUID(),
      requestSignature: `sig-${segmentId}`,
    });
    await narrationAttemptRepo.complete(attempt.id, { status: 'succeeded' });
    return audioSegmentRepo.activateAudioSegment({
      textSegmentId: segmentId,
      producedByAttemptId: attempt.id,
      storageRef,
      provider: 'elevenlabs',
      modelUsed: 'eleven_multilingual_v2',
      providerVoiceId: 'vendor-voice-1',
      durationMs: 1234,
      format,
      sampleRateHz: 44100,
      fileSizeBytes: bytes.byteLength,
      checksum: 'test-checksum',
      estimatedCost: '0.001',
      generationSignature: `gensig-${segmentId}`,
    });
  }

  it('owner retrieves active audio and the bytes are exactly identical', async () => {
    const { userId, token } = await registerAndLogin('audio-owner');
    const { segment } = await makeSegment(userId);
    const originalBytes = Buffer.from('this is definitely not real mp3 data, just a byte sequence to verify round-trip', 'utf8');
    await seedActiveAudio(segment.id, originalBytes);

    const response = await fetch(`${baseUrl}/segments/${segment.id}/audio`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    const receivedBytes = Buffer.from(await response.arrayBuffer());
    expect(receivedBytes.equals(originalBytes)).toBe(true);
  });

  it('returns the correct MIME type per format', async () => {
    const { userId, token } = await registerAndLogin('audio-mime');
    const { segment } = await makeSegment(userId);
    await seedActiveAudio(segment.id, Buffer.from('wav-bytes'), 'wav');

    const response = await fetch(`${baseUrl}/segments/${segment.id}/audio`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('audio/wav');
  });

  it('returns the correct Content-Length', async () => {
    const { userId, token } = await registerAndLogin('audio-length');
    const { segment } = await makeSegment(userId);
    const bytes = Buffer.from('exactly this many bytes of fake audio content here');
    await seedActiveAudio(segment.id, bytes);

    const response = await fetch(`${baseUrl}/segments/${segment.id}/audio`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.headers.get('Content-Length')).toBe(String(bytes.byteLength));
  });

  it('a text segment with no active audio returns 404', async () => {
    const { userId, token } = await registerAndLogin('audio-none');
    const { segment } = await makeSegment(userId);

    const response = await fetch(`${baseUrl}/segments/${segment.id}/audio`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(404);
    const body = (await response.json()) as any;
    expect(body.error.code).toBe('SEGMENT_NOT_FOUND');
  });

  it('a nonexistent text segment returns 404', async () => {
    const { token } = await registerAndLogin('audio-nonexistent');
    const response = await fetch(`${baseUrl}/segments/${randomUUID()}/audio`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(404);
  });

  it("another user's segment returns 404, not the audio", async () => {
    const owner = await registerAndLogin('audio-owner-2');
    const other = await registerAndLogin('audio-other');
    const { segment } = await makeSegment(owner.userId);
    await seedActiveAudio(segment.id, Buffer.from('owners-private-audio'));

    const response = await fetch(`${baseUrl}/segments/${segment.id}/audio`, {
      headers: { Authorization: `Bearer ${other.token}` },
    });
    expect(response.status).toBe(404);

    // Confirm the owner really can access it -- proves the 404 above is ownership, not a bug.
    const ownerResponse = await fetch(`${baseUrl}/segments/${segment.id}/audio`, {
      headers: { Authorization: `Bearer ${owner.token}` },
    });
    expect(ownerResponse.status).toBe(200);
  });

  it('unauthenticated request returns 401', async () => {
    const response = await fetch(`${baseUrl}/segments/${randomUUID()}/audio`);
    expect(response.status).toBe(401);
  });

  it('a missing underlying file returns a safe error, never raw filesystem internals', async () => {
    const { userId, token } = await registerAndLogin('audio-missing-file');
    const { segment } = await makeSegment(userId);
    const audioSegment = await seedActiveAudio(segment.id, Buffer.from('will be deleted'));

    // Simulate a storage-layer inconsistency: the DB row says active audio exists, but
    // the underlying file is gone (e.g. an out-of-band filesystem issue).
    const key = audioSegment.storageRef.replace('local://', '');
    await unlink(join(storageDir, key));

    const response = await fetch(`${baseUrl}/segments/${segment.id}/audio`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(404);
    const text = await response.text();
    expect(text).not.toMatch(/ENOENT|node:fs|node_modules|local:\/\//i);
  });
});
