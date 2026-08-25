import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestDb } from '../db/setup.js';
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
import { createDatabaseWithPool } from '../../src/db/client.js';

const REAL_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://lumen:lumen@localhost:5432/lumen_test';

async function buildDeps(db: ReturnType<typeof getTestDb>) {
  return {
    storage: new LocalFilesystemStorageProvider(await mkdtemp(join(tmpdir(), 'lumen-health-test-'))),
    registry: new ProviderRegistry(),
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
}

describe('GET /health and GET /ready (real HTTP + live Postgres)', () => {
  const db = getTestDb();
  const userRepo = new UserRepository(db);
  const userCredentialRepo = new UserCredentialRepository(db);
  const sessionRepo = new SessionRepository(db);

  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const deps = await buildDeps(db);
    const authService = new AuthService({ userRepo, userCredentialRepo, sessionRepo });
    server = await createApiServer(deps, createSessionIdentityResolver(authService), authService);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('liveness: succeeds with a minimal, non-sensitive 200 response', async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ status: 'ok' });
  });

  it('liveness: requires no authentication', async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
  });

  it('readiness: succeeds with a minimal 200 response when the database is reachable', async () => {
    const response = await fetch(`${baseUrl}/ready`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ status: 'ready' });
  });

  it('readiness: requires no authentication', async () => {
    const response = await fetch(`${baseUrl}/ready`);
    expect(response.status).toBe(200);
  });

  it('neither endpoint exposes secrets, filesystem paths, stack traces, or dependency versions', async () => {
    const healthText = await (await fetch(`${baseUrl}/health`)).text();
    const readyText = await (await fetch(`${baseUrl}/ready`)).text();
    for (const text of [healthText, readyText]) {
      expect(text).not.toMatch(/postgres:\/\/|DATABASE_URL|node_modules|\/home\/|version|dependencies/i);
    }
  });

  it('regression: normal authenticated routes remain unaffected -- GET /books still requires auth', async () => {
    const response = await fetch(`${baseUrl}/books`);
    expect(response.status).toBe(401);
  });
});

describe('GET /ready — database-unavailable behavior (real Postgres, deliberately broken connection)', () => {
  it('returns a generic 503 when the database becomes unreachable after a successful startup, never the raw error', async () => {
    const { db, pool } = createDatabaseWithPool(REAL_DATABASE_URL);
    const deps = await buildDeps(db);
    const userRepo = new UserRepository(db);
    const userCredentialRepo = new UserCredentialRepository(db);
    const sessionRepo = new SessionRepository(db);
    const authService = new AuthService({ userRepo, userCredentialRepo, sessionRepo });

    // Startup succeeds normally against a genuinely working connection (this is the
    // realistic scenario a readiness probe protects against: the DB was fine at boot
    // and later became unreachable, not that it was broken from the very first request).
    const server = await createApiServer(deps, createSessionIdentityResolver(authService), authService);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address() as AddressInfo;

    try {
      const healthyResponse = await fetch(`http://127.0.0.1:${addr.port}/ready`);
      expect(healthyResponse.status).toBe(200);

      // Now break the connection the readiness probe depends on.
      await pool.end();

      const response = await fetch(`http://127.0.0.1:${addr.port}/ready`);
      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body).toEqual({ status: 'not_ready' });
      const text = JSON.stringify(body);
      expect(text).not.toMatch(/ECONNREFUSED|Pool|node_modules|at new|stack/i);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
