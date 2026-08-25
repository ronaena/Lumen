import { defineConfig } from 'drizzle-kit';

// Phase 1 scope: schema + migrations only. No application wiring, no API, no auth.
// DATABASE_URL is read from the environment — never hard-coded, never committed.
// See .env.example for the shape expected locally/in CI.
export default defineConfig({
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://localhost:5432/lumen_dev',
  },
  strict: true,
  verbose: true,
});
