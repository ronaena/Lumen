import { randomUUID } from 'node:crypto';
import type { StorageProvider } from '../processing/storage/StorageProvider.js';
import { computeFileChecksum } from '../processing/checksum.js';
import { ProcessingError } from '../processing/errors/ProcessingErrors.js';
import { computeRequestSignature } from '../domain/narration/requestSignature.js';
import type { NarrationRequest } from '../domain/narration/NarrationRequest.js';
import type { MoneyAmount } from '../domain/shared/types.js';
import type { ProviderRegistry } from '../tts/ProviderRegistry.js';
import type { TextSegmentRepository } from '../repositories/TextSegmentRepository.js';
import type { VoiceRepository } from '../repositories/VoiceRepository.js';
import type { NarrationAttemptRepository } from '../repositories/NarrationAttemptRepository.js';
import type { AudioSegmentRepository } from '../repositories/AudioSegmentRepository.js';
import type { ProviderUsageRepository } from '../repositories/ProviderUsageRepository.js';

export interface NarrationEngineDeps {
  storage: StorageProvider;
  registry: ProviderRegistry;
  textSegmentRepo: TextSegmentRepository;
  voiceRepo: VoiceRepository;
  narrationAttemptRepo: NarrationAttemptRepository;
  audioSegmentRepo: AudioSegmentRepository;
  providerUsageRepo: ProviderUsageRepository;
}

export interface NarrateSegmentInput {
  textSegmentId: string;
  bookId: string;
  chapterId: string;
  userId: string;
  costCeiling?: MoneyAmount;
}

export interface NarrateSegmentResult {
  /** True when existing valid audio was reused — no attempt or cost was incurred. */
  skipped: boolean;
  audioSegmentId?: string;
  /** The full ordered chain of attempts made this call (1 entry unless fallback occurred). */
  attemptIds: string[];
  failed: boolean;
  lastErrorCode?: string;
}

/**
 * Default model per provider. A per-request override could later flow through
 * NarrationRequest.providerOptions.<provider>.modelId — not needed for Phase 4 MVP,
 * where each provider is used with one standard model.
 */
const DEFAULT_MODEL_BY_PROVIDER: Record<string, string> = {
  elevenlabs: 'eleven_multilingual_v2',
  google_cloud_tts: 'chirp3_hd',
};

// Rough MP3 bitrate assumption used ONLY to estimate audio duration when a provider
// response doesn't include one. This is an ESTIMATE, not a decoded value — real duration
// extraction would need an audio-parsing dependency, which is out of Phase 4 scope. Any
// consumer of AudioSegment.durationMs should treat it as approximate until a future phase
// adds real decoding.
const ASSUMED_MP3_BITRATE_BPS = 128_000;

function estimateDurationMs(byteLength: number): number {
  return Math.round((byteLength * 8 * 1000) / ASSUMED_MP3_BITRATE_BPS);
}

/**
 * Narrates exactly one TextSegment. This is the unit of work for the entire engine — no
 * chapter- or book-level regeneration exists here or anywhere else in this codebase.
 *
 * Idempotency: before doing any work, compares the target generation signature (content +
 * voice + delivery-direction version + provider + model) against the current active
 * AudioSegment's generationSignature. If they match, this call is a no-op — no new
 * NarrationAttempt, no cost incurred, matching "same content + same voice + same
 * direction + same provider/model -> reusable."
 *
 * Fallback: iterates ProviderRegistry's eligible providers in order. A retryable failure
 * moves to the next eligible provider, creating a new NarrationAttempt with
 * triggeringAttemptId pointing at the one that failed — preserving the complete,
 * reconstructable audit chain. A non-retryable failure, or exhausting all providers,
 * ends the loop with the segment marked failed; no successful previous audio is ever
 * touched by a failed attempt.
 */
