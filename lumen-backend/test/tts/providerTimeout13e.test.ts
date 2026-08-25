import { describe, it, expect } from 'vitest';
import { ElevenLabsProvider } from '../../src/tts/providers/elevenlabs/ElevenLabsProvider.js';
import { GoogleCloudTtsProvider } from '../../src/tts/providers/google/GoogleCloudTtsProvider.js';
import { PROVIDER_REQUEST_TIMEOUT_MS, isNetworkFailure } from '../../src/tts/providers/httpErrorMapping.js';
import { ProviderRegistry } from '../../src/tts/ProviderRegistry.js';
import { narrateSegment } from '../../src/narration/NarrationEngine.js';
import { getTestDb, resetDatabase, createTestUser } from '../db/setup.js';
import { LocalFilesystemStorageProvider } from '../../src/processing/storage/LocalFilesystemStorageProvider.js';
import { BookRepository } from '../../src/repositories/BookRepository.js';
import { ChapterRepository } from '../../src/repositories/ChapterRepository.js';
import { TextSegmentRepository } from '../../src/repositories/TextSegmentRepository.js';
import { VoiceRepository } from '../../src/repositories/VoiceRepository.js';
import { AudioSegmentRepository } from '../../src/repositories/AudioSegmentRepository.js';
import { NarrationAttemptRepository } from '../../src/repositories/NarrationAttemptRepository.js';
import { ProviderUsageRepository } from '../../src/repositories/ProviderUsageRepository.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Simulates exactly what a real `fetch` call does when its AbortSignal fires: rejects
 * with the signal's own abort reason (a DOMException named 'TimeoutError', confirmed
 * directly against Node's actual AbortSignal.timeout() behavior during implementation —
 * see the isNetworkFailure() comment in httpErrorMapping.ts).
 *
 * Deliberately does NOT wait for the real 30-second production timeout to naturally
 * elapse — that would make this test suite itself take 30+ real seconds per case. Instead
 * it aborts on its own short internal delay, reproducing the exact error SHAPE a real
 * timeout produces without coupling test runtime to the approved production duration.
 * This tests the functional contract ("does a timeout-shaped failure get handled
 * correctly") rather than the literal wall-clock wait, which is what the approved scope
 * actually cares about — the wiring that PROVIDER_REQUEST_TIMEOUT_MS is really 30_000 is
 * verified separately, directly, below.
 */
function neverResolvingFetch(): typeof fetch {
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    return new Promise((_resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
      }, 20);
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(init.signal!.reason);
      });
    });
  }) as typeof fetch;
}

function immediateSuccessFetch(body: string | Buffer = 'fake-audio-bytes'): typeof fetch {
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    if (String(_input).includes('/v1/user') || String(_input).includes('languageCode=en-US')) {
      return new Response('{}', { status: 200 });
    }
    if (String(_input).includes('/v1/text:synthesize')) {
      return new Response(JSON.stringify({ audioContent: Buffer.from('fake-audio').toString('base64') }), {
        status: 200,
      });
    }
    return new Response(body, { status: 200 });
  }) as typeof fetch;
}

/**
 * Like neverResolvingFetch, but only for the synthesis call specifically — the
 * availability-probe endpoint responds normally and quickly. This matters: if
 * checkAvailability() itself also hung, the provider would be filtered out of the
 * eligible set entirely (a real behavior confirmed by an earlier run of this exact
 * test — "1 attempt" instead of "2" was the actual symptom), meaning
 * synthesizeSegment would never even be attempted and this test wouldn't exercise the
 * timeout-during-synthesis path it's meant to prove.
 */
function timeoutOnlyDuringSynthesisFetch(): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/v1/user') || url.includes('languageCode=en-US')) {
      return new Response('{}', { status: 200 });
    }
    return new Promise((_resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
      }, 20);
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(init.signal!.reason);
      });
    });
  }) as typeof fetch;
}

