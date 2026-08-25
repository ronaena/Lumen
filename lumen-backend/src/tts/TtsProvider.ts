import type { NarrationRequest } from '../domain/narration/NarrationRequest';
import type { NarrationResult } from '../domain/narration/NarrationResult';
import type { ProviderCapabilities } from '../domain/narration/ProviderCapabilities';
import type { NormalizedError } from '../domain/narration/NormalizedError';
import type { ProviderId, MoneyAmount } from '../domain/shared/types';

export type AvailabilityStatus =
  | { available: true }
  | {
      available: false;
      reason: 'quota_exceeded' | 'outage' | 'auth_error' | 'rate_limited';
      retryAfterMs?: number;
    };

export type ValidationResult = { valid: true } | { valid: false; issues: string[] };

export interface VoiceFilter {
  language?: string;
  role?: 'narrator' | 'character';
}

export interface VoiceCatalogEntry {
  voiceId: string;
  displayName: string;
  language: string[];
  supportsCloning: boolean;
  previewAudioUrl?: string;
}

/**
 * TtsProvider — the single contract every text-to-speech provider adapter implements.
 *
 * The narration engine (a later phase) depends ONLY on this interface. No provider SDK,
 * vendor HTTP client, or vendor-specific type may appear in core narration/domain code —
 * that logic belongs entirely inside a provider adapter under src/tts/providers/.
 *
 * Optional methods are declared with `?` because "do not assume every provider supports
 * every capability" is a hard architectural requirement — the engine checks
 * getCapabilities() before ever calling an optional method.
 *
 * ElevenLabsProvider and GoogleCloudTtsProvider (src/tts/providers/) both implement this
 * contract in full, including getVoices/getVoice. This file defines the contract; the
 * adapters are the concrete implementations.
 */
export interface TtsProvider {
  readonly id: ProviderId;

  getCapabilities(): Promise<ProviderCapabilities>;

  checkAvailability(): Promise<AvailabilityStatus>;

  validateRequest(request: NarrationRequest): Promise<ValidationResult>;

  estimateCost(request: NarrationRequest): Promise<MoneyAmount>;

  synthesizeSegment(request: NarrationRequest): Promise<NarrationResult>;

  /** Only implemented if getCapabilities().narration.longFormNarration is true. */
  synthesizeLongFormSegment?(request: NarrationRequest): Promise<NarrationResult>;

  /** Only implemented if the provider supports asynchronousJobs. */
  getJobStatus?(providerJobId: string): Promise<NarrationResult>;
  cancelJob?(providerJobId: string): Promise<void>;

  getVoices(filter?: VoiceFilter): Promise<VoiceCatalogEntry[]>;
  getVoice(voiceId: string): Promise<VoiceCatalogEntry | null>;

  /** Every provider MUST implement this — the one mandatory error-translation boundary. */
  normalizeError(rawError: unknown): NormalizedError;
}
