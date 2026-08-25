import { assertDefined } from './assertDefined';
import { eq } from 'drizzle-orm';
import type { Database } from '../db/client';
import { processingJobs, processingJobSteps } from '../db/schema/index';

export interface CreateProcessingJobInput {
  bookId: string;
  userId: string;
  jobType: (typeof processingJobs.$inferInsert)['jobType'];
  /** NULL for book-level jobs (full_processing); a chapter ID for single_chapter_retry. */
  scopeId?: string;
}

/**
 * ProcessingJobRepository — deliberately does NOT pre-check for an existing active job
 * before inserting. Concurrency correctness comes from the database's two partial unique
 * indexes (DB-2/PIPE-2 correction); a pre-check-then-insert here would just reintroduce
 * the race window the DB constraint exists to close. Callers must handle the unique
 * constraint violation as the expected "a job is already active for this scope" signal.
 */
export class ProcessingJobRepository {
  constructor(private readonly db: Database) {}

  async create(input: CreateProcessingJobInput) {
    const [job] = await this.db.insert(processingJobs).values(input).returning();
    return assertDefined(job, "ProcessingJobRepository.create");
  }

  async findById(jobId: string) {
    const [job] = await this.db.select().from(processingJobs).where(eq(processingJobs.id, jobId));
    return job ?? null;
  }

  async listByBook(bookId: string) {
    return this.db.select().from(processingJobs).where(eq(processingJobs.bookId, bookId));
  }

  async createStep(input: typeof processingJobSteps.$inferInsert) {
    const [step] = await this.db.insert(processingJobSteps).values(input).returning();
    return assertDefined(step, "ProcessingJobRepository.createStep");
  }

  async listStepsByJob(processingJobId: string) {
    return this.db
      .select()
      .from(processingJobSteps)
      .where(eq(processingJobSteps.processingJobId, processingJobId));
  }

  /**
   * ProcessingJobStep is a mutable status tracker (unlike the append-only NarrationAttempt
   * / ProviderUsage) — updating it in place as a stage progresses is the approved design.
   */
  async updateStepStatus(
    stepId: string,
    update: {
      status: (typeof processingJobSteps.$inferInsert)['status'];
      lastError?: string | null;
      startedAt?: Date;
      completedAt?: Date;
    },
  ) {
    const [step] = await this.db
      .update(processingJobSteps)
      .set(update)
      .where(eq(processingJobSteps.id, stepId))
      .returning();
    return step ?? null;
  }

  async updateJobStatus(
    jobId: string,
    update: {
      status: (typeof processingJobs.$inferInsert)['status'];
      startedAt?: Date;
      completedAt?: Date;
    },
  ) {
    const [job] = await this.db
      .update(processingJobs)
      .set(update)
      .where(eq(processingJobs.id, jobId))
      .returning();
    return job ?? null;
  }

  /**
   * Workstream 13D: finds every job still `processing`, regardless of book/scope — used
   * only by the startup reconciliation pass. Same single-process load-bearing assumption
   * as NarrationAttemptRepository.listAllProcessing(): any row still in this state at a
   * new process's startup belonged to a process that no longer exists.
   */
  async listAllProcessing() {
    return this.db.select().from(processingJobs).where(eq(processingJobs.status, 'processing'));
  }
}
