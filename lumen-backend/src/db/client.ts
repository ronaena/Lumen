import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema/index';

export type Database = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Creates a Drizzle database client bound to the given connection string.
 * Deliberately takes the URL as a parameter rather than reading env internally, so tests
 * can point at a disposable test database without touching global config.
 */
export function createDatabase(connectionString: string): Database {
  const pool = new Pool({ connectionString });
  return drizzle(pool, { schema });
}

/**
 * Like createDatabase, but also returns the underlying pg Pool so a caller can close it
 * cleanly (pool.end()) on shutdown. Deliberately a separate function rather than a
 * changed signature on createDatabase -- that function has 4 existing call sites
 * (migrate.ts, seedSystemVoices.ts, progress.test.ts, test/db/setup.ts), none of which
 * need pool access, and changing its return shape would touch all of them for no
 * benefit. Used only by the production entrypoint (src/main.ts).
 */
export function createDatabaseWithPool(connectionString: string): { db: Database; pool: Pool } {
  const pool = new Pool({ connectionString });
  return { db: drizzle(pool, { schema }), pool };
}
