import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { ApiRouter } from './http/ApiRouter';
import type { IdentityResolver } from './identity/IdentityContext';
import type { ApiDeps } from './ApiDeps';
import type { AuthService } from '../auth/AuthService';
import { RateLimiter } from './security/RateLimiter';
import { reconcileOrphanedWork } from '../narration/reconcileOrphanedWork';
import { handleIngestBook, handleGetBook, handleListBooks } from './routes/books';
import { handleTriggerJob, handleGetJob } from './routes/jobs';
import {
  handleUpdateListeningProgress,
  handleGetListeningProgress,
  handleUpdateReadingProgress,
  handleGetReadingProgress,
} from './routes/progress';
import {
  handleCreateCharacter,
  handleAssignCharacterVoice,
  handleAssignSegmentToCharacter,
  handleListCharacters,
} from './routes/characters';
import { handleCreateScene, handleListScenes, handleGetScene, handleUpdateSceneDirection } from './routes/scenes';
import { handleListChapters, handleListSegments } from './routes/content';
import { handleGetAudio } from './routes/audio';
import { handleListVoices } from './routes/voices';
import { handleLiveness, handleReadiness } from './routes/health';
import {
  handleListAllVoices,
  handleCreateVoice,
  handleUpdateVoice,
  handleListMappingsForVoice,
  handleCreateMapping,
  handleUpdateMapping,
} from './routes/adminVoices';
import {
  handleRegister,
  handleLogin,
  handleLogout,
  handleLogoutAll,
  handleChangePassword,
  handleGetCurrentUser,
} from './routes/auth';
import { handleAdminDashboard } from './routes/adminDashboard';
import { handleListUsers, handleGetUser, handleChangeUserRole, handleChangeUserStatus } from './routes/adminUsers';
import { handleListAuditLog } from './routes/adminAuditLog';

/**
 * Builds the full route table. `authService` is required as of Phase 12 — the three
 * /auth/* routes are always registered, regardless of which IdentityResolver is passed
 * for the rest of the API (production uses sessionIdentityResolver backed by this same
 * authService; tests may use a test-only resolver for the non-auth routes while still
 * exercising the real register/login/logout flow through these same handlers).
 *
 * `rateLimiter` is optional and defaults to a real-clock RateLimiter — tests may inject
 * one with a fake clock (Workstream 13B) to avoid waiting real minutes for window resets.
 */
