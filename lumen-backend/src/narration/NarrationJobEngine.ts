import type { NarrationEngineDeps } from './NarrationEngine.js';
import { narrateSegment } from './NarrationEngine.js';
import { ProcessingError } from '../processing/errors/ProcessingErrors.js';
import type { BookRepository } from '../repositories/BookRepository.js';
import type { ChapterRepository } from '../repositories/ChapterRepository.js';
import type { ProcessingJobRepository } from '../repositories/ProcessingJobRepository.js';

export interface NarrationJobDeps extends NarrationEngineDeps {
  bookRepo: BookRepository;
  chapterRepo: ChapterRepository;
  jobRepo: ProcessingJobRepository;
}

/**
 * Cooperative cancellation: the job loop checks `cancelled` before starting each new
 * chapter (and each new segment within a chapter). Because narration is processed
 * sequentially and synchronously per segment, no segment is ever left in a genuine
 * mid-flight state when cancellation is observed — there's nothing to roll back.
 */
export interface CancellationToken {
  cancelled: boolean;
}

export type NarrationJobScope = { type: 'book' } | { type: 'chapter'; chapterId: string };

export interface RunNarrationJobInput {
  bookId: string;
  userId: string;
  scope: NarrationJobScope;
  cancellationToken?: CancellationToken;
}

export interface ChapterOutcome {
  chapterId: string;
  segmentsTotal: number;
  segmentsSkipped: number;
  segmentsSucceeded: number;
  segmentsFailed: number;
}

export interface RunNarrationJobResult {
  processingJobId: string;
  jobStatus: 'completed' | 'cancelled';
  chapterOutcomes: ChapterOutcome[];
  bookStatus: string;
}

/**
 * Runs narration across a book- or chapter-scoped job, using the existing
 * ProcessingJob/ProcessingJobStep tables exactly as designed in Phase 1/2 — including
 * relying on the DB's two partial unique indexes (not a pre-check) to reject a duplicate
 * active job for the same scope, consistent with corrections §3 (DB-2/PIPE-2).
 *
 * TextSegment remains the unit of work throughout: this function never regenerates a
 * whole chapter or book — it iterates segments and delegates each one to
 * narrateSegment(), which is independently idempotent (see Phase 4). "Retry" at this
 * layer means "run this function again" — already-valid audio is skipped automatically,
 * not specially handled here.
 *
 * Book-status transition follows the approved rule (corrections §19): ready only at
 * 100% chapters ready; partially_ready once at least one chapter is ready; a
 * narration-only failure never fails the whole book — it's segment-scoped, and a chapter
 * with some failed segments simply stays short of 'ready' rather than becoming 'failed'.
 */
