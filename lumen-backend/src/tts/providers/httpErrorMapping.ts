import type { NormalizedErrorCode } from '../../domain/narration/NormalizedError.js';

/**
 * Generic HTTP-status-to-NormalizedErrorCode mapping shared by provider adapters.
 * Individual adapters may override specific cases (e.g. a provider-specific 400 body
 * that indicates INVALID_VOICE vs UNSUPPORTED_LANGUAGE) but this covers the common cases
 * so neither adapter has to duplicate basic HTTP semantics.
 */
export function mapHttpStatusToErrorCode(status: number): NormalizedErrorCode {
  if (status === 401 || status === 403) return 'AUTH_ERROR';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 402) return 'QUOTA_EXCEEDED';
  if (status === 413) return 'INPUT_TOO_LONG';
  if (status === 451) return 'CONTENT_POLICY_REJECTED';
  if (status === 502 || status === 503 || status === 504) return 'PROVIDER_UNAVAILABLE';
  if (status >= 500) return 'PROVIDER_UNAVAILABLE';
  if (status >= 400) return 'UNKNOWN_ERROR';
  return 'UNKNOWN_ERROR';
}

/** Approved Workstream 13E value — applied to every outbound TTS provider HTTP call. */
export const PROVIDER_REQUEST_TIMEOUT_MS = 30_000;

export function isNetworkFailure(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false;
  return (
    cause.name === 'TypeError' || // fetch's generic network-failure error
    // AbortSignal.timeout() aborts with a DOMException named 'TimeoutError' — confirmed
    // directly (not assumed) during Workstream 13E implementation. Routing it here means
    // a timed-out request is treated exactly like any other network failure: mapped to
    // the existing retryable TRANSIENT_ERROR code, which is what lets the existing
    // fallback-to-secondary-provider mechanism (Phase 4/5) correctly trigger on it.
    cause.name === 'TimeoutError' ||
    cause.message.includes('ECONNREFUSED') ||
    cause.message.includes('ETIMEDOUT') ||
    cause.message.includes('fetch failed')
  );
}

export async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
