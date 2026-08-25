import { z } from 'zod';
import type { ApiRequest, ApiResponse } from '../http/ApiRouter';
import type { AuthService } from '../../auth/AuthService';
import { mapErrorToHttp, VALIDATION_FAILED, NOT_FOUND } from '../errors/mapErrorToHttp';

/**
 * Admin-only user management (Admin User Management v1, approved workstream). Every
 * handler here is registered with { adminOnly: true } in server.ts -- authorization
 * enforcement lives in exactly one place (ApiRouter.handle()), never duplicated here.
 *
 * authService (not a raw UserRepository) is the sole gateway to user data from this
 * layer, matching the exact pattern established by /auth/me and /admin/dashboard --
 * self/last-admin protection logic lives once, in AuthService, not scattered across
 * these handlers.
 */

const RoleBody = z.object({ role: z.enum(['user', 'admin']) });
const StatusBody = z.object({ disabled: z.boolean() });

export async function handleListUsers(authService: AuthService, _req: ApiRequest): Promise<ApiResponse> {
  const users = await authService.listUsersForAdmin();
  return { status: 200, body: users };
}

export async function handleGetUser(authService: AuthService, req: ApiRequest): Promise<ApiResponse> {
  const user = await authService.getUserForAdmin(req.params.userId!);
  if (!user) return NOT_FOUND;
  return { status: 200, body: user };
}

export async function handleChangeUserRole(authService: AuthService, req: ApiRequest): Promise<ApiResponse> {
  const parsed = RoleBody.safeParse(req.body);
  if (!parsed.success) return { status: 400, body: VALIDATION_FAILED(parsed.error.message).body };
  try {
    const updated = await authService.changeUserRole(req.identity!.userId, req.params.userId!, parsed.data.role);
    if (!updated) return NOT_FOUND;
    return { status: 200, body: updated };
  } catch (error) {
    return mapErrorToHttp(error);
  }
}

export async function handleChangeUserStatus(authService: AuthService, req: ApiRequest): Promise<ApiResponse> {
  const parsed = StatusBody.safeParse(req.body);
  if (!parsed.success) return { status: 400, body: VALIDATION_FAILED(parsed.error.message).body };
  try {
    const updated = await authService.setUserDisabled(req.identity!.userId, req.params.userId!, parsed.data.disabled);
    if (!updated) return NOT_FOUND;
    return { status: 200, body: updated };
  } catch (error) {
    return mapErrorToHttp(error);
  }
}
