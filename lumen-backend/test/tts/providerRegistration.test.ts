import { describe, it, expect, vi } from 'vitest';
import { buildProviderRegistry } from '../../src/main.js';
import { loadEnv } from '../../src/config/env.js';

const REAL_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://lumen:lumen@localhost:5432/lumen_test';

describe('ElevenLabs provider registration (real TTS / voice configuration wiring)', () => {
  it('ELEVENLABS_API_KEY absent -> registry remains exactly as empty as before this workstream', () => {
    const env = loadEnv({ DATABASE_URL: REAL_DATABASE_URL });
    const registry = buildProviderRegistry(env);
    expect(registry.listRegisteredProviderIds()).toEqual([]);
  });

  it('ELEVENLABS_API_KEY present -> ElevenLabs is registered', () => {
    const env = loadEnv({ DATABASE_URL: REAL_DATABASE_URL, ELEVENLABS_API_KEY: 'fake-test-key-not-real' });
    const registry = buildProviderRegistry(env);
    expect(registry.listRegisteredProviderIds()).toEqual(['elevenlabs']);
  });

  it('an empty-string ELEVENLABS_API_KEY is rejected by config validation, not silently treated as present', () => {
    expect(() => loadEnv({ DATABASE_URL: REAL_DATABASE_URL, ELEVENLABS_API_KEY: '' })).toThrow();
  });

  it('no secret leakage: the constructed registry never exposes the raw API key anywhere inspectable', () => {
    const secretKey = 'sk-definitely-a-secret-value-12345';
    const env = loadEnv({ DATABASE_URL: REAL_DATABASE_URL, ELEVENLABS_API_KEY: secretKey });
    const registry = buildProviderRegistry(env);

    const serialized = JSON.stringify(registry);
    expect(serialized ?? '').not.toContain(secretKey);

    const ids = registry.listRegisteredProviderIds();
    expect(ids.every((id) => typeof id === 'string' && !id.includes(secretKey))).toBe(true);
  });

  it('no secret leakage: console.log/console.error are never called with the API key during registration', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const secretKey = 'sk-another-secret-value-67890';
      const env = loadEnv({ DATABASE_URL: REAL_DATABASE_URL, ELEVENLABS_API_KEY: secretKey });
      buildProviderRegistry(env);

      const allLoggedArgs = [...logSpy.mock.calls, ...errorSpy.mock.calls].flat();
      expect(allLoggedArgs.some((arg) => typeof arg === 'string' && arg.includes(secretKey))).toBe(false);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('startup wiring still works without any credentials (registry construction does not throw)', () => {
    const env = loadEnv({ DATABASE_URL: REAL_DATABASE_URL });
    expect(() => buildProviderRegistry(env)).not.toThrow();
  });

  it('Google remains unwired regardless of ElevenLabs key presence', () => {
    const env = loadEnv({ DATABASE_URL: REAL_DATABASE_URL, ELEVENLABS_API_KEY: 'fake-key' });
    const registry = buildProviderRegistry(env);
    expect(registry.listRegisteredProviderIds()).not.toContain('google_cloud_tts');
  });
});
