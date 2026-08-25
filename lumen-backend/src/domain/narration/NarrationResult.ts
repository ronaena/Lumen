import type { VoiceRef } from '../voice/VoiceRef';
import type { AudioFormat, MoneyAmount, ProviderId } from '../shared/types';
import type { NormalizedError } from './NormalizedError';

export interface AudioLocation {
  storageRef: string;
}

export interface NarrationWarning {
  code: string;
  message: string;
}

/**
 * NarrationResult — the provider-neutral result model. Every consumer (audio pipeline,
 * retry logic, cost tracking, UI status) reads this shape; none of them need to know
 * which provider produced it.
 */
export interface NarrationResult {
  requestId: string;
  provider: ProviderId;
  /** Present for async/batch providers. */
  providerJobId?: string;

  status: 'completed' | 'processing' | 'queued' | 'failed' | 'partial';

  audio?: {
    location: AudioLocation;
    durationMs: number;
    format: AudioFormat;
    sampleRateHz: number;
  };

  usage: {
    characterCount: number;
    estimatedCost: MoneyAmount;
    actualCost?: MoneyAmount;
    processingTimeMs?: number;
  };

  voiceUsed: {
    requestedVoiceRef: VoiceRef;
    /** Vendor's actual voice ID — audit/debug field only, never a join key. */
    providerVoiceId: string;
    modelUsed: string;
  };

  warnings?: NarrationWarning[];
  /** Present only when status === 'failed'. */
  error?: NormalizedError;

  /** Raw passthrough for debugging — never consumed by core logic. */
  providerMetadata?: Record<string, unknown>;
}
