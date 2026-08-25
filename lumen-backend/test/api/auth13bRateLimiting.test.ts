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

describe('Workstream 13B: Security Hardening — rate limiting (real HTTP + live Postgres, deterministic fake clock)', () => {
  const db = getTestDb();
  const userRepo = new UserRepository(db);
  const userCredentialRepo = new UserCredentialRepository(db);
  const sessionRepo = new SessionRepository(db);
  const bookRepo = new BookRepository(db);

  let storageDir: string;
  let server: Server;
  let baseUrl: string;
  let clock: ManualClock;
  let authService: AuthService;

  beforeAll(async () => {
    storageDir = await mkdtemp(join(tmpdir(), 'lumen-13b-test-'));
    const storage = new LocalFilesystemStorageProvider(storageDir);
    const registry = new ProviderRegistry();
    authService = new AuthService({ userRepo, userCredentialRepo, sessionRepo });

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

  async function login(email: string, password: string, extraHeaders: Record<string, string> = {}) {
    return fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...extraHeaders },
      body: JSON.stringify({ email, password }),
    });
  }

  async function register(email: string, password: string, extraHeaders: Record<string, string> = {}) {
    return fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...extraHeaders },
      body: JSON.stringify({ email, password }),
    });
  }

  it('login: the first 10 requests in a window succeed normally (not rate-limited)', async () => {
    const email = uniqueEmail('login-under-limit');
    await register(email, 'correct-horse-battery');
    for (let i = 0; i < 10; i += 1) {
      const response = await login(email, 'wrong-password-on-purpose');
      expect(response.status).toBe(401);
    }
  });

  it('login: the 11th request in the same window is rate-limited with 429 + Retry-After', async () => {
    const email = uniqueEmail('login-over-limit');
    await register(email, 'correct-horse-battery');
    for (let i = 0; i < 10; i += 1) {
      await login(email, 'wrong-password-on-purpose');
    }
    const eleventh = await login(email, 'wrong-password-on-purpose');
    expect(eleventh.status).toBe(429);
    const body = (await eleventh.json()) as any;
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(eleventh.headers.get('Retry-After')).toBeTruthy();
    expect(Number(eleventh.headers.get('Retry-After'))).toBeGreaterThan(0);
  });

  it('login: the counter resets after the window elapses', async () => {
    const email = uniqueEmail('login-window-reset');
    await register(email, 'correct-horse-battery');
    for (let i = 0; i < 10; i += 1) {
      await login(email, 'wrong-password-on-purpose');
    }
    const blocked = await login(email, 'wrong-password-on-purpose');
    expect(blocked.status).toBe(429);

    clock.advance(15 * 60 * 1000 + 1);
    const afterReset = await login(email, 'wrong-password-on-purpose');
    expect(afterReset.status).toBe(401);
  });

  it('login: a successful login still counts toward and can hit the limit', async () => {
    const email = uniqueEmail('login-success-counts');
    await register(email, 'correct-horse-battery');
    for (let i = 0; i < 9; i += 1) {
      await login(email, 'wrong');
    }
    const tenth = await login(email, 'correct-horse-battery');
    expect(tenth.status).toBe(200);

    const eleventh = await login(email, 'correct-horse-battery');
    expect(eleventh.status).toBe(429);
  });

  it('registration: the first 5 requests in a window succeed (per the approved policy)', async () => {
    for (let i = 0; i < 5; i += 1) {
      const response = await register(uniqueEmail(`reg-under-${i}`), 'correct-horse-battery');
      expect(response.status).toBe(201);
    }
  });

  it('registration: the 6th request in the same window is rate-limited', async () => {
    for (let i = 0; i < 5; i += 1) {
      await register(uniqueEmail(`reg-fill-${i}`), 'correct-horse-battery');
    }
    const sixth = await register(uniqueEmail('reg-over'), 'correct-horse-battery');
    expect(sixth.status).toBe(429);
    const body = (await sixth.json()) as any;
    expect(body.error.code).toBe('RATE_LIMITED');
  });

  it('registration: duplicate-email behavior is unchanged, not swallowed by the limiter', async () => {
    const email = uniqueEmail('reg-behavior-unchanged');
    const first = await register(email, 'correct-horse-battery');
    expect(first.status).toBe(201);
    const duplicate = await register(email, 'a-different-password');
    expect(duplicate.status).toBe(409);
  });

  it('endpoint isolation: filling the login limit does not consume registration quota', async () => {
    const email = uniqueEmail('isolation-login');
    await register(email, 'correct-horse-battery');
    for (let i = 0; i < 10; i += 1) {
      await login(email, 'wrong-password-on-purpose');
    }
    const loginBlocked = await login(email, 'wrong-password-on-purpose');
    expect(loginBlocked.status).toBe(429);

    const stillCanRegister = await register(uniqueEmail('isolation-still-works'), 'correct-horse-battery');
    expect(stillCanRegister.status).toBe(201);
  });

  it('a fresh key (unrelated to any other test) starts with a clean counter', async () => {
    const email = uniqueEmail('fresh-key');
    await register(email, 'correct-horse-battery');
    const response = await login(email, 'wrong-password-on-purpose');
    expect(response.status).toBe(401);
  });

  it('header spoofing: a fake X-Forwarded-For does NOT let a client evade its real-IP limit', async () => {
    const email = uniqueEmail('spoof-xff');
    await register(email, 'correct-horse-battery');
    for (let i = 0; i < 10; i += 1) {
      await login(email, 'wrong-password-on-purpose');
    }
    const spoofed = await login(email, 'wrong-password-on-purpose', { 'X-Forwarded-For': '1.2.3.4' });
    expect(spoofed.status).toBe(429);
  });

  it('header spoofing: X-Real-IP is equally ignored', async () => {
    const email = uniqueEmail('spoof-real-ip');
    await register(email, 'correct-horse-battery');
    for (let i = 0; i < 10; i += 1) {
      await login(email, 'wrong-password-on-purpose');
    }
    const spoofed = await login(email, 'wrong-password-on-purpose', { 'X-Real-IP': '9.9.9.9' });
    expect(spoofed.status).toBe(429);
  });

  it('logout remains completely unthrottled', async () => {
    // Mint 20 independent, valid sessions directly through AuthService (bypassing HTTP —
    // this never touches the login rate limit, since the limiter only sits at the router
    // layer). Each token is used for exactly one logout call, since logout correctly
    // deletes the session on success — reusing one token across 20 calls would just be
    // testing "logout is idempotent," not "logout is unthrottled."
    const email = uniqueEmail('logout-unthrottled');
    await register(email, 'correct-horse-battery');
    for (let i = 0; i < 20; i += 1) {
      const { token } = await authService.login({ email, password: 'correct-horse-battery' });
      const response = await fetch(`${baseUrl}/auth/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(200);
    }
  });

  it('logout-all remains completely unthrottled', async () => {
    const email = uniqueEmail('logout-all-unthrottled');
    await register(email, 'correct-horse-battery');
    for (let i = 0; i < 20; i += 1) {
      const { token } = await authService.login({ email, password: 'correct-horse-battery' });
      const response = await fetch(`${baseUrl}/auth/logout-all`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(200);
    }
  });

  it('POST /books remains completely unthrottled', async () => {
    const email = uniqueEmail('books-unthrottled');
    await register(email, 'correct-horse-battery');
    const { token } = (await (await login(email, 'correct-horse-battery')).json()) as any;

    for (let i = 0; i < 15; i += 1) {
      const response = await fetch(`${baseUrl}/books`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: 'x.epub' }),
      });
      expect(response.status).not.toBe(429);
    }
  });

  it('POST /books/:bookId/jobs remains completely unthrottled', async () => {
    const email = uniqueEmail('jobs-unthrottled');
    const { id: userId } = (await (await register(email, 'correct-horse-battery')).json()) as any;
    const { token } = (await (await login(email, 'correct-horse-battery')).json()) as any;
    const book = await bookRepo.create({ userId, title: 'Unthrottled Jobs Test', language: 'en' });

    for (let i = 0; i < 15; i += 1) {
      const response = await fetch(`${baseUrl}/books/${book.id}/jobs`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'book' }),
      });
      expect(response.status).not.toBe(429);
    }
  });

  it('cleanup: expired buckets are removed by the periodic sweep, bounding memory growth', async () => {
    const rateLimiter = new RateLimiter(clock, 1000);
    for (let i = 0; i < 5; i += 1) {
      rateLimiter.check(`fake-ip-${i}:test-category`, { maxRequests: 10, windowMs: 15 * 60 * 1000 });
    }
    expect(rateLimiter.bucketCount).toBe(5);

    clock.advance(15 * 60 * 1000 + 1);
    rateLimiter.sweep();
    expect(rateLimiter.bucketCount).toBe(0);
  });
});
