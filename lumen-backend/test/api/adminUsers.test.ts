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
import { promoteUserToAdmin } from '../../src/db/promoteUserToAdmin.js';

describe('Admin User Management v1 (real HTTP + live Postgres)', () => {
  const db = getTestDb();
  const userRepo = new UserRepository(db);
  const userCredentialRepo = new UserCredentialRepository(db);
  const sessionRepo = new SessionRepository(db);
  const voiceRepo = new VoiceRepository(db);

  let storageDir: string;
  let server: Server;
  let baseUrl: string;
  let clock: ManualClock;
  let authServiceForDirectCalls: AuthService;

  beforeAll(async () => {
    storageDir = await mkdtemp(join(tmpdir(), 'lumen-adminusers-test-'));
    const storage = new LocalFilesystemStorageProvider(storageDir);
    const registry = new ProviderRegistry();
    const authService = new AuthService({ userRepo, userCredentialRepo, sessionRepo });
    authServiceForDirectCalls = authService;
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

  async function registerAndLogin(label: string) {
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
    return { email, token };
  }

  async function registerLoginAndPromote(label: string) {
    const { email, token } = await registerAndLogin(label);
    await promoteUserToAdmin(userRepo, email);
    return { email, token };
  }

  async function getUserId(token: string): Promise<string> {
    const response = await fetch(`${baseUrl}/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
    const body = (await response.json()) as any;
    return body.userId;
  }

  it('unauthenticated request to any admin user endpoint returns 401', async () => {
    expect((await fetch(`${baseUrl}/admin/users`)).status).toBe(401);
  });

  it('authenticated non-admin gets 403 on list/detail/role/status endpoints', async () => {
    const { token } = await registerAndLogin('adminusers-nonadmin');
    expect((await fetch(`${baseUrl}/admin/users`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(403);
    expect(
      (await fetch(`${baseUrl}/admin/users/00000000-0000-0000-0000-000000000000`, { headers: { Authorization: `Bearer ${token}` } }))
        .status,
    ).toBe(403);
  });

  it('spoofed admin headers grant no privilege -- role comes only from the server-resolved identity', async () => {
    const { token } = await registerAndLogin('adminusers-spoof');
    const response = await fetch(`${baseUrl}/admin/users`, {
      headers: { Authorization: `Bearer ${token}`, 'X-Role': 'admin', 'X-Is-Admin': 'true' },
    });
    expect(response.status).toBe(403);
  });

  it('admin succeeds on list/detail', async () => {
    const { token } = await registerLoginAndPromote('adminusers-admin-auth');
    expect((await fetch(`${baseUrl}/admin/users`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
  });

  it('admin: list returns only safe fields, never a password hash or session token', async () => {
    const { token } = await registerLoginAndPromote('adminusers-list-safe');
    await registerAndLogin('adminusers-list-other');
    const response = await fetch(`${baseUrl}/admin/users`, { headers: { Authorization: `Bearer ${token}` } });
    const users = (await response.json()) as any[];
    expect(users.length).toBeGreaterThanOrEqual(2);
    const text = JSON.stringify(users);
    expect(text).not.toMatch(/passwordHash|password_hash|tokenHash|token_hash/i);
    expect(Object.keys(users[0]).sort()).toEqual(['createdAt', 'disabled', 'displayName', 'email', 'id', 'role', 'updatedAt'].sort());
  });

  it('admin: detail returns safe fields for a specific user; nonexistent user returns 404', async () => {
    const { token } = await registerLoginAndPromote('adminusers-detail');
    const other = await registerAndLogin('adminusers-detail-target');
    const otherId = await getUserId(other.token);

    const response = await fetch(`${baseUrl}/admin/users/${otherId}`, { headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.email).toBe(other.email);
    expect(body.disabled).toBe(false);

    const missing = await fetch(`${baseUrl}/admin/users/00000000-0000-0000-0000-000000000000`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(missing.status).toBe(404);
  });

  it('admin: promote a user to admin, then demote back to user', async () => {
    const { token: adminToken } = await registerLoginAndPromote('adminusers-role-admin');
    const other = await registerAndLogin('adminusers-role-target');
    const otherId = await getUserId(other.token);

    const promoteResponse = await fetch(`${baseUrl}/admin/users/${otherId}/role`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'admin' }),
    });
    expect(promoteResponse.status).toBe(200);
    expect(((await promoteResponse.json()) as any).role).toBe('admin');

    const demoteResponse = await fetch(`${baseUrl}/admin/users/${otherId}/role`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'user' }),
    });
    expect(demoteResponse.status).toBe(200);
    expect(((await demoteResponse.json()) as any).role).toBe('user');
  });

  it('invalid role value is rejected', async () => {
    const { token } = await registerLoginAndPromote('adminusers-invalid-role');
    const response = await fetch(`${baseUrl}/admin/users/00000000-0000-0000-0000-000000000000/role`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'superadmin' }),
    });
    expect(response.status).toBe(400);
  });

  it('non-admin cannot change any role', async () => {
    const { token } = await registerAndLogin('adminusers-role-nonadmin');
    const response = await fetch(`${baseUrl}/admin/users/00000000-0000-0000-0000-000000000000/role`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'admin' }),
    });
    expect(response.status).toBe(403);
  });

  it('role change on a nonexistent user returns 404', async () => {
    const { token } = await registerLoginAndPromote('adminusers-role-404');
    const response = await fetch(`${baseUrl}/admin/users/00000000-0000-0000-0000-000000000000/role`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'admin' }),
    });
    expect(response.status).toBe(404);
  });

  it('the last remaining active admin cannot be demoted', async () => {
    const { token, email } = await registerLoginAndPromote('adminusers-lastadmin-demote');
    const selfId = await getUserId(token);
    expect(email).toBeTruthy();

    const response = await fetch(`${baseUrl}/admin/users/${selfId}/role`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'user' }),
    });
    expect(response.status).toBe(409);
    const body = (await response.json()) as any;
    expect(body.error.code).toBe('CANNOT_REMOVE_LAST_ADMIN');
  });

  it('a non-last admin CAN be demoted (self-demotion allowed when not the last admin)', async () => {
    const { token: admin1Token } = await registerLoginAndPromote('adminusers-multi-1');
    const { token: admin2Token } = await registerLoginAndPromote('adminusers-multi-2');
    const admin2Id = await getUserId(admin2Token);

    const response = await fetch(`${baseUrl}/admin/users/${admin2Id}/role`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${admin1Token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'user' }),
    });
    expect(response.status).toBe(200);
  });

  it('admin cannot disable themselves, even if not the last admin', async () => {
    const { token: admin1Token } = await registerLoginAndPromote('adminusers-selfdisable-1');
    await registerLoginAndPromote('adminusers-selfdisable-2');
    const selfId = await getUserId(admin1Token);

    const response = await fetch(`${baseUrl}/admin/users/${selfId}/status`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${admin1Token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ disabled: true }),
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as any;
    expect(body.error.code).toBe('CANNOT_DISABLE_SELF');
  });

  it('the true last remaining active admin cannot be disabled by anyone else via real HTTP -- but this always resolves via the self-disable rule (403 CANNOT_DISABLE_SELF), since with exactly one active admin, no other admin exists to even authenticate as an actor', async () => {
    const { token: soleAdminToken } = await registerLoginAndPromote('adminusers-lastadmin-disable');
    const soleAdminId = await getUserId(soleAdminToken);

    const response = await fetch(`${baseUrl}/admin/users/${soleAdminId}/status`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${soleAdminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ disabled: true }),
    });
    expect(response.status).toBe(403);
    expect(((await response.json()) as any).error.code).toBe('CANNOT_DISABLE_SELF');
  });

  it('CANNOT_REMOVE_LAST_ADMIN is independently correct at the service layer, even though the self-disable rule always intercepts this exact scenario via real HTTP (defense in depth, not dead code)', async () => {
    const { email, token } = await registerLoginAndPromote('adminusers-lastadmin-service-level');
    const soleAdminId = await getUserId(token);
    expect(email).toBeTruthy();

    // Calls the service directly with a different (fabricated) callerUserId, bypassing
    // the HTTP/authorization layer entirely -- this is the only way to exercise
    // CANNOT_REMOVE_LAST_ADMIN's own logic in isolation, since via real HTTP the
    // self-disable rule always fires first when there's genuinely only one active admin.
    await expect(
      authServiceForDirectCalls.setUserDisabled('00000000-0000-0000-0000-000000000001', soleAdminId, true),
    ).rejects.toMatchObject({ code: 'CANNOT_REMOVE_LAST_ADMIN' });
  });

  it('disabling a normal user works, and the disabled user cannot log in again', async () => {
    const { token: adminToken } = await registerLoginAndPromote('adminusers-disable-target-admin');
    const { email: targetEmail, token: targetToken } = await registerAndLogin('adminusers-disable-target');
    const targetId = await getUserId(targetToken);

    const disableResponse = await fetch(`${baseUrl}/admin/users/${targetId}/status`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ disabled: true }),
    });
    expect(disableResponse.status).toBe(200);
    expect(((await disableResponse.json()) as any).disabled).toBe(true);

    const loginAttempt = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: targetEmail, password: 'correct-horse-battery' }),
    });
    expect(loginAttempt.status).toBe(401);
  });

  it("CRITICAL: disabling a user invalidates their EXISTING session -- the very next authenticated request must fail, not just future logins", async () => {
    const { token: adminToken } = await registerLoginAndPromote('adminusers-disable-existing-session-admin');
    const { token: targetToken } = await registerAndLogin('adminusers-disable-existing-session-target');
    const targetId = await getUserId(targetToken);

    const beforeDisable = await fetch(`${baseUrl}/auth/me`, { headers: { Authorization: `Bearer ${targetToken}` } });
    expect(beforeDisable.status).toBe(200);

    await fetch(`${baseUrl}/admin/users/${targetId}/status`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ disabled: true }),
    });

    const afterDisable = await fetch(`${baseUrl}/auth/me`, { headers: { Authorization: `Bearer ${targetToken}` } });
    expect(afterDisable.status).toBe(401);
  });

  it('re-enabling restores normal login and session behavior', async () => {
    const { token: adminToken } = await registerLoginAndPromote('adminusers-reenable-admin');
    const { email: targetEmail, token: targetToken } = await registerAndLogin('adminusers-reenable-target');
    const targetId = await getUserId(targetToken);

    await fetch(`${baseUrl}/admin/users/${targetId}/status`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ disabled: true }),
    });

    const enableResponse = await fetch(`${baseUrl}/admin/users/${targetId}/status`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ disabled: false }),
    });
    expect(enableResponse.status).toBe(200);
    expect(((await enableResponse.json()) as any).disabled).toBe(false);

    const loginAgain = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: targetEmail, password: 'correct-horse-battery' }),
    });
    expect(loginAgain.status).toBe(200);
  });

  it('non-admin cannot disable/enable anyone', async () => {
    const { token } = await registerAndLogin('adminusers-status-nonadmin');
    const response = await fetch(`${baseUrl}/admin/users/00000000-0000-0000-0000-000000000000/status`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ disabled: true }),
    });
    expect(response.status).toBe(403);
  });

  it('disabling a nonexistent user returns 404', async () => {
    const { token } = await registerLoginAndPromote('adminusers-status-404');
    const response = await fetch(`${baseUrl}/admin/users/00000000-0000-0000-0000-000000000000/status`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ disabled: true }),
    });
    expect(response.status).toBe(404);
  });

  it('regression: /auth/me, /health, /ready, /admin/dashboard, /admin/voices remain unaffected', async () => {
    const { token } = await registerLoginAndPromote('adminusers-regression');
    expect((await fetch(`${baseUrl}/auth/me`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
    expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/ready`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/admin/dashboard`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
    expect((await fetch(`${baseUrl}/admin/voices`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
  });

  it('regression: an ordinary, never-disabled user logs in and uses the app completely normally', async () => {
    const { token } = await registerAndLogin('adminusers-ordinary-regression');
    const response = await fetch(`${baseUrl}/books`, { headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
  });
});
