import type { ApiRequest, ApiResponse } from '../http/ApiRouter';
import type { ApiDeps } from '../ApiDeps';
import { ProcessingError } from '../../processing/errors/ProcessingErrors';
import { mapErrorToHttp } from '../errors/mapErrorToHttp';

const FORMAT_TO_MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg_opus: 'audio/ogg',
};

/**
 * GET /segments/:textSegmentId/audio — Gap 2.
 *
 * Ownership walks textSegment -> chapter -> book -> user, the exact same pattern used
 * by every list-content route added in the prior workstream. storageRef is NEVER
 * exposed to the client at any point -- it's resolved to bytes here and discarded; the
 * opaque `local://...` string itself never appears in any response body or header.
 *
 * "No active audio" and "storage read failed" are both deliberately mapped to the same
 * SEGMENT_NOT_FOUND -> 404 as "segment doesn't exist" and "not owned" -- this is
 * consistent with the whole codebase's existing never-distinguish-why convention, and
 * additionally means a storage-layer inconsistency (DB row present, file missing) never
 * leaks a distinguishable signal to the client, nor any raw Node fs error text.
 */
export async function handleGetAudio(deps: ApiDeps, req: ApiRequest): Promise<ApiResponse> {
  const textSegmentId = req.params.textSegmentId!;
  try {
    const segment = await deps.textSegmentRepo.findById(textSegmentId);
    if (!segment) throw new ProcessingError('SEGMENT_NOT_FOUND');

    const chapter = await deps.chapterRepo.findById(segment.chapterId);
    if (!chapter) throw new ProcessingError('SEGMENT_NOT_FOUND');

    const book = await deps.bookRepo.findById(chapter.bookId, req.identity!.userId);
    if (!book) throw new ProcessingError('SEGMENT_NOT_FOUND');

    const audioSegment = await deps.audioSegmentRepo.findActiveForTextSegment(textSegmentId);
    if (!audioSegment) throw new ProcessingError('SEGMENT_NOT_FOUND');

    let bytes: Buffer;
    try {
      bytes = await deps.storage.read(audioSegment.storageRef);
    } catch {
      throw new ProcessingError('SEGMENT_NOT_FOUND');
    }

    const contentType = FORMAT_TO_MIME[audioSegment.format] ?? 'application/octet-stream';
    return {
      status: 200,
      body: bytes,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(bytes.byteLength),
      },
    };
  } catch (error) {
    return mapErrorToHttp(error);
  }
}
