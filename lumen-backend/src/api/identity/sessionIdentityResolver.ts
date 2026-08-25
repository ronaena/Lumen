import type { IdentityResolver } from './IdentityContext';
import type { AuthService } from '../../auth/AuthService';

function extractBearerToken(headers: Record<string, string | string[] | undefined>): string | null {
  const raw = headers['authorization'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  if (!match) return null;
  const token = match[1]?.trim();
  return token && token.length > 0 ? token : null;
}

/**
 * sessionIdentityResolver — implements the SAME IdentityResolver interface Phase 11
 * defined, unchanged. Its only inputs are the request headers; its only output is
 * { userId } or null. It never inspects a route body, never accepts a client-supplied
 * userId, and never implements ownership — that remains entirely the existing
 * repositories' job.
 *
 * Malformed/missing Authorization headers and invalid/expired session tokens all
 * resolve to null identically — the caller (ApiRouter) already turns null into the
 * existing 401 IDENTITY_UNAVAILABLE response, so there's no new response shape here.
 */
export function createSessionIdentityResolver(authService: AuthService): IdentityResolver {
  return async (request) => {
    const token = extractBearerToken(request.headers);
    if (!token) return null;

    const session = await authService.validateSession(token);
    if (!session) return null;

    return { userId: session.userId, role: session.role };
  };
}
