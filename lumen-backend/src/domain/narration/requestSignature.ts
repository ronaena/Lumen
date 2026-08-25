import { createHash } from 'node:crypto';

/**
 * Inputs to the content-addressable request signature.
 *
 * This is the LOGICAL synthesis identity — "does this attempt represent the same
 * narration configuration as another attempt?" It is deliberately NOT the invocation
 * identity (that's requestId, stored separately and unique per call).
 *
 * Per the approved DB-3 correction, this composition is fixed and must not be casually
 * extended: requestId, attemptNumber, and all timestamps are excluded on purpose, because
 * including any of them would make the signature unique per-call and therefore useless
 * for detecting "we already tried this exact configuration."
 */
export interface RequestSignatureInput {
  textSegmentId: string;
  contentHash: string;
  narratorVoiceId: string;
  deliveryDirectionVersion: number;
  provider: string;
  modelUsed: string;
}

/**
 * Computes the deterministic requestSignature for a NarrationAttempt.
 *
 * Deterministic: identical input always produces identical output — no randomness, no
 * timestamps, no invocation-specific identity folded in.
 */
export function computeRequestSignature(input: RequestSignatureInput): string {
  const canonical = [
    input.textSegmentId,
    input.contentHash,
    input.narratorVoiceId,
    String(input.deliveryDirectionVersion),
    input.provider,
    input.modelUsed,
  ].join('|');

  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
