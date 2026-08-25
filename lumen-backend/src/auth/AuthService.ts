import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { ProcessingError } from '../processing/errors/ProcessingErrors';
import type { UserRepository } from '../repositories/UserRepository';
import type { UserCredentialRepository } from '../repositories/UserCredentialRepository';
import type { SessionRepository } from '../repositories/SessionRepository';
import type { AdminAuditLogRepository, AuditLogFilters } from '../repositories/AdminAuditLogRepository';

// TypeScript's promisify(scrypt) doesn't correctly resolve the options-overload's
// callback signature — a known typing quirk, not a design choice — so this wraps the
// callback form directly against the exact overload being used, fully typed.
function scryptAsync(password: string, salt: string, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

// Documented scrypt parameters appropriate for password storage (matching Node's own
// documented recommendation: N=2^14, r=8, p=1). Fixed constants, not stored per-row —
// see userCredentials.ts for why per-row parameter versioning isn't needed in Phase 12.
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, per the approved default

export interface AuthServiceDeps {
  userRepo: UserRepository;
  userCredentialRepo: UserCredentialRepository;
  sessionRepo: SessionRepository;
  /**
   * Admin Audit Log v1 (approved workstream). Optional -- absent means audit logging is
   * a genuine no-op, not a crash. Kept optional specifically so the 13 existing test
   * files that construct AuthService without it continue to compile and work completely
   * unchanged; only tests that actually exercise audit logging, and the real production
   * entrypoint (main.ts), need to supply it.
   */
  auditLogRepo?: AdminAuditLogRepository;
}

export interface RegisterInput {
  email: string;
  password: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

async function hashPassword(password: string): Promise<{ hash: string; salt: string }> {
  const salt = randomBytes(16).toString('hex');
  const derived = await scryptAsync(password, salt, SCRYPT_KEYLEN);
  return { hash: derived.toString('hex'), salt };
}

async function verifyPassword(password: string, storedHashHex: string, saltHex: string): Promise<boolean> {
  const derived = await scryptAsync(password, saltHex, SCRYPT_KEYLEN);
  const stored = Buffer.from(storedHashHex, 'hex');
  if (derived.length !== stored.length) return false;
  return timingSafeEqual(derived, stored);
}

function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

/**
 * AuthService — register, login, logout, and session validation. Deliberately thin:
 * every persistence operation goes through UserRepository / UserCredentialRepository /
 * SessionRepository, never a direct query here. This service owns exactly the
 * authentication concern — it never touches ownership/business logic belonging to any
 * other service.
 */
export class AuthService {
  constructor(private readonly deps: AuthServiceDeps) {}

  /** Returns safe user info only — never the credential. */
  async register(input: RegisterInput) {
    const email = normalizeEmail(input.email);
    const existing = await this.deps.userRepo.findByEmail(email);
    if (existing) {
      throw new ProcessingError('EMAIL_ALREADY_REGISTERED');
    }

    const user = await this.deps.userRepo.create({ email });
    const { hash, salt } = await hashPassword(input.password);
    await this.deps.userCredentialRepo.create({ userId: user.id, passwordHash: hash, passwordSalt: salt });

    return { id: user.id, email: user.email, createdAt: user.createdAt };
  }

  /** Returns the raw session token — the ONLY time it ever exists outside this call. */
  async login(input: LoginInput): Promise<{ token: string; expiresAt: Date }> {
    const email = normalizeEmail(input.email);
    const user = await this.deps.userRepo.findByEmail(email);

    // Do the same amount of "work" (a scrypt call) whether the user exists or not, using
    // a fixed dummy salt when there's no real credential to check against — this keeps
    // response time from becoming a side channel revealing whether an email is
    // registered, on top of the identical error message already doing so.
    const credential = user ? await this.deps.userCredentialRepo.findByUserId(user.id) : null;
    const dummySalt = '00000000000000000000000000000000';
    const passwordMatches = credential
      ? await verifyPassword(input.password, credential.passwordHash, credential.passwordSalt)
      : await verifyPassword(input.password, dummySalt, dummySalt).then(() => false);

    if (!user || !credential || !passwordMatches) {
      throw new ProcessingError('AUTHENTICATION_FAILED');
    }
    // Disabled users get the exact same error/message as a wrong password -- never
    // reveal that an account exists-but-is-disabled, consistent with this function's
    // existing timing/message non-distinguishing design.
    if (user.deletedAt) {
      throw new ProcessingError('AUTHENTICATION_FAILED');
    }

    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

    await this.deps.sessionRepo.create({ userId: user.id, tokenHash, expiresAt });

    return { token: rawToken, expiresAt };
  }

  /** Deleting an already-invalid token is a safe no-op — logout is always "successful" from the client's view. */
  async logout(rawToken: string): Promise<void> {
    const tokenHash = hashToken(rawToken);
    await this.deps.sessionRepo.deleteByTokenHash(tokenHash);
  }

  /**
   * Revokes every session for a user, including the one used to call this endpoint. The
   * request that triggered this already had its identity resolved before this method
   * runs (the router resolves identity once, up front), so this response still succeeds
   * normally — it's only the NEXT request with any of those tokens that will correctly
   * fail as unauthenticated, since the underlying session rows no longer exist.
   */
  async logoutAll(userId: string): Promise<void> {
    await this.deps.sessionRepo.deleteAllByUserId(userId);
  }

  /**
   * Changes a user's password after re-verifying their current one. Re-verification is
   * deliberate: an authenticated session alone is not sufficient to silently replace the
   * credential — this guards against an unattended-but-logged-in session being escalated
   * into a permanent account takeover.
   */
  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    const credential = await this.deps.userCredentialRepo.findByUserId(userId);
    if (!credential) {
      throw new ProcessingError('AUTHENTICATION_FAILED');
    }

    const currentMatches = await verifyPassword(currentPassword, credential.passwordHash, credential.passwordSalt);
    if (!currentMatches) {
      throw new ProcessingError('AUTHENTICATION_FAILED');
    }

    const { hash, salt } = await hashPassword(newPassword);
    await this.deps.userCredentialRepo.update(userId, { passwordHash: hash, passwordSalt: salt });
  }

  /**
   * Validates a raw bearer token and returns the trusted userId + role, or null. This is
   * the exact function sessionIdentityResolver calls — it never inspects anything except
   * the token itself. role is resolved from the database here, the same trusted,
   * server-side path as userId — never client-supplied.
   *
   * Admin User Management v1: re-checks user.deletedAt on EVERY call, not just at login.
   * This is what makes a disabled user's existing session stop working on their very
   * next authenticated request -- no session rows are deleted, the rejection is dynamic
   * and re-evaluated here every time, since this function already fetches the user row
   * for role resolution regardless.
   */
  async validateSession(rawToken: string): Promise<{ userId: string; role: 'user' | 'admin' } | null> {
    const tokenHash = hashToken(rawToken);
    const session = await this.deps.sessionRepo.findValidByTokenHash(tokenHash);
    if (!session) return null;
    const user = await this.deps.userRepo.findById(session.userId);
    if (!user) return null;
    if (user.deletedAt) return null;
    return { userId: session.userId, role: user.role };
  }

  /** Voice Management v1 UI: backs GET /auth/me -- returns the caller's own identity/role, never anyone else's. */
  async getUserById(userId: string): Promise<{ userId: string; email: string; role: 'user' | 'admin' } | null> {
    const user = await this.deps.userRepo.findById(userId);
    if (!user) return null;
    return { userId: user.id, email: user.email, role: user.role };
  }

  /** Admin Dashboard v1 -- delegates to UserRepository.getCounts(), the same "AuthService is the sole API-layer gateway to user data" pattern already used everywhere else in this class. */
  async getUserCounts(): Promise<{ total: number; admins: number }> {
    return this.deps.userRepo.getCounts();
  }

  // ==================== Admin User Management v1 ====================

  /** Explicitly constructed DTO -- never a raw repository row. Never includes passwordHash, sessions, or any credential. */
  private toSafeUser(user: {
    id: string;
    email: string;
    displayName: string | null;
    role: 'user' | 'admin';
    deletedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }): SafeAdminUser {
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      disabled: user.deletedAt !== null,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

  async listUsersForAdmin(): Promise<SafeAdminUser[]> {
    const users = await this.deps.userRepo.listAll();
    return users.map((u) => this.toSafeUser(u));
  }

  async getUserForAdmin(userId: string): Promise<SafeAdminUser | null> {
    const user = await this.deps.userRepo.findById(userId);
    if (!user) return null;
    return this.toSafeUser(user);
  }

  /** Admin Audit Log v1: fire-and-forget, non-blocking write -- a logging failure must never break the actual admin action. */
  private async audit(entry: {
    adminUserId: string;
    action: string;
    targetType: string;
    targetId: string | null;
    result: 'success' | 'failure';
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    if (!this.deps.auditLogRepo) return;
    try {
      await this.deps.auditLogRepo.record(entry);
    } catch {
      // Deliberately swallowed -- an audit-log write failure must never surface as, or
      // be confused with, a failure of the actual admin action it's describing.
    }
  }

  /**
   * Admin User Management v1. Demoting the last remaining ACTIVE admin is rejected --
   * countActiveAdmins() already excludes disabled admins, so demoting an already-disabled
   * admin never trips this (they weren't functioning as an admin anyway). Promotion is
   * never restricted -- it can only increase admin capacity, never remove it.
   */
  async changeUserRole(adminUserId: string, targetUserId: string, newRole: 'user' | 'admin'): Promise<SafeAdminUser | null> {
    const target = await this.deps.userRepo.findById(targetUserId);
    if (!target) {
      await this.audit({ adminUserId, action: 'USER_ROLE_CHANGED', targetType: 'user', targetId: targetUserId, result: 'failure' });
      return null;
    }

    if (newRole === 'user' && target.role === 'admin' && !target.deletedAt) {
      const activeAdmins = await this.deps.userRepo.countActiveAdmins();
      if (activeAdmins <= 1) {
        await this.audit({
          adminUserId,
          action: 'USER_ROLE_CHANGED',
          targetType: 'user',
          targetId: targetUserId,
          result: 'failure',
          metadata: { fromRole: target.role, toRole: newRole },
        });
        throw new ProcessingError('CANNOT_REMOVE_LAST_ADMIN');
      }
    }

    const updated = await this.deps.userRepo.updateRole(targetUserId, newRole);
    await this.audit({
      adminUserId,
      action: 'USER_ROLE_CHANGED',
      targetType: 'user',
      targetId: targetUserId,
      result: updated ? 'success' : 'failure',
      metadata: { fromRole: target.role, toRole: newRole },
    });
    return updated ? this.toSafeUser(updated) : null;
  }

  /**
   * Admin User Management v1.
   * disabled=true: rejects self-disable unconditionally (rule 1), and rejects disabling
   * the last remaining active admin (rule 3) -- both checked before any write.
   * disabled=false (enable): no restriction: re-enabling only ever restores capacity, it
   * can never leave the system without an admin.
   */
  async setUserDisabled(callerUserId: string, targetUserId: string, disabled: boolean): Promise<SafeAdminUser | null> {
    const action = 'USER_STATUS_CHANGED';
    if (disabled && targetUserId === callerUserId) {
      await this.audit({ adminUserId: callerUserId, action, targetType: 'user', targetId: targetUserId, result: 'failure', metadata: { disabled } });
      throw new ProcessingError('CANNOT_DISABLE_SELF');
    }

    const target = await this.deps.userRepo.findById(targetUserId);
    if (!target) {
      await this.audit({ adminUserId: callerUserId, action, targetType: 'user', targetId: targetUserId, result: 'failure', metadata: { disabled } });
      return null;
    }

    if (disabled && target.role === 'admin' && !target.deletedAt) {
      const activeAdmins = await this.deps.userRepo.countActiveAdmins();
      if (activeAdmins <= 1) {
        await this.audit({ adminUserId: callerUserId, action, targetType: 'user', targetId: targetUserId, result: 'failure', metadata: { disabled } });
        throw new ProcessingError('CANNOT_REMOVE_LAST_ADMIN');
      }
    }

    const updated = await this.deps.userRepo.setDisabled(targetUserId, disabled);
    await this.audit({
      adminUserId: callerUserId,
      action,
      targetType: 'user',
      targetId: targetUserId,
      result: updated ? 'success' : 'failure',
      metadata: { disabled },
    });
    return updated ? this.toSafeUser(updated) : null;
  }

  /** Admin Audit Log v1 read path -- reuses the same auditLogRepo already held for writes. */
  /** Admin Audit Log Filtering v1: filters is optional, passed straight through to the repository. */
  async listAuditLog(limit: number, offset: number, filters?: AuditLogFilters) {
    if (!this.deps.auditLogRepo) return [];
    return this.deps.auditLogRepo.list(limit, offset, filters);
  }

  /**
   * Small accessor so route-registration code for areas with no dedicated service
   * (voice/mapping mutations, handled directly against ApiDeps in adminVoices.ts) can
   * reach the same auditLogRepo AuthService already holds, rather than threading a new
   * top-level parameter through createApiServer/createApiRouter -- which would touch
   * every one of their 14+ existing call sites for no benefit.
   */
  getAuditLogRepo(): AdminAuditLogRepository | undefined {
    return this.deps.auditLogRepo;
  }
}

export interface SafeAdminUser {
  id: string;
  email: string;
  displayName: string | null;
  role: 'user' | 'admin';
  disabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
