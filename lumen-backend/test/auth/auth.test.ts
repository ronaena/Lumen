import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sql } from 'drizzle-orm';
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

describe('Phase 12: Authentication & Trusted Identity (real HTTP server + live Postgres)', () => {
  const db = getTestDb();
  const userRepo = new UserRepository(db);
  const userCredentialRepo = new UserCredentialRepository(db);
  const sessionRepo = new SessionRepository(db);
  const bookRepo = new BookRepository(db);
  const chapterRepo = new ChapterRepository(db);
  const textSegmentRepo = new TextSegmentRepository(db);
  const voiceRepo = new VoiceRepository(db);

  let storageDir: string;
  let server: Server;
  let baseUrl: string;
  let authService: AuthService;
  let testRateLimiterClock: ManualClock;

  beforeAll(async () => {
    storageDir = await mkdtemp(join(tmpdir(), 'lumen-auth-test-'));
    const storage = new LocalFilesystemStorageProvider(storageDir);
    const registry = new ProviderRegistry();
    authService = new AuthService({ userRepo, userCredentialRepo, sessionRepo });

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
      characterRepo: new CharacterRepository(db),
      characterVoiceAssignmentRepo: new CharacterVoiceAssignmentRepository(db),
      sceneRepo: new SceneRepository(db),
    };

    const rateLimiterClock = new ManualClock();
    const rateLimiter = new RateLimiter(rateLimiterClock);
    server = await createApiServer(deps, createSessionIdentityResolver(authService), authService, rateLimiter);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
    testRateLimiterClock = rateLimiterClock;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(storageDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await resetDatabase();
    // This file exercises register/login many times across many unrelated tests, all
    // from the same loopback IP against one shared server instance — advancing the
    // rate-limit clock well past the 15-minute window before every test keeps these
    // pre-existing auth-behavior tests from being incidentally throttled by Workstream
    // 13B, a feature they were never designed to test (that's auth13bRateLimiting.test.ts).
    testRateLimiterClock.advance(16 * 60 * 1000);
  });

  function uniqueEmail(label: string): string {
    return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  }

  async function register(email: string, password: string) {
    return fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  }

  async function login(email: string, password: string) {
    return fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  }

  it('successful registration returns safe user info, never credential material', async () => {
    const email = uniqueEmail('reg-success');
    const response = await register(email, 'correct-horse-battery');
    expect(response.status).toBe(201);
    const body = (await response.json()) as any;
    expect(body.email).toBe(email);
    expect(body.id).toBeTruthy();
    expect(body.password).toBeUndefined();
    expect(body.passwordHash).toBeUndefined();
    expect(body.salt).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/hash|salt|token/i);
  });

  it('duplicate email registration is rejected', async () => {
    const email = uniqueEmail('reg-dup');
    const first = await register(email, 'correct-horse-battery');
    expect(first.status).toBe(201);

    const second = await register(email, 'a-different-password');
    expect(second.status).toBe(409);
    const body = (await second.json()) as any;
    expect(body.error.code).toBe('EMAIL_ALREADY_REGISTERED');
  });

  it('malformed email is rejected with 400', async () => {
    const response = await register('not-an-email', 'correct-horse-battery');
    expect(response.status).toBe(400);
    const body = (await response.json()) as any;
    expect(body.error.code).toBe('VALIDATION_FAILED');
  });

  it('missing password is rejected with 400', async () => {
    const response = await fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: uniqueEmail('no-pw') }),
    });
    expect(response.status).toBe(400);
  });

  it('password below the minimum length is rejected', async () => {
    const response = await register(uniqueEmail('short-pw'), 'short');
    expect(response.status).toBe(400);
    const body = (await response.json()) as any;
    expect(body.error.code).toBe('VALIDATION_FAILED');
  });

  it('successful login returns a working token', async () => {
    const email = uniqueEmail('login-success');
    await register(email, 'correct-horse-battery');
    const response = await login(email, 'correct-horse-battery');
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(typeof body.token).toBe('string');
    expect(body.token.length).toBeGreaterThan(20);
  });

  it('wrong password is rejected with a generic, non-revealing error', async () => {
    const email = uniqueEmail('login-wrongpw');
    await register(email, 'correct-horse-battery');
    const response = await login(email, 'totally-wrong-password');
    expect(response.status).toBe(401);
    const body = (await response.json()) as any;
    expect(body.error.code).toBe('AUTHENTICATION_FAILED');
    expect(body.error.message).toBe('Invalid email or password.');
  });

  it('unknown email is rejected with the SAME error as wrong password — never reveals account existence', async () => {
    const unknownResponse = await login(uniqueEmail('never-registered'), 'whatever-password');
    const email = uniqueEmail('login-exists-check');
    await register(email, 'correct-horse-battery');
    const wrongPasswordResponse = await login(email, 'wrong-password-here');

    expect(unknownResponse.status).toBe(wrongPasswordResponse.status);
    const unknownBody = (await unknownResponse.json()) as any;
    const wrongBody = (await wrongPasswordResponse.json()) as any;
    expect(unknownBody.error.code).toBe(wrongBody.error.code);
    expect(unknownBody.error.message).toBe(wrongBody.error.message);
  });

  it('malformed login request returns 400', async () => {
    const response = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not valid json',
    });
    expect(response.status).toBe(400);
  });

  it('the returned token actually works to access a protected route', async () => {
    const email = uniqueEmail('token-works');
    await register(email, 'correct-horse-battery');
    const loginResponse = await login(email, 'correct-horse-battery');
    const { token } = (await loginResponse.json()) as any;

    const protectedResponse = await fetch(`${baseUrl}/books/00000000-0000-0000-0000-000000000000`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(protectedResponse.status).toBe(404);
  });

  it('the returned raw token is NOT the value stored in the database (only a hash is stored)', async () => {
    const email = uniqueEmail('token-not-stored');
    await register(email, 'correct-horse-battery');
    const loginResponse = await login(email, 'correct-horse-battery');
    const { token } = (await loginResponse.json()) as any;

    const result: any = await db.execute(sql`SELECT token_hash FROM sessions`);
    const rows = result.rows ?? result;
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).not.toBe(token);
    expect(rows[0].token_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('a valid session authenticates successfully', async () => {
    const email = uniqueEmail('session-valid');
    await register(email, 'correct-horse-battery');
    const { token } = (await (await login(email, 'correct-horse-battery')).json()) as any;

    const response = await fetch(`${baseUrl}/books/00000000-0000-0000-0000-000000000000`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(404);
  });

  it('an expired session is rejected as unauthenticated', async () => {
    const email = uniqueEmail('session-expired');
    await register(email, 'correct-horse-battery');
    const { token } = (await (await login(email, 'correct-horse-battery')).json()) as any;

    await db.execute(sql`UPDATE sessions SET expires_at = now() - interval '1 day'`);

    const response = await fetch(`${baseUrl}/books/00000000-0000-0000-0000-000000000000`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(401);
    const body = (await response.json()) as any;
    expect(body.error.code).toBe('IDENTITY_UNAVAILABLE');
  });

  it('an invalid/random session token is rejected', async () => {
    const response = await fetch(`${baseUrl}/books/00000000-0000-0000-0000-000000000000`, {
      headers: { Authorization: 'Bearer completely-made-up-token-that-was-never-issued' },
    });
    expect(response.status).toBe(401);
  });

  it('logout invalidates the token — the same token is rejected afterward', async () => {
    const email = uniqueEmail('logout-invalidates');
    await register(email, 'correct-horse-battery');
    const { token } = (await (await login(email, 'correct-horse-battery')).json()) as any;

    const logoutResponse = await fetch(`${baseUrl}/auth/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(logoutResponse.status).toBe(200);

    const afterLogout = await fetch(`${baseUrl}/books/00000000-0000-0000-0000-000000000000`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(afterLogout.status).toBe(401);
  });

  it('logout does not invalidate another session (even for the same user)', async () => {
    const email = uniqueEmail('logout-scoped');
    await register(email, 'correct-horse-battery');
    const { token: tokenA } = (await (await login(email, 'correct-horse-battery')).json()) as any;
    const { token: tokenB } = (await (await login(email, 'correct-horse-battery')).json()) as any;
    expect(tokenA).not.toBe(tokenB);

    await fetch(`${baseUrl}/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${tokenA}` } });

    const stillValid = await fetch(`${baseUrl}/books/00000000-0000-0000-0000-000000000000`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    expect(stillValid.status).toBe(404);
  });

  it('malformed Authorization header (no "Bearer" scheme) is rejected', async () => {
    const email = uniqueEmail('malformed-header');
    await register(email, 'correct-horse-battery');
    const { token } = (await (await login(email, 'correct-horse-battery')).json()) as any;

    const response = await fetch(`${baseUrl}/books/00000000-0000-0000-0000-000000000000`, {
      headers: { Authorization: token },
    });
    expect(response.status).toBe(401);
  });

  it('authenticated identity resolves to exactly the user who logged in', async () => {
    const email = uniqueEmail('identity-check');
    const registerResponse = await register(email, 'correct-horse-battery');
    const { id: userId } = (await registerResponse.json()) as any;
    const { token } = (await (await login(email, 'correct-horse-battery')).json()) as any;

    const book = await bookRepo.create({ userId, title: 'Identity Test', language: 'en' });
    const getResponse = await fetch(`${baseUrl}/books/${book.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(getResponse.status).toBe(200);
  });

  it('MANDATORY: a client-supplied userId can never override the session identity (spoofing test)', async () => {
    const emailA = uniqueEmail('spoof-a');
    const emailB = uniqueEmail('spoof-b');
    const { id: userIdA } = (await (await register(emailA, 'correct-horse-battery')).json()) as any;
    const { id: userIdB } = (await (await register(emailB, 'correct-horse-battery')).json()) as any;
    const { token: tokenA } = (await (await login(emailA, 'correct-horse-battery')).json()) as any;

    const bookOwnedByB = await bookRepo.create({ userId: userIdB, title: "B's book", language: 'en' });

    const response = await fetch(`${baseUrl}/books/${bookOwnedByB.id}`, {
      headers: {
        Authorization: `Bearer ${tokenA}`,
        'X-User-Id': userIdB,
      },
    });

    expect(response.status).toBe(404);
    expect(userIdA).not.toBe(userIdB);
  });

  it('ownership: user A can access their own resource', async () => {
    const email = uniqueEmail('own-a');
    const { id: userId } = (await (await register(email, 'correct-horse-battery')).json()) as any;
    const { token } = (await (await login(email, 'correct-horse-battery')).json()) as any;
    const book = await bookRepo.create({ userId, title: 'Mine', language: 'en' });

    const response = await fetch(`${baseUrl}/books/${book.id}`, { headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
  });

  it('ownership: user A cannot access user B resource, and vice versa', async () => {
    const emailA = uniqueEmail('own-cross-a');
    const emailB = uniqueEmail('own-cross-b');
    const { id: userIdA } = (await (await register(emailA, 'correct-horse-battery')).json()) as any;
    const { id: userIdB } = (await (await register(emailB, 'correct-horse-battery')).json()) as any;
    const { token: tokenA } = (await (await login(emailA, 'correct-horse-battery')).json()) as any;
    const { token: tokenB } = (await (await login(emailB, 'correct-horse-battery')).json()) as any;

    const bookA = await bookRepo.create({ userId: userIdA, title: "A's book", language: 'en' });
    const bookB = await bookRepo.create({ userId: userIdB, title: "B's book", language: 'en' });

    const aAccessingB = await fetch(`${baseUrl}/books/${bookB.id}`, { headers: { Authorization: `Bearer ${tokenA}` } });
    expect(aAccessingB.status).toBe(404);

    const bAccessingA = await fetch(`${baseUrl}/books/${bookA.id}`, { headers: { Authorization: `Bearer ${tokenB}` } });
    expect(bAccessingA.status).toBe(404);
  });

  it('no raw DB/crypto internals ever leak through any auth error response', async () => {
    const responses = await Promise.all([
      register('bad-email', 'x'),
      login('nobody@example.com', 'whatever'),
      fetch(`${baseUrl}/books/x`, { headers: { Authorization: 'Bearer garbage' } }),
    ]);
    for (const response of responses) {
      const text = await response.text();
      expect(text).not.toMatch(/scrypt|timingSafeEqual|pg_|constraint|stack|node_modules/i);
    }
  });
});
