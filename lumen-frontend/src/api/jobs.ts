import { apiFetch } from './client';

export interface JobStep {
  stepType: string;
  scopeType: string;
  scopeId: string | null;
  status: string;
  lastError: string | null;
}

export interface Job {
  id: string;
  bookId: string;
  jobType: string;
  status: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  steps: JobStep[];
}

export interface TriggerJobResult {
  processingJobId: string;
  jobStatus: string;
  bookStatus: string;
  chapterOutcomes: unknown[];
}

/** Also the retry entry point -- the backend's job engine is idempotent by design. */
export async function triggerJob(bookId: string): Promise<TriggerJobResult> {
  return apiFetch<TriggerJobResult>(`/books/${bookId}/jobs`, {
    method: 'POST',
    body: JSON.stringify({ scope: 'book' }),
  });
}

export async function getJob(bookId: string, jobId: string): Promise<Job> {
  return apiFetch<Job>(`/books/${bookId}/jobs/${jobId}`);
}
