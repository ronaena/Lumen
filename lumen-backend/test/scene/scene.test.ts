import { describe, it, expect, beforeEach } from 'vitest';
import { getTestDb, resetDatabase, createTestUser } from '../db/setup.js';
import { BookRepository } from '../../src/repositories/BookRepository.js';
import { ChapterRepository } from '../../src/repositories/ChapterRepository.js';
import { TextSegmentRepository } from '../../src/repositories/TextSegmentRepository.js';
import { VoiceRepository } from '../../src/repositories/VoiceRepository.js';
import { SceneRepository } from '../../src/repositories/SceneRepository.js';
import {
  createScene,
  getScene,
  listScenesForChapter,
  updateSceneMetadata,
  updateSceneDirection,
  resolveEffectiveDirectionForSegment,
} from '../../src/scene/SceneService.js';

describe('Phase 8: Scene / Direction Foundation (live Postgres)', () => {
  const db = getTestDb();
  const bookRepo = new BookRepository(db);
  const chapterRepo = new ChapterRepository(db);
  const textSegmentRepo = new TextSegmentRepository(db);
  const voiceRepo = new VoiceRepository(db);
  const sceneRepo = new SceneRepository(db);

  const deps = { bookRepo, chapterRepo, textSegmentRepo, sceneRepo };

  beforeEach(async () => {
    await resetDatabase();
  });

  async function makeChapterWithSegments(count = 4) {
    const user = await createTestUser(db, `scene-${Date.now()}-${Math.random()}@example.com`);
    const voice = await voiceRepo.create({ displayName: 'Narrator', role: 'narrator', language: 'en' });
    const book = await bookRepo.create({ userId: user.id, title: 'Scene Test Book', language: 'en' });
    const chapter = await chapterRepo.create({ bookId: book.id, orderIndex: 0, sourceLocation: 'ch1' });
    const segments = [];
    for (let i = 0; i < count; i += 1) {
      segments.push(
        await textSegmentRepo.create({
          chapterId: chapter.id,
          orderIndex: i,
          sourceText: `Sentence ${i}.`,
          normalizedText: `Sentence ${i}.`,
          charCount: 10,
          sourceReference: `p[${i}]`,
          contentHash: `hash-${i}`,
          narratorVoiceId: voice.id,
        }),
      );
    }
    return { user, book, chapter, segments };
  }

  it('A + B: creates and retrieves a scene', async () => {
    const { user, chapter, segments } = await makeChapterWithSegments();
    const scene = await createScene(deps, {
      userId: user.id,
      chapterId: chapter.id,
      startSegmentId: segments[0]!.id,
      endSegmentId: segments[1]!.id,
      sceneType: 'suspense',
    });

    const fetched = await getScene(deps, { userId: user.id, sceneId: scene.id });
    expect(fetched.id).toBe(scene.id);
    expect(fetched.sceneType).toBe('suspense');
  });

  it('C: lists scenes for a chapter ordered by start segment position, not creation order', async () => {
    const { user, chapter, segments } = await makeChapterWithSegments();
    const laterScene = await createScene(deps, {
      userId: user.id,
      chapterId: chapter.id,
      startSegmentId: segments[2]!.id,
      endSegmentId: segments[3]!.id,
    });
    const earlierScene = await createScene(deps, {
      userId: user.id,
      chapterId: chapter.id,
      startSegmentId: segments[0]!.id,
      endSegmentId: segments[1]!.id,
    });

    const listed = await listScenesForChapter(deps, { userId: user.id, chapterId: chapter.id });
    expect(listed.map((s) => s.id)).toEqual([earlierScene.id, laterScene.id]);
  });

  it('D: updates scene metadata', async () => {
    const { user, chapter, segments } = await makeChapterWithSegments();
    const scene = await createScene(deps, {
      userId: user.id,
      chapterId: chapter.id,
      startSegmentId: segments[0]!.id,
      endSegmentId: segments[0]!.id,
    });

    const updated = await updateSceneMetadata(deps, {
      userId: user.id,
      sceneId: scene.id,
      sceneType: 'action',
      intensity: '0.90',
    });
    expect(updated!.sceneType).toBe('action');
    expect(updated!.intensity).toBe('0.90');
  });

  it('E: scene is correctly associated with its chapter/book', async () => {
    const { user, chapter, book, segments } = await makeChapterWithSegments();
    const scene = await createScene(deps, {
      userId: user.id,
      chapterId: chapter.id,
      startSegmentId: segments[0]!.id,
      endSegmentId: segments[0]!.id,
    });
    expect(scene.chapterId).toBe(chapter.id);
    const chapterRow = await chapterRepo.findById(scene.chapterId);
    expect(chapterRow!.bookId).toBe(book.id);
  });

  it('F: cross-user isolation — another user cannot retrieve or update this scene', async () => {
    const { user, chapter, segments } = await makeChapterWithSegments();
    const scene = await createScene(deps, {
      userId: user.id,
      chapterId: chapter.id,
      startSegmentId: segments[0]!.id,
      endSegmentId: segments[0]!.id,
    });

    const otherUser = await createTestUser(db, `scene-other-${Date.now()}@example.com`);
    await expect(getScene(deps, { userId: otherUser.id, sceneId: scene.id })).rejects.toMatchObject({
      code: 'SCENE_NOT_FOUND',
    });
    await expect(
      updateSceneMetadata(deps, { userId: otherUser.id, sceneId: scene.id, sceneType: 'hacked' }),
    ).rejects.toMatchObject({ code: 'SCENE_NOT_FOUND' });
  });

  it('G + L: cross-book isolation — a scene cannot reference segments from a different book/chapter', async () => {
    const { user, chapter } = await makeChapterWithSegments();
    const otherBook = await bookRepo.create({ userId: user.id, title: 'Other Book', language: 'en' });
    const otherChapter = await chapterRepo.create({ bookId: otherBook.id, orderIndex: 0, sourceLocation: 'x' });
    const otherVoice = await voiceRepo.create({ displayName: 'V', role: 'narrator', language: 'en' });
    const otherSegment = await textSegmentRepo.create({
      chapterId: otherChapter.id,
      orderIndex: 0,
      sourceText: 'X.',
      normalizedText: 'X.',
      charCount: 2,
      sourceReference: 'p[0]',
      contentHash: 'hx',
      narratorVoiceId: otherVoice.id,
    });

    await expect(
      createScene(deps, {
        userId: user.id,
        chapterId: chapter.id,
        startSegmentId: otherSegment.id,
        endSegmentId: otherSegment.id,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_SCENE_REFERENCE' });
  });

  it('H + I + J: SceneDirection (the direction jsonb field) creation/retrieval/update', async () => {
    const { user, chapter, segments } = await makeChapterWithSegments();
    const scene = await createScene(deps, {
      userId: user.id,
      chapterId: chapter.id,
      startSegmentId: segments[0]!.id,
      endSegmentId: segments[1]!.id,
    });
    expect(scene.direction).toBeNull();

    await updateSceneDirection(deps, {
      userId: user.id,
      sceneId: scene.id,
      direction: { emotion: 'tense', pace: 0.6 },
    });

    const fetched = await getScene(deps, { userId: user.id, sceneId: scene.id });
    expect(fetched.direction).toEqual({ emotion: 'tense', pace: 0.6 });

    await updateSceneDirection(deps, {
      userId: user.id,
      sceneId: scene.id,
      direction: { emotion: 'calm', pace: 0.3 },
    });
    const refetched = await getScene(deps, { userId: user.id, sceneId: scene.id });
    expect(refetched.direction).toEqual({ emotion: 'calm', pace: 0.3 });
  });

  it('K + M: Scene.direction is authoritative and cascades to covered TextSegments as the resolved/cached value, versioned for regeneration', async () => {
    const { user, chapter, segments } = await makeChapterWithSegments();
    const scene = await createScene(deps, {
      userId: user.id,
      chapterId: chapter.id,
      startSegmentId: segments[1]!.id,
      endSegmentId: segments[2]!.id,
    });

    const versionBefore = (await textSegmentRepo.findById(segments[1]!.id))!.deliveryDirectionVersion;

    await updateSceneDirection(deps, {
      userId: user.id,
      sceneId: scene.id,
      direction: { emotion: 'suspenseful', intensity: 0.8 },
    });

    const covered1 = await textSegmentRepo.findById(segments[1]!.id);
    const covered2 = await textSegmentRepo.findById(segments[2]!.id);
    const outsideBefore = await textSegmentRepo.findById(segments[0]!.id);
    const outsideAfter = await textSegmentRepo.findById(segments[3]!.id);

    expect(covered1!.deliveryDirection).toEqual({ emotion: 'suspenseful', intensity: 0.8 });
    expect(covered2!.deliveryDirection).toEqual({ emotion: 'suspenseful', intensity: 0.8 });
    expect(covered1!.deliveryDirectionVersion).toBe(versionBefore + 1);

    expect(outsideBefore!.deliveryDirection).toBeNull();
    expect(outsideAfter!.deliveryDirection).toBeNull();

    const resolvedCovered = await resolveEffectiveDirectionForSegment(deps, {
      userId: user.id,
      textSegmentId: segments[1]!.id,
    });
    expect(resolvedCovered.sceneId).toBe(scene.id);
    expect(resolvedCovered.direction).toEqual({ emotion: 'suspenseful', intensity: 0.8 });

    const resolvedOutside = await resolveEffectiveDirectionForSegment(deps, {
      userId: user.id,
      textSegmentId: segments[0]!.id,
    });
    expect(resolvedOutside.sceneId).toBeNull();
  });

  it('N: repeated identical direction updates are idempotent in effect', async () => {
    const { user, chapter, segments } = await makeChapterWithSegments();
    const scene = await createScene(deps, {
      userId: user.id,
      chapterId: chapter.id,
      startSegmentId: segments[0]!.id,
      endSegmentId: segments[0]!.id,
    });

    await updateSceneDirection(deps, { userId: user.id, sceneId: scene.id, direction: { emotion: 'calm' } });
    const afterFirst = await textSegmentRepo.findById(segments[0]!.id);

    await updateSceneDirection(deps, { userId: user.id, sceneId: scene.id, direction: { emotion: 'calm' } });
    const afterSecond = await textSegmentRepo.findById(segments[0]!.id);

    expect(afterSecond!.deliveryDirection).toEqual(afterFirst!.deliveryDirection);
    const first = await getScene(deps, { userId: user.id, sceneId: scene.id });
    const second = await getScene(deps, { userId: user.id, sceneId: scene.id });
    expect(first).toEqual(second);
  });

  it('rejects a scene whose start segment comes after its end segment', async () => {
    const { user, chapter, segments } = await makeChapterWithSegments();
    await expect(
      createScene(deps, {
        userId: user.id,
        chapterId: chapter.id,
        startSegmentId: segments[2]!.id,
        endSegmentId: segments[0]!.id,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_SCENE_REFERENCE' });
  });

  describe('negative scope checks — proving Phase 8 performs NO automatic behavior', () => {
    it('no scene is ever created without an explicit caller-supplied create call', async () => {
      const { chapter } = await makeChapterWithSegments();
      const scenes = await sceneRepo.listByChapter(chapter.id);
      expect(scenes).toHaveLength(0);
    });

    it('no scene classification/type is ever inferred — an unspecified sceneType stays null', async () => {
      const { user, chapter, segments } = await makeChapterWithSegments();
      const scene = await createScene(deps, {
        userId: user.id,
        chapterId: chapter.id,
        startSegmentId: segments[0]!.id,
        endSegmentId: segments[0]!.id,
      });
      expect(scene.sceneType).toBeNull();
      expect(scene.emotionalClassification).toBeNull();
      expect(scene.confidence).toBeNull();
    });

    it('the source tree contains no scene-detection/classification/inference implementation', async () => {
      const fs = await import('node:fs');
      const content = fs.readFileSync('src/scene/SceneService.ts', 'utf8');
      const codeWithoutComments = content.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(codeWithoutComments).not.toMatch(/detect|classify|infer|nlp|llm/i);
    });

    it('no dialogue attribution logic exists anywhere in the scene module', async () => {
      const fs = await import('node:fs');
      const content = fs.readFileSync('src/scene/SceneService.ts', 'utf8');
      expect(content.toLowerCase()).not.toContain('dialogue');
    });
  });
});
