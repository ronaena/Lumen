import { apiFetch } from './client';

export interface Book {
  id: string;
  title: string;
  author: string | null;
  status: string;
  chapterCount: number;
  segmentCount: number;
  createdAt: string;
}

export async function listBooks(): Promise<Book[]> {
  return apiFetch<Book[]>('/books');
}

export async function getBook(bookId: string): Promise<Book> {
  return apiFetch<Book>(`/books/${bookId}`);
}

export interface IngestBookResult {
  bookId: string;
  processingJobId: string;
  chapterCount: number;
  segmentCount: number;
}

/** fileBase64 must already be base64-encoded by the caller -- see UploadPage. */
export async function ingestBook(input: {
  filename: string;
  mimeType: string;
  fileBase64: string;
  narratorVoiceId: string;
}): Promise<IngestBookResult> {
  return apiFetch<IngestBookResult>('/books', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}
