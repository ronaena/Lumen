import { assertDefined } from './assertDefined';
import { eq, and, isNull, count } from 'drizzle-orm';
import type { Database } from '../db/client';
import { voices, voiceProviderMappings } from '../db/schema/index';

export class VoiceRepository {
  constructor(private readonly db: Database) {}

  async create(input: typeof voices.$inferInsert) {
    const [voice] = await this.db.insert(voices).values(input).returning();
    return assertDefined(voice, "VoiceRepository.create");
  }

  async findById(voiceId: string) {
    const [voice] = await this.db.select().from(voices).where(eq(voices.id, voiceId));
    return voice ?? null;
  }

  /** Admin-only (Voice Management v1) -- updates voice metadata (displayName/role/language). Never changes id/userId/bookId. */
  async update(voiceId: string, input: Partial<Pick<typeof voices.$inferInsert, 'displayName' | 'role' | 'language'>>) {
    const [voice] = await this.db
      .update(voices)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(voices.id, voiceId))
      .returning();
    return voice ?? null;
  }

  /**
   * Admin-only (Voice Management v1) -- every voice regardless of userId/bookId, for the
   * admin management view. Distinct from listSystemVoices(), which is the public-facing
   * GET /voices query (system voices only) and is intentionally unchanged by this
   * workstream.
   */
  async listAll() {
    return this.db.select().from(voices);
  }

  /**
   * Resolves the same logical Voice into a provider-specific voice ID — this is the exact
   * lookup a mid-chapter fallback uses: same Voice, different provider mapping, never a
   * copied vendor voice ID.
   */
  async findMapping(voiceId: string, provider: string) {
    const [mapping] = await this.db
      .select()
      .from(voiceProviderMappings)
      .where(
        and(
          eq(voiceProviderMappings.voiceId, voiceId),
          eq(voiceProviderMappings.provider, provider),
          eq(voiceProviderMappings.isActive, true),
        ),
      );
    return mapping ?? null;
  }

  /**
   * Voice Management v1 (approved workstream) intentionally supersedes the prior "no
   * user-facing mutation path" restriction on this table -- see voices.ts's schema
   * comment, updated alongside this change. Writes here are now reachable via the
   * admin-only /admin/voices API, gated by the new centralized adminOnly router guard.
   * Ordinary (non-admin) users still have zero mutation capability -- unchanged.
   */
  async createMapping(input: typeof voiceProviderMappings.$inferInsert) {
    const [mapping] = await this.db.insert(voiceProviderMappings).values(input).returning();
    return assertDefined(mapping, "VoiceRepository.createMapping");
  }

  /** Admin-only (Voice Management v1). */
  async listMappingsForVoice(voiceId: string) {
    return this.db.select().from(voiceProviderMappings).where(eq(voiceProviderMappings.voiceId, voiceId));
  }

  async findMappingById(mappingId: string) {
    const [mapping] = await this.db.select().from(voiceProviderMappings).where(eq(voiceProviderMappings.id, mappingId));
    return mapping ?? null;
  }

  /**
   * Admin-only (Voice Management v1). Covers both "update mapping fields" (e.g.
   * providerVoiceId, providerModel) and "enable/disable" (isActive) -- deliberately the
   * same method, since both are just a partial update to the same row.
   */
  async updateMapping(
    mappingId: string,
    input: Partial<Pick<typeof voiceProviderMappings.$inferInsert, 'providerVoiceId' | 'providerModel' | 'isActive'>>,
  ) {
    const [mapping] = await this.db.update(voiceProviderMappings).set(input).where(eq(voiceProviderMappings.id, mappingId)).returning();
    return mapping ?? null;
  }

  /**
   * Gap 3: system/shared voices only (userId IS NULL) — the only voice visibility scope
   * with real evidence supporting it (see the Gap 3 discovery report). Never returns
   * user-owned or book-scoped voices, since production code has no path that creates
   * either today.
   */
  async listSystemVoices() {
    return this.db.select().from(voices).where(isNull(voices.userId));
  }

  /** Admin Dashboard v1 -- safe aggregate counts only, never individual mapping rows/providerVoiceIds. */
  async getCounts(): Promise<{ totalVoices: number; activeMappings: number; inactiveMappings: number }> {
    const [totalVoicesRow] = await this.db.select({ value: count() }).from(voices);
    const [activeRow] = await this.db
      .select({ value: count() })
      .from(voiceProviderMappings)
      .where(eq(voiceProviderMappings.isActive, true));
    const [inactiveRow] = await this.db
      .select({ value: count() })
      .from(voiceProviderMappings)
      .where(eq(voiceProviderMappings.isActive, false));
    return {
      totalVoices: totalVoicesRow?.value ?? 0,
      activeMappings: activeRow?.value ?? 0,
      inactiveMappings: inactiveRow?.value ?? 0,
    };
  }
}
