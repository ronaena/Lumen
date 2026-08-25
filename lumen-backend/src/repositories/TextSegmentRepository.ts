import { assertDefined } from './assertDefined';
import { eq, and, asc } from 'drizzle-orm';
import type { Database } from '../db/client';
import { textSegments } from '../db/schema/index';

export interface CreateTextSegmentInput {
  chapterId: string;
  orderIndex: number;
  sourceText: string;
  normalizedText: string;
  charCount: number;
  sourceReference: string;
  contentHash: string;
  narratorVoiceId: string;
}

export class TextSegmentRepository {
  constructor(private readonly db: Database) {}

  async create(input: CreateTextSegmentInput) {
    const [segment] = await this.db.insert(textSegments).values(input).returning();
    return assertDefined(segment, "TextSegmentRepository.create");
  }

  async findById(textSegmentId: string) {
    const [segment] = await this.db
      .select()
      .from(textSegments)
      .where(eq(textSegments.id, textSegmentId));
    return segment ?? null;
  }

  async listByChapter(chapterId: string) {
    return this.db
      .select()
      .from(textSegments)
      .where(eq(textSegments.chapterId, chapterId))
      .orderBy(asc(textSegments.orderIndex));
  }

  async findByChapterAndOrder(chapterId: string, orderIndex: number) {
    const [segment] = await this.db
      .select()
      .from(textSegments)
      .where(and(eq(textSegments.chapterId, chapterId), eq(textSegments.orderIndex, orderIndex)));
    return segment ?? null;
  }

  async updateNarrationStatus(
    textSegmentId: string,
    narrationStatus: (typeof textSegments.$inferSelect)['narrationStatus'],
  ) {
    const [updated] = await this.db
      .update(textSegments)
      .set({ narrationStatus, updatedAt: new Date() })
      .where(eq(textSegments.id, textSegmentId))
      .returning();
    return updated;
  }

  /**
   * Sets which character voice narrates this segment (or clears it back to narrator-only
   * with null). No separate version bump is needed here: the regeneration-decision
   * signature is computed from the EFFECTIVE voice (characterVoiceId ?? narratorVoiceId,
   * see NarrationEngine), so a voice change already changes the hash directly — bumping
   * deliveryDirectionVersion here would conflate a voice change with a direction change,
   * which are different concepts even though both currently invalidate cached audio.
   */
  async updateCharacterVoice(textSegmentId: string, characterVoiceId: string | null) {
    const [updated] = await this.db
      .update(textSegments)
      .set({ characterVoiceId, updatedAt: new Date() })
      .where(eq(textSegments.id, textSegmentId))
      .returning();
    return updated ?? null;
  }

  /** Used to cascade a character's voice reassignment to every segment currently using it. */
  async listByCharacterVoiceId(characterVoiceId: string) {
    return this.db.select().from(textSegments).where(eq(textSegments.characterVoiceId, characterVoiceId));
  }

  /**
   * Sets the resolved/cached delivery direction and bumps deliveryDirectionVersion.
   * Per the approved precedence rule: when a Scene covers this segment, Scene.direction
   * is authoritative and this IS the cached copy of it — callers (SceneService) are
   * responsible for supplying the scene's direction content here, not inventing their own.
   */
  async setDeliveryDirection(textSegmentId: string, direction: Record<string, unknown>) {
    const current = await this.findById(textSegmentId);
    if (!current) return null;
    const [updated] = await this.db
      .update(textSegments)
      .set({
        deliveryDirection: direction,
        deliveryDirectionVersion: current.deliveryDirectionVersion + 1,
        updatedAt: new Date(),
      })
      .where(eq(textSegments.id, textSegmentId))
      .returning();
    return updated ?? null;
  }
}
