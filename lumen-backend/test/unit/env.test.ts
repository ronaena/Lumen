import { describe, it, expect } from 'vitest';
import { loadEnv } from '../../src/config/env.js';

describe('loadEnv — the single config boundary', () => {
  it('accepts a well-formed postgres:// connection string', () => {
    const env = loadEnv({ DATABASE_URL: 'postgres://user:pass@localhost:5432/db' });
    expect(env.DATABASE_URL).toBe('postgres://user:pass@localhost:5432/db');
  });

  it('accepts a well-formed postgresql:// connection string', () => {
    const env = loadEnv({ DATABASE_URL: 'postgresql://user:pass@localhost:5432/db' });
    expect(env.DATABASE_URL).toBe('postgresql://user:pass@localhost:5432/db');
  });

  it('fails clearly when DATABASE_URL is missing entirely', () => {
    expect(() => loadEnv({})).toThrow(/Invalid environment configuration/);
  });

  it('fails clearly when DATABASE_URL is empty', () => {
    expect(() => loadEnv({ DATABASE_URL: '' })).toThrow(/Invalid environment configuration/);
  });

  it('fails clearly when DATABASE_URL is malformed (not a postgres connection string)', () => {
    // This is the exact gap Phase 10 hardening closed: previously any non-empty string
    // passed, so a typo like this would only fail much later with an opaque pg error.
    expect(() => loadEnv({ DATABASE_URL: 'not-a-url' })).toThrow(/Invalid environment configuration/);
  });

  it('does not read from real process.env when a source is explicitly provided', () => {
    // Confirms test config can never accidentally fall through to whatever happens to
    // be in the real environment.
    const env = loadEnv({ DATABASE_URL: 'postgresql://explicit-source-only/db', SOME_OTHER_VAR: 'x' } as NodeJS.ProcessEnv);
    expect(env.DATABASE_URL).toBe('postgresql://explicit-source-only/db');
  });
});
