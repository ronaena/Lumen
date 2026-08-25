import type { IdentityResolver } from './IdentityContext.js';

/**
 * UnauthenticatedIdentityResolver — the ONLY identity resolver wired into the real
 * production server (see src/api/server.ts). It always returns null.
 *
 * This is not a stub awaiting a TODO — it is the correct, honest behavior for this
 * phase: authentication does not exist yet, so no real HTTP request can ever establish
 * a trusted identity, and every ownership-protected route will correctly respond as
 * "identity unavailable" until a future authentication phase supplies a real resolver
 * that implements this same IdentityResolver contract.
 *
 * Swapping in real authentication later means writing one new resolver against this
 * interface and changing which resolver src/api/server.ts is constructed with — no
 * route handler, service, or repository changes.
 */
export const unauthenticatedIdentityResolver: IdentityResolver = async () => null;
