import { eq, and } from 'drizzle-orm';
import type { Database } from '../db/client';
import { audioSegments, textSegments } from '../db/schema/index';

export interface CreateAudioSegmentInput {
  textSegmentId: string;
  producedByAttemptId: string;
  storageRef: string;
  provider: string;
  providerJobId?: string;
  modelUsed: string;
  providerVoiceId: string;
  durationMs: number;
  format: (typeof audioSegments.$inferInsert)['format'];
  sampleRateHz: number;
  fileSizeBytes: number;
  checksum: string;
  estimatedCost: string;
  actualCost?: string;
  currency?: string;
  generationSignature: string;
}

export class AudioSegmentRepository {
  constructor(private readonly db: Database) {}

  async findById(audioSegmentId: string) {
    const [segment] = await this.db
      .select()
      .from(audioSegments)
      .where(eq(audioSegments.id, audioSegmentId));
    return segment ?? null;
  }

  async findActiveForTextSegment(textSegmentId: string) {
    const [segment] = await this.db
      .select()
      .from(audioSegments)
      .where(and(eq(audioSegments.textSegmentId, textSegmentId), eq(audioSegments.status, 'active')));
    return segment ?? null;
  }

  /**
   * Atomically activates a newly-generated AudioSegment as the current audio for its
   * TextSegment, per the mandatory atomic transition (corrections §18 / PIPE-5):
   *   1. Insert the new AudioSegment (status = 'active').
   *   2. Mark the previously-active AudioSegment (if any) as 'superseded' — never deleted.
   *   3. Point TextSegment.currentAudioSegmentId at the new row.
   * All three steps happen in one transaction — there is never an observable moment where
   * currentAudioSegmentId points at a segment not yet correctly marked 'superseded'.
   */
  async activateAudioSegment(input: CreateAudioSegmentInput) {
    return this.db.transaction(async (tx) => {
      const [newSegment] = await tx.insert(audioSegments).values(input).returning();
      if (!newSegment) {
        throw new Error('Failed to insert AudioSegment during activation');
      }

      const [previousActive] = await tx
        .select()
        .from(audioSegments)
        .where(
          and(
            eq(audioSegments.textSegmentId, input.textSegmentId),
            eq(audioSegments.status, 'active'),
          ),
        );

      if (previousActive && previousActive.id !== newSegment.id) {
        await tx
          .update(audioSegments)
          .set({ status: 'superseded' })
          .where(eq(audioSegments.id, previousActive.id));
      }

      await tx
        .update(textSegments)
        .set({ currentAudioSegmentId: newSegment.id, narrationStatus: 'ready', updatedAt: new Date() })
        .where(eq(textSegments.id, input.textSegmentId));

      return newSegment;
    });
  }
}
