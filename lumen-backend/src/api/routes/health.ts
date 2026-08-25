import type { ApiRequest, ApiResponse } from '../http/ApiRouter';
import type { ApiDeps } from '../ApiDeps';

/**
 * GET /health — liveness. Proves only that the HTTP server itself is alive and routing
 * requests. No database call, no auth, no dependency on anything downstream — if this
 * handler runs at all, the answer is definitionally "ok". Never exposes secrets,
 * filesystem paths, environment variables, or dependency versions.
 */
export async function handleLiveness(_deps: ApiDeps, _req: ApiRequest): Promise<ApiResponse> {
  return { status: 200, body: { status: 'ok' } };
}

// A fixed, harmless, definitely-nonexistent UUID used only as a cheap DB-connectivity
// probe -- listByUser on a real-but-unmatched id is a genuine, already-tested,
// already-safe indexed query (see BookRepository), so this adds zero new query surface
// and zero ApiDeps interface change to get a real readiness signal.
const READINESS_PROBE_USER_ID = '00000000-0000-0000-0000-000000000000';

/**
 * The actual DB-connectivity check, extracted so both GET /ready and the admin
 * dashboard (Admin Dashboard v1) share exactly one implementation -- never duplicated.
 */
export async function isDatabaseReady(deps: ApiDeps): Promise<boolean> {
  try {
    await deps.bookRepo.listByUser(READINESS_PROBE_USER_ID);
    return true;
  } catch {
    return false;
  }
}

/**
 * GET /ready — readiness. Verifies the one dependency actually required to serve
 * requests: the database. Deliberately does NOT check TTS provider availability (no
 * ElevenLabs/Google call, no credential requirement) -- provider absence is already a
 * normal, expected, non-failing state (empty ProviderRegistry), not a readiness failure.
 * On DB failure, returns a generic 503 -- the raw error/connection string/stack trace is
 * never included in the response, matching the same safe-error discipline used
 * throughout the rest of the API.
 */
export async function handleReadiness(deps: ApiDeps, _req: ApiRequest): Promise<ApiResponse> {
  const ready = await isDatabaseReady(deps);
  if (ready) {
    return { status: 200, body: { status: 'ready' } };
  }
  return { status: 503, body: { status: 'not_ready' } };
}