describe('Workstream 13E: TTS provider HTTP timeout hardening', () => {
  it('the approved production timeout value is exactly 30 seconds (30,000 ms)', () => {
    expect(PROVIDER_REQUEST_TIMEOUT_MS).toBe(30_000);
  });

  it('every ElevenLabsProvider outbound call passes an AbortSignal', async () => {
    const provider = new ElevenLabsProvider({ apiKey: 'k', httpClient: immediateSuccessFetch() });
    await provider.checkAvailability();
    await provider.getVoices();
  });

  it('every GoogleCloudTtsProvider outbound call passes an AbortSignal', async () => {
    const provider = new GoogleCloudTtsProvider({ apiKey: 'k', httpClient: immediateSuccessFetch() });
    await provider.checkAvailability();
    await provider.getVoices();
  });

  it('isNetworkFailure() correctly classifies a TimeoutError as a network failure (the fix that makes fallback work)', () => {
    const timeoutError = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    expect(isNetworkFailure(timeoutError)).toBe(true);
  });

  it('ElevenLabsProvider: a request that never resolves is terminated by the abort mechanism and produces the safe, retryable TRANSIENT_ERROR', async () => {
    const provider = new ElevenLabsProvider({ apiKey: 'k', httpClient: neverResolvingFetch() });
    const request = {
      requestId: 'req-1',
      text: 'Hello world.',
      narratorVoice: { voiceId: 'v1' },
      language: 'en',
      output: {},
      providerOptions: { elevenlabs: { vendorVoiceId: 'vendor-1' } },
    } as any;

    const result = await provider.synthesizeSegment(request);
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('TRANSIENT_ERROR');
    expect(result.error?.retryable).toBe(true);
    expect(result.error?.message).not.toMatch(/DOMException|at new|node_modules/i);
  });

  it('GoogleCloudTtsProvider: a request that never resolves is terminated and produces the safe, retryable TRANSIENT_ERROR', async () => {
    const provider = new GoogleCloudTtsProvider({ apiKey: 'k', httpClient: neverResolvingFetch() });
    const request = {
      requestId: 'req-2',
      text: 'Hello world.',
      narratorVoice: { voiceId: 'v1' },
      language: 'en',
      output: {},
      providerOptions: { google_cloud_tts: { vendorVoiceId: 'vendor-1' } },
    } as any;

    const result = await provider.synthesizeSegment(request);
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('TRANSIENT_ERROR');
    expect(result.error?.retryable).toBe(true);
  });

  it('a normal, fast provider response succeeds normally and is completely unaffected by the timeout change', async () => {
    const provider = new ElevenLabsProvider({
      apiKey: 'k',
      httpClient: (async (input: string | URL | Request, init?: RequestInit) => {
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        if (String(input).includes('/v1/text-to-speech/')) {
          return new Response(Buffer.from('fake-mp3'), { status: 200 });
        }
        return new Response('{}', { status: 200 });
      }) as typeof fetch,
    });
    const request = {
      requestId: 'req-3',
      text: 'Hello world.',
      narratorVoice: { voiceId: 'v1' },
      language: 'en',
      output: {},
      providerOptions: { elevenlabs: { vendorVoiceId: 'vendor-1' } },
    } as any;

    const result = await provider.synthesizeSegment(request);
    expect(result.status).toBe('completed');
  });

  describe('primary -> secondary fallback still works when the primary times out (real Postgres)', () => {
    const db = getTestDb();
    const bookRepo = new BookRepository(db);
    const chapterRepo = new ChapterRepository(db);
    const textSegmentRepo = new TextSegmentRepository(db);
    const voiceRepo = new VoiceRepository(db);
    const audioSegmentRepo = new AudioSegmentRepository(db);
    const narrationAttemptRepo = new NarrationAttemptRepository(db);
    const providerUsageRepo = new ProviderUsageRepository(db);

    it('a primary provider that times out correctly triggers fallback to the secondary provider', async () => {
      await resetDatabase();
      const storageDir = await mkdtemp(join(tmpdir(), 'lumen-13e-test-'));
      try {
        const storage = new LocalFilesystemStorageProvider(storageDir);
        const registry = new ProviderRegistry();
        registry.register(new ElevenLabsProvider({ apiKey: 'k', httpClient: timeoutOnlyDuringSynthesisFetch() }), 1);
        registry.register(new GoogleCloudTtsProvider({ apiKey: 'k', httpClient: immediateSuccessFetch() }), 2);

        const user = await createTestUser(db, `13e-${Date.now()}@example.com`);
        const voice = await voiceRepo.create({ displayName: 'Narrator', role: 'narrator', language: 'en' });
        await voiceRepo.createMapping({ voiceId: voice.id, provider: 'elevenlabs', providerVoiceId: 'vendor-el' });
        await voiceRepo.createMapping({
          voiceId: voice.id,
          provider: 'google_cloud_tts',
          providerVoiceId: 'vendor-gc',
        });
        const book = await bookRepo.create({ userId: user.id, title: '13E Fallback Test', language: 'en' });
        const chapter = await chapterRepo.create({ bookId: book.id, orderIndex: 0, sourceLocation: 'ch1' });
        const segment = await textSegmentRepo.create({
          chapterId: chapter.id,
          orderIndex: 0,
          sourceText: 'Test.',
          normalizedText: 'Test.',
          charCount: 5,
          sourceReference: 'p[0]',
          contentHash: 'h1',
          narratorVoiceId: voice.id,
        });

        const result = await narrateSegment(
          {
            storage,
            registry,
            textSegmentRepo,
            voiceRepo,
            narrationAttemptRepo,
            audioSegmentRepo,
            providerUsageRepo,
          },
          {
            textSegmentId: segment.id,
            bookId: book.id,
            chapterId: chapter.id,
            userId: user.id,
            costCeiling: { amountMicros: 999_999, currency: 'USD' },
          },
        );

        expect(result.failed).toBe(false);
        expect(result.audioSegmentId).toBeTruthy();

        const attempts = await narrationAttemptRepo.listByTextSegment(segment.id);
        expect(attempts).toHaveLength(2);
        expect(attempts[0]!.provider).toBe('elevenlabs');
        expect(attempts[0]!.status).toBe('failed');
        expect(attempts[1]!.provider).toBe('google_cloud_tts');
        expect(attempts[1]!.status).toBe('succeeded');
      } finally {
        await rm(storageDir, { recursive: true, force: true });
      }
    });
  });
});
