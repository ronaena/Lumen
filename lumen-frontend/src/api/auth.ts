import { apiFetch, clearToken, setToken } from './client';

export interface RegisteredUser {
  id: string;
  email: string;
  createdAt: string;
}

export async function register(email: string, password: string): Promise<RegisteredUser> {
  return apiFetch<RegisteredUser>('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

export async function login(email: string, password: string): Promise<{ token: string; expiresAt: string }> {
  const result = await apiFetch<{ token: string; expiresAt: string }>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  setToken(result.token);
  return result;
}

export async function logout(): Promise<void> {
  try {
    await apiFetch('/auth/logout', { method: 'POST' });
  } finally {
    clearToken();
  }
}

export async function logoutAll(): Promise<void> {
  try {
    await apiFetch('/auth/logout-all', { method: 'POST' });
  } finally {
    clearToken();
  }
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  await apiFetch('/auth/password', {
    method: 'PUT',
    body: JSON.stringify({ currentPassword, newPassword }),
  });
}

export interface CurrentUser {
  userId: string;
  email: string;
  role: 'user' | 'admin';
}

export async function getCurrentUser(): Promise<CurrentUser> {
  return apiFetch<CurrentUser>('/auth/me');
}
