import type { NarrationAttemptRepository } from '../repositories/NarrationAttemptRepository';
import type { ProcessingJobRepository } from '../repositories/ProcessingJobRepository';

export interface ReconciliationDeps {
  narrationAttemptRepo: NarrationAttemptRepository;
  jobRepo: ProcessingJobRepository;
}

export interface ReconciliationResult {
  reconciledAttempts: number;
  reconciledJobs: number;
}

const ORPHANED_MESSAGE =
  'This work was interrupted by a previous process termination and must be retried.';

/**
 * reconcileOrphanedWork — Workstream 13D.
 *
 * LOAD-BEARING ARCHITECTURAL ASSUMPTION: this system is single-process (confirmed
 * during 13B/13C/13D discovery — no clustering, no background workers, no multi-instance
 * deployment exists anywhere in this codebase). That fact is what makes this function
 * correct: any NarrationAttempt or ProcessingJob still in `status = 'processing'` at the
 * moment a NEW process starts up cannot possibly still be legitimately in flight — the
 * only process that could have been running it is, by definition, no longer running,
 * since a new process is what's calling this function. No timestamp/age heuristic is
 * needed or used; the startup boundary itself is the orphan boundary.
 *
 * If this architecture ever becomes multi-instance, this function's correctness breaks
 * immediately and it MUST be revisited before that change ships — it would then be
 * capable of failing genuinely in-flight work owned by a still-running sibling process.
 *
 * What this function deliberately does NOT do:
 *  - it does not retry the orphaned work itself — it only clears the stuck state so the
 *    EXISTING retry paths (re-triggering narration, re-triggering a job) become usable
 *    again, exactly as they already are for any other `failed` row.
 *  - it does not touch any row already in a terminal state (`completed`, `failed`,
 *    `cancelled`) — both underlying queries only ever select `processing` rows, so
 *    running this function twice in a row reconciles nothing the second time (already
 *    naturally idempotent, not specially cased).
 *  - it does not add a new database status/enum value — `failed` already exists and is
 *    the correct terminal state for "did not complete successfully."
 */
export async function reconcileOrphanedWork(deps: ReconciliationDeps): Promise<ReconciliationResult> {
  const orphanedAttempts = await deps.narrationAttemptRepo.listAllProcessing();
  for (const attempt of orphanedAttempts) {
    await deps.narrationAttemptRepo.complete(attempt.id, {
      status: 'failed',
      normalizedErrorCode: 'TRANSIENT_ERROR',
      errorMessage: ORPHANED_MESSAGE,
    });
  }

  const orphanedJobs = await deps.jobRepo.listAllProcessing();
  for (const job of orphanedJobs) {
    await deps.jobRepo.updateJobStatus(job.id, { status: 'failed', completedAt: new Date() });
  }

  return {
    reconciledAttempts: orphanedAttempts.length,
    reconciledJobs: orphanedJobs.length,
  };
}
