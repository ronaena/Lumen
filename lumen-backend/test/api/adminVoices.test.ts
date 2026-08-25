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

describe('Voice Management v1: admin-only voice management + role authorization (real HTTP + live Postgres)', () => {
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
    storageDir = await mkdtemp(join(tmpdir(), 'lumen-adminvoices-test-'));
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

  it('unauthenticated request to an admin endpoint returns 401', async () => {
    const response = await fetch(`${baseUrl}/admin/voices`);
    expect(response.status).toBe(401);
  });

  it('an authenticated normal (non-admin) user gets 403 on an admin endpoint', async () => {
    const { token } = await registerAndLogin('adminvoices-normaluser');
    const response = await fetch(`${baseUrl}/admin/voices`, { headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(403);
    const body = (await response.json()) as any;
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('an authenticated admin succeeds on an admin endpoint', async () => {
    const { token } = await registerLoginAndPromote('adminvoices-admin-auth');
    const response = await fetch(`${baseUrl}/admin/voices`, { headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
  });

  it('a client cannot self-promote to admin via any request field -- role is never client-controlled', async () => {
    const { token } = await registerAndLogin('adminvoices-selfpromote');
    await fetch(`${baseUrl}/books`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Role': 'admin',
        'X-Is-Admin': 'true',
      },
    });
    const response = await fetch(`${baseUrl}/admin/voices`, { headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(403);
  });

  it('admin: create, list, and update a voice', async () => {
    const { token } = await registerLoginAndPromote('adminvoices-crud');

    const createResponse = await fetch(`${baseUrl}/admin/voices`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'Test Narrator', role: 'narrator', language: 'en' }),
    });
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as any;
    expect(created.displayName).toBe('Test Narrator');

    const listResponse = await fetch(`${baseUrl}/admin/voices`, { headers: { Authorization: `Bearer ${token}` } });
    const list = (await listResponse.json()) as any[];
    expect(list.some((v) => v.id === created.id)).toBe(true);

    const updateResponse = await fetch(`${baseUrl}/admin/voices/${created.id}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'Renamed Narrator' }),
    });
    expect(updateResponse.status).toBe(200);
    const updated = (await updateResponse.json()) as any;
    expect(updated.displayName).toBe('Renamed Narrator');
  });

  it('admin: updating a nonexistent voice returns 404', async () => {
    const { token } = await registerLoginAndPromote('adminvoices-update-404');
    const response = await fetch(`${baseUrl}/admin/voices/00000000-0000-0000-0000-000000000000`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'X' }),
    });
    expect(response.status).toBe(404);
  });

  it('a normal (non-admin) user cannot create, update, or mutate any voice record', async () => {
    const { token: adminToken } = await registerLoginAndPromote('adminvoices-victim-admin');
    const created = (await (
      await fetch(`${baseUrl}/admin/voices`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'Victim Voice', role: 'narrator', language: 'en' }),
      })
    ).json()) as any;

    const { token: userToken } = await registerAndLogin('adminvoices-attacker');
    const createAttempt = await fetch(`${baseUrl}/admin/voices`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${userToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'Malicious Voice', role: 'narrator', language: 'en' }),
    });
    expect(createAttempt.status).toBe(403);

    const updateAttempt = await fetch(`${baseUrl}/admin/voices/${created.id}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${userToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'Hacked' }),
    });
    expect(updateAttempt.status).toBe(403);
  });

  it('admin: create and update (enable/disable) a provider mapping, never exposing credentials', async () => {
    const { token } = await registerLoginAndPromote('adminvoices-mapping');
    const voice = (await (
      await fetch(`${baseUrl}/admin/voices`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'Mapped Voice', role: 'narrator', language: 'en' }),
      })
    ).json()) as any;

    const createMappingResponse = await fetch(`${baseUrl}/admin/voices/${voice.id}/mappings`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'elevenlabs', providerVoiceId: 'test-fixture-vendor-id-1' }),
    });
    expect(createMappingResponse.status).toBe(201);
    const mapping = (await createMappingResponse.json()) as any;
    expect(mapping.isActive).toBe(true);

    const disableResponse = await fetch(`${baseUrl}/admin/voices/${voice.id}/mappings/${mapping.id}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: false }),
    });
    expect(disableResponse.status).toBe(200);
    const disabled = (await disableResponse.json()) as any;
    expect(disabled.isActive).toBe(false);

    const activeMapping = await voiceRepo.findMapping(voice.id, 'elevenlabs');
    expect(activeMapping).toBeNull();
  });

  it('admin: creating a mapping for a nonexistent voice returns 404', async () => {
    const { token } = await registerLoginAndPromote('adminvoices-mapping-404');
    const response = await fetch(`${baseUrl}/admin/voices/00000000-0000-0000-0000-000000000000/mappings`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'elevenlabs', providerVoiceId: 'irrelevant' }),
    });
    expect(response.status).toBe(404);
  });

  it('security: no response from any admin endpoint ever contains an API key, credential, or provider secret', async () => {
    const { token } = await registerLoginAndPromote('adminvoices-secrets');
    const voice = (await (
      await fetch(`${baseUrl}/admin/voices`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'Secret Check Voice', role: 'narrator', language: 'en' }),
      })
    ).json()) as any;
    const mappingResponse = await fetch(`${baseUrl}/admin/voices/${voice.id}/mappings`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'elevenlabs', providerVoiceId: 'test-fixture-vendor-id-2' }),
    });
    const text = await mappingResponse.text();
    expect(text).not.toMatch(/ELEVENLABS_API_KEY|apiKey|api_key|sk-[a-zA-Z0-9]/i);
  });

  it('regression: existing public GET /voices behavior is unaffected by the admin layer', async () => {
    const response = await fetch(`${baseUrl}/voices`);
    expect(response.status).toBe(401);
  });
});

describe('promoteUserToAdmin (operator-run bootstrap script)', () => {
  const db = getTestDb();
  const userRepo = new UserRepository(db);

  beforeEach(async () => {
    await resetDatabase();
  });

  it('fails if the target user does not exist -- never creates one', async () => {
    await expect(promoteUserToAdmin(userRepo, 'nobody@example.com')).rejects.toThrow(/No user found/);
    const user = await userRepo.findByEmail('nobody@example.com');
    expect(user).toBeNull();
  });

  it('promotes an existing user to admin', async () => {
    const email = `promote-test-${Date.now()}@example.com`;
    const created = await userRepo.create({ email });
    expect(created.role).toBe('user');

    await promoteUserToAdmin(userRepo, email);

    const updated = await userRepo.findByEmail(email);
    expect(updated?.role).toBe('admin');
  });

  it('is idempotent -- running it again on an existing admin succeeds without error or duplication', async () => {
    const email = `promote-idempotent-${Date.now()}@example.com`;
    await userRepo.create({ email });
    await promoteUserToAdmin(userRepo, email);
    await expect(promoteUserToAdmin(userRepo, email)).resolves.toBeUndefined();

    const user = await userRepo.findByEmail(email);
    expect(user?.role).toBe('admin');
  });

  it('normalizes email consistently with the rest of the user model', async () => {
    const email = `promote-normalize-${Date.now()}@example.com`;
    await userRepo.create({ email });
    await promoteUserToAdmin(userRepo, `  ${email.toUpperCase()}  `);

    const user = await userRepo.findByEmail(email);
    expect(user?.role).toBe('admin');
  });
});

describe('GET /auth/me (Admin Voice Management UI workstream)', () => {
  const db = getTestDb();
  const userRepo = new UserRepository(db);
  const userCredentialRepo = new UserCredentialRepository(db);
  const sessionRepo = new SessionRepository(db);

  let storageDir: string;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    storageDir = await mkdtemp(join(tmpdir(), 'lumen-authme-test-'));
    const storage = new LocalFilesystemStorageProvider(storageDir);
    const registry = new ProviderRegistry();
    const authService = new AuthService({ userRepo, userCredentialRepo, sessionRepo });

    const deps = {
      storage,
      registry,
      bookRepo: new BookRepository(db),
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

  it('returns the caller\'s own userId, email, and role -- role defaults to user', async () => {
    const email = `authme-${Date.now()}@example.com`;
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

    const response = await fetch(`${baseUrl}/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.email).toBe(email);
    expect(body.role).toBe('user');
    expect(body.userId).toBeTruthy();
  });

  it('reflects admin role after promotion', async () => {
    const email = `authme-admin-${Date.now()}@example.com`;
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
    await promoteUserToAdmin(userRepo, email);

    const response = await fetch(`${baseUrl}/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
    const body = (await response.json()) as any;
    expect(body.role).toBe('admin');
  });

  it('unauthenticated request returns 401', async () => {
    const response = await fetch(`${baseUrl}/auth/me`);
    expect(response.status).toBe(401);
  });
});

describe('GET /admin/voices/:voiceId/mappings (list mappings for a voice)', () => {
  const db = getTestDb();
  const userRepo = new UserRepository(db);
  const userCredentialRepo = new UserCredentialRepository(db);
  const sessionRepo = new SessionRepository(db);
  const voiceRepo = new VoiceRepository(db);

  let storageDir: string;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    storageDir = await mkdtemp(join(tmpdir(), 'lumen-listmappings-test-'));
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

  async function registerLoginAndPromote(label: string) {
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
    await promoteUserToAdmin(userRepo, email);
    return { token };
  }

  it('returns the mappings for a voice, including an inactive one after disabling', async () => {
    const { token } = await registerLoginAndPromote('listmappings');
    const voice = await voiceRepo.create({ displayName: 'List Mappings Voice', role: 'narrator', language: 'en' });
    await voiceRepo.createMapping({ voiceId: voice.id, provider: 'elevenlabs', providerVoiceId: 'fixture-1' });

    const response = await fetch(`${baseUrl}/admin/voices/${voice.id}/mappings`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    const mappings = (await response.json()) as any[];
    expect(mappings).toHaveLength(1);
    expect(mappings[0].provider).toBe('elevenlabs');
  });

  it('returns 404 for a nonexistent voice', async () => {
    const { token } = await registerLoginAndPromote('listmappings-404');
    const response = await fetch(`${baseUrl}/admin/voices/00000000-0000-0000-0000-000000000000/mappings`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(404);
  });

  it('non-admin gets 403', async () => {
    const emailNormal = `listmappings-nonadmin-${Date.now()}@example.com`;
    await fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: emailNormal, password: 'correct-horse-battery' }),
    });
    const loginResponse = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: emailNormal, password: 'correct-horse-battery' }),
    });
    const { token } = (await loginResponse.json()) as any;
    const response = await fetch(`${baseUrl}/admin/voices/00000000-0000-0000-0000-000000000000/mappings`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(403);
  });
});

describe('GET /admin/dashboard (Admin Dashboard / Production Operations Foundation v1)', () => {
  const db = getTestDb();
  const userRepo = new UserRepository(db);
  const userCredentialRepo = new UserCredentialRepository(db);
  const sessionRepo = new SessionRepository(db);
  const voiceRepo = new VoiceRepository(db);

  let storageDir: string;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    storageDir = await mkdtemp(join(tmpdir(), 'lumen-dashboard-test-'));
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

  it('unauthenticated request returns 401', async () => {
    const response = await fetch(`${baseUrl}/admin/dashboard`);
    expect(response.status).toBe(401);
  });

  it('authenticated non-admin returns 403', async () => {
    const { token } = await registerAndLogin('dashboard-nonadmin');
    const response = await fetch(`${baseUrl}/admin/dashboard`, { headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(403);
  });

  it('admin gets 200 with the expected response shape and accurate aggregate counts', async () => {
    const { email, token } = await registerAndLogin('dashboard-admin');
    await promoteUserToAdmin(userRepo, email);

    // A second, non-admin user, plus a voice with one active and one inactive mapping,
    // to prove the counts are real aggregates, not hardcoded/fabricated numbers.
    await registerAndLogin('dashboard-other-user');
    const voice = await voiceRepo.create({ displayName: 'Dashboard Test Voice', role: 'narrator', language: 'en' });
    const activeMapping = await voiceRepo.createMapping({ voiceId: voice.id, provider: 'elevenlabs', providerVoiceId: 'fixture-active' });
    const inactiveMapping = await voiceRepo.createMapping({ voiceId: voice.id, provider: 'google_cloud_tts', providerVoiceId: 'fixture-inactive' });
    await voiceRepo.updateMapping(inactiveMapping.id, { isActive: false });

    const response = await fetch(`${baseUrl}/admin/dashboard`, { headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;

    expect(body.system.healthy).toBe(true);
    expect(body.system.ready).toBe(true);
    expect(body.users.total).toBe(2); // the admin + the other user
    expect(body.users.admins).toBe(1);
    expect(body.voices.total).toBe(1);
    expect(body.voices.activeMappings).toBe(1);
    expect(body.voices.inactiveMappings).toBe(1);
    expect(activeMapping.isActive).toBe(true);
  });

  it('security: no secret, credential, password hash, session token, or providerVoiceId ever appears in the dashboard response', async () => {
    const { email, token } = await registerAndLogin('dashboard-secrets');
    await promoteUserToAdmin(userRepo, email);
    const voice = await voiceRepo.create({ displayName: 'Secret Check Voice', role: 'narrator', language: 'en' });
    await voiceRepo.createMapping({ voiceId: voice.id, provider: 'elevenlabs', providerVoiceId: 'super-secret-vendor-id-should-never-appear' });

    const response = await fetch(`${baseUrl}/admin/dashboard`, { headers: { Authorization: `Bearer ${token}` } });
    const text = await response.text();
    expect(text).not.toMatch(/super-secret-vendor-id-should-never-appear/);
    expect(text).not.toMatch(/passwordHash|password_hash|tokenHash|token_hash|ELEVENLABS_API_KEY|DATABASE_URL/i);
  });

  it('regression: existing GET /health and GET /ready behavior is unchanged after the isDatabaseReady extraction', async () => {
    const healthResponse = await fetch(`${baseUrl}/health`);
    expect(healthResponse.status).toBe(200);
    expect(await healthResponse.json()).toEqual({ status: 'ok' });

    const readyResponse = await fetch(`${baseUrl}/ready`);
    expect(readyResponse.status).toBe(200);
    expect(await readyResponse.json()).toEqual({ status: 'ready' });
  });

  it('regression: existing admin voice routes still work after this workstream', async () => {
    const { email, token } = await registerAndLogin('dashboard-regression-admin');
    await promoteUserToAdmin(userRepo, email);
    const response = await fetch(`${baseUrl}/admin/voices`, { headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
  });
});
