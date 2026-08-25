import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getTestDb, resetDatabase, createTextSegmentFixture } from './setup.js';
import { NarrationAttemptRepository } from '../../src/repositories/NarrationAttemptRepository.js';
import { computeRequestSignature } from '../../src/domain/narration/requestSignature.js';

describe('NarrationAttempt constraints', () => {
  const db = getTestDb();
  const attemptRepo = new NarrationAttemptRepository(db);

  beforeEach(async () => {
    await resetDatabase();
  });

  it('rejects a duplicate requestId', async () => {
    const { segment, voice } = await createTextSegmentFixture(db, 'attempt1');
    const requestId = randomUUID();
    const signature = computeRequestSignature({
      textSegmentId: segment.id,
      contentHash: segment.contentHash,
      narratorVoiceId: voice.id,
      deliveryDirectionVersion: 1,
      provider: 'elevenlabs',
      modelUsed: 'eleven_multilingual_v2',
    });

    await attemptRepo.create({
      textSegmentId: segment.id,
      attemptNumber: 1,
      provider: 'elevenlabs',
      requestId,
      requestSignature: signature,
    });

    // Complete the first attempt so a second attemptNumber is legal — isolating this
    // test to purely the requestId uniqueness constraint, not the one-processing rule.
    const first = await attemptRepo.findByRequestId(requestId);
    await attemptRepo.complete(first!.id, { status: 'failed', normalizedErrorCode: 'TRANSIENT_ERROR' });

    await expect(
      attemptRepo.create({
        textSegmentId: segment.id,
        attemptNumber: 2,
        provider: 'elevenlabs',
        requestId, // same requestId reused — must be rejected
        requestSignature: signature,
      }),
    ).rejects.toMatchObject({ cause: { code: '23505' } });
  });

  it('rejects a second simultaneous processing attempt for the same TextSegment (DB-5)', async () => {
    const { segment, voice } = await createTextSegmentFixture(db, 'attempt2');
    const signature = computeRequestSignature({
      textSegmentId: segment.id,
      contentHash: segment.contentHash,
      narratorVoiceId: voice.id,
      deliveryDirectionVersion: 1,
      provider: 'elevenlabs',
      modelUsed: 'eleven_multilingual_v2',
    });

    await attemptRepo.create({
      textSegmentId: segment.id,
      attemptNumber: 1,
      provider: 'elevenlabs',
      requestId: randomUUID(),
      requestSignature: signature,
    });

    // Second attempt created without completing the first — both would be 'processing'.
    await expect(
      attemptRepo.create({
        textSegmentId: segment.id,
        attemptNumber: 2,
        provider: 'elevenlabs',
        requestId: randomUUID(),
        requestSignature: signature,
      }),
    ).rejects.toMatchObject({ cause: { code: '23505' } });
  });

  it('allows a second attempt once the first is completed, and preserves history', async () => {
    const { segment, voice } = await createTextSegmentFixture(db, 'attempt3');
    const signature = computeRequestSignature({
      textSegmentId: segment.id,
      contentHash: segment.contentHash,
      narratorVoiceId: voice.id,
      deliveryDirectionVersion: 1,
      provider: 'elevenlabs',
      modelUsed: 'eleven_multilingual_v2',
    });

    const first = await attemptRepo.create({
      textSegmentId: segment.id,
      attemptNumber: 1,
      provider: 'elevenlabs',
      requestId: randomUUID(),
      requestSignature: signature,
    });
    await attemptRepo.complete(first.id, { status: 'failed', normalizedErrorCode: 'RATE_LIMITED' });

    const second = await attemptRepo.create({
      textSegmentId: segment.id,
      attemptNumber: 2,
      provider: 'elevenlabs',
      requestId: randomUUID(),
      requestSignature: signature,
    });

    const history = await attemptRepo.listByTextSegment(segment.id);
    expect(history).toHaveLength(2);
    expect(history[0]!.status).toBe('failed'); // first attempt's history is intact, not overwritten
    expect(history[1]!.id).toBe(second.id);
  });

  it('a fallback attempt correctly references its triggeringAttemptId, forming a traceable chain', async () => {
    const { segment, voice } = await createTextSegmentFixture(db, 'attempt4');
    const signature = computeRequestSignature({
      textSegmentId: segment.id,
      contentHash: segment.contentHash,
      narratorVoiceId: voice.id,
      deliveryDirectionVersion: 1,
      provider: 'elevenlabs',
      modelUsed: 'eleven_multilingual_v2',
    });

    const primaryAttempt = await attemptRepo.create({
      textSegmentId: segment.id,
      attemptNumber: 1,
      provider: 'elevenlabs',
      requestId: randomUUID(),
      requestSignature: signature,
    });
    await attemptRepo.complete(primaryAttempt.id, {
      status: 'failed',
      normalizedErrorCode: 'PROVIDER_UNAVAILABLE',
    });

    const fallbackSignature = computeRequestSignature({
      textSegmentId: segment.id,
      contentHash: segment.contentHash,
      narratorVoiceId: voice.id,
      deliveryDirectionVersion: 1,
      provider: 'google_cloud_tts',
      modelUsed: 'chirp3-hd',
    });
    const fallbackAttempt = await attemptRepo.create({
      textSegmentId: segment.id,
      attemptNumber: 2,
      provider: 'google_cloud_tts',
      requestId: randomUUID(),
      requestSignature: fallbackSignature,
      isFallbackAttempt: true,
      triggeringAttemptId: primaryAttempt.id,
    });
    await attemptRepo.complete(fallbackAttempt.id, { status: 'succeeded' });

    const chain = await attemptRepo.getFallbackChain(fallbackAttempt.id);
    expect(chain).toHaveLength(2);
    expect(chain[0]!.id).toBe(primaryAttempt.id);
    expect(chain[0]!.provider).toBe('elevenlabs');
    expect(chain[1]!.id).toBe(fallbackAttempt.id);
    expect(chain[1]!.provider).toBe('google_cloud_tts');
    expect(chain[1]!.isFallbackAttempt).toBe(true);
  });
});
