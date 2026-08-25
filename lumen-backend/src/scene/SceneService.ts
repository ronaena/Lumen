import { ProcessingError } from '../processing/errors/ProcessingErrors.js';
import type { BookRepository } from '../repositories/BookRepository.js';
import type { ChapterRepository } from '../repositories/ChapterRepository.js';
import type { TextSegmentRepository } from '../repositories/TextSegmentRepository.js';
import type { SceneRepository, CreateSceneInput, UpdateSceneMetadataInput } from '../repositories/SceneRepository.js';

export interface SceneServiceDeps {
  bookRepo: BookRepository;
  chapterRepo: ChapterRepository;
  textSegmentRepo: TextSegmentRepository;
  sceneRepo: SceneRepository;
}

/**
 * NOTHING in this file infers where a scene begins or ends, what its emotional
 * classification is, or what direction it should carry. Every Scene and every direction
 * value is explicit, caller-supplied input. There is no automatic scene detection,
 * classification, or direction inference here or anywhere else in this codebase — that
 * boundary is intentional and permanent for this phase, matching the identical boundary
 * already established for Character in Phase 7.
 */

async function assertChapterOwnedByUser(deps: SceneServiceDeps, chapterId: string, userId: string) {
  const chapter = await deps.chapterRepo.findById(chapterId);
  if (!chapter) throw new ProcessingError('SCENE_NOT_FOUND');
  const book = await deps.bookRepo.findById(chapter.bookId, userId);
  if (!book) throw new ProcessingError('SCENE_NOT_FOUND');
  return chapter;
}

async function assertSceneOwnedByUser(deps: SceneServiceDeps, sceneId: string, userId: string) {
  const scene = await deps.sceneRepo.findById(sceneId);
  if (!scene) throw new ProcessingError('SCENE_NOT_FOUND');
  await assertChapterOwnedByUser(deps, scene.chapterId, userId);
  return scene;
}

export async function createScene(
  deps: SceneServiceDeps,
  input: {
    userId: string;
    chapterId: string;
    startSegmentId: string;
    endSegmentId: string;
    sceneType?: string;
    emotionalClassification?: string;
    intensity?: string;
    confidence?: string;
  },
) {
  await assertChapterOwnedByUser(deps, input.chapterId, input.userId);

  const startSegment = await deps.textSegmentRepo.findById(input.startSegmentId);
  const endSegment = await deps.textSegmentRepo.findById(input.endSegmentId);
  if (!startSegment || !endSegment) throw new ProcessingError('INVALID_SCENE_REFERENCE');
  if (startSegment.chapterId !== input.chapterId || endSegment.chapterId !== input.chapterId) {
    throw new ProcessingError('INVALID_SCENE_REFERENCE');
  }
  if (startSegment.orderIndex > endSegment.orderIndex) {
    throw new ProcessingError('INVALID_SCENE_REFERENCE');
  }

  const createInput: CreateSceneInput = {
    chapterId: input.chapterId,
    startSegmentId: input.startSegmentId,
    endSegmentId: input.endSegmentId,
    sceneType: input.sceneType,
    emotionalClassification: input.emotionalClassification,
    intensity: input.intensity,
    confidence: input.confidence,
  };
  return deps.sceneRepo.create(createInput);
}

export async function getScene(deps: SceneServiceDeps, input: { userId: string; sceneId: string }) {
  return assertSceneOwnedByUser(deps, input.sceneId, input.userId);
}

/** Lists a chapter's scenes ordered by their start segment's position — no stored orderIndex on Scene itself. */
export async function listScenesForChapter(deps: SceneServiceDeps, input: { userId: string; chapterId: string }) {
  await assertChapterOwnedByUser(deps, input.chapterId, input.userId);
  const sceneRows = await deps.sceneRepo.listByChapter(input.chapterId);

  const withOrder = await Promise.all(
    sceneRows.map(async (scene) => {
      const startSegment = await deps.textSegmentRepo.findById(scene.startSegmentId);
      return { scene, startOrderIndex: startSegment?.orderIndex ?? Number.MAX_SAFE_INTEGER };
    }),
  );
  withOrder.sort((a, b) => a.startOrderIndex - b.startOrderIndex);
  return withOrder.map((entry) => entry.scene);
}

export async function updateSceneMetadata(
  deps: SceneServiceDeps,
  input: { userId: string; sceneId: string } & UpdateSceneMetadataInput,
) {
  await assertSceneOwnedByUser(deps, input.sceneId, input.userId);
  const { userId, sceneId, ...update } = input;
  return deps.sceneRepo.updateMetadata(sceneId, update);
}

/**
 * Sets this scene's direction and cascades it to every TextSegment the scene covers,
 * implementing the approved precedence rule exactly: Scene.direction is authoritative;
 * TextSegment.deliveryDirection becomes the resolved/cached copy. Each covered segment's
 * deliveryDirectionVersion is bumped as part of that cache write, which is what makes
 * narration correctly detect that previously-generated audio for those segments is now
 * stale — no separate "invalidate" step is needed; it falls out of the existing
 * regeneration machinery.
 *
 * This does NOT touch NarrationEngine or the TTS abstraction — narration already reads
 * deliveryDirectionVersion for its own idempotency signature; this only makes sure that
 * field changes when it should.
 */
export async function updateSceneDirection(
  deps: SceneServiceDeps,
  input: { userId: string; sceneId: string; direction: Record<string, unknown> },
) {
  const scene = await assertSceneOwnedByUser(deps, input.sceneId, input.userId);
  const updated = await deps.sceneRepo.updateDirection(input.sceneId, input.direction);

  const startSegment = await deps.textSegmentRepo.findById(scene.startSegmentId);
  const endSegment = await deps.textSegmentRepo.findById(scene.endSegmentId);
  if (startSegment && endSegment) {
    const chapterSegments = await deps.textSegmentRepo.listByChapter(scene.chapterId);
    const covered = chapterSegments.filter(
      (s) => s.orderIndex >= startSegment.orderIndex && s.orderIndex <= endSegment.orderIndex,
    );
    for (const segment of covered) {
      await deps.textSegmentRepo.setDeliveryDirection(segment.id, input.direction);
    }
  }

  return updated;
}

/**
 * Read-only resolution: does a scene cover this segment, and if so, what direction is
 * authoritative for it right now? This is the provider-neutral data boundary a future
 * narration engine could consume — it is NOT wired into NarrationEngine in this phase.
 */
export async function resolveEffectiveDirectionForSegment(
  deps: SceneServiceDeps,
  input: { userId: string; textSegmentId: string },
): Promise<{ sceneId: string | null; direction: Record<string, unknown> | null }> {
  const segment = await deps.textSegmentRepo.findById(input.textSegmentId);
  if (!segment) throw new ProcessingError('SEGMENT_NOT_FOUND');
  await assertChapterOwnedByUser(deps, segment.chapterId, input.userId);

  const scenes = await deps.sceneRepo.listByChapter(segment.chapterId);
  for (const scene of scenes) {
    const startSegment = await deps.textSegmentRepo.findById(scene.startSegmentId);
    const endSegment = await deps.textSegmentRepo.findById(scene.endSegmentId);
    if (!startSegment || !endSegment) continue;
    if (segment.orderIndex >= startSegment.orderIndex && segment.orderIndex <= endSegment.orderIndex) {
      return { sceneId: scene.id, direction: (scene.direction as Record<string, unknown> | null) ?? null };
    }
  }
  return { sceneId: null, direction: (segment.deliveryDirection as Record<string, unknown> | null) ?? null };
}
