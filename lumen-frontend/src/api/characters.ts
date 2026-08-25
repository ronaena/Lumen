import { apiFetch } from './client';

export interface Character {
  id: string;
  bookId: string;
  name: string;
  description: string | null;
}

export async function createCharacter(bookId: string, name: string, description?: string): Promise<Character> {
  return apiFetch<Character>(`/books/${bookId}/characters`, {
    method: 'POST',
    body: JSON.stringify({ name, description }),
  });
}

export async function assignCharacterVoice(characterId: string, voiceId: string): Promise<unknown> {
  return apiFetch(`/characters/${characterId}/voice`, {
    method: 'PUT',
    body: JSON.stringify({ voiceId }),
  });
}

export async function assignSegmentToCharacter(textSegmentId: string, characterId: string): Promise<unknown> {
  return apiFetch(`/segments/${textSegmentId}/character`, {
    method: 'PUT',
    body: JSON.stringify({ characterId }),
  });
}

export interface Scene {
  id: string;
  chapterId: string;
  startSegmentId: string;
  endSegmentId: string;
  sceneType: string | null;
  emotionalClassification: string | null;
  direction: Record<string, unknown> | null;
}

export async function listScenes(chapterId: string): Promise<Scene[]> {
  return apiFetch<Scene[]>(`/chapters/${chapterId}/scenes`);
}

export async function createScene(
  chapterId: string,
  input: { startSegmentId: string; endSegmentId: string; sceneType?: string; emotionalClassification?: string },
): Promise<Scene> {
  return apiFetch<Scene>(`/chapters/${chapterId}/scenes`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function getScene(sceneId: string): Promise<Scene> {
  return apiFetch<Scene>(`/scenes/${sceneId}`);
}

export async function updateSceneDirection(sceneId: string, direction: Record<string, unknown>): Promise<Scene> {
  return apiFetch<Scene>(`/scenes/${sceneId}/direction`, {
    method: 'PUT',
    body: JSON.stringify({ direction }),
  });
}
