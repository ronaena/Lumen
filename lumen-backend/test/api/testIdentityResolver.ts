import type { IdentityResolver } from '../../src/api/identity/IdentityContext.js';

/**
 * TEST-ONLY identity injection mechanism, per the Phase 11 architectural decision §4.
 *
 * This is dependency injection for tests, not authentication:
 *  - it lives entirely in test/, never imported by anything under src/
 *  - it is never wired into the production server (src/api/server.ts always uses
 *    unauthenticatedIdentityResolver)
 *  - it does not weaken or bypass any repository/service ownership check — it only
 *    supplies the trusted userId a real auth system would supply later
 *  - it reads a header no production client is documented to send, and no production
 *    code path ever inspects
 */
export const testIdentityResolver: IdentityResolver = async (request) => {
  const header = request.headers['x-test-user-id'];
  const userId = Array.isArray(header) ? header[0] : header;
  if (!userId) return null;
  return { userId, role: 'user' };
};
