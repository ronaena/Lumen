import type {
  TtsProvider,
  AvailabilityStatus,
  ValidationResult,
  VoiceFilter,
  VoiceCatalogEntry,
} from '../../TtsProvider.js';
import type { NarrationRequest } from '../../../domain/narration/NarrationRequest.js';
import type { NarrationResult } from '../../../domain/narration/NarrationResult.js';
import type { ProviderCapabilities } from '../../../domain/narration/ProviderCapabilities.js';
import type { NormalizedError } from '../../../domain/narration/NormalizedError.js';
import type { MoneyAmount, ProviderId } from '../../../domain/shared/types.js';
import { mapHttpStatusToErrorCode, isNetworkFailure, safeReadText, PROVIDER_REQUEST_TIMEOUT_MS } from '../httpErrorMapping.js';

export interface ElevenLabsConfig {
  apiKey: string;
  /** Injectable for testing — never a real network call in tests. Defaults to global fetch. */
  httpClient?: typeof fetch;
  baseUrl?: string;
}

const DEFAULT_BASE_URL = 'https://api.elevenlabs.io';
const DEFAULT_MODEL = 'eleven_multilingual_v2';
// Approximate published per-character cost at the standard paid tier — used only for
// pre-flight cost-ceiling estimation, not billing reconciliation.
const ESTIMATED_MICROS_PER_CHAR = 750;
const MAX_CHARS_PER_REQUEST = 5000;

/**
 * ElevenLabsProvider — the ONLY file in this codebase that imports/calls the ElevenLabs
 * API. Implements TtsProvider exactly; nothing outside this file (and its test) knows or
 * needs to know this is ElevenLabs.
 *
 * Voice resolution boundary: this adapter does NOT perform any database lookup. The
 * caller (the narration engine, Phase 4) is responsible for resolving the logical
 * Voice -> VoiceProviderMapping -> vendor voice ID BEFORE calling this provider, and
 * passing the resolved vendor voice ID via `request.providerOptions.elevenlabs.vendorVoiceId`
 * — this keeps the adapter stateless, testable in isolation, and free of any DB/repository
 * dependency: the adapter never talks directly to the database.
 *
 * Storage boundary: synthesizeSegment() returns raw audio bytes via
 * `providerMetadata.rawAudioBase64` with `audio.location.storageRef` left as an explicit
 * placeholder ("pending://not-yet-persisted"). Persisting those bytes through
 * StorageProvider and computing the real storageRef is the narration engine's job
 * (Phase 4) — this adapter has no StorageProvider dependency either.
 */
export class ElevenLabsProvider implements TtsProvider {
  readonly id: ProviderId = 'elevenlabs';
  private readonly httpClient: typeof fetch;
  private readonly baseUrl: string;
  /**
   * True private class field (#, not TypeScript's `private` keyword) -- unlike a regular
   * `private readonly config: ElevenLabsConfig` parameter property (which creates a
   * normal, enumerable instance property still visible to JSON.stringify/Object.keys/
   * for...in), a # field is genuinely invisible to all of those. Found and fixed during
   * the Real TTS/Voice Configuration workstream: the constructed registry's own required
   * "no secret leakage" test caught that a real-shaped API key flowing through the
   * previous config-object storage would have been fully JSON-serializable.
   */
  #apiKey: string;

  constructor(config: ElevenLabsConfig) {
    this.#apiKey = config.apiKey;
    this.httpClient = config.httpClient ?? fetch;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  }

  async getCapabilities(): Promise<ProviderCapabilities> {
    return {
      providerId: this.id,
      narration: {
        longFormNarration: true,
        streaming: true,
        batchGeneration: true,
        asynchronousJobs: false,
      },
      expressiveness: {
        emotionControl: true,
        pacingControl: true,
        pauseControl: true,
        pronunciationControl: 'custom_markup',
      },
      voices: {
        cloning: 'professional',
        multiVoiceProjects: true,
        characterVoiceConsistency: true,
      },
      languages: ['en', 'es', 'fr', 'de', 'it', 'pt', 'pl', 'hi', 'ar', 'zh', 'ja', 'ko'],
      audioFormats: ['mp3'],
      sampleRates: [44100],
      limits: {
        maxCharsPerRequest: MAX_CHARS_PER_REQUEST,
      },
      jobControl: {
        supportsCancel: false,
        supportsStatusPolling: false,
      },
    };
  }

  async checkAvailability(): Promise<AvailabilityStatus> {
    try {
      const response = await this.httpClient(`${this.baseUrl}/v1/user`, {
        headers: { 'xi-api-key': this.#apiKey },
        signal: AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS),
      });
      if (response.ok) return { available: true };
      if (response.status === 401 || response.status === 403) {
        return { available: false, reason: 'auth_error' };
      }
      if (response.status === 429) {
        return { available: false, reason: 'rate_limited' };
      }
      return { available: false, reason: 'outage' };
    } catch {
      return { available: false, reason: 'outage' };
    }
  }

  async validateRequest(request: NarrationRequest): Promise<ValidationResult> {
    const issues: string[] = [];
    if (!request.text || request.text.trim().length === 0) {
      issues.push('text must not be empty');
    }
    if (request.text.length > MAX_CHARS_PER_REQUEST) {
      issues.push(`text exceeds this provider's ${MAX_CHARS_PER_REQUEST}-character limit`);
    }
    const vendorVoiceId = request.providerOptions?.elevenlabs?.vendorVoiceId;
    if (!vendorVoiceId || typeof vendorVoiceId !== 'string') {
      issues.push(
        'providerOptions.elevenlabs.vendorVoiceId must be resolved by the caller via VoiceProviderMapping before calling this provider',
      );
    }
    return issues.length > 0 ? { valid: false, issues } : { valid: true };
  }

