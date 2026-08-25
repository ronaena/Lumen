import { apiFetch } from './client';

export interface Voice {
  id: string;
  displayName: string;
  role: 'narrator' | 'character';
  language: string;
}

export async function listVoices(): Promise<Voice[]> {
  return apiFetch<Voice[]>('/voices');
}
