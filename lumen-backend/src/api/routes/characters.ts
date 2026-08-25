import { z } from 'zod';
import type { ApiRequest, ApiResponse } from '../http/ApiRouter.js';
import type { ApiDeps } from '../ApiDeps.js';
import { createCharacter, assignCharacterVoice, assignSegmentToCharacter } from '../../character/CharacterService.js';
import { mapErrorToHttp, VALIDATION_FAILED, NOT_FOUND } from '../errors/mapErrorToHttp.js';

const CreateCharacterBody = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
});

const AssignVoiceBody = z.object({
  voiceId: z.string().uuid(),
});

const AssignSegmentBody = z.object({
  characterId: z.string().uuid(),
});

export async function handleCreateCharacter(deps: ApiDeps, req: ApiRequest): Promise<ApiResponse> {
  const parsed = CreateCharacterBody.safeParse(req.body);
  if (!parsed.success) return { status: 400, body: VALIDATION_FAILED(parsed.error.message).body };
  try {
    const character = await createCharacter(deps, {
      userId: req.identity!.userId,
      bookId: req.params.bookId!,
      name: parsed.data.name,
      description: parsed.data.description,
    });
    return { status: 201, body: character };
  } catch (error) {
    return mapErrorToHttp(error);
  }
}

export async function handleAssignCharacterVoice(deps: ApiDeps, req: ApiRequest): Promise<ApiResponse> {
  const parsed = AssignVoiceBody.safeParse(req.body);
  if (!parsed.success) return { status: 400, body: VALIDATION_FAILED(parsed.error.message).body };
  try {
    const assignment = await assignCharacterVoice(deps, {
      userId: req.identity!.userId,
      characterId: req.params.characterId!,
      voiceId: parsed.data.voiceId,
    });
    return { status: 200, body: assignment };
  } catch (error) {
    return mapErrorToHttp(error);
  }
}

export async function handleAssignSegmentToCharacter(deps: ApiDeps, req: ApiRequest): Promise<ApiResponse> {
  const parsed = AssignSegmentBody.safeParse(req.body);
  if (!parsed.success) return { status: 400, body: VALIDATION_FAILED(parsed.error.message).body };
  try {
    const updated = await assignSegmentToCharacter(deps, {
      userId: req.identity!.userId,
      textSegmentId: req.params.textSegmentId!,
      characterId: parsed.data.characterId,
    });
    return { status: 200, body: updated };
  } catch (error) {
    return mapErrorToHttp(error);
  }
}

/**
 * GET /books/:bookId/characters — reuses CharacterRepository.listByBook(bookId) exactly
 * as it already existed. Ownership is the same direct bookRepo.findById(bookId, userId)
 * check used by handleGetBook/handleListChapters — a missing or not-owned book both
 * surface as the same 404.
 */
export async function handleListCharacters(deps: ApiDeps, req: ApiRequest): Promise<ApiResponse> {
  const bookId = req.params.bookId!;
  const book = await deps.bookRepo.findById(bookId, req.identity!.userId);
  if (!book) {
    return NOT_FOUND;
  }
  const characters = await deps.characterRepo.listByBook(bookId);
  return { status: 200, body: characters };
}
