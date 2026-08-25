import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { characterVoiceAssignments } from '../db/schema/index.js';
import { assertDefined } from './assertDefined.js';

export interface UpsertCharacterVoiceAssignmentInput {
  characterId: string;
  voiceId: string;
  confidence?: string;
  isUserConfirmed?: boolean;
}

export class CharacterVoiceAssignmentRepository {
  constructor(private readonly db: Database) {}

  /**
   * Reassigning a character's voice is an UPDATE of the same row, not a new one — the
   * schema's unique(characterId) constraint means a character has exactly one current
   * assignment. Prior assignments are not retained as history here (unlike
   * NarrationAttempt); if that auditability is ever needed, it's a future decision, not
   * assumed now.
   */
  async upsert(input: UpsertCharacterVoiceAssignmentInput) {
    const [row] = await this.db
      .insert(characterVoiceAssignments)
      .values({ ...input, isUserConfirmed: input.isUserConfirmed ?? true })
      .onConflictDoUpdate({
        target: characterVoiceAssignments.characterId,
        set: {
          voiceId: input.voiceId,
          confidence: input.confidence,
          isUserConfirmed: input.isUserConfirmed ?? true,
        },
      })
      .returning();
    return assertDefined(row, 'CharacterVoiceAssignmentRepository.upsert');
  }

  async findByCharacterId(characterId: string) {
    const [row] = await this.db
      .select()
      .from(characterVoiceAssignments)
      .where(eq(characterVoiceAssignments.characterId, characterId));
    return row ?? null;
  }
}
