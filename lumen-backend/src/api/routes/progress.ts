import { z } from 'zod';
import type { ApiRequest, ApiResponse } from '../http/ApiRouter.js';
import type { ApiDeps } from '../ApiDeps.js';
import { updateListeningProgress, updateReadingProgress } from '../../progress/ProgressService.js';
import { mapErrorToHttp, VALIDATION_FAILED, NOT_FOUND } from '../errors/mapErrorToHttp.js';

const ListeningProgressBody = z.object({
  chapterId: z.string().uuid(),
  audioSegmentId: z.string().uuid().optional(),
  playbackPositionMs: z.number().int().nonnegative(),
  completionPct: z.string(),
});

const ReadingProgressBody = z.object({
  chapterId: z.string().uuid(),
  textSegmentId: z.string().uuid().optional(),
  readingPositionOffset: z.number().int().nonnegative().optional(),
  completionPct: z.string(),
});

export async function handleUpdateListeningProgress(deps: ApiDeps, req: ApiRequest): Promise<ApiResponse> {
  const parsed = ListeningProgressBody.safeParse(req.body);
  if (!parsed.success) return { status: 400, body: VALIDATION_FAILED(parsed.error.message).body };

  try {
    const updated = await updateListeningProgress(deps, {
      userId: req.identity!.userId,
      bookId: req.params.bookId!,
      ...parsed.data,
    });
    return { status: 200, body: updated };
  } catch (error) {
    return mapErrorToHttp(error);
  }
}

export async function handleGetListeningProgress(deps: ApiDeps, req: ApiRequest): Promise<ApiResponse> {
  const bookId = req.params.bookId!;
  const book = await deps.bookRepo.findById(bookId, req.identity!.userId);
  if (!book) return NOT_FOUND;
  const progress = await deps.listeningProgressRepo.findByUserAndBook(req.identity!.userId, bookId);
  if (!progress) return NOT_FOUND;
  return { status: 200, body: progress };
}

export async function handleUpdateReadingProgress(deps: ApiDeps, req: ApiRequest): Promise<ApiResponse> {
  const parsed = ReadingProgressBody.safeParse(req.body);
  if (!parsed.success) return { status: 400, body: VALIDATION_FAILED(parsed.error.message).body };

  try {
    const updated = await updateReadingProgress(deps, {
      userId: req.identity!.userId,
      bookId: req.params.bookId!,
      ...parsed.data,
    });
    return { status: 200, body: updated };
  } catch (error) {
    return mapErrorToHttp(error);
  }
}

export async function handleGetReadingProgress(deps: ApiDeps, req: ApiRequest): Promise<ApiResponse> {
  const bookId = req.params.bookId!;
  const book = await deps.bookRepo.findById(bookId, req.identity!.userId);
  if (!book) return NOT_FOUND;
  const progress = await deps.readingProgressRepo.findByUserAndBook(req.identity!.userId, bookId);
  if (!progress) return NOT_FOUND;
  return { status: 200, body: progress };
}