export function createApiRouter(
  deps: ApiDeps,
  identityResolver: IdentityResolver,
  authService: AuthService,
  rateLimiter: RateLimiter = new RateLimiter(),
  notFoundFallback?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>,
): ApiRouter {
  const router = new ApiRouter(identityResolver, rateLimiter, notFoundFallback);

  // Public — cannot require a pre-existing session by definition.
  router.register('GET', '/health', (req) => handleLiveness(deps, req), { public: true });
  router.register('GET', '/ready', (req) => handleReadiness(deps, req), { public: true });

  router.register('POST', '/auth/register', (req) => handleRegister(authService, req), {
    public: true,
    rateLimit: { category: 'auth-register', maxRequests: 5, windowMs: 15 * 60 * 1000 },
  });
  router.register('POST', '/auth/login', (req) => handleLogin(authService, req), {
    public: true,
    rateLimit: { category: 'auth-login', maxRequests: 10, windowMs: 15 * 60 * 1000 },
  });
  // Protected — requires an already-valid session to log out of.
  router.register('POST', '/auth/logout', (req) => handleLogout(authService, req));
  router.register('POST', '/auth/logout-all', (req) => handleLogoutAll(authService, req));
  router.register('PUT', '/auth/password', (req) => handleChangePassword(authService, req), {
    rateLimit: { category: 'auth-password', maxRequests: 10, windowMs: 15 * 60 * 1000 },
  });
  router.register('GET', '/auth/me', (req) => handleGetCurrentUser(authService, req));
  router.register('GET', '/admin/dashboard', (req) => handleAdminDashboard(deps, authService, req), { adminOnly: true });
  router.register('GET', '/admin/users', (req) => handleListUsers(authService, req), { adminOnly: true });
  router.register('GET', '/admin/users/:userId', (req) => handleGetUser(authService, req), { adminOnly: true });
  router.register('PATCH', '/admin/users/:userId/role', (req) => handleChangeUserRole(authService, req), { adminOnly: true });
  router.register('PATCH', '/admin/users/:userId/status', (req) => handleChangeUserStatus(authService, req), {
    adminOnly: true,
  });
  router.register('GET', '/admin/audit-log', (req) => handleListAuditLog(authService, req), { adminOnly: true });

  router.register('POST', '/books', (req) => handleIngestBook(deps, req));
  router.register('GET', '/books', (req) => handleListBooks(deps, req));
  router.register('GET', '/books/:bookId', (req) => handleGetBook(deps, req));
  router.register('GET', '/books/:bookId/chapters', (req) => handleListChapters(deps, req));
  router.register('GET', '/chapters/:chapterId/segments', (req) => handleListSegments(deps, req));

  router.register('POST', '/books/:bookId/jobs', (req) => handleTriggerJob(deps, req));
  router.register('GET', '/books/:bookId/jobs/:jobId', (req) => handleGetJob(deps, req));

  router.register('PUT', '/books/:bookId/progress/listening', (req) => handleUpdateListeningProgress(deps, req));
  router.register('GET', '/books/:bookId/progress/listening', (req) => handleGetListeningProgress(deps, req));
  router.register('PUT', '/books/:bookId/progress/reading', (req) => handleUpdateReadingProgress(deps, req));
  router.register('GET', '/books/:bookId/progress/reading', (req) => handleGetReadingProgress(deps, req));

  router.register('POST', '/books/:bookId/characters', (req) => handleCreateCharacter(deps, req));
  router.register('GET', '/books/:bookId/characters', (req) => handleListCharacters(deps, req));
  router.register('PUT', '/characters/:characterId/voice', (req) => handleAssignCharacterVoice(deps, req));
  router.register('PUT', '/segments/:textSegmentId/character', (req) => handleAssignSegmentToCharacter(deps, req));
  router.register('GET', '/segments/:textSegmentId/audio', (req) => handleGetAudio(deps, req));
  router.register('GET', '/voices', (req) => handleListVoices(deps, req));

  router.register('GET', '/admin/voices', (req) => handleListAllVoices(deps, req), { adminOnly: true });
  router.register('POST', '/admin/voices', (req) => handleCreateVoice(deps, authService.getAuditLogRepo(), req), {
    adminOnly: true,
  });
  router.register('PUT', '/admin/voices/:voiceId', (req) => handleUpdateVoice(deps, authService.getAuditLogRepo(), req), {
    adminOnly: true,
  });
  router.register('GET', '/admin/voices/:voiceId/mappings', (req) => handleListMappingsForVoice(deps, req), { adminOnly: true });
  router.register('POST', '/admin/voices/:voiceId/mappings', (req) => handleCreateMapping(deps, authService.getAuditLogRepo(), req), {
    adminOnly: true,
  });
  router.register(
    'PUT',
    '/admin/voices/:voiceId/mappings/:mappingId',
    (req) => handleUpdateMapping(deps, authService.getAuditLogRepo(), req),
    { adminOnly: true },
  );

  router.register('POST', '/chapters/:chapterId/scenes', (req) => handleCreateScene(deps, req));
  router.register('GET', '/chapters/:chapterId/scenes', (req) => handleListScenes(deps, req));
  router.register('GET', '/scenes/:sceneId', (req) => handleGetScene(deps, req));
  router.register('PUT', '/scenes/:sceneId/direction', (req) => handleUpdateSceneDirection(deps, req));

  return router;
}

/**
 * Startup lifecycle: reconcile orphaned processing state (Workstream 13D) BEFORE the
 * server is constructed/ready to accept requests — the server must never accept traffic
 * against a potentially inconsistent processing state. reconcileOrphanedWork() throws
 * on an unexpected repository/database error rather than swallowing it, which is what
 * makes `createApiServer` correctly reject (fail startup) instead of silently
 * proceeding — no logging framework exists in this project (consistent with every prior
 * workstream's decision not to introduce one), so this failure mode is "the returned
 * Promise rejects," not a logged-and-continued warning.
 */
export async function createApiServer(
  deps: ApiDeps,
  identityResolver: IdentityResolver,
  authService: AuthService,
  rateLimiter: RateLimiter = new RateLimiter(),
  notFoundFallback?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>,
): Promise<Server> {
  await reconcileOrphanedWork({ narrationAttemptRepo: deps.narrationAttemptRepo, jobRepo: deps.jobRepo });

  const router = createApiRouter(deps, identityResolver, authService, rateLimiter, notFoundFallback);
  rateLimiter.startCleanup();
  return createServer((req, res) => {
    router.handle(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.' } }));
      }
    });
  });
}
