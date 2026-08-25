import { ProcessingError } from '../processing/errors/ProcessingErrors.js';
import type { BookRepository } from '../repositories/BookRepository.js';
import type { ChapterRepository } from '../repositories/ChapterRepository.js';
import type { TextSegmentRepository } from '../repositories/TextSegmentRepository.js';
import type { VoiceRepository } from '../repositories/VoiceRepository.js';
import type { CharacterRepository } from '../repositories/CharacterRepository.js';
import type { CharacterVoiceAssignmentRepository } from '../repositories/CharacterVoiceAssignmentRepository.js';

export interface CharacterServiceDeps {
  bookRepo: BookRepository;
  chapterRepo: ChapterRepository;
  textSegmentRepo: TextSegmentRepository;
  voiceRepo: VoiceRepository;
  characterRepo: CharacterRepository;
  characterVoiceAssignmentRepo: CharacterVoiceAssignmentRepository;
}

/**
 * NOTHING in this file (or anywhere else in this codebase) automatically decides which
 * segment belongs to which character. Every association here is explicit, caller-supplied
 * input — there is no dialogue detection, NLP attribution, or heuristic of any kind.
 * That's an intentional, permanent boundary for this phase, not a placeholder.
 */

export async function createCharacter(
  deps: CharacterServiceDeps,
  input: { userId: string; bookId: string; name: string; description?: string },
) {
  const book = await deps.bookRepo.findById(input.bookId, input.userId);
  if (!book) throw new ProcessingError('CHARACTER_NOT_FOUND'); // book not owned/found — same safe error either way
  return deps.characterRepo.create({ bookId: input.bookId, name: input.name, description: input.description });
}

async function assertCharacterOwnedByUser(deps: CharacterServiceDeps, characterId: string, userId: string) {
  const character = await deps.characterRepo.findById(characterId);
  if (!character) throw new ProcessingError('CHARACTER_NOT_FOUND');
  const book = await deps.bookRepo.findById(character.bookId, userId);
  if (!book) throw new ProcessingError('CHARACTER_NOT_FOUND'); // wrong owner — never distinguish from "doesn't exist"
  return character;
}

/**
 * Assigns (or reassigns) a character's voice. Reassignment is the interesting case:
 * every TextSegment currently narrated by the character's OLD voice is cascaded to the
 * new one, which — combined with NarrationEngine resolving the EFFECTIVE voice
 * (characterVoiceId ?? narratorVoiceId) into the regeneration signature — means the next
 * narration run naturally regenerates those segments. No manual "mark stale" step is
 * needed; it falls out of the existing idempotency/versioning machinery once the voice
 * value itself is correct.
 */
export async function assignCharacterVoice(
  deps: CharacterServiceDeps,
  input: { userId: string; characterId: string; voiceId: string },
) {
  await assertCharacterOwnedByUser(deps, input.characterId, input.userId);

  const voice = await deps.voiceRepo.findById(input.voiceId);
  if (!voice) throw new ProcessingError('VOICE_NOT_FOUND');

  const previousAssignment = await deps.characterVoiceAssignmentRepo.findByCharacterId(input.characterId);
  const updated = await deps.characterVoiceAssignmentRepo.upsert({
    characterId: input.characterId,
    voiceId: input.voiceId,
  });

  if (previousAssignment && previousAssignment.voiceId !== input.voiceId) {
    const affectedSegments = await deps.textSegmentRepo.listByCharacterVoiceId(previousAssignment.voiceId);
    for (const segment of affectedSegments) {
      await deps.textSegmentRepo.updateCharacterVoice(segment.id, input.voiceId);
    }
  }

  return updated;
}

/**
 * Manually associates one TextSegment with a character's currently assigned voice. This
 * is the explicit, caller-driven mechanism a future editorial/attribution feature would
 * call — it performs no detection of its own.
 */
export async function assignSegmentToCharacter(
  deps: CharacterServiceDeps,
  input: { userId: string; textSegmentId: string; characterId: string },
) {
  const segment = await deps.textSegmentRepo.findById(input.textSegmentId);
  if (!segment) throw new ProcessingError('SEGMENT_NOT_FOUND');

  const chapter = await deps.chapterRepo.findById(segment.chapterId);
  if (!chapter) throw new ProcessingError('SEGMENT_NOT_FOUND');

  const book = await deps.bookRepo.findById(chapter.bookId, input.userId);
  if (!book) throw new ProcessingError('SEGMENT_NOT_FOUND');

  const character = await deps.characterRepo.findById(input.characterId);
  if (!character || character.bookId !== chapter.bookId) {
    // Cross-book character reference — same safe rejection pattern as Phase 6.
    throw new ProcessingError('CHARACTER_NOT_FOUND');
  }

  const assignment = await deps.characterVoiceAssignmentRepo.findByCharacterId(input.characterId);
  if (!assignment) throw new ProcessingError('VOICE_ASSIGNMENT_INVALID');

  return deps.textSegmentRepo.updateCharacterVoice(input.textSegmentId, assignment.voiceId);
}

/** Clears a segment back to narrator-only (no character voice). */
export async function clearSegmentCharacterVoice(
  deps: CharacterServiceDeps,
  input: { userId: string; textSegmentId: string },
) {
  const segment = await deps.textSegmentRepo.findById(input.textSegmentId);
  if (!segment) throw new ProcessingError('SEGMENT_NOT_FOUND');
  const chapter = await deps.chapterRepo.findById(segment.chapterId);
  if (!chapter) throw new ProcessingError('SEGMENT_NOT_FOUND');
  const book = await deps.bookRepo.findById(chapter.bookId, input.userId);
  if (!book) throw new ProcessingError('SEGMENT_NOT_FOUND');

  return deps.textSegmentRepo.updateCharacterVoice(input.textSegmentId, null);
}
