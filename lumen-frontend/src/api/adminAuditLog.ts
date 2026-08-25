import { apiFetch } from './client';

export interface AuditLogEntry {
  id: string;
  adminUserId: string;
  action: string;
  targetType: string;
  targetId: string | null;
  result: 'success' | 'failure';
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface AuditLogResponse {
  items: AuditLogEntry[];
  limit: number;
  offset: number;
}

export interface AuditLogFilters {
  adminUserId?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  result?: 'success' | 'failure';
  from?: string;
  to?: string;
}

export async function getAuditLog(limit = 50, offset = 0, filters: AuditLogFilters = {}): Promise<AuditLogResponse> {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, value);
  }
  return apiFetch<AuditLogResponse>(`/admin/audit-log?${params.toString()}`);
}
