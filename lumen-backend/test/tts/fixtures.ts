import type { NarrationRequest } from '../../src/domain/narration/NarrationRequest.js';

export function buildNarrationRequest(overrides: Partial<NarrationRequest> = {}): NarrationRequest {
  return {
    requestId: 'req-' + Math.random().toString(36).slice(2),
    bookId: 'book-1',
    chapterId: 'chapter-1',
    segmentId: 'segment-1',
    text: 'Once upon a time, in a land far away.',
    language: 'en-US',
    narratorVoice: { voiceId: 'lumen-voice-1', role: 'narrator' },
    output: { format: 'mp3' },
    providerOptions: {
      elevenlabs: { vendorVoiceId: 'vendor-voice-abc' },
      google_cloud_tts: { vendorVoiceId: 'en-US-Studio-O' },
    },
    ...overrides,
  };
}