  async estimateCost(request: NarrationRequest): Promise<MoneyAmount> {
    return { amountMicros: request.text.length * ESTIMATED_MICROS_PER_CHAR, currency: 'USD' };
  }

  async synthesizeSegment(request: NarrationRequest): Promise<NarrationResult> {
    const validation = await this.validateRequest(request);
    if (!validation.valid) {
      return this.buildFailureResult(
        request,
        this.buildNormalizedError('UNKNOWN_ERROR', validation.issues.join('; ')),
      );
    }

    const vendorVoiceId = request.providerOptions!.elevenlabs!.vendorVoiceId as string;
    const modelId = (request.providerOptions?.elevenlabs?.modelId as string) ?? DEFAULT_MODEL;

    try {
      const response = await this.httpClient(`${this.baseUrl}/v1/text-to-speech/${vendorVoiceId}`, {
        method: 'POST',
        headers: { 'xi-api-key': this.#apiKey, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS),
        body: JSON.stringify({
          text: request.text,
          model_id: modelId,
          voice_settings: request.providerOptions?.elevenlabs
            ? {
                stability: request.providerOptions.elevenlabs.stability,
                similarity_boost: request.providerOptions.elevenlabs.similarityBoost,
              }
            : undefined,
        }),
      });

      if (!response.ok) {
        const bodyText = await safeReadText(response);
        return this.buildFailureResult(request, this.normalizeHttpFailure(response.status, bodyText));
      }

      const audioBytes = Buffer.from(await response.arrayBuffer());
      const estimatedCost = await this.estimateCost(request);

      return {
        requestId: request.requestId,
        provider: this.id,
        status: 'completed',
        audio: {
          location: { storageRef: 'pending://not-yet-persisted' },
          durationMs: 0,
          format: 'mp3',
          sampleRateHz: 44100,
        },
        usage: {
          characterCount: request.text.length,
          estimatedCost,
        },
        voiceUsed: {
          requestedVoiceRef: request.narratorVoice,
          providerVoiceId: vendorVoiceId,
          modelUsed: modelId,
        },
        providerMetadata: {
          rawAudioBase64: audioBytes.toString('base64'),
          rawAudioByteLength: audioBytes.byteLength,
        },
      };
    } catch (cause) {
      return this.buildFailureResult(request, this.normalizeError(cause));
    }
  }

  async getVoices(filter?: VoiceFilter): Promise<VoiceCatalogEntry[]> {
    try {
      const response = await this.httpClient(`${this.baseUrl}/v1/voices`, {
        headers: { 'xi-api-key': this.#apiKey },
        signal: AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) return [];
      const body = (await response.json()) as { voices?: Array<Record<string, unknown>> };
      const voices = (body.voices ?? []).map((v) => ({
        voiceId: String(v.voice_id),
        displayName: String(v.name ?? v.voice_id),
        language: [] as string[],
        supportsCloning: true,
        previewAudioUrl: typeof v.preview_url === 'string' ? v.preview_url : undefined,
      }));
      void filter;
      return voices;
    } catch {
      return [];
    }
  }

  async getVoice(voiceId: string): Promise<VoiceCatalogEntry | null> {
    const voices = await this.getVoices();
    return voices.find((v) => v.voiceId === voiceId) ?? null;
  }

  normalizeError(rawError: unknown): NormalizedError {
    if (isNetworkFailure(rawError)) {
      return this.buildNormalizedError(
        'TRANSIENT_ERROR',
        'A network error occurred while contacting ElevenLabs.',
        rawError,
      );
    }
    if (rawError instanceof Error) {
      return this.buildNormalizedError('UNKNOWN_ERROR', rawError.message, rawError);
    }
    return this.buildNormalizedError('UNKNOWN_ERROR', 'An unknown error occurred.', rawError);
  }

  private normalizeHttpFailure(status: number, bodyText: string): NormalizedError {
    let code = mapHttpStatusToErrorCode(status);
    if (status === 400 && /voice_not_found/i.test(bodyText)) {
      code = 'INVALID_VOICE';
    }
    return this.buildNormalizedError(code, `ElevenLabs request failed with status ${status}.`, {
      status,
      bodyText,
    });
  }

  private buildNormalizedError(
    code: NormalizedError['code'],
    message: string,
    rawProviderCode?: unknown,
  ): NormalizedError {
    return {
      code,
      message,
      retryable: code === 'RATE_LIMITED' || code === 'TRANSIENT_ERROR' || code === 'PROVIDER_UNAVAILABLE',
      providerId: this.id,
      rawProviderCode: rawProviderCode !== undefined ? JSON.stringify(rawProviderCode) : undefined,
    };
  }

  private buildFailureResult(request: NarrationRequest, error: NormalizedError): NarrationResult {
    return {
      requestId: request.requestId,
      provider: this.id,
      status: 'failed',
      usage: {
        characterCount: request.text.length,
        estimatedCost: { amountMicros: 0, currency: 'USD' },
      },
      voiceUsed: {
        requestedVoiceRef: request.narratorVoice,
        providerVoiceId: (request.providerOptions?.elevenlabs?.vendorVoiceId as string) ?? 'unknown',
        modelUsed: (request.providerOptions?.elevenlabs?.modelId as string) ?? DEFAULT_MODEL,
      },
      error,
    };
  }
}
