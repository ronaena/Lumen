import { eq, count, and, isNull } from 'drizzle-orm';
import type { Database } from '../db/client';
import { users } from '../db/schema/index';
import { assertDefined } from './assertDefined';

export interface CreateUserInput {
  email: string;
  displayName?: string;
}

export class UserRepository {
  constructor(private readonly db: Database) {}

  async create(input: CreateUserInput) {
    const [row] = await this.db.insert(users).values(input).returning();
    return assertDefined(row, 'UserRepository.create');
  }

  async findByEmail(email: string) {
    const [row] = await this.db.select().from(users).where(eq(users.email, email));
    return row ?? null;
  }

  async findById(userId: string) {
    const [row] = await this.db.select().from(users).where(eq(users.id, userId));
    return row ?? null;
  }

  /** Voice Management v1 (approved workstream) -- used only by the operator-run promoteUserToAdmin script, never by any HTTP route. */
  async updateRole(userId: string, role: 'user' | 'admin') {
    const [row] = await this.db.update(users).set({ role, updatedAt: new Date() }).where(eq(users.id, userId)).returning();
    return row ?? null;
  }

  /** Admin Dashboard v1 -- safe aggregate counts only, never individual user rows/emails. */
  async getCounts(): Promise<{ total: number; admins: number }> {
    const [totalRow] = await this.db.select({ value: count() }).from(users);
    const [adminRow] = await this.db.select({ value: count() }).from(users).where(eq(users.role, 'admin'));
    return { total: totalRow?.value ?? 0, admins: adminRow?.value ?? 0 };
  }

  /** Admin User Management v1. */
  async listAll() {
    return this.db.select().from(users);
  }

  /**
   * Admin User Management v1. Count of currently-enabled admins -- the exact quantity
   * last-admin protection depends on. A disabled admin is deliberately NOT counted here:
   * they can't act as an admin either way, so counting them would let the system reach a
   * state with zero functioning admins while technically satisfying a naive "count >= 1"
   * check.
   */
  async countActiveAdmins(): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(users)
      .where(and(eq(users.role, 'admin'), isNull(users.deletedAt)));
    return row?.value ?? 0;
  }

  /**
   * Admin User Management v1 (approved workstream). users.deletedAt is the approved,
   * reused mechanism for "disabled" -- confirmed dormant (unreferenced anywhere in
   * application code) before this workstream reused it. Setting it non-null means: (1)
   * AuthService.login() rejects future login attempts, (2) AuthService.validateSession()
   * rejects the user's existing sessions on their very next authenticated request (no
   * session rows are deleted -- the check is dynamic and re-evaluated every time).
   * Enable is the same method with disabled=false, setting deletedAt back to null. This
   * never deletes the user row itself.
   */
  async setDisabled(userId: string, disabled: boolean) {
    const [row] = await this.db
      .update(users)
      .set({ deletedAt: disabled ? new Date() : null, updatedAt: new Date() })
      .where(eq(users.id, userId))
      .returning();
    return row ?? null;
  }
}
