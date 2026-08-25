import { z } from 'zod';
import type { ApiRequest, ApiResponse } from '../http/ApiRouter.js';
import type { ApiDeps } from '../ApiDeps.js';
import { ingestBook } from '../../processing/pipeline/processBook.js';
import { mapErrorToHttp, VALIDATION_FAILED, NOT_FOUND } from '../errors/mapErrorToHttp.js';

/**
 * Binary EPUB content travels as base64 inside the JSON body rather than multipart
 * form-data — this avoids adding a multipart-parsing dependency for Phase 11. Revisit
 * if/when a real upload UX requires streaming large files directly.
 */
const IngestBookBody = z.object({
  filename: z.string().min(1),
  mimeType: z.string().min(1),
  fileBase64: z.string().min(1),
  narratorVoiceId: z.string().uuid(),
});

export async function handleIngestBook(deps: ApiDeps, req: ApiRequest): Promise<ApiResponse> {
  const parsed = IngestBookBody.safeParse(req.body);
  if (!parsed.success) {
    return { status: 400, body: VALIDATION_FAILED(parsed.error.message).body };
  }

  try {
    const buffer = Buffer.from(parsed.data.fileBase64, 'base64');
    const result = await ingestBook(deps, {
      userId: req.identity!.userId,
      buffer,
      filename: parsed.data.filename,
      mimeType: parsed.data.mimeType,
      narratorVoiceId: parsed.data.narratorVoiceId,
    });
    return {
      status: 201,
      body: {
        bookId: result.bookId,
        processingJobId: result.processingJobId,
        chapterCount: result.chapterCount,
        segmentCount: result.segmentCount,
      },
    };
  } catch (error) {
    return mapErrorToHttp(error);
  }
}

export async function handleGetBook(deps: ApiDeps, req: ApiRequest): Promise<ApiResponse> {
  const bookId = req.params.bookId!;
  const book = await deps.bookRepo.findById(bookId, req.identity!.userId);
  if (!book) {
    return NOT_FOUND;
  }
  return {
    status: 200,
    body: {
      id: book.id,
      title: book.title,
      author: book.author,
      status: book.status,
      chapterCount: book.chapterCount,
      segmentCount: book.segmentCount,
      createdAt: book.createdAt,
    },
  };
}

/**
 * GET /books — list every book owned by the authenticated user. Reuses
 * BookRepository.listByUser(userId), which already existed and was already correctly
 * scoped by userId before this route did. No repository change was needed. Response
 * fields deliberately mirror GET /books/:bookId exactly — same shape, just an array.
 */
export async function handleListBooks(deps: ApiDeps, req: ApiRequest): Promise<ApiResponse> {
  const books = await deps.bookRepo.listByUser(req.identity!.userId);
  return {
    status: 200,
    body: books.map((book) => ({
      id: book.id,
      title: book.title,
      author: book.author,
      status: book.status,
      chapterCount: book.chapterCount,
      segmentCount: book.segmentCount,
      createdAt: book.createdAt,
    })),
  };
}