export async function runNarrationJob(
  deps: NarrationJobDeps,
  input: RunNarrationJobInput,
): Promise<RunNarrationJobResult> {
  const { bookRepo, chapterRepo, textSegmentRepo, jobRepo } = deps;
  const cancellationToken = input.cancellationToken ?? { cancelled: false };

  const jobType = input.scope.type === 'book' ? 'full_processing' : 'single_chapter_retry';
  const scopeId = input.scope.type === 'chapter' ? input.scope.chapterId : undefined;

  // No pre-check for an existing active job — the DB's two partial unique indexes are
  // the actual source of truth for concurrency correctness (see corrections §3). A
  // caller attempting a genuinely duplicate active job gets the underlying constraint
  // violation propagated, not a silently swallowed no-op.
  const job = await jobRepo.create({ bookId: input.bookId, userId: input.userId, jobType, scopeId });
  await jobRepo.updateJobStatus(job.id, { status: 'processing', startedAt: new Date() });

  try {
    const allChapters = await chapterRepo.listByBook(input.bookId);
    if (allChapters.length === 0) {
      throw new ProcessingError('CHAPTER_DETECTION_FAILED');
    }

    const targetChapters =
      input.scope.type === 'book'
        ? allChapters
        : allChapters.filter((c) => c.id === (input.scope as { chapterId: string }).chapterId);

    const chapterOutcomes: ChapterOutcome[] = [];
    let wasCancelled = false;

    for (const chapter of targetChapters) {
      if (cancellationToken.cancelled) {
        wasCancelled = true;
        break;
      }

      const step = await jobRepo.createStep({
        processingJobId: job.id,
        stepType: 'narration',
        scopeType: 'chapter',
        scopeId: chapter.id,
        status: 'processing',
        startedAt: new Date(),
      });

      const segments = await textSegmentRepo.listByChapter(chapter.id);
      const outcome: ChapterOutcome = {
        chapterId: chapter.id,
        segmentsTotal: segments.length,
        segmentsSkipped: 0,
        segmentsSucceeded: 0,
        segmentsFailed: 0,
      };

      let chapterCancelled = false;
      for (const segment of segments) {
        if (cancellationToken.cancelled) {
          chapterCancelled = true;
          wasCancelled = true;
          break;
        }

        const result = await narrateSegment(deps, {
          textSegmentId: segment.id,
          bookId: input.bookId,
          chapterId: chapter.id,
          userId: input.userId,
        });

        if (result.skipped) outcome.segmentsSkipped += 1;
        else if (result.failed) outcome.segmentsFailed += 1;
        else outcome.segmentsSucceeded += 1;
      }

      chapterOutcomes.push(outcome);

      if (chapterCancelled) {
        await jobRepo.updateStepStatus(step.id, { status: 'cancelled', completedAt: new Date() });
        break;
      }

      const allSegmentsReady = outcome.segmentsFailed === 0;
      const allSegmentsFailed =
        outcome.segmentsSucceeded === 0 && outcome.segmentsSkipped === 0 && outcome.segmentsFailed > 0;

      if (allSegmentsReady) {
        await chapterRepo.update(chapter.id, { status: 'ready' });
        await jobRepo.updateStepStatus(step.id, { status: 'completed', completedAt: new Date() });
      } else if (allSegmentsFailed) {
        await jobRepo.updateStepStatus(step.id, {
          status: 'failed',
          lastError: `All ${outcome.segmentsTotal} segments in this chapter failed to narrate.`,
          completedAt: new Date(),
        });
        // Chapter.status intentionally NOT set to 'failed' here — narration failures are
        // segment-scoped by design (corrections §19); the chapter stays retryable via a
        // chapter-scoped job without needing a whole-chapter "failed" state to clear.
      } else {
        await jobRepo.updateStepStatus(step.id, {
          status: 'failed',
          lastError: `${outcome.segmentsFailed} of ${outcome.segmentsTotal} segments failed to narrate.`,
          completedAt: new Date(),
        });
      }
    }

    // Book-status recompute over ALL chapters, even for a chapter-scoped job — a
    // chapter retry can change the book's overall readiness too.
    const finalChapters = await chapterRepo.listByBook(input.bookId);
    const readyCount = finalChapters.filter((c) => c.status === 'ready').length;
    let bookStatus: 'ready' | 'partially_ready' | 'processing';
    if (readyCount === finalChapters.length) bookStatus = 'ready';
    else if (readyCount > 0) bookStatus = 'partially_ready';
    else bookStatus = 'processing';

    await bookRepo.update(input.bookId, { status: bookStatus });

    if (wasCancelled) {
      await jobRepo.updateJobStatus(job.id, { status: 'cancelled', completedAt: new Date() });
      return { processingJobId: job.id, jobStatus: 'cancelled', chapterOutcomes, bookStatus };
    }

    await jobRepo.updateJobStatus(job.id, { status: 'completed', completedAt: new Date() });
    return { processingJobId: job.id, jobStatus: 'completed', chapterOutcomes, bookStatus };
  } catch (error) {
    await jobRepo.updateJobStatus(job.id, { status: 'failed', completedAt: new Date() });
    throw error;
  }
}
