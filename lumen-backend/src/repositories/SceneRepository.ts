import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { scenes } from '../db/schema/index.js';
import { assertDefined } from './assertDefined.js';

export interface CreateSceneInput {
  chapterId: string;
  startSegmentId: string;
  endSegmentId: string;
  sceneType?: string;
  emotionalClassification?: string;
  intensity?: string;
  confidence?: string;
  direction?: Record<string, unknown>;
}

export interface UpdateSceneMetadataInput {
  sceneType?: string;
  emotionalClassification?: string;
  intensity?: string;
  confidence?: string;
}

/**
 * SceneRepository — plain CRUD only. No deletion method exists: the approved schema has
 * no soft-delete field (no deletedAt) and no documented retention policy for Scene, so
 * per the Phase 8 instruction ("safe deletion only if deletion semantics are explicitly
 * supported"), deletion is deliberately NOT implemented this phase rather than invented.
 */
export class SceneRepository {
  constructor(private readonly db: Database) {}

  async create(input: CreateSceneInput) {
    const [row] = await this.db.insert(scenes).values(input).returning();
    return assertDefined(row, 'SceneRepository.create');
  }

  async findById(sceneId: string) {
    const [row] = await this.db.select().from(scenes).where(eq(scenes.id, sceneId));
    return row ?? null;
  }

  async listByChapter(chapterId: string) {
    return this.db.select().from(scenes).where(eq(scenes.chapterId, chapterId));
  }

  async updateMetadata(sceneId: string, update: UpdateSceneMetadataInput) {
    const [row] = await this.db.update(scenes).set(update).where(eq(scenes.id, sceneId)).returning();
    return row ?? null;
  }

  /** Direction is the "SceneDirection" concept — a jsonb field on this same table. */
  async updateDirection(sceneId: string, direction: Record<string, unknown>) {
    const [row] = await this.db.update(scenes).set({ direction }).where(eq(scenes.id, sceneId)).returning();
    return row ?? null;
  }
}
