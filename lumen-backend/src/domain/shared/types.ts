/** Shared primitive types used across the domain layer. No I/O, no vendor concepts. */

export type AudioFormat = 'mp3' | 'wav' | 'ogg_opus';

/** Open string type deliberately — new providers must be addable without a union-type edit. */
export type ProviderId = 'elevenlabs' | 'google_cloud_tts' | string;

export interface MoneyAmount {
  amountMicros: number;
  currency: 'USD';
}

export interface RetryPolicy {
  maxAttempts: number;
  backoffMs: number;
  allowProviderFallback: boolean;
}

export interface PauseHint {
  afterCharIndex: number;
  durationMs: number;
}

export interface PronunciationHint {
  term: string;
  guidance: string;
}

export type NarrationStyle = 'calm' | 'suspenseful' | 'dialogue' | 'narration' | string;
export type EmotionHint = 'neutral' | 'sad' | 'excited' | 'tense' | 'angry' | string;

export interface DeliveryDirection {
  style?: NarrationStyle;
  emotion?: EmotionHint;
  intensity?: number;
  pace?: number;
  pauses?: PauseHint[];
  pronunciation?: PronunciationHint[];
}
