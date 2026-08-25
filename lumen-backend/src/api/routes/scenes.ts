import { z } from 'zod';
import type { ApiRequest, ApiResponse } from '../http/ApiRouter.js';
import type { ApiDeps } from '../ApiDeps.js';
import { createScene, getScene, listScenesForChapter, updateSceneDirection } from '../../scene/SceneService.js';
import { mapErrorToHttp, VALIDATION_FAILED, NOT_FOUND } from '../errors/mapErrorToHttp.js';

const CreateSceneBody = z.object({
  startSegmentId: z.string().uuid(),
  endSegmentId: z.string().uuid(),
  sceneType: z.string().optional(),
  emotionalClassification: z.string().optional(),
});

const UpdateDirectionBody = z.object({
  direction: z.record(z.string(), z.unknown()),
});

export async function handleCreateScene(deps: ApiDeps, req: ApiRequest): Promise<ApiResponse> {
  const parsed = CreateSceneBody.safeParse(req.body);
  if (!parsed.success) return { status: 400, body: VALIDATION_FAILED(parsed.error.message).body };
  try {
    const scene = await createScene(deps, {
      userId: req.identity!.userId,
      chapterId: req.params.chapterId!,
      ...parsed.data,
    });
    return { status: 201, body: scene };
  } catch (error) {
    return mapErrorToHttp(error);
  }
}

export async function handleListScenes(deps: ApiDeps, req: ApiRequest): Promise<ApiResponse> {
  try {
    const scenes = await listScenesForChapter(deps, {
      userId: req.identity!.userId,
      chapterId: req.params.chapterId!,
    });
    return { status: 200, body: scenes };
  } catch (error) {
    return mapErrorToHttp(error);
  }
}

export async function handleGetScene(deps: ApiDeps, req: ApiRequest): Promise<ApiResponse> {
  try {
    const scene = await getScene(deps, { userId: req.identity!.userId, sceneId: req.params.sceneId! });
    return { status: 200, body: scene };
  } catch (error) {
    return mapErrorToHttp(error);
  }
}

export async function handleUpdateSceneDirection(deps: ApiDeps, req: ApiRequest): Promise<ApiResponse> {
  const parsed = UpdateDirectionBody.safeParse(req.body);
  if (!parsed.success) return { status: 400, body: VALIDATION_FAILED(parsed.error.message).body };
  try {
    const updated = await updateSceneDirection(deps, {
      userId: req.identity!.userId,
      sceneId: req.params.sceneId!,
      direction: parsed.data.direction,
    });
    if (!updated) return NOT_FOUND;
    return { status: 200, body: updated };
  } catch (error) {
    return mapErrorToHttp(error);
  }
}
