import type { ApiRequest, ApiResponse } from '../http/ApiRouter';
import type { ApiDeps } from '../ApiDeps';
import { ProcessingError } from '../../processing/errors/ProcessingErrors';
import { mapErrorToHttp, NOT_FOUND } from '../errors/mapErrorToHttp';

/**
 * GET /books/:bookId/chapters — reuses ChapterRepository.listByBook(bookId) exactly as
 * it already existed; no repository change. Ownership follows the same pattern as
 * handleGetBook: bookRepo.findById(bookId, userId) returns null for both "doesn't
 * exist" and "not yours," and both surface as the same 404 here, matching every other
 * ownership-scoped route in this codebase.
 */
export async function handleListChapters(deps: ApiDeps, req: ApiRequest): Promise<ApiResponse> {
  const bookId = req.params.bookId!;
  const book = await deps.bookRepo.findById(bookId, req.identity!.userId);
  if (!book) {
    return NOT_FOUND;
  }
  const chapters = await deps.chapterRepo.listByBook(bookId);
  return {
    status: 200,
    body: chapters.map((chapter) => ({
      id: chapter.id,
      bookId: chapter.bookId,
      orderIndex: chapter.orderIndex,
      title: chapter.title,
      status: chapter.status,
      textCharCount: chapter.textCharCount,
      segmentCount: chapter.segmentCount,
    })),
  };
}

/**
 * GET /chapters/:chapterId/segments — reuses TextSegmentRepository.listByChapter
 * exactly as it already existed. Ownership walks chapter -> book -> user, the same
 * pattern already established by SceneService's assertChapterOwnedByUser (Phase 8) —
 * a chapter lookup that fails, or whose book isn't owned by the caller, both surface as
 * the same CHAPTER_NOT_FOUND -> 404, never distinguishing the two cases.
 */
export async function handleListSegments(deps: ApiDeps, req: ApiRequest): Promise<ApiResponse> {
  const chapterId = req.params.chapterId!;
  try {
    const chapter = await deps.chapterRepo.findById(chapterId);
    if (!chapter) throw new ProcessingError('CHAPTER_NOT_FOUND');
    const book = await deps.bookRepo.findById(chapter.bookId, req.identity!.userId);
    if (!book) throw new ProcessingError('CHAPTER_NOT_FOUND');

    const segments = await deps.textSegmentRepo.listByChapter(chapterId);
    return {
      status: 200,
      body: segments.map((segment) => ({
        id: segment.id,
        chapterId: segment.chapterId,
        orderIndex: segment.orderIndex,
        sourceText: segment.sourceText,
        narrationStatus: segment.narrationStatus,
        currentAudioSegmentId: segment.currentAudioSegmentId,
      })),
    };
  } catch (error) {
    return mapErrorToHttp(error);
  }
}
