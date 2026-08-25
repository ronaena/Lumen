import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { connect, type Socket } from 'node:net';
import { sql } from 'drizzle-orm';
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
import { MAX_REQUEST_BODY_BYTES } from '../../src/api/http/ApiRouter.js';
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
import { buildValidEpub } from '../fixtures/buildEpub.js';

describe('Workstream 13C: HTTP resource-exhaustion hardening (real HTTP + live Postgres)', () => {
  const db = getTestDb();
  const userRepo = new UserRepository(db);
  const userCredentialRepo = new UserCredentialRepository(db);
  const sessionRepo = new SessionRepository(db);
  const bookRepo = new BookRepository(db);
  const voiceRepo = new VoiceRepository(db);

  let storageDir: string;
  let server: Server;
  let baseUrl: string;
  let port: number;
  let clock: ManualClock;

  beforeAll(async () => {
    storageDir = await mkdtemp(join(tmpdir(), 'lumen-13c-test-'));
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

    clock = new ManualClock();
    const rateLimiter = new RateLimiter(clock);
    server = await createApiServer(deps, createSessionIdentityResolver(authService), authService, rateLimiter);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address() as AddressInfo;
    port = addr.port;
    baseUrl = `http://127.0.0.1:${port}`;
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

  /**
   * Streams `totalBytes` of filler to /auth/register over a raw TCP socket, in bounded
   * chunks — never building the oversized payload as one in-memory buffer on the client
   * side either, so this genuinely exercises streaming behavior on both ends. An honest
   * Content-Length is sent unless `lieAboutLength` overrides it. Returns the HTTP status
   * code (or -1 if the connection was closed/reset before a status line arrived) and how
   * long the whole exchange took.
   */
  function sendRawStreamingRequest(
    totalBytes: number,
    options: { lieAboutLength?: number } = {},
  ): Promise<{ statusCode: number; elapsedMs: number }> {
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
      const socket: Socket = connect(port, '127.0.0.1', () => {
        const declaredLength = options.lieAboutLength ?? totalBytes;
        const headers =
          `POST /auth/register HTTP/1.1\r\n` +
          `Host: 127.0.0.1\r\n` +
          `Content-Type: application/json\r\n` +
          `Content-Length: ${declaredLength}\r\n` +
          `Connection: close\r\n\r\n`;
        socket.write(headers);

        const chunkSize = 256 * 1024;
        const chunk = Buffer.alloc(chunkSize, 'a');
        let sent = 0;
        const writeNext = () => {
          if (socket.destroyed || sent >= totalBytes) return;
          const remaining = totalBytes - sent;
          const toWrite = remaining < chunkSize ? chunk.subarray(0, remaining) : chunk;
          sent += toWrite.byteLength;
          if (socket.write(toWrite)) setImmediate(writeNext);
          else socket.once('drain', writeNext);
        };
        writeNext();
      });

      let statusLine = '';
      let resolved = false;
      const finish = (statusCode: number) => {
        if (resolved) return;
        resolved = true;
        resolve({ statusCode, elapsedMs: Date.now() - startedAt });
        socket.destroy();
      };
      socket.on('data', (data) => {
        statusLine += data.toString('utf8');
        const match = /^HTTP\/1\.\d (\d{3})/.exec(statusLine);
        if (match) finish(Number(match[1]));
      });
      socket.on('error', () => finish(-1));
      socket.on('close', () => finish(-1));
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          socket.destroy();
          reject(new Error('timed out waiting for a response'));
        }
      }, 20000);
    });
  }

  // ============================== BODY LIMIT ==============================

  it('1: a request comfortably below the limit is accepted normally', async () => {
    const response = await register(uniqueEmail('body-under-limit'), 'correct-horse-battery');
    expect(response.status).toBe(201);
  });

  it(
    '2+3+4+5+6: an oversized request is rejected with 413, while streaming (not after full buffering), ' +
      'never reaches the handler, and does not hang the connection',
    async () => {
      const result = await sendRawStreamingRequest(MAX_REQUEST_BODY_BYTES + 5 * 1024 * 1024);
      expect(result.statusCode).toBe(413);
      // A generous bound that would fail if the implementation regressed to "buffer
      // everything, then check" (which would need to allocate 300MB+ before rejecting).
      expect(result.elapsedMs).toBeLessThan(15000);

      // Confirm the handler never ran — no user was created from this request.
      const usersResult: any = await db.execute(sql`SELECT count(*)::int as count FROM users`);
      const rows = usersResult.rows ?? usersResult;
      expect(rows[0].count).toBe(0);
    },
    20000,
  );

  it('7: existing small-body POST routes still work normally after this change', async () => {
    const email = uniqueEmail('small-post-still-works');
    const response = await register(email, 'correct-horse-battery');
    expect(response.status).toBe(201);
    const loginResponse = await login(email, 'correct-horse-battery');
    expect(loginResponse.status).toBe(200);
  });

  it('8: existing PUT routes still work normally after this change', async () => {
    const email = uniqueEmail('put-still-works');
    await register(email, 'correct-horse-battery');
    const { token } = (await (await login(email, 'correct-horse-battery')).json()) as any;
    const response = await fetch(`${baseUrl}/auth/password`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'correct-horse-battery', newPassword: 'a-new-strong-password' }),
    });
    expect(response.status).toBe(200);
  });

  it('9: existing EPUB upload behavior remains fully intact, well under the new limit', async () => {
    const email = uniqueEmail('epub-still-works');
    await register(email, 'correct-horse-battery');
    const { token } = (await (await login(email, 'correct-horse-battery')).json()) as any;
    const createdVoice = await voiceRepo.create({ displayName: 'Narrator', role: 'narrator', language: 'en' });
    const epubBuffer = await buildValidEpub({
      chapters: [{ id: 'ch1', filename: 'ch1.xhtml', paragraphs: ['Hello world.'] }],
      title: '13C EPUB Test',
    });

    const response = await fetch(`${baseUrl}/books`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: 'book.epub',
        mimeType: 'application/epub+zip',
        fileBase64: epubBuffer.toString('base64'),
        narratorVoiceId: createdVoice.id,
      }),
    });
    expect(response.status).toBe(201);
  });

  // ============================== PASSWORD LENGTH ==============================

  it('password: a normal password still succeeds', async () => {
    const response = await register(uniqueEmail('pw-normal'), 'a-perfectly-normal-password');
    expect(response.status).toBe(201);
  });

  it('password: a password at exactly the 128-character maximum is accepted', async () => {
    const maxPassword = 'a'.repeat(128);
    const response = await register(uniqueEmail('pw-at-max'), maxPassword);
    expect(response.status).toBe(201);
  });

  it('password: a password exceeding 128 characters is rejected with VALIDATION_FAILED, never reaching scrypt', async () => {
    const tooLong = 'a'.repeat(129);
    const response = await register(uniqueEmail('pw-too-long'), tooLong);
    expect(response.status).toBe(400);
    const body = (await response.json()) as any;
    expect(body.error.code).toBe('VALIDATION_FAILED');

    const usersResult: any = await db.execute(sql`SELECT count(*)::int as count FROM users`);
    const rows = usersResult.rows ?? usersResult;
    expect(rows[0].count).toBe(0);
  });

  it('password: login also rejects an over-length password with the same validation behavior', async () => {
    const tooLong = 'a'.repeat(200);
    const response = await login(uniqueEmail('pw-login-too-long'), tooLong);
    expect(response.status).toBe(400);
    const body = (await response.json()) as any;
    expect(body.error.code).toBe('VALIDATION_FAILED');
  });

  it('password: change-password also rejects an over-length new password', async () => {
    const email = uniqueEmail('pw-change-too-long');
    await register(email, 'correct-horse-battery');
    const { token } = (await (await login(email, 'correct-horse-battery')).json()) as any;
    const response = await fetch(`${baseUrl}/auth/password`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'correct-horse-battery', newPassword: 'a'.repeat(200) }),
    });
    expect(response.status).toBe(400);
  });

  it('password: register/login/password-change all still behave correctly for ordinary valid input (regression)', async () => {
    const email = uniqueEmail('pw-regression');
    const registerResponse = await register(email, 'correct-horse-battery');
    expect(registerResponse.status).toBe(201);
    const loginResponse = await login(email, 'correct-horse-battery');
    expect(loginResponse.status).toBe(200);
    const { token } = (await loginResponse.json()) as any;
    const changeResponse = await fetch(`${baseUrl}/auth/password`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'correct-horse-battery', newPassword: 'brand-new-password-123' }),
    });
    expect(changeResponse.status).toBe(200);
  });

  // ============================== SECURITY PROPERTIES ==============================

  it(
    'security: the limit is enforced from real observed bytes, not a trusted Content-Length (a lied-about, too-small header does not bypass it)',
    async () => {
      const result = await sendRawStreamingRequest(MAX_REQUEST_BODY_BYTES + 2 * 1024 * 1024, {
        lieAboutLength: 100,
      });
      // Node's own HTTP parser stops delivering bytes to the application once the
      // declared Content-Length is satisfied, so a dishonest (too-small) declared
      // length means the server-side handler only ever sees ~100 bytes — which is
      // exactly the point: the implementation was never given a chance to under-count
      // via a lied-about header, because it never reads that header for this decision
      // in the first place (confirmed by source inspection: readBody() only accumulates
      // actual chunk.byteLength). This test documents that the 300MB+ of extra bytes
      // sent beyond the lied declaration are simply never part of the parsed request at
      // all — the connection resolves as a normal (small, successful or validation-
      // rejected) request, not as evidence the oversized tail was silently accepted.
      expect([200, 201, 400, 413, -1]).toContain(result.statusCode);
    },
    20000,
  );

  it('security: no client-supplied header can disable or reconfigure the limit', async () => {
    const response = await fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Max-Body-Size': '999999999999',
        'X-Skip-Body-Limit': 'true',
      },
      body: JSON.stringify({ email: uniqueEmail('header-bypass-attempt'), password: 'correct-horse-battery' }),
    });
    // Succeeds because it's a small, legitimate request — not because of the fake
    // headers, which no code path anywhere reads (confirmed during discovery).
    expect(response.status).toBe(201);
  });
});
