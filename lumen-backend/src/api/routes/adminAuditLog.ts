import { z } from 'zod';
import type { ApiRequest, ApiResponse } from '../http/ApiRouter';
import type { AuthService } from '../../auth/AuthService';
import { VALIDATION_FAILED } from '../errors/mapErrorToHttp';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

const QuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(MAX_LIMIT).default(DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).default(0),
  adminUserId: z.string().uuid().optional(),
  action: z.string().min(1).optional(),
  targetType: z.string().min(1).optional(),
  targetId: z.string().uuid().optional(),
  result: z.enum(['success', 'failure']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

/**
 * GET /admin/audit-log — Admin Audit Log v1, extended by Admin Audit Log Filtering v1
 * (approved workstream). adminOnly, reusing the exact same centralized guard as every
 * other admin route -- no second authorization mechanism. Bounded pagination only
 * (never unbounded), safe DTO only (raw repository rows are never returned directly).
 * Every filter is optional -- omitting all of them reproduces the original unfiltered
 * v1 behavior exactly.
 */
export async function handleListAuditLog(authService: AuthService, req: ApiRequest): Promise<ApiResponse> {
  const parsed = QuerySchema.safeParse({
    limit: req.query.get('limit') ?? undefined,
    offset: req.query.get('offset') ?? undefined,
    adminUserId: req.query.get('adminUserId') ?? undefined,
    action: req.query.get('action') ?? undefined,
    targetType: req.query.get('targetType') ?? undefined,
    targetId: req.query.get('targetId') ?? undefined,
    result: req.query.get('result') ?? undefined,
    from: req.query.get('from') ?? undefined,
    to: req.query.get('to') ?? undefined,
  });
  if (!parsed.success) {
    return { status: 400, body: VALIDATION_FAILED(parsed.error.message).body };
  }
  const { limit, offset, adminUserId, action, targetType, targetId, result, from, to } = parsed.data;
  const entries = await authService.listAuditLog(limit, offset, { adminUserId, action, targetType, targetId, result, from, to });

  return {
    status: 200,
    body: {
      items: entries.map((entry) => ({
        id: entry.id,
        adminUserId: entry.adminUserId,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        result: entry.result,
        metadata: entry.metadata,
        createdAt: entry.createdAt,
      })),
      limit,
      offset,
    },
  };
}
