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
import { AdminAuditLogRepository } from '../../src/repositories/AdminAuditLogRepository.js';
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

describe('Admin Audit Log v1 (real HTTP + live Postgres)', () => {
  const db = getTestDb();
  const userRepo = new UserRepository(db);
  const userCredentialRepo = new UserCredentialRepository(db);
  const sessionRepo = new SessionRepository(db);
  const voiceRepo = new VoiceRepository(db);
  const auditLogRepo = new AdminAuditLogRepository(db);

  let storageDir: string;
  let server: Server;
  let baseUrl: string;
  let clock: ManualClock;

  beforeAll(async () => {
    storageDir = await mkdtemp(join(tmpdir(), 'lumen-auditlog-test-'));
    const storage = new LocalFilesystemStorageProvider(storageDir);
    const registry = new ProviderRegistry();
    const authService = new AuthService({ userRepo, userCredentialRepo, sessionRepo, auditLogRepo });
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
    return ((await response.json()) as any).userId;
  }

  it('unauthenticated request returns 401', async () => {
    expect((await fetch(`${baseUrl}/admin/audit-log`)).status).toBe(401);
  });

  it('authenticated non-admin returns 403', async () => {
    const { token } = await registerAndLogin('auditlog-nonadmin');
    expect((await fetch(`${baseUrl}/admin/audit-log`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(403);
  });

  it('a successful user role change is recorded with safe metadata', async () => {
    const { token: adminToken } = await registerLoginAndPromote('auditlog-role-success');
    const other = await registerAndLogin('auditlog-role-target');
    const otherId = await getUserId(other.token);

    await fetch(`${baseUrl}/admin/users/${otherId}/role`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'admin' }),
    });

    const response = await fetch(`${baseUrl}/admin/audit-log`, { headers: { Authorization: `Bearer ${adminToken}` } });
    const body = (await response.json()) as any;
    const entry = body.items.find((i: any) => i.action === 'USER_ROLE_CHANGED' && i.targetId === otherId);
    expect(entry).toBeTruthy();
    expect(entry.result).toBe('success');
    expect(entry.metadata).toEqual({ fromRole: 'user', toRole: 'admin' });
  });

  it('a successful voice creation is recorded', async () => {
    const { token } = await registerLoginAndPromote('auditlog-voice-success');
    const createResponse = await fetch(`${baseUrl}/admin/voices`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'Audit Test Voice', role: 'narrator', language: 'en' }),
    });
    const created = (await createResponse.json()) as any;

    const response = await fetch(`${baseUrl}/admin/audit-log`, { headers: { Authorization: `Bearer ${token}` } });
    const body = (await response.json()) as any;
    const entry = body.items.find((i: any) => i.action === 'VOICE_CREATED' && i.targetId === created.id);
    expect(entry).toBeTruthy();
    expect(entry.result).toBe('success');
    expect(entry.metadata).toEqual({ displayName: 'Audit Test Voice' });
  });

  it('a successful mapping creation is recorded WITHOUT the providerVoiceId value', async () => {
    const { token } = await registerLoginAndPromote('auditlog-mapping-success');
    const voice = (await (
      await fetch(`${baseUrl}/admin/voices`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'Mapping Audit Voice', role: 'narrator', language: 'en' }),
      })
    ).json()) as any;

    await fetch(`${baseUrl}/admin/voices/${voice.id}/mappings`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'elevenlabs', providerVoiceId: 'sensitive-vendor-id-must-not-appear' }),
    });

    const response = await fetch(`${baseUrl}/admin/audit-log`, { headers: { Authorization: `Bearer ${token}` } });
    const text = await response.text();
    expect(text).not.toMatch(/sensitive-vendor-id-must-not-appear/);
    const body = JSON.parse(text);
    const entry = body.items.find((i: any) => i.action === 'MAPPING_CREATED');
    expect(entry).toBeTruthy();
    expect(entry.metadata).toEqual({ provider: 'elevenlabs', isActive: true });
  });

  it('a failed (blocked) last-admin demotion is recorded as a failure', async () => {
    const { token, email } = await registerLoginAndPromote('auditlog-demote-failure');
    const selfId = await getUserId(token);
    expect(email).toBeTruthy();

    await fetch(`${baseUrl}/admin/users/${selfId}/role`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'user' }),
    });

    const response = await fetch(`${baseUrl}/admin/audit-log`, { headers: { Authorization: `Bearer ${token}` } });
    const body = (await response.json()) as any;
    const entry = body.items.find((i: any) => i.action === 'USER_ROLE_CHANGED' && i.targetId === selfId);
    expect(entry).toBeTruthy();
    expect(entry.result).toBe('failure');
  });

  it('a failed (blocked) self-disable attempt is recorded as a failure', async () => {
    const { token } = await registerLoginAndPromote('auditlog-selfdisable-failure');
    const selfId = await getUserId(token);

    await fetch(`${baseUrl}/admin/users/${selfId}/status`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ disabled: true }),
    });

    const response = await fetch(`${baseUrl}/admin/audit-log`, { headers: { Authorization: `Bearer ${token}` } });
    const body = (await response.json()) as any;
    const entry = body.items.find((i: any) => i.action === 'USER_STATUS_CHANGED' && i.targetId === selfId);
    expect(entry).toBeTruthy();
    expect(entry.result).toBe('failure');
  });

  it('read-only admin requests (list users, list voices) do not create audit entries', async () => {
    const { token } = await registerLoginAndPromote('auditlog-noreads');
    const before = (await (await fetch(`${baseUrl}/admin/audit-log`, { headers: { Authorization: `Bearer ${token}` } })).json()) as any;
    const beforeCount = before.items.length;

    await fetch(`${baseUrl}/admin/users`, { headers: { Authorization: `Bearer ${token}` } });
    await fetch(`${baseUrl}/admin/voices`, { headers: { Authorization: `Bearer ${token}` } });
    await fetch(`${baseUrl}/admin/dashboard`, { headers: { Authorization: `Bearer ${token}` } });
    await fetch(`${baseUrl}/health`);
    await fetch(`${baseUrl}/ready`);

    const after = (await (await fetch(`${baseUrl}/admin/audit-log`, { headers: { Authorization: `Bearer ${token}` } })).json()) as any;
    expect(after.items.length).toBe(beforeCount);
  });

  it('a normal, non-admin request rejected before reaching a mutation handler creates no audit entry', async () => {
    const { token: adminToken } = await registerLoginAndPromote('auditlog-rejected-noaudit-admin');
    const { token: userToken } = await registerAndLogin('auditlog-rejected-noaudit-user');

    const before = (await (await fetch(`${baseUrl}/admin/audit-log`, { headers: { Authorization: `Bearer ${adminToken}` } })).json()) as any;

    await fetch(`${baseUrl}/admin/users/00000000-0000-0000-0000-000000000000/role`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${userToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'admin' }),
    });

    const after = (await (await fetch(`${baseUrl}/admin/audit-log`, { headers: { Authorization: `Bearer ${adminToken}` } })).json()) as any;
    expect(after.items.length).toBe(before.items.length);
  });

  it('pagination defaults to limit=50, offset=0, newest first', async () => {
    const { token } = await registerLoginAndPromote('auditlog-pagination-defaults');
    await fetch(`${baseUrl}/admin/voices`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'Pagination Voice 1', role: 'narrator', language: 'en' }),
    });
    await fetch(`${baseUrl}/admin/voices`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'Pagination Voice 2', role: 'narrator', language: 'en' }),
    });

    const response = await fetch(`${baseUrl}/admin/audit-log`, { headers: { Authorization: `Bearer ${token}` } });
    const body = (await response.json()) as any;
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(0);
    expect(body.items.length).toBeGreaterThanOrEqual(2);
    const idx1 = body.items.findIndex((i: any) => i.metadata?.displayName === 'Pagination Voice 1');
    const idx2 = body.items.findIndex((i: any) => i.metadata?.displayName === 'Pagination Voice 2');
    expect(idx2).toBeLessThan(idx1);
  });

  it('explicit limit and offset are honored', async () => {
    const { token } = await registerLoginAndPromote('auditlog-pagination-explicit');
    for (let i = 0; i < 3; i += 1) {
      await fetch(`${baseUrl}/admin/voices`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: `Explicit Pagination Voice ${i}`, role: 'narrator', language: 'en' }),
      });
    }

    const response = await fetch(`${baseUrl}/admin/audit-log?limit=1&offset=0`, { headers: { Authorization: `Bearer ${token}` } });
    const body = (await response.json()) as any;
    expect(body.limit).toBe(1);
    expect(body.items.length).toBe(1);
  });

  it('limit exceeding the maximum (100) is rejected', async () => {
    const { token } = await registerLoginAndPromote('auditlog-pagination-max');
    const response = await fetch(`${baseUrl}/admin/audit-log?limit=101`, { headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(400);
  });

  it('a negative offset is rejected', async () => {
    const { token } = await registerLoginAndPromote('auditlog-pagination-negative');
    const response = await fetch(`${baseUrl}/admin/audit-log?offset=-1`, { headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(400);
  });

  it('no response ever contains a password hash, session token, or DATABASE_URL', async () => {
    const { token } = await registerLoginAndPromote('auditlog-safety');
    await fetch(`${baseUrl}/admin/voices`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'Safety Voice', role: 'narrator', language: 'en' }),
    });
    const response = await fetch(`${baseUrl}/admin/audit-log`, { headers: { Authorization: `Bearer ${token}` } });
    const text = await response.text();
    expect(text).not.toMatch(/passwordHash|password_hash|tokenHash|token_hash|DATABASE_URL|postgres:\/\//i);
  });
});

