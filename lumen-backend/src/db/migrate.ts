import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDatabase } from './client';
import { loadEnv } from '../config/env';

async function main(): Promise<void> {
  const env = loadEnv();
  const db = createDatabase(env.DATABASE_URL);
  await migrate(db, { migrationsFolder: './drizzle' });
  // eslint-disable-next-line no-console
  console.log('Migrations applied successfully.');
  process.exit(0);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Migration failed:', error);
  process.exit(1);
});
