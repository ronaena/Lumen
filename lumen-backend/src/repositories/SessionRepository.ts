import { eq, and, gt } from 'drizzle-orm';
import type { Database } from '../db/client';
import { sessions } from '../db/schema/index';
import { assertDefined } from './assertDefined';

export interface CreateSessionInput {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
}

/**
 * SessionRepository — the only place session rows are read or written. Every lookup here
 * takes a tokenHash (already derived by the caller from the raw bearer token), never the
 * raw token itself — this repository has no method that could leak or compare against a
 * plaintext credential.
 */
export class SessionRepository {
  constructor(private readonly db: Database) {}

  async create(input: CreateSessionInput) {
    const [row] = await this.db.insert(sessions).values(input).returning();
    return assertDefined(row, 'SessionRepository.create');
  }

  /** Returns the session only if it exists AND has not expired. */
  async findValidByTokenHash(tokenHash: string) {
    const [row] = await this.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, new Date())));
    return row ?? null;
  }

  /** Deletes by tokenHash — used for logout. Deleting a nonexistent/already-expired session is a safe no-op. */
  async deleteByTokenHash(tokenHash: string): Promise<void> {
    await this.db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
  }

  /** Revokes every session belonging to a user — used by logout-all. Scoped strictly by userId. */
  async deleteAllByUserId(userId: string): Promise<void> {
    await this.db.delete(sessions).where(eq(sessions.userId, userId));
  }
}
