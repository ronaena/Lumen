import { apiFetch, ApiError } from './client';

export interface ListeningProgress {
  chapterId: string;
  audioSegmentId: string | null;
  playbackPositionMs: number;
  completionPct: string;
}

export interface ReadingProgress {
  chapterId: string;
  textSegmentId: string | null;
  readingPositionOffset: number | null;
  completionPct: string;
}

export async function getListeningProgress(bookId: string): Promise<ListeningProgress | null> {
  try {
    return await apiFetch<ListeningProgress>(`/books/${bookId}/progress/listening`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

export async function putListeningProgress(
  bookId: string,
  input: { chapterId: string; audioSegmentId?: string; playbackPositionMs: number; completionPct: string },
): Promise<ListeningProgress> {
  return apiFetch<ListeningProgress>(`/books/${bookId}/progress/listening`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

export async function getReadingProgress(bookId: string): Promise<ReadingProgress | null> {
  try {
    return await apiFetch<ReadingProgress>(`/books/${bookId}/progress/reading`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

export async function putReadingProgress(
  bookId: string,
  input: { chapterId: string; textSegmentId?: string; readingPositionOffset?: number; completionPct: string },
): Promise<ReadingProgress> {
  return apiFetch<ReadingProgress>(`/books/${bookId}/progress/reading`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}
