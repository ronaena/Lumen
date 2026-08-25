import { z } from 'zod';
import type { ApiRequest, ApiResponse } from '../http/ApiRouter.js';
import type { ApiDeps } from '../ApiDeps.js';
import { runNarrationJob } from '../../narration/NarrationJobEngine.js';
import { mapErrorToHttp, VALIDATION_FAILED, NOT_FOUND } from '../errors/mapErrorToHttp.js';

const TriggerJobBody = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('book') }),
  z.object({ scope: z.literal('chapter'), chapterId: z.string().uuid() }),
]);

/**
 * Also serves as the "retry" entry point: runNarrationJob is idempotent by design
 * (Phase 5) — already-narrated segments are skipped, only incomplete/failed work is
 * retried. Calling this endpoint again on a book that partially failed IS the retry
 * operation; no separate endpoint is needed for that case.
 */
export async function handleTriggerJob(deps: ApiDeps, req: ApiRequest): Promise<ApiResponse> {
  const bookId = req.params.bookId!;
  const book = await deps.bookRepo.findById(bookId, req.identity!.userId);
  if (!book) return NOT_FOUND;

  const parsed = TriggerJobBody.safeParse(req.body);
  if (!parsed.success) {
    return { status: 400, body: VALIDATION_FAILED(parsed.error.message).body };
  }

  try {
    const scope =
      parsed.data.scope === 'book'
        ? { type: 'book' as const }
        : { type: 'chapter' as const, chapterId: parsed.data.chapterId };
    const result = await runNarrationJob(deps, { bookId, userId: req.identity!.userId, scope });
    return {
      status: 202,
      body: {
        processingJobId: result.processingJobId,
        jobStatus: result.jobStatus,
        bookStatus: result.bookStatus,
        chapterOutcomes: result.chapterOutcomes,
      },
    };
  } catch (error) {
    return mapErrorToHttp(error);
  }
}

export async function handleGetJob(deps: ApiDeps, req: ApiRequest): Promise<ApiResponse> {
  const bookId = req.params.bookId!;
  const jobId = req.params.jobId!;

  const book = await deps.bookRepo.findById(bookId, req.identity!.userId);
  if (!book) return NOT_FOUND;

  const job = await deps.jobRepo.findById(jobId);
  // Ownership is enforced by checking the job's bookId matches a book this user owns —
  // ProcessingJob has no direct userId-scoped lookup, so this mirrors the same
  // walk-up-to-book pattern already used for Chapter/TextSegment ownership in Phases 6-8.
  if (!job || job.bookId !== bookId) return NOT_FOUND;

  const steps = await deps.jobRepo.listStepsByJob(job.id);
  return {
    status: 200,
    body: {
      id: job.id,
      bookId: job.bookId,
      jobType: job.jobType,
      status: job.status,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      steps: steps.map((s) => ({
        stepType: s.stepType,
        scopeType: s.scopeType,
        scopeId: s.scopeId,
        status: s.status,
        lastError: s.lastError,
      })),
    },
  };
}
