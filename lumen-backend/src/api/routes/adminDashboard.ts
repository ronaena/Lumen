import type { ApiRequest, ApiResponse } from '../http/ApiRouter';
import type { ApiDeps } from '../ApiDeps';
import type { AuthService } from '../../auth/AuthService';
import { isDatabaseReady } from './health';

/**
 * GET /admin/dashboard — Admin Dashboard / Production Operations Foundation v1.
 * Read-only aggregate operational overview. Reuses isDatabaseReady (the exact same
 * check GET /ready uses) rather than duplicating the DB-connectivity probe, and reuses
 * AuthService.getUserCounts()/VoiceRepository.getCounts() -- no new repository layer,
 * no analytics framework, no raw SQL.
 *
 * authService is passed as a separate parameter, not added to ApiDeps -- matching the
 * exact existing pattern every other auth handler already uses. createApiServer never
 * constructs userRepo standalone; only authService (which wraps it) is passed in from
 * main.ts/tests, so this handler goes through authService rather than requiring a
 * signature change to createApiServer or every test file that calls it.
 *
 * Every field here is an aggregate count or a boolean -- never an individual user row,
 * email, password hash, session token, provider credential, or providerVoiceId.
 * Confirmed by construction: this handler never selects individual rows from users or
 * voice_provider_mappings.
 */
export async function handleAdminDashboard(deps: ApiDeps, authService: AuthService, _req: ApiRequest): Promise<ApiResponse> {
  const [ready, userCounts, voiceCounts] = await Promise.all([
    isDatabaseReady(deps),
    authService.getUserCounts(),
    deps.voiceRepo.getCounts(),
  ]);

  return {
    status: 200,
    body: {
      system: {
        healthy: true,
        ready,
      },
      users: {
        total: userCounts.total,
        admins: userCounts.admins,
      },
      voices: {
        total: voiceCounts.totalVoices,
        activeMappings: voiceCounts.activeMappings,
        inactiveMappings: voiceCounts.inactiveMappings,
      },
    },
  };
}
