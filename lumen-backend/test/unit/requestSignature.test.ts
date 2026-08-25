import { describe, it, expect } from 'vitest';
import { computeRequestSignature } from '../../src/domain/narration/requestSignature.js';

describe('computeRequestSignature', () => {
  const baseInput = {
    textSegmentId: 'seg-1',
    contentHash: 'abc123',
    narratorVoiceId: 'voice-1',
    deliveryDirectionVersion: 1,
    provider: 'elevenlabs',
    modelUsed: 'eleven_multilingual_v2',
  };

  it('is deterministic — identical input produces identical output', () => {
    const first = computeRequestSignature(baseInput);
    const second = computeRequestSignature({ ...baseInput });
    expect(first).toBe(second);
  });

  it('changes when contentHash changes', () => {
    const original = computeRequestSignature(baseInput);
    const changed = computeRequestSignature({ ...baseInput, contentHash: 'different' });
    expect(changed).not.toBe(original);
  });

  it('excludes requestId — two different requestIds for the same logical config produce the same signature', () => {
    // requestId is not even a parameter to the function; this test documents the contract:
    // the signature is computed purely from logical-identity fields, and calling it twice
    // for what would be two different NarrationRequest.requestId values yields the same result.
    const callOne = computeRequestSignature(baseInput);
    const callTwo = computeRequestSignature(baseInput);
    expect(callOne).toBe(callTwo);
  });

  it('excludes attemptNumber — the function has no attemptNumber parameter at all', () => {
    // Type-level guarantee: RequestSignatureInput has no attemptNumber field, so this is
    // also enforced at compile time. This test documents that two calls representing
    // "attempt 1" and "attempt 2" of the same configuration are indistinguishable by signature.
    const attempt1Equivalent = computeRequestSignature(baseInput);
    const attempt2Equivalent = computeRequestSignature(baseInput);
    expect(attempt1Equivalent).toBe(attempt2Equivalent);
  });

  it('produces a 64-character hex sha256 digest', () => {
    const signature = computeRequestSignature(baseInput);
    expect(signature).toMatch(/^[a-f0-9]{64}$/);
  });
});
