import type { Server } from 'node:http';
import type { Pool } from 'pg';
import { loadEnv } from './config/env.js';
import { createDatabaseWithPool } from './db/client.js';
import { createApiServer } from './api/server.js';
import { createSessionIdentityResolver } from './api/identity/sessionIdentityResolver.js';
import { RateLimiter } from './api/security/RateLimiter.js';
import { AuthService } from './auth/AuthService.js';
import { LocalFilesystemStorageProvider } from './processing/storage/LocalFilesystemStorageProvider.js';
import { ProviderRegistry } from './tts/ProviderRegistry.js';
import { ElevenLabsProvider } from './tts/providers/elevenlabs/ElevenLabsProvider.js';
import type { Env } from './config/env.js';
import { BookRepository } from './repositories/BookRepository.js';
import { ChapterRepository } from './repositories/ChapterRepository.js';
import { TextSegmentRepository } from './repositories/TextSegmentRepository.js';
import { VoiceRepository } from './repositories/VoiceRepository.js';
import { AudioSegmentRepository } from './repositories/AudioSegmentRepository.js';
import { NarrationAttemptRepository } from './repositories/NarrationAttemptRepository.js';
import { ProviderUsageRepository } from './repositories/ProviderUsageRepository.js';
import { ProcessingJobRepository } from './repositories/ProcessingJobRepository.js';
import { ListeningProgressRepository } from './repositories/ListeningProgressRepository.js';
import { ReadingProgressRepository } from './repositories/ReadingProgressRepository.js';
import { CharacterRepository } from './repositories/CharacterRepository.js';
import { CharacterVoiceAssignmentRepository } from './repositories/CharacterVoiceAssignmentRepository.js';
import { SceneRepository } from './repositories/SceneRepository.js';
import { UserRepository } from './repositories/UserRepository.js';
import { UserCredentialRepository } from './repositories/UserCredentialRepository.js';
import { SessionRepository } from './repositories/SessionRepository.js';
import { AdminAuditLogRepository } from './repositories/AdminAuditLogRepository.js';

/**
 * Cleanly releases every resource this process itself owns, in a safe order: stop
 * accepting new HTTP connections first, then stop the rate limiter's cleanup interval,
 * then close the database pool. Extracted as its own function (rather than inlined in
 * the signal handlers) specifically so it can be tested directly -- sending real
 * SIGTERM/SIGINT to the vitest process itself would kill the test runner, not just the
 * thing under test, so tests call this function, never a real OS signal.
 *
 * Guarded against double-invocation: a second SIGTERM/SIGINT arriving mid-shutdown must
 * not attempt to close an already-closing server/pool a second time.
 */
export function createGracefulShutdown(server: Server, pool: Pool, rateLimiter: RateLimiter) {
  let shuttingDown = false;
  return async function gracefulShutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    rateLimiter.stopCleanup();
    await pool.end();
  };
}

/**
 * Constructs the ProviderRegistry for this process. ElevenLabs is registered only when
 * ELEVENLABS_API_KEY is present -- absent, the registry is exactly as empty as it was
 * before this workstream, and every existing credential-free path is unaffected.
 * Extracted as its own function (same pattern as createGracefulShutdown) specifically so
 * tests can verify "key present -> registered" / "key absent -> empty" without going
 * through the full main() startup sequence, and without ever triggering a real network
 * call (checkAvailability() is never called here -- only registration).
 */
export function buildProviderRegistry(env: Env): ProviderRegistry {
  const registry = new ProviderRegistry();
  if (env.ELEVENLABS_API_KEY) {
    registry.register(new ElevenLabsProvider({ apiKey: env.ELEVENLABS_API_KEY }), 1);
  }
  // Google remains implemented but deliberately unwired this workstream -- see
  // ProviderRegistry.ts's module comment.
  return registry;
}

export async function main(): Promise<void> {
  const env = loadEnv();

  const { db, pool } = createDatabaseWithPool(env.DATABASE_URL);
  const storage = new LocalFilesystemStorageProvider(env.STORAGE_ROOT);
  const registry = buildProviderRegistry(env);

  const userRepo = new UserRepository(db);
  const userCredentialRepo = new UserCredentialRepository(db);
  const sessionRepo = new SessionRepository(db);
  const auditLogRepo = new AdminAuditLogRepository(db);
  const authService = new AuthService({ userRepo, userCredentialRepo, sessionRepo, auditLogRepo });

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

  const rateLimiter = new RateLimiter();
  const server = await createApiServer(deps, createSessionIdentityResolver(authService), authService, rateLimiter);

  await new Promise<void>((resolve) => server.listen(env.PORT, resolve));
  console.log(`Lumen API listening on port ${env.PORT}`);

  const shutdown = createGracefulShutdown(server, pool, rateLimiter);
  let shutdownInProgress = false;
  const handleSignal = (signal: string) => {
    if (shutdownInProgress) return;
    shutdownInProgress = true;
    console.log(`Received ${signal}, shutting down gracefully...`);
    shutdown()
      .then(() => process.exit(0))
      .catch((err) => {
        console.error('Error during shutdown:', err instanceof Error ? err.message : err);
        process.exit(1);
      });
  };
  process.on('SIGTERM', () => handleSignal('SIGTERM'));
  process.on('SIGINT', () => handleSignal('SIGINT'));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('Fatal startup error:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