export async function narrateSegment(
  deps: NarrationEngineDeps,
  input: NarrateSegmentInput,
): Promise<NarrateSegmentResult> {
  const { storage, registry, textSegmentRepo, voiceRepo, narrationAttemptRepo, audioSegmentRepo, providerUsageRepo } =
    deps;

  const segment = await textSegmentRepo.findById(input.textSegmentId);
  if (!segment) throw new ProcessingError('SEGMENT_NOT_FOUND');

  // The EFFECTIVE voice for this segment: a character voice takes precedence over the
  // book's narrator voice when one is assigned (Phase 7). This must be used consistently
  // everywhere a "voice" is needed below — resolving the Voice row, computing the
  // signature, and resolving the vendor mapping — or a character-voice reassignment
  // would silently fail to invalidate cached audio (the signature wouldn't change even
  // though the actual narrating voice should).
  const effectiveVoiceId = segment.characterVoiceId ?? segment.narratorVoiceId;
  const voice = await voiceRepo.findById(effectiveVoiceId);
  if (!voice) throw new ProcessingError('VOICE_NOT_FOUND');

  const baseRequest: NarrationRequest = {
    requestId: 'eligibility-check',
    bookId: input.bookId,
    chapterId: input.chapterId,
    segmentId: segment.id,
    text: segment.normalizedText,
    language: voice.language,
    narratorVoice: { voiceId: voice.id, role: segment.characterVoiceId ? 'character' : 'narrator' },
    output: { format: 'mp3' },
    costCeiling: input.costCeiling,
  };

  const eligibleProviders = await registry.getEligibleProviders(baseRequest);
  if (eligibleProviders.length === 0) {
    throw new ProcessingError('NO_ELIGIBLE_PROVIDER');
  }

  const primaryModel = DEFAULT_MODEL_BY_PROVIDER[eligibleProviders[0]!.id] ?? 'default';
  const expectedSignature = computeRequestSignature({
    textSegmentId: segment.id,
    contentHash: segment.contentHash,
    narratorVoiceId: voice.id,
    deliveryDirectionVersion: segment.deliveryDirectionVersion,
    provider: eligibleProviders[0]!.id,
    modelUsed: primaryModel,
  });

  const existingAudio = await audioSegmentRepo.findActiveForTextSegment(segment.id);
  if (existingAudio && existingAudio.generationSignature === expectedSignature) {
    return { skipped: true, audioSegmentId: existingAudio.id, attemptIds: [], failed: false };
  }

  const existingAttempts = await narrationAttemptRepo.listByTextSegment(segment.id);
  let attemptNumber = existingAttempts.length + 1;
  let triggeringAttemptId: string | undefined;
  const attemptIds: string[] = [];
  let lastErrorCode: string | undefined;

  for (let i = 0; i < eligibleProviders.length; i += 1) {
    const provider = eligibleProviders[i]!;
    const mapping = await voiceRepo.findMapping(voice.id, provider.id);
    if (!mapping) {
      continue;
    }

    const model = DEFAULT_MODEL_BY_PROVIDER[provider.id] ?? 'default';
    const requestSignature = computeRequestSignature({
      textSegmentId: segment.id,
      contentHash: segment.contentHash,
      narratorVoiceId: voice.id,
      deliveryDirectionVersion: segment.deliveryDirectionVersion,
      provider: provider.id,
      modelUsed: model,
    });
    const requestId = randomUUID();

    const attempt = await narrationAttemptRepo.create({
      textSegmentId: segment.id,
      attemptNumber,
      provider: provider.id,
      requestId,
      requestSignature,
      isFallbackAttempt: i > 0,
      triggeringAttemptId,
      costCeilingAtRequest: input.costCeiling ? String(input.costCeiling.amountMicros) : undefined,
    });
    attemptIds.push(attempt.id);
    attemptNumber += 1;

    const request: NarrationRequest = {
      ...baseRequest,
      requestId,
      providerOptions: { [provider.id]: { vendorVoiceId: mapping.providerVoiceId, modelId: model } },
    };

    const result = await provider.synthesizeSegment(request);

    if (result.status === 'completed' && result.audio) {
      const audioBytes = Buffer.from((result.providerMetadata?.rawAudioBase64 as string) ?? '', 'base64');
      const storageRef = await storage.write(
        `books/${input.bookId}/audio/${segment.id}-${attempt.id}.${result.audio.format}`,
        audioBytes,
      );
      const checksum = computeFileChecksum(audioBytes);
      const estimatedCost = result.usage.estimatedCost.amountMicros / 1_000_000;
      const actualCost = result.usage.actualCost ? result.usage.actualCost.amountMicros / 1_000_000 : undefined;

      await narrationAttemptRepo.complete(attempt.id, {
        status: 'succeeded',
        warnings: result.warnings,
        actualCost: actualCost !== undefined ? String(actualCost) : undefined,
      });
      await providerUsageRepo.record({
        narrationAttemptId: attempt.id,
        userId: input.userId,
        bookId: input.bookId,
        chapterId: input.chapterId,
        textSegmentId: segment.id,
        provider: provider.id,
        model,
        charCount: result.usage.characterCount,
        estimatedCost: String(estimatedCost),
        actualCost: actualCost !== undefined ? String(actualCost) : undefined,
        outcome: 'success',
      });

      const audioSegment = await audioSegmentRepo.activateAudioSegment({
        textSegmentId: segment.id,
        producedByAttemptId: attempt.id,
        storageRef,
        provider: provider.id,
        modelUsed: model,
        providerVoiceId: mapping.providerVoiceId,
        durationMs: result.audio.durationMs || estimateDurationMs(audioBytes.byteLength),
        format: result.audio.format,
        sampleRateHz: result.audio.sampleRateHz,
        fileSizeBytes: audioBytes.byteLength,
        checksum,
        estimatedCost: String(estimatedCost),
        actualCost: actualCost !== undefined ? String(actualCost) : undefined,
        generationSignature: requestSignature,
      });

      return { skipped: false, audioSegmentId: audioSegment.id, attemptIds, failed: false };
    }

    const error = result.error;
    await narrationAttemptRepo.complete(attempt.id, {
      status: 'failed',
      normalizedErrorCode: error?.code,
      errorMessage: error?.message,
      warnings: result.warnings,
    });
    await providerUsageRepo.record({
      narrationAttemptId: attempt.id,
      userId: input.userId,
      bookId: input.bookId,
      chapterId: input.chapterId,
      textSegmentId: segment.id,
      provider: provider.id,
      model,
      charCount: result.usage.characterCount,
      estimatedCost: String(result.usage.estimatedCost.amountMicros / 1_000_000),
      outcome: 'failure',
    });

    lastErrorCode = error?.code;
    triggeringAttemptId = attempt.id;

    if (!error?.retryable) {
      break;
    }
  }

  await textSegmentRepo.updateNarrationStatus(segment.id, 'failed');
  return { skipped: false, attemptIds, failed: true, lastErrorCode };
}
