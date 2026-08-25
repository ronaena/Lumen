import type { ProviderId } from '../shared/types';

/**
 * The complete, closed set of error codes core workflow logic is allowed to reason about.
 * Provider adapters MUST translate every raw vendor error into one of these — core
 * retry/fallback logic never inspects a raw provider exception or status code directly.
 */
export type NormalizedErrorCode =
  | 'RATE_LIMITED'
  | 'QUOTA_EXCEEDED'
  | 'AUTH_ERROR'
  | 'INVALID_VOICE'
  | 'UNSUPPORTED_LANGUAGE'
  | 'UNSUPPORTED_CAPABILITY'
  | 'INPUT_TOO_LONG'
  | 'CONTENT_POLICY_REJECTED'
  | 'PROVIDER_UNAVAILABLE'
  | 'TRANSIENT_ERROR'
  | 'UNKNOWN_ERROR';

export interface NormalizedError {
  code: NormalizedErrorCode;
  /** Safe to log; never shown raw to end users. */
  message: string;
  retryable: boolean;
  providerId: ProviderId;
  /** Kept for debugging only — core logic must never branch on this. */
  rawProviderCode?: string;
}
