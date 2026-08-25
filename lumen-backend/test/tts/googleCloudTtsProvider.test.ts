import { describe, it, expect } from 'vitest';
import { GoogleCloudTtsProvider } from '../../src/tts/providers/google/GoogleCloudTtsProvider.js';
import { buildNarrationRequest } from './fixtures.js';

function fakeHttpClient(
  handler: (url: string, init?: RequestInit) => Promise<Response> | Response,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    return handler(String(input), init);
  }) as typeof fetch;
}

describe('GoogleCloudTtsProvider (offline)', () => {
  it('getCapabilities reports the documented shape', async () => {
    const provider = new GoogleCloudTtsProvider({ apiKey: 'test-key' });
    const caps = await provider.getCapabilities();
    expect(caps.providerId).toBe('google_cloud_tts');
    expect(caps.voices.cloning).toBe('instant');
    expect(caps.expressiveness.pronunciationControl).toBe('ssml');
  });

  it('synthesizeSegment builds the correct request shape and decodes base64 audio on success', async () => {
    const fakeAudioBytes = Buffer.from('fake-wav-bytes');
    const provider = new GoogleCloudTtsProvider({
      apiKey: 'test-key',
      httpClient: fakeHttpClient((url, init) => {
        expect(url).toContain('/v1/text:synthesize');
        const body = JSON.parse(String(init?.body));
        expect(body.voice.name).toBe('en-US-Studio-O');
        expect(body.input.text).toBe('Once upon a time, in a land far away.');
        return new Response(
          JSON.stringify({ audioContent: fakeAudioBytes.toString('base64') }),
          { status: 200 },
        );
      }),
    });

    const result = await provider.synthesizeSegment(buildNarrationRequest());

    expect(result.status).toBe('completed');
    expect(result.provider).toBe('google_cloud_tts');
    expect(result.voiceUsed.providerVoiceId).toBe('en-US-Studio-O');
    const returnedBytes = Buffer.from(result.providerMetadata!.rawAudioBase64 as string, 'base64');
    expect(Buffer.compare(returnedBytes, fakeAudioBytes)).toBe(0);
  });

  it('uses providerOptions.google_cloud_tts.ssmlOverride when present instead of plain text', async () => {
    const provider = new GoogleCloudTtsProvider({
      apiKey: 'test-key',
      httpClient: fakeHttpClient((url, init) => {
        const body = JSON.parse(String(init?.body));
        expect(body.input.ssml).toBe('<speak>Hello</speak>');
        expect(body.input.text).toBeUndefined();
        return new Response(JSON.stringify({ audioContent: '' }), { status: 200 });
      }),
    });

    await provider.synthesizeSegment(
      buildNarrationRequest({
        providerOptions: {
          google_cloud_tts: { vendorVoiceId: 'en-US-Studio-O', ssmlOverride: '<speak>Hello</speak>' },
        },
      }),
    );
  });

  it('normalizes a 503 into PROVIDER_UNAVAILABLE, retryable', async () => {
    const provider = new GoogleCloudTtsProvider({
      apiKey: 'test-key',
      httpClient: fakeHttpClient(() => new Response('unavailable', { status: 503 })),
    });
    const result = await provider.synthesizeSegment(buildNarrationRequest());
    expect(result.error?.code).toBe('PROVIDER_UNAVAILABLE');
    expect(result.error?.retryable).toBe(true);
  });

  it('validateRequest rejects a request missing a resolved vendorVoiceId', async () => {
    const provider = new GoogleCloudTtsProvider({ apiKey: 'test-key' });
    const result = await provider.validateRequest(buildNarrationRequest({ providerOptions: {} }));
    expect(result.valid).toBe(false);
  });

  it('never leaks a raw HTTP body as the normalized error message', async () => {
    const provider = new GoogleCloudTtsProvider({
      apiKey: 'test-key',
      httpClient: fakeHttpClient(() => new Response('<html>raw google error page</html>', { status: 500 })),
    });
    const result = await provider.synthesizeSegment(buildNarrationRequest());
    expect(result.error?.message).not.toContain('<html>');
  });
});

describe('ElevenLabs <-> Google fallback interchangeability (offline)', () => {
  it('both providers satisfy the identical TtsProvider contract shape for the same request', async () => {
    const { ElevenLabsProvider } = await import('../../src/tts/providers/elevenlabs/ElevenLabsProvider.js');
    const fakeAudio = Buffer.from('audio');

    const elevenLabs = new ElevenLabsProvider({
      apiKey: 'k',
      httpClient: fakeHttpClient(() => new Response(fakeAudio, { status: 503 })), // simulate primary failing
    });
    const google = new GoogleCloudTtsProvider({
      apiKey: 'k',
      httpClient: fakeHttpClient(() => new Response(JSON.stringify({ audioContent: fakeAudio.toString('base64') }), { status: 200 })),
    });

    const request = buildNarrationRequest();
    const primaryResult = await elevenLabs.synthesizeSegment(request);
    expect(primaryResult.status).toBe('failed');
    expect(primaryResult.error?.code).toBe('PROVIDER_UNAVAILABLE');

    // Fallback: same logical request, same requestId, different provider — the pattern
    // the narration engine (Phase 4) will implement, exercised here at the adapter level.
    const fallbackResult = await google.synthesizeSegment(request);
    expect(fallbackResult.status).toBe('completed');
    expect(fallbackResult.requestId).toBe(primaryResult.requestId);
    expect(fallbackResult.provider).toBe('google_cloud_tts');
  });
});
