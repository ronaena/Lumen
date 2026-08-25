/**
 * IdentityContext — the ONLY shape through which a `userId` (and, since Voice
 * Management v1, a `role`) may reach an API handler.
 *
 * This is the seam the Phase 11 architecture audit specified:
 *
 *   HTTP Request → Identity Context → trusted userId → Handler → Service → Repository
 *
 * No handler in src/api/routes ever reads a userId from a header, query param, or
 * request body. Every handler receives it exclusively through this interface, resolved
 * BEFORE the handler runs. This is what makes "never trust a client-provided userId"
 * mechanically true rather than a convention someone could forget.
 *
 * `role` is resolved server-side the exact same way, by the exact same resolver, from
 * the database — never from a client-supplied field, header, or environment variable.
 */
export interface IdentityContext {
  userId: string;
  role: 'user' | 'admin';
}

/**
 * Resolves an IdentityContext for an incoming request, or returns null if no trusted
 * identity can be established. Returning null is not an error — it is the correct,
 * honest result whenever no valid session exists.
 *
 * A resolver MUST NOT:
 *  - read a userId or role from request headers, query params, or body and trust it directly
 *  - default to a hard-coded user or role
 *  - infer identity from a bookId or any other resource identifier
 */
export type IdentityResolver = (request: {
  headers: Record<string, string | string[] | undefined>;
}) => Promise<IdentityContext | null>;