describe('AdminAuditLogRepository is genuinely append-only', () => {
  it('exposes no update or delete method', () => {
    const repo = new AdminAuditLogRepository(getTestDb());
    expect((repo as any).update).toBeUndefined();
    expect((repo as any).delete).toBeUndefined();
  });
});

describe('Admin Audit Log Filtering v1 (real HTTP + live Postgres)', () => {
  const db = getTestDb();
  const userRepo = new UserRepository(db);
  const userCredentialRepo = new UserCredentialRepository(db);
  const sessionRepo = new SessionRepository(db);
  const voiceRepo = new VoiceRepository(db);
  const auditLogRepo = new AdminAuditLogRepository(db);

  let storageDir: string;
  let server: Server;
  let baseUrl: string;
  let clock: ManualClock;

  beforeAll(async () => {
    storageDir = await mkdtemp(join(tmpdir(), 'lumen-auditlogfilter-test-'));
    const storage = new LocalFilesystemStorageProvider(storageDir);
    const registry = new ProviderRegistry();
    const authService = new AuthService({ userRepo, userCredentialRepo, sessionRepo, auditLogRepo });
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
    return ((await response.json()) as any).userId;
  }

  async function createVoice(token: string, displayName: string) {
    const response = await fetch(`${baseUrl}/admin/voices`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName, role: 'narrator', language: 'en' }),
    });
    return (await response.json()) as any;
  }

  it('unfiltered request is unaffected -- exact same behavior as before this workstream', async () => {
    const { token } = await registerLoginAndPromote('filter-unfiltered-regression');
    await createVoice(token, 'Unfiltered Voice');
    const response = await fetch(`${baseUrl}/admin/audit-log`, { headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.items.some((i: any) => i.metadata?.displayName === 'Unfiltered Voice')).toBe(true);
  });

  it('filters by action', async () => {
    const { token } = await registerLoginAndPromote('filter-action');
    await createVoice(token, 'Action Filter Voice');
    const otherId = await getUserId((await registerAndLogin('filter-action-target')).token);
    await fetch(`${baseUrl}/admin/users/${otherId}/role`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'admin' }),
    });

    const response = await fetch(`${baseUrl}/admin/audit-log?action=VOICE_CREATED`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await response.json()) as any;
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.every((i: any) => i.action === 'VOICE_CREATED')).toBe(true);
  });

  it('filters by targetType', async () => {
    const { token } = await registerLoginAndPromote('filter-targettype');
    await createVoice(token, 'TargetType Filter Voice');

    const response = await fetch(`${baseUrl}/admin/audit-log?targetType=voice`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await response.json()) as any;
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.every((i: any) => i.targetType === 'voice')).toBe(true);
  });

  it('filters by result (success vs failure)', async () => {
    const { token } = await registerLoginAndPromote('filter-result');
    const selfId = await getUserId(token);
    // A blocked self-disable -- a real failure entry.
    await fetch(`${baseUrl}/admin/users/${selfId}/status`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ disabled: true }),
    });
    await createVoice(token, 'Success Result Voice');

    const failuresResponse = await fetch(`${baseUrl}/admin/audit-log?result=failure`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const failuresBody = (await failuresResponse.json()) as any;
    expect(failuresBody.items.length).toBeGreaterThan(0);
    expect(failuresBody.items.every((i: any) => i.result === 'failure')).toBe(true);

    const successResponse = await fetch(`${baseUrl}/admin/audit-log?result=success`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const successBody = (await successResponse.json()) as any;
    expect(successBody.items.length).toBeGreaterThan(0);
    expect(successBody.items.every((i: any) => i.result === 'success')).toBe(true);
  });

  it('filters by adminUserId -- only shows actions performed by that specific admin', async () => {
    const { token: admin1Token } = await registerLoginAndPromote('filter-adminid-1');
    const { token: admin2Token } = await registerLoginAndPromote('filter-adminid-2');
    const admin1Id = await getUserId(admin1Token);

    await createVoice(admin1Token, 'Admin1 Voice');
    await createVoice(admin2Token, 'Admin2 Voice');

    const response = await fetch(`${baseUrl}/admin/audit-log?adminUserId=${admin1Id}`, {
      headers: { Authorization: `Bearer ${admin1Token}` },
    });
    const body = (await response.json()) as any;
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.every((i: any) => i.adminUserId === admin1Id)).toBe(true);
    expect(body.items.some((i: any) => i.metadata?.displayName === 'Admin2 Voice')).toBe(false);
  });

  it('filters by targetId', async () => {
    const { token } = await registerLoginAndPromote('filter-targetid');
    const voiceA = await createVoice(token, 'Target A');
    await createVoice(token, 'Target B');

    const response = await fetch(`${baseUrl}/admin/audit-log?targetId=${voiceA.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await response.json()) as any;
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.every((i: any) => i.targetId === voiceA.id)).toBe(true);
  });

  it('filters by date range (from/to) -- excludes entries outside the window', async () => {
    const { token } = await registerLoginAndPromote('filter-daterange');
    await createVoice(token, 'Date Range Voice');

    // A window comfortably in the future -- must exclude the entry just created.
    const farFuture = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    const response = await fetch(`${baseUrl}/admin/audit-log?from=${encodeURIComponent(farFuture)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await response.json()) as any;
    expect(body.items.some((i: any) => i.metadata?.displayName === 'Date Range Voice')).toBe(false);

    // A window comfortably including "now" -- must include the entry.
    const farPast = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
    const includingResponse = await fetch(`${baseUrl}/admin/audit-log?from=${encodeURIComponent(farPast)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const includingBody = (await includingResponse.json()) as any;
    expect(includingBody.items.some((i: any) => i.metadata?.displayName === 'Date Range Voice')).toBe(true);
  });

  it('combines multiple filters (action + result + adminUserId) correctly', async () => {
    const { token } = await registerLoginAndPromote('filter-combined');
    const adminId = await getUserId(token);
    await createVoice(token, 'Combined Filter Voice');

    const response = await fetch(
      `${baseUrl}/admin/audit-log?action=VOICE_CREATED&result=success&adminUserId=${adminId}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const body = (await response.json()) as any;
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.every((i: any) => i.action === 'VOICE_CREATED' && i.result === 'success' && i.adminUserId === adminId)).toBe(
      true,
    );
  });

  it('a filter matching nothing returns an empty items array, not an error', async () => {
    const { token } = await registerLoginAndPromote('filter-nomatch');
    const response = await fetch(`${baseUrl}/admin/audit-log?action=NONEXISTENT_ACTION_XYZ`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.items).toEqual([]);
  });

  it('an invalid adminUserId (not a UUID) is rejected with 400', async () => {
    const { token } = await registerLoginAndPromote('filter-invalid-uuid');
    const response = await fetch(`${baseUrl}/admin/audit-log?adminUserId=not-a-uuid`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(400);
  });

  it('an invalid result value is rejected with 400', async () => {
    const { token } = await registerLoginAndPromote('filter-invalid-result');
    const response = await fetch(`${baseUrl}/admin/audit-log?result=maybe`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(400);
  });

  it('filtering combined with pagination still respects limit/offset correctly', async () => {
    const { token } = await registerLoginAndPromote('filter-pagination-combo');
    for (let i = 0; i < 3; i += 1) {
      await createVoice(token, `Pagination Combo Voice ${i}`);
    }
    const response = await fetch(`${baseUrl}/admin/audit-log?action=VOICE_CREATED&limit=1&offset=0`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await response.json()) as any;
    expect(body.items.length).toBe(1);
    expect(body.limit).toBe(1);
  });

  it('unauthenticated filtered request returns 401', async () => {
    const response = await fetch(`${baseUrl}/admin/audit-log?action=VOICE_CREATED`);
    expect(response.status).toBe(401);
  });

  it('non-admin filtered request returns 403', async () => {
    const { token } = await registerAndLogin('filter-nonadmin');
    const response = await fetch(`${baseUrl}/admin/audit-log?action=VOICE_CREATED`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(403);
  });

  it('filtered responses never expose secrets', async () => {
    const { token } = await registerLoginAndPromote('filter-safety');
    await createVoice(token, 'Filter Safety Voice');
    const response = await fetch(`${baseUrl}/admin/audit-log?targetType=voice`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const text = await response.text();
    expect(text).not.toMatch(/passwordHash|password_hash|tokenHash|token_hash|DATABASE_URL|postgres:\/\//i);
  });
});
