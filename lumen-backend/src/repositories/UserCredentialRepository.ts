import { eq } from 'drizzle-orm';
import type { Database } from '../db/client';
import { userCredentials } from '../db/schema/index';
import { assertDefined } from './assertDefined';

export interface CreateUserCredentialInput {
  userId: string;
  passwordHash: string;
  passwordSalt: string;
}

/**
 * UserCredentialRepository — the only place password hash/salt material is read or
 * written. No plaintext password is ever accepted or returned here — AuthService hashes
 * before calling create(), and callers of findByUserId() get back the stored
 * hash/salt only to perform a comparison, never to display or log.
 */
export class UserCredentialRepository {
  constructor(private readonly db: Database) {}

  async create(input: CreateUserCredentialInput) {
    const [row] = await this.db.insert(userCredentials).values(input).returning();
    return assertDefined(row, 'UserCredentialRepository.create');
  }

  async findByUserId(userId: string) {
    const [row] = await this.db.select().from(userCredentials).where(eq(userCredentials.userId, userId));
    return row ?? null;
  }

  /** Replaces the hash/salt for an existing credential record — used by password change. */
  async update(userId: string, input: { passwordHash: string; passwordSalt: string }) {
    const [row] = await this.db
      .update(userCredentials)
      .set({ passwordHash: input.passwordHash, passwordSalt: input.passwordSalt, updatedAt: new Date() })
      .where(eq(userCredentials.userId, userId))
      .returning();
    return row ?? null;
  }
}
