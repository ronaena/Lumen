import { apiFetch } from './client';

export interface AdminDashboardData {
  system: { healthy: boolean; ready: boolean };
  users: { total: number; admins: number };
  voices: { total: number; activeMappings: number; inactiveMappings: number };
}

export async function getAdminDashboard(): Promise<AdminDashboardData> {
  return apiFetch<AdminDashboardData>('/admin/dashboard');
}
