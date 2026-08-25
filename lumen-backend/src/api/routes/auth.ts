import { z } from 'zod';
import type { ApiRequest, ApiResponse } from '../http/ApiRouter';
import type { AuthService } from '../../auth/AuthService';
import { mapErrorToHttp, VALIDATION_FAILED } from '../errors/mapErrorToHttp';

const MIN_PASSWORD_LENGTH = 8;
// Approved Workstream 13C bound: comfortably above any legitimate password, low enough
// to prevent an attacker from forcing scrypt (deliberately CPU/memory-expensive) to run
// against a pathologically long input.
const MAX_PASSWORD_LENGTH = 128;

const RegisterBody = z.object({
  email: z.string().email(),
  password: z
    .string()
    .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`)
    .max(MAX_PASSWORD_LENGTH, `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`),
});

const LoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH, `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`),
});

const ChangePasswordBody = z.object({
  currentPassword: z
    .string()
    .min(1)
    .max(MAX_PASSWORD_LENGTH, `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`),
  newPassword: z
    .string()
    .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`)
    .max(MAX_PASSWORD_LENGTH, `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`),
});

export async function handleRegister(authService: AuthService, req: ApiRequest): Promise<ApiResponse> {
  const parsed = RegisterBody.safeParse(req.body);
  if (!parsed.success) {
    return { status: 400, body: VALIDATION_FAILED(parsed.error.message).body };
  }
  try {
    const user = await authService.register(parsed.data);
    // Never returns password/passwordHash/salt/session internals — only safe profile fields.
    return { status: 201, body: { id: user.id, email: user.email, createdAt: user.createdAt } };
  } catch (error) {
    return mapErrorToHttp(error);
  }
}

export async function handleLogin(authService: AuthService, req: ApiRequest): Promise<ApiResponse> {
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) {
    return { status: 400, body: VALIDATION_FAILED(parsed.error.message).body };
  }
  try {
    const { token, expiresAt } = await authService.login(parsed.data);
    return { status: 200, body: { token, expiresAt } };
  } catch (error) {
    return mapErrorToHttp(error);
  }
}

export async function handleLogout(authService: AuthService, req: ApiRequest): Promise<ApiResponse> {
  // This route is identity-gated (not public), so req.identity is guaranteed non-null by
  // the router — a valid session was already required to reach this handler. The raw
  // token itself (needed to know WHICH session to delete) comes from the Authorization
  // header the router already extracted, never from IdentityContext.
  const header = req.authorizationHeader;
  const match = header ? /^Bearer\s+(.+)$/i.exec(header.trim()) : null;
  const token = match?.[1]?.trim();
  if (token) {
    await authService.logout(token);
  }
  return { status: 200, body: { loggedOut: true } };
}

export async function handleLogoutAll(authService: AuthService, req: ApiRequest): Promise<ApiResponse> {
  // Ownership here is trivial by construction: there is no target userId in the request
  // at all — only req.identity!.userId (server-resolved) ever reaches logoutAll(), so
  // there is no client-controlled field that could select a different user's sessions.
  await authService.logoutAll(req.identity!.userId);
  return { status: 200, body: { loggedOut: true } };
}

export async function handleChangePassword(authService: AuthService, req: ApiRequest): Promise<ApiResponse> {
  const parsed = ChangePasswordBody.safeParse(req.body);
  if (!parsed.success) {
    return { status: 400, body: VALIDATION_FAILED(parsed.error.message).body };
  }
  try {
    await authService.changePassword(req.identity!.userId, parsed.data.currentPassword, parsed.data.newPassword);
    return { status: 200, body: { passwordChanged: true } };
  } catch (error) {
    return mapErrorToHttp(error);
  }
}

/**
 * GET /auth/me — Admin Voice Management UI workstream. Lets a logged-in client learn
 * its own role (needed to decide whether to show the admin nav), without changing the
 * existing login response shape. Identity-gated, not adminOnly -- any authenticated
 * user may see their own identity, never anyone else's (req.identity!.userId is the
 * only input, exactly like handleLogoutAll above).
 */
export async function handleGetCurrentUser(authService: AuthService, req: ApiRequest): Promise<ApiResponse> {
  const user = await authService.getUserById(req.identity!.userId);
  if (!user) return { status: 404, body: { error: { code: 'NOT_FOUND', message: 'Resource not found.' } } };
  return { status: 200, body: user };
}
