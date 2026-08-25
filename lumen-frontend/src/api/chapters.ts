import { apiFetch } from './client';

export interface Chapter {
  id: string;
  bookId: string;
  orderIndex: number;
  title: string | null;
  status: string;
  textCharCount: number;
  segmentCount: number;
}

export interface TextSegment {
  id: string;
  chapterId: string;
  orderIndex: number;
  sourceText: string;
  narrationStatus: string;
  currentAudioSegmentId: string | null;
}

export async function listChapters(bookId: string): Promise<Chapter[]> {
  return apiFetch<Chapter[]>(`/books/${bookId}/chapters`);
}

export async function listSegments(chapterId: string): Promise<TextSegment[]> {
  return apiFetch<TextSegment[]>(`/chapters/${chapterId}/segments`);
}
