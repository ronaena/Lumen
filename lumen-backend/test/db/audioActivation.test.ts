import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getTestDb, resetDatabase, createTextSegmentFixture } from './setup.js';
import { NarrationAttemptRepository } from '../../src/repositories/NarrationAttemptRepository.js';
import { AudioSegmentRepository } from '../../src/repositories/AudioSegmentRepository.js';
import { TextSegmentRepository } from '../../src/repositories/TextSegmentRepository.js';
import { computeRequestSignature } from '../../src/domain/narration/requestSignature.js';

describe('AudioSegment atomic activation (PIPE-5)', () => {
  const db = getTestDb();
  const attemptRepo = new NarrationAttemptRepository(db);
  const audioRepo = new AudioSegmentRepository(db);
  const textSegmentRepo = new TextSegmentRepository(db);

  beforeEach(async () => {
    await resetDatabase();
  });

  async function makeCompletedAttempt(
    segmentId: string,
    voiceId: string,
    contentHash: string,
    attemptNumber = 1,
    deliveryDirectionVersion = 1,
  ) {
    const signature = computeRequestSignature({
      textSegmentId: segmentId,
      contentHash,
      narratorVoiceId: voiceId,
      deliveryDirectionVersion,
      provider: 'elevenlabs',
      modelUsed: 'eleven_multilingual_v2',
    });
    const attempt = await attemptRepo.create({
      textSegmentId: segmentId,
      attemptNumber,
      provider: 'elevenlabs',
      requestId: randomUUID(),
      requestSignature: signature,
    });
    await attemptRepo.complete(attempt.id, { status: 'succeeded' });
    return attempt;
  }

  it('first activation sets currentAudioSegmentId and status=active, with no prior segment to supersede', async () => {
    const { segment, voice } = await createTextSegmentFixture(db, 'audio1');
    const attempt = await makeCompletedAttempt(segment.id, voice.id, segment.contentHash);

    const audioSegment = await audioRepo.activateAudioSegment({
      textSegmentId: segment.id,
      producedByAttemptId: attempt.id,
      storageRef: 's3://bucket/seg1-v1.mp3',
      provider: 'elevenlabs',
      modelUsed: 'eleven_multilingual_v2',
      providerVoiceId: 'vendor-voice-abc',
      durationMs: 4200,
      format: 'mp3',
      sampleRateHz: 44100,
      fileSizeBytes: 67000,
      checksum: 'audio-checksum-1',
      estimatedCost: '0.002100',
      generationSignature: 'gen-sig-1',
    });

    expect(audioSegment.status).toBe('active');

    const updatedSegment = await textSegmentRepo.findById(segment.id);
    expect(updatedSegment!.currentAudioSegmentId).toBe(audioSegment.id);
    expect(updatedSegment!.narrationStatus).toBe('ready');
  });

  it('regeneration atomically supersedes the prior active segment and re-points currentAudioSegmentId', async () => {
    const { segment, voice } = await createTextSegmentFixture(db, 'audio2');
    const firstAttempt = await makeCompletedAttempt(segment.id, voice.id, segment.contentHash, 1, 1);

    const firstAudio = await audioRepo.activateAudioSegment({
      textSegmentId: segment.id,
      producedByAttemptId: firstAttempt.id,
      storageRef: 's3://bucket/seg2-v1.mp3',
      provider: 'elevenlabs',
      modelUsed: 'eleven_multilingual_v2',
      providerVoiceId: 'vendor-voice-abc',
      durationMs: 4000,
      format: 'mp3',
      sampleRateHz: 44100,
      fileSizeBytes: 65000,
      checksum: 'audio-checksum-v1',
      estimatedCost: '0.002000',
      generationSignature: 'gen-sig-v1',
    });

    const secondAttempt = await makeCompletedAttempt(segment.id, voice.id, segment.contentHash, 2, 2);

    const secondAudio = await audioRepo.activateAudioSegment({
      textSegmentId: segment.id,
      producedByAttemptId: secondAttempt.id,
      storageRef: 's3://bucket/seg2-v2.mp3',
      provider: 'elevenlabs',
      modelUsed: 'eleven_multilingual_v2',
      providerVoiceId: 'vendor-voice-abc',
      durationMs: 4300,
      format: 'mp3',
      sampleRateHz: 44100,
      fileSizeBytes: 68000,
      checksum: 'audio-checksum-v2',
      estimatedCost: '0.002200',
      generationSignature: 'gen-sig-v2',
    });

    // Old artifact is superseded, NOT deleted.
    const reloadedFirst = await audioRepo.findById(firstAudio.id);
    expect(reloadedFirst!.status).toBe('superseded');

    // New artifact is active.
    const reloadedSecond = await audioRepo.findById(secondAudio.id);
    expect(reloadedSecond!.status).toBe('active');

    // currentAudioSegmentId now resolves to the NEW segment.
    const updatedTextSegment = await textSegmentRepo.findById(segment.id);
    expect(updatedTextSegment!.currentAudioSegmentId).toBe(secondAudio.id);

    // Exactly one active segment exists at a time for this text segment.
    const active = await audioRepo.findActiveForTextSegment(segment.id);
    expect(active!.id).toBe(secondAudio.id);
  });
});
