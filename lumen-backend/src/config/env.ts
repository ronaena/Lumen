import { z } from 'zod';

/**
 * The single config boundary for this codebase. All environment access goes through
 * here — nothing else reads process.env directly. No TTS provider credentials are read,
 * validated, or referenced anywhere in this codebase — confirmed by repository-wide
 * search (see README.md's "Not included" section). The production entrypoint
 * (src/main.ts) deliberately constructs an empty ProviderRegistry(); real provider
 * credential loading is a separate, unapproved future workstream.
 */
const envSchema = z.object({
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .regex(
      /^postgres(ql)?:\/\/.+/,
      'DATABASE_URL must be a postgres:// or postgresql:// connection string',
    ),
  PORT: z.coerce.number().int().positive().default(3000),
  STORAGE_ROOT: z.string().min(1).default('./storage-data'),
  /**
   * Optional. Present -> main.ts registers a real ElevenLabsProvider at startup.
   * Absent -> ProviderRegistry stays exactly as empty as before this workstream, and
   * every existing credential-free test/deployment path is unaffected. Never logged,
   * never referenced outside provider construction -- confirmed by repository-wide
   * search before this workstream began.
   */
  ELEVENLABS_API_KEY: z.string().min(1).optional(),
  /**
   * Remote Deployment v1 (approved workstream). Optional -- when set, main.ts also
   * serves the frontend's built static files (and falls back to index.html for
   * client-side routes) from this directory, from the SAME process/port as the API.
   * Absent in dev mode (Vite's own dev server handles static assets) and in every
   * existing test -- zero effect unless explicitly configured for a single-service
   * production deployment.
   */
  FRONTEND_STATIC_ROOT: z.string().min(1).optional(),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new Error(`Invalid environment configuration: ${result.error.message}`);
  }
  return result.data;
}
