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

export interface GoogleCloudTtsConfig {
  apiKey: string;
  httpClient?: typeof fetch;
  baseUrl?: string;
}

const DEFAULT_BASE_URL = 'https://texttospeech.googleapis.com';
const ESTIMATED_MICROS_PER_CHAR = 160;
const MAX_CHARS_PER_REQUEST = 5000;

/**
 * GoogleCloudTtsProvider — the ONLY file that calls the Google Cloud TTS API. Fallback
 * partner to ElevenLabsProvider behind the same TtsProvider contract.
 *
 * Same two boundaries as ElevenLabsProvider: no DB access (vendor voice ID must arrive
 * pre-resolved via `providerOptions.google_cloud_tts.vendorVoiceId`), no StorageProvider
 * access (raw audio bytes returned via providerMetadata, persisted by the engine).
 *
 * Scope note: only the synchronous `text:synthesize` endpoint is implemented. Google's
 * long-running synthesizeLongAudio API is not used here — TextSegment-level requests are
 * paragraph-sized and comfortably within the synchronous endpoint's limits, so
 * asynchronousJobs is reported as false rather than half-implementing job polling this
 * phase.
 */
export class GoogleCloudTtsProvider implements TtsProvider {
  readonly id: ProviderId = 'google_cloud_tts';
  private readonly httpClient: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly config: GoogleCloudTtsConfig) {
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
        emotionControl: false,
        pacingControl: true,
        pauseControl: true,
        pronunciationControl: 'ssml',
      },
      voices: {
        cloning: 'instant',
        multiVoiceProjects: false,
        characterVoiceConsistency: false,
      },
      languages: ['en', 'es', 'fr', 'de', 'it', 'pt', 'ja', 'ko', 'zh', 'hi', 'ar'],
      audioFormats: ['mp3', 'wav'],
      sampleRates: [24000, 44100],
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
      const response = await this.httpClient(
        `${this.baseUrl}/v1/voices?key=${this.config.apiKey}&languageCode=en-US`,
        { signal: AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS) },
      );
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
    const vendorVoiceId = request.providerOptions?.google_cloud_tts?.vendorVoiceId;
    if (!vendorVoiceId || typeof vendorVoiceId !== 'string') {
      issues.push(
        'providerOptions.google_cloud_tts.vendorVoiceId must be resolved by the caller via VoiceProviderMapping before calling this provider',
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

    const vendorVoiceId = request.providerOptions!.google_cloud_tts!.vendorVoiceId as string;
    const languageCode = request.language;
    const voiceType = (request.providerOptions?.google_cloud_tts?.voiceType as string) ?? 'chirp3_hd';

    try {
      const response = await this.httpClient(`${this.baseUrl}/v1/text:synthesize?key=${this.config.apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS),
        body: JSON.stringify({
          input: request.providerOptions?.google_cloud_tts?.ssmlOverride
            ? { ssml: request.providerOptions.google_cloud_tts.ssmlOverride }
            : { text: request.text },
          voice: { languageCode, name: vendorVoiceId },
          audioConfig: { audioEncoding: 'MP3', sampleRateHertz: request.output.sampleRateHz ?? 24000 },
        }),
      });

      if (!response.ok) {
        const bodyText = await safeReadText(response);
        return this.buildFailureResult(request, this.normalizeHttpFailure(response.status, bodyText));
      }

      const body = (await response.json()) as { audioContent?: string };
      if (!body.audioContent) {
        return this.buildFailureResult(
          request,
          this.buildNormalizedError('UNKNOWN_ERROR', 'Google Cloud TTS returned no audio content.'),
        );
      }

      const audioBytes = Buffer.from(body.audioContent, 'base64');
      const estimatedCost = await this.estimateCost(request);

      return {
        requestId: request.requestId,
        provider: this.id,
        status: 'completed',
        audio: {
          location: { storageRef: 'pending://not-yet-persisted' },
          durationMs: 0,
          format: 'mp3',
          sampleRateHz: request.output.sampleRateHz ?? 24000,
        },
        usage: {
          characterCount: request.text.length,
          estimatedCost,
        },
        voiceUsed: {
          requestedVoiceRef: request.narratorVoice,
          providerVoiceId: vendorVoiceId,
          modelUsed: voiceType,
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
      const languageParam = filter?.language ? `&languageCode=${filter.language}` : '';
      const response = await this.httpClient(
        `${this.baseUrl}/v1/voices?key=${this.config.apiKey}${languageParam}`,
        { signal: AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS) },
      );
      if (!response.ok) return [];
      const body = (await response.json()) as {
        voices?: Array<{ name: string; languageCodes: string[] }>;
      };
      return (body.voices ?? []).map((v) => ({
        voiceId: v.name,
        displayName: v.name,
        language: v.languageCodes,
        supportsCloning: false,
      }));
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
        'A network error occurred while contacting Google Cloud TTS.',
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
    if (status === 400 && /invalid.*voice/i.test(bodyText)) {
      code = 'INVALID_VOICE';
    }
    if (status === 400 && /language/i.test(bodyText)) {
      code = 'UNSUPPORTED_LANGUAGE';
    }
    return this.buildNormalizedError(code, `Google Cloud TTS request failed with status ${status}.`, {
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
        providerVoiceId: (request.providerOptions?.google_cloud_tts?.vendorVoiceId as string) ?? 'unknown',
        modelUsed: (request.providerOptions?.google_cloud_tts?.voiceType as string) ?? 'chirp3_hd',
      },
      error,
    };
  }
}
