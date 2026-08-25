import { apiFetch } from './client';

export interface AdminUser {
  id: string;
  email: string;
  displayName: string | null;
  role: 'user' | 'admin';
  disabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export async function listUsers(): Promise<AdminUser[]> {
  return apiFetch<AdminUser[]>('/admin/users');
}

export async function getUser(userId: string): Promise<AdminUser> {
  return apiFetch<AdminUser>(`/admin/users/${userId}`);
}

export async function changeUserRole(userId: string, role: 'user' | 'admin'): Promise<AdminUser> {
  return apiFetch<AdminUser>(`/admin/users/${userId}/role`, { method: 'PATCH', body: JSON.stringify({ role }) });
}

export async function setUserDisabled(userId: string, disabled: boolean): Promise<AdminUser> {
  return apiFetch<AdminUser>(`/admin/users/${userId}/status`, { method: 'PATCH', body: JSON.stringify({ disabled }) });
}
