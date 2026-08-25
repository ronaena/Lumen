import { describe, it, expect } from 'vitest';
import { ElevenLabsProvider } from '../../src/tts/providers/elevenlabs/ElevenLabsProvider.js';
import { buildNarrationRequest } from './fixtures.js';

/**
 * Every test in this file is OFFLINE — no real network call is ever made. The httpClient
 * is fully injected and fed deterministic fixtures. Per the approved instruction: real
 * ElevenLabs credentials are unavailable in this environment (and this sandbox's network
 * allowlist blocks api.elevenlabs.io regardless), so only the request-building and
 * response-normalization logic is verified here — never a live production call.
 */
function fakeHttpClient(
  handler: (url: string, init?: RequestInit) => Promise<Response> | Response,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    return handler(String(input), init);
  }) as typeof fetch;
}

describe('ElevenLabsProvider (offline)', () => {
  it('getCapabilities reports the documented shape without any network call', async () => {
    const provider = new ElevenLabsProvider({
      apiKey: 'test-key',
      httpClient: fakeHttpClient(() => {
        throw new Error('should not be called');
      }),
    });
    const caps = await provider.getCapabilities();
    expect(caps.providerId).toBe('elevenlabs');
    expect(caps.narration.longFormNarration).toBe(true);
    expect(caps.voices.cloning).toBe('professional');
  });

  it('checkAvailability reports available:true on a 200 response', async () => {
    const provider = new ElevenLabsProvider({
      apiKey: 'test-key',
      httpClient: fakeHttpClient(() => new Response('{}', { status: 200 })),
    });
    const result = await provider.checkAvailability();
    expect(result).toEqual({ available: true });
  });

  it('checkAvailability reports auth_error on 401', async () => {
    const provider = new ElevenLabsProvider({
      apiKey: 'bad-key',
      httpClient: fakeHttpClient(() => new Response('{}', { status: 401 })),
    });
    const result = await provider.checkAvailability();
    expect(result).toEqual({ available: false, reason: 'auth_error' });
  });

  it('checkAvailability reports outage on a network exception', async () => {
    const provider = new ElevenLabsProvider({
      apiKey: 'test-key',
      httpClient: fakeHttpClient(() => {
        throw new TypeError('fetch failed');
      }),
    });
    const result = await provider.checkAvailability();
    expect(result).toEqual({ available: false, reason: 'outage' });
  });

  it('validateRequest rejects a request missing a resolved vendorVoiceId', async () => {
    const provider = new ElevenLabsProvider({ apiKey: 'test-key' });
    const request = buildNarrationRequest({ providerOptions: {} });
    const result = await provider.validateRequest(request);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.some((i) => i.includes('vendorVoiceId'))).toBe(true);
    }
  });

  it('validateRequest accepts a well-formed request', async () => {
    const provider = new ElevenLabsProvider({ apiKey: 'test-key' });
    const result = await provider.validateRequest(buildNarrationRequest());
    expect(result.valid).toBe(true);
  });

  it('estimateCost scales with character count', async () => {
    const provider = new ElevenLabsProvider({ apiKey: 'test-key' });
    const short = await provider.estimateCost(buildNarrationRequest({ text: 'Hi.' }));
    const long = await provider.estimateCost(buildNarrationRequest({ text: 'Hi.'.repeat(100) }));
    expect(long.amountMicros).toBeGreaterThan(short.amountMicros);
    expect(short.currency).toBe('USD');
  });

  it('synthesizeSegment returns a completed NarrationResult with raw audio bytes on success', async () => {
    const fakeAudioBytes = Buffer.from('fake-mp3-bytes');
    const provider = new ElevenLabsProvider({
      apiKey: 'test-key',
      httpClient: fakeHttpClient((url, init) => {
        expect(url).toContain('/v1/text-to-speech/vendor-voice-abc');
        expect(init?.method).toBe('POST');
        const body = JSON.parse(String(init?.body));
        expect(body.text).toBe('Once upon a time, in a land far away.');
        return new Response(fakeAudioBytes, { status: 200 });
      }),
    });

    const result = await provider.synthesizeSegment(buildNarrationRequest());

    expect(result.status).toBe('completed');
    expect(result.provider).toBe('elevenlabs');
    expect(result.audio?.format).toBe('mp3');
    expect(result.audio?.location.storageRef).toBe('pending://not-yet-persisted');
    const returnedBytes = Buffer.from(result.providerMetadata!.rawAudioBase64 as string, 'base64');
    expect(Buffer.compare(returnedBytes, fakeAudioBytes)).toBe(0);
    expect(result.voiceUsed.providerVoiceId).toBe('vendor-voice-abc');
  });

  it('synthesizeSegment normalizes a 429 into RATE_LIMITED, retryable', async () => {
    const provider = new ElevenLabsProvider({
      apiKey: 'test-key',
      httpClient: fakeHttpClient(() => new Response('rate limited', { status: 429 })),
    });
    const result = await provider.synthesizeSegment(buildNarrationRequest());
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('RATE_LIMITED');
    expect(result.error?.retryable).toBe(true);
    expect(result.error?.providerId).toBe('elevenlabs');
    expect(result.error?.message).not.toBe('rate limited');
  });

  it('synthesizeSegment normalizes a 401 into AUTH_ERROR, not retryable', async () => {
    const provider = new ElevenLabsProvider({
      apiKey: 'bad-key',
      httpClient: fakeHttpClient(() => new Response('unauthorized', { status: 401 })),
    });
    const result = await provider.synthesizeSegment(buildNarrationRequest());
    expect(result.error?.code).toBe('AUTH_ERROR');
    expect(result.error?.retryable).toBe(false);
  });

  it('synthesizeSegment normalizes a network exception into TRANSIENT_ERROR', async () => {
    const provider = new ElevenLabsProvider({
      apiKey: 'test-key',
      httpClient: fakeHttpClient(() => {
        throw new TypeError('fetch failed');
      }),
    });
    const result = await provider.synthesizeSegment(buildNarrationRequest());
    expect(result.error?.code).toBe('TRANSIENT_ERROR');
    expect(result.error?.retryable).toBe(true);
  });

  it('getVoices parses the vendor voice catalog into VoiceCatalogEntry shape', async () => {
    const provider = new ElevenLabsProvider({
      apiKey: 'test-key',
      httpClient: fakeHttpClient(
        () =>
          new Response(
            JSON.stringify({
              voices: [{ voice_id: 'v1', name: 'Aria', preview_url: 'https://example.com/a.mp3' }],
            }),
            { status: 200 },
          ),
      ),
    });
    const voices = await provider.getVoices();
    expect(voices).toEqual([
      {
        voiceId: 'v1',
        displayName: 'Aria',
        language: [],
        supportsCloning: true,
        previewAudioUrl: 'https://example.com/a.mp3',
      },
    ]);
  });
});
