import { apiFetch } from './client';

export interface AdminVoice {
  id: string;
  userId: string | null;
  bookId: string | null;
  displayName: string;
  role: 'narrator' | 'character';
  language: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderMapping {
  id: string;
  voiceId: string;
  provider: string;
  providerVoiceId: string;
  providerModel: string | null;
  isActive: boolean;
  createdAt: string;
}

export async function listAllVoices(): Promise<AdminVoice[]> {
  return apiFetch<AdminVoice[]>('/admin/voices');
}

export async function createVoice(input: { displayName: string; role: 'narrator' | 'character'; language: string }): Promise<AdminVoice> {
  return apiFetch<AdminVoice>('/admin/voices', { method: 'POST', body: JSON.stringify(input) });
}

export async function updateVoice(
  voiceId: string,
  input: Partial<{ displayName: string; role: 'narrator' | 'character'; language: string }>,
): Promise<AdminVoice> {
  return apiFetch<AdminVoice>(`/admin/voices/${voiceId}`, { method: 'PUT', body: JSON.stringify(input) });
}

export async function createMapping(
  voiceId: string,
  input: { provider: 'elevenlabs' | 'google_cloud_tts'; providerVoiceId: string; providerModel?: string },
): Promise<ProviderMapping> {
  return apiFetch<ProviderMapping>(`/admin/voices/${voiceId}/mappings`, { method: 'POST', body: JSON.stringify(input) });
}

export async function updateMapping(
  voiceId: string,
  mappingId: string,
  input: Partial<{ providerVoiceId: string; providerModel: string; isActive: boolean }>,
): Promise<ProviderMapping> {
  return apiFetch<ProviderMapping>(`/admin/voices/${voiceId}/mappings/${mappingId}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}
