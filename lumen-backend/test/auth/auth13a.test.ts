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

describe('Workstream 13A: Authentication Hardening — password change & logout-all (real HTTP + live Postgres)', () => {
  const db = getTestDb();
  const userRepo = new UserRepository(db);
  const userCredentialRepo = new UserCredentialRepository(db);
  const sessionRepo = new SessionRepository(db);
  const bookRepo = new BookRepository(db);

  let storageDir: string;
  let server: Server;
  let testRateLimiterClock: ManualClock;
  let baseUrl: string;

  beforeAll(async () => {
    storageDir = await mkdtemp(join(tmpdir(), 'lumen-13a-test-'));
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

  async function registerAndLogin(label: string, password = 'correct-horse-battery') {
    const email = uniqueEmail(label);
    const registerResponse = await register(email, password);
    const { id: userId } = (await registerResponse.json()) as any;
    const { token } = (await (await login(email, password)).json()) as any;
    return { email, userId, token, password };
  }

  it('1: an authenticated user can change their password', async () => {
    const { token } = await registerAndLogin('pw-change');
    const response = await fetch(`${baseUrl}/auth/password`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'correct-horse-battery', newPassword: 'a-new-strong-password' }),
    });
    expect(response.status).toBe(200);
  });

  it('2: an unauthenticated password-change request is rejected', async () => {
    const response = await fetch(`${baseUrl}/auth/password`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'x', newPassword: 'a-new-strong-password' }),
    });
    expect(response.status).toBe(401);
  });

  it('3: the wrong current password is rejected, and the password is NOT changed', async () => {
    const { email, token, password } = await registerAndLogin('pw-wrong-current');
    const response = await fetch(`${baseUrl}/auth/password`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'totally-wrong', newPassword: 'a-new-strong-password' }),
    });
    expect(response.status).toBe(401);
    const body = (await response.json()) as any;
    expect(body.error.code).toBe('AUTHENTICATION_FAILED');

    const stillWorks = await login(email, password);
    expect(stillWorks.status).toBe(200);
  });

  it('4: a new password below the minimum length is rejected', async () => {
    const { token } = await registerAndLogin('pw-weak-new');
    const response = await fetch(`${baseUrl}/auth/password`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'correct-horse-battery', newPassword: 'short' }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as any;
    expect(body.error.code).toBe('VALIDATION_FAILED');
  });

  it('5 + 6 + 7: successful change persists — old password stops working, new password works', async () => {
    const { email, token } = await registerAndLogin('pw-persist');
    const changeResponse = await fetch(`${baseUrl}/auth/password`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'correct-horse-battery', newPassword: 'brand-new-password-123' }),
    });
    expect(changeResponse.status).toBe(200);

    const oldPasswordLogin = await login(email, 'correct-horse-battery');
    expect(oldPasswordLogin.status).toBe(401);

    const newPasswordLogin = await login(email, 'brand-new-password-123');
    expect(newPasswordLogin.status).toBe(200);
  });

  it("8: user A's password change cannot affect user B's credentials", async () => {
    const userA = await registerAndLogin('pw-cross-a');
    const userB = await registerAndLogin('pw-cross-b');

    const response = await fetch(`${baseUrl}/auth/password`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${userA.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: userA.password, newPassword: 'a-new-strong-password' }),
    });
    expect(response.status).toBe(200);

    const bStillWorks = await login(userB.email, userB.password);
    expect(bStillWorks.status).toBe(200);
  });

  it('9: password hash/salt are never exposed in the change-password response', async () => {
    const { token } = await registerAndLogin('pw-no-leak');
    const response = await fetch(`${baseUrl}/auth/password`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'correct-horse-battery', newPassword: 'a-new-strong-password' }),
    });
    const text = await response.text();
    expect(text).not.toMatch(/hash|salt/i);
  });

  it('1: an authenticated user can revoke all of their own sessions', async () => {
    const { token } = await registerAndLogin('logout-all-basic');
    const response = await fetch(`${baseUrl}/auth/logout-all`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
  });

  it('2 + 3: multiple sessions for the same user are ALL revoked, including the current one', async () => {
    const email = uniqueEmail('logout-all-multi');
    const password = 'correct-horse-battery';
    await register(email, password);
    const { token: tokenA } = (await (await login(email, password)).json()) as any;
    const { token: tokenB } = (await (await login(email, password)).json()) as any;
    const { token: tokenC } = (await (await login(email, password)).json()) as any;

    const response = await fetch(`${baseUrl}/auth/logout-all`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(response.status).toBe(200);

    for (const token of [tokenA, tokenB, tokenC]) {
      const check = await fetch(`${baseUrl}/books/00000000-0000-0000-0000-000000000000`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(check.status).toBe(401);
    }
  });

  it("4: another user's sessions remain valid after logout-all", async () => {
    const userA = await registerAndLogin('logout-all-a');
    const userB = await registerAndLogin('logout-all-b');

    await fetch(`${baseUrl}/auth/logout-all`, { method: 'POST', headers: { Authorization: `Bearer ${userA.token}` } });

    const bCheck = await fetch(`${baseUrl}/books/00000000-0000-0000-0000-000000000000`, {
      headers: { Authorization: `Bearer ${userB.token}` },
    });
    expect(bCheck.status).toBe(404);
  });

  it('5: an unauthenticated logout-all request is rejected', async () => {
    const response = await fetch(`${baseUrl}/auth/logout-all`, { method: 'POST' });
    expect(response.status).toBe(401);
  });

  it('6: a client cannot select another user via a spoofed identity header', async () => {
    const userA = await registerAndLogin('logout-all-spoof-a');
    const userB = await registerAndLogin('logout-all-spoof-b');

    await fetch(`${baseUrl}/auth/logout-all`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${userA.token}`, 'X-User-Id': userB.userId },
    });

    const bCheck = await fetch(`${baseUrl}/books/00000000-0000-0000-0000-000000000000`, {
      headers: { Authorization: `Bearer ${userB.token}` },
    });
    expect(bCheck.status).toBe(404);
  });

  it('7: any subsequent authenticated request using a revoked session fails', async () => {
    const { token } = await registerAndLogin('logout-all-subsequent');
    await fetch(`${baseUrl}/auth/logout-all`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });

    const afterResponse = await fetch(`${baseUrl}/books/00000000-0000-0000-0000-000000000000`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(afterResponse.status).toBe(401);
  });
});
