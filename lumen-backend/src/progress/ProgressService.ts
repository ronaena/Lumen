import { ProcessingError } from '../processing/errors/ProcessingErrors.js';
import type { BookRepository } from '../repositories/BookRepository.js';
import type { ChapterRepository } from '../repositories/ChapterRepository.js';
import type { TextSegmentRepository } from '../repositories/TextSegmentRepository.js';
import type { AudioSegmentRepository } from '../repositories/AudioSegmentRepository.js';
import type {
  ListeningProgressRepository,
  UpsertListeningProgressInput,
} from '../repositories/ListeningProgressRepository.js';
import type {
  ReadingProgressRepository,
  UpsertReadingProgressInput,
} from '../repositories/ReadingProgressRepository.js';

export interface ProgressServiceDeps {
  bookRepo: BookRepository;
  chapterRepo: ChapterRepository;
  textSegmentRepo: TextSegmentRepository;
  audioSegmentRepo: AudioSegmentRepository;
  listeningProgressRepo: ListeningProgressRepository;
  readingProgressRepo: ReadingProgressRepository;
}

export interface ChapterPositionSummary {
  currentChapterIndex: number;
  totalChapters: number;
  isLastChapter: boolean;
}

/**
 * Validates that a chapter genuinely belongs to the given book — a repository-level FK
 * only guarantees the chapter *exists somewhere*, not that it belongs to *this* book. A
 * client-supplied chapterId for a different book must be rejected here, not silently
 * accepted.
 */
async function assertChapterBelongsToBook(
  deps: ProgressServiceDeps,
  chapterId: string,
  bookId: string,
): Promise<void> {
  const chapter = await deps.chapterRepo.findById(chapterId);
  if (!chapter || chapter.bookId !== bookId) {
    throw new ProcessingError('INVALID_PROGRESS_REFERENCE');
  }
}

export async function updateListeningProgress(
  deps: ProgressServiceDeps,
  input: {
    userId: string;
    bookId: string;
    chapterId: string;
    audioSegmentId?: string;
    playbackPositionMs: number;
    completionPct: string;
  },
) {
  const book = await deps.bookRepo.findById(input.bookId, input.userId);
  if (!book) throw new ProcessingError('INVALID_PROGRESS_REFERENCE');

  await assertChapterBelongsToBook(deps, input.chapterId, input.bookId);

  if (input.audioSegmentId) {
    const audioSegment = await deps.audioSegmentRepo.findById(input.audioSegmentId);
    if (!audioSegment) throw new ProcessingError('INVALID_PROGRESS_REFERENCE');
    const textSegment = await deps.textSegmentRepo.findById(audioSegment.textSegmentId);
    if (!textSegment || textSegment.chapterId !== input.chapterId) {
      throw new ProcessingError('INVALID_PROGRESS_REFERENCE');
    }
  }

  const upsertInput: UpsertListeningProgressInput = {
    userId: input.userId,
    bookId: input.bookId,
    chapterId: input.chapterId,
    audioSegmentId: input.audioSegmentId,
    playbackPositionMs: input.playbackPositionMs,
    completionPct: input.completionPct,
  };
  return deps.listeningProgressRepo.upsert(upsertInput);
}

export async function updateReadingProgress(
  deps: ProgressServiceDeps,
  input: {
    userId: string;
    bookId: string;
    chapterId: string;
    textSegmentId?: string;
    readingPositionOffset?: number;
    completionPct: string;
  },
) {
  const book = await deps.bookRepo.findById(input.bookId, input.userId);
  if (!book) throw new ProcessingError('INVALID_PROGRESS_REFERENCE');

  await assertChapterBelongsToBook(deps, input.chapterId, input.bookId);

  if (input.textSegmentId) {
    const textSegment = await deps.textSegmentRepo.findById(input.textSegmentId);
    if (!textSegment || textSegment.chapterId !== input.chapterId) {
      throw new ProcessingError('INVALID_PROGRESS_REFERENCE');
    }
  }

  const upsertInput: UpsertReadingProgressInput = {
    userId: input.userId,
    bookId: input.bookId,
    chapterId: input.chapterId,
    textSegmentId: input.textSegmentId,
    readingPositionOffset: input.readingPositionOffset,
    completionPct: input.completionPct,
  };
  return deps.readingProgressRepo.upsert(upsertInput);
}

/**
 * Resolves the audio a resumed listener should actually hear now, which may differ from
 * the AudioSegment ID stored at the moment progress was last saved: if that TextSegment's
 * audio has since been regenerated (the old one superseded, per the atomic activation
 * rule), the stored progress row still points at the (retained, not deleted) old
 * artifact. This resolver always returns the CURRENTLY active AudioSegment for that
 * TextSegment — progress survives regeneration by never trusting the stored pointer as
 * authoritative once regeneration may have occurred.
 */
export async function resolveEffectiveListeningAudio(
  deps: ProgressServiceDeps,
  userId: string,
  bookId: string,
): Promise<{ textSegmentId: string; currentAudioSegmentId: string | null } | null> {
  const progress = await deps.listeningProgressRepo.findByUserAndBook(userId, bookId);
  if (!progress || !progress.audioSegmentId) return null;

  const storedAudioSegment = await deps.audioSegmentRepo.findById(progress.audioSegmentId);
  if (!storedAudioSegment) return null;

  const textSegment = await deps.textSegmentRepo.findById(storedAudioSegment.textSegmentId);
  if (!textSegment) return null;

  return {
    textSegmentId: textSegment.id,
    currentAudioSegmentId: textSegment.currentAudioSegmentId,
  };
}

/** Pure aggregation helper: where a chapter sits within the book's overall structure. */
export function computeChapterPositionSummary(
  chapters: Array<{ id: string; orderIndex: number }>,
  currentChapterId: string,
): ChapterPositionSummary | null {
  const sorted = [...chapters].sort((a, b) => a.orderIndex - b.orderIndex);
  const index = sorted.findIndex((c) => c.id === currentChapterId);
  if (index === -1) return null;
  return {
    currentChapterIndex: index,
    totalChapters: sorted.length,
    isLastChapter: index === sorted.length - 1,
  };
}
