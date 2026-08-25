import type { AudioFormat, ProviderId } from '../shared/types';

/**
 * The set of capability keys a NarrationRequest.requiredCapabilities array may reference.
 * Routing filters on these — never on a hard-coded provider name.
 *
 * Deliberately does NOT include music/ambience/mixing capabilities: those are not
 * TtsProvider concerns. They belong to a future, separate audio-processing/mixing
 * subsystem operating downstream of already-generated AudioSegment artifacts.
 */
export type CapabilityKey =
  | 'longFormNarration'
  | 'streaming'
  | 'batchGeneration'
  | 'asynchronousJobs'
  | 'emotionControl'
  | 'pacingControl'
  | 'pauseControl'
  | 'voiceCloning'
  | 'multiVoiceProjects'
  | 'characterVoiceConsistency';

export interface ProviderCapabilities {
  providerId: ProviderId;

  narration: {
    longFormNarration: boolean;
    streaming: boolean;
    batchGeneration: boolean;
    asynchronousJobs: boolean;
  };

  expressiveness: {
    emotionControl: boolean;
    pacingControl: boolean;
    pauseControl: boolean;
    pronunciationControl: 'none' | 'lexicon' | 'ssml' | 'custom_markup';
  };

  voices: {
    cloning: 'none' | 'instant' | 'professional';
    multiVoiceProjects: boolean;
    characterVoiceConsistency: boolean;
  };

  languages: string[];
  audioFormats: AudioFormat[];
  sampleRates: number[];

  limits: {
    maxCharsPerRequest?: number;
    rateLimitPerMinute?: number;
  };

  jobControl: {
    supportsCancel: boolean;
    supportsStatusPolling: boolean;
  };
}
