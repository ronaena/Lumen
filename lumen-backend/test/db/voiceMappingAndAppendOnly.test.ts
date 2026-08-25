import { describe, it, expect, beforeEach } from 'vitest';
import { getTestDb, resetDatabase } from './setup.js';
import { VoiceRepository } from '../../src/repositories/VoiceRepository.js';
import { NarrationAttemptRepository } from '../../src/repositories/NarrationAttemptRepository.js';
import { ProviderUsageRepository } from '../../src/repositories/ProviderUsageRepository.js';

describe('VoiceProviderMapping uniqueness', () => {
  const db = getTestDb();
  const voiceRepo = new VoiceRepository(db);

  beforeEach(async () => {
    await resetDatabase();
  });

  it('enforces one active mapping per (voiceId, provider)', async () => {
    const voice = await voiceRepo.create({ displayName: 'Narrator', role: 'narrator', language: 'en' });

    await voiceRepo.createMapping({
      voiceId: voice.id,
      provider: 'elevenlabs',
      providerVoiceId: 'vendor-voice-1',
    });

    await expect(
      voiceRepo.createMapping({
        voiceId: voice.id,
        provider: 'elevenlabs',
        providerVoiceId: 'vendor-voice-2', // different vendor ID, same voice+provider — still a conflict
      }),
    ).rejects.toMatchObject({ cause: { code: '23505' } });
  });

  it('allows the same voice to have mappings for different providers', async () => {
    const voice = await voiceRepo.create({ displayName: 'Narrator', role: 'narrator', language: 'en' });

    const elevenLabsMapping = await voiceRepo.createMapping({
      voiceId: voice.id,
      provider: 'elevenlabs',
      providerVoiceId: 'vendor-voice-1',
    });
    const googleMapping = await voiceRepo.createMapping({
      voiceId: voice.id,
      provider: 'google_cloud_tts',
      providerVoiceId: 'en-US-Studio-O',
    });

    // Fallback resolution: same logical Voice, different vendor ID per provider.
    expect(elevenLabsMapping.providerVoiceId).not.toBe(googleMapping.providerVoiceId);
    const resolvedForGoogle = await voiceRepo.findMapping(voice.id, 'google_cloud_tts');
    expect(resolvedForGoogle!.providerVoiceId).toBe('en-US-Studio-O');
  });
});

describe('Append-only repository boundaries', () => {
  it('NarrationAttemptRepository exposes no generic update method', () => {
    const proto = NarrationAttemptRepository.prototype;
    const methodNames = Object.getOwnPropertyNames(proto);
    expect(methodNames).not.toContain('update');
    // Only `create` (new attempt) and the guarded one-time `complete` may mutate rows.
    expect(methodNames).toContain('create');
    expect(methodNames).toContain('complete');
  });

  it('ProviderUsageRepository exposes no update method at all', () => {
    const proto = ProviderUsageRepository.prototype;
    const methodNames = Object.getOwnPropertyNames(proto);
    expect(methodNames).not.toContain('update');
    expect(methodNames).toContain('record');
  });
});
