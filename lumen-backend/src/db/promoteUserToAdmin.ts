/**
 * promoteUserToAdmin.ts — Voice Management v1's approved admin-bootstrap mechanism.
 *
 * Deliberately mirrors seedSystemVoices.ts's existing pattern: a standalone,
 * operator-run script, never registered as an HTTP route, never callable by any client.
 * This is the standard, safe resolution to role-based systems' inherent bootstrap
 * paradox (you need an admin to create an admin, except the first one).
 *
 * Usage: tsx src/db/promoteUserToAdmin.ts <email>
 *
 * Behavior (all explicitly required, see Voice Management v1 approval):
 *  1. Requires exactly one email argument.
 *  2. Normalizes/validates the email the same way the rest of the user model does
 *     (reuses AuthService's own normalizeEmail, never a separate implementation).
 *  3. Fails if the user does not exist -- never creates one.
 *  4. Updates only that user's role to 'admin'.
 *  5. Idempotent -- running it again on an existing admin succeeds without creating
 *     anything or erroring.
 *  6. Never prints passwords, session tokens, DATABASE_URL, or any other secret --
 *     only the target email and the resulting role are ever logged.
 */
import { createDatabase } from './client.js';
import { UserRepository } from '../repositories/UserRepository.js';
import { normalizeEmail } from '../auth/AuthService.js';

export async function promoteUserToAdmin(userRepo: UserRepository, rawEmail: string): Promise<void> {
  const email = normalizeEmail(rawEmail);
  const user = await userRepo.findByEmail(email);
  if (!user) {
    throw new Error(`No user found with email ${email}. This script never creates a user -- register the account first.`);
  }
  if (user.role === 'admin') {
    console.log(`${email} is already an admin. No change made.`);
    return;
  }
  await userRepo.updateRole(user.id, 'admin');
  console.log(`${email} promoted to admin.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !args[0]) {
    console.error('Usage: tsx src/db/promoteUserToAdmin.ts <email>');
    console.error('Exactly one email argument is required.');
    process.exit(1);
  }

  const { loadEnv } = await import('../config/env.js');
  const env = loadEnv();
  const db = createDatabase(env.DATABASE_URL);
  const userRepo = new UserRepository(db);

  try {
    await promoteUserToAdmin(userRepo, args[0]);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
