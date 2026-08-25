import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { getTestDb, resetDatabase, createTextSegmentFixture } from '../db/setup.js';
import { LocalFilesystemStorageProvider } from '../../src/processing/storage/LocalFilesystemStorageProvider.js';
import { ProviderRegistry } from '../../src/tts/ProviderRegistry.js';
import { ElevenLabsProvider } from '../../src/tts/providers/elevenlabs/ElevenLabsProvider.js';
import { GoogleCloudTtsProvider } from '../../src/tts/providers/google/GoogleCloudTtsProvider.js';
import { narrateSegment } from '../../src/narration/NarrationEngine.js';
import { TextSegmentRepository } from '../../src/repositories/TextSegmentRepository.js';
import { VoiceRepository } from '../../src/repositories/VoiceRepository.js';
import { NarrationAttemptRepository } from '../../src/repositories/NarrationAttemptRepository.js';
import { AudioSegmentRepository } from '../../src/repositories/AudioSegmentRepository.js';
import { ProviderUsageRepository } from '../../src/repositories/ProviderUsageRepository.js';

function fakeHttpClient(
  handler: (url: string, init?: RequestInit) => Promise<Response> | Response,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => handler(String(input), init)) as typeof fetch;
}

const FAKE_MP3 = Buffer.from('fake-mp3-audio-bytes-for-testing');

function elevenLabsSuccess() {
  return new ElevenLabsProvider({
    apiKey: 'k',
    httpClient: fakeHttpClient(() => new Response(FAKE_MP3, { status: 200 })),
  });
}
// Fails synthesis specifically, while reporting healthy on the availability-check
// endpoint (/v1/user) — this is the realistic scenario the fallback loop exists for: a
// provider that LOOKS available but fails on an actual synthesis call. Conflating the two
// endpoints into one blanket-failing handler was an earlier bug in this fixture — it made
// ProviderRegistry filter the provider out via checkAvailability() before the fallback
// loop ever ran, which silently prevented the fallback path from being exercised at all.
function elevenLabsFailing(status: number) {
  return new ElevenLabsProvider({
    apiKey: 'k',
    httpClient: fakeHttpClient((url) => {
      if (url.includes('/v1/user')) return new Response('{}', { status: 200 });
      return new Response('failure', { status });
    }),
  });
}
function googleSuccess() {
  return new GoogleCloudTtsProvider({
    apiKey: 'k',
    httpClient: fakeHttpClient(
      () => new Response(JSON.stringify({ audioContent: FAKE_MP3.toString('base64') }), { status: 200 }),
    ),
  });
}
// Same fix as elevenLabsFailing: healthy on the availability-check endpoint (/v1/voices),
// fails only the synthesis endpoint (/v1/text:synthesize).
function googleFailing(status: number) {
  return new GoogleCloudTtsProvider({
    apiKey: 'k',
    httpClient: fakeHttpClient((url) => {
      if (url.includes('/v1/voices')) return new Response('{}', { status: 200 });
      return new Response('failure', { status });
    }),
  });
}

describe('Phase 4: NarrationEngine (offline provider fixtures, live Postgres + real storage)', () => {
  const db = getTestDb();
  const textSegmentRepo = new TextSegmentRepository(db);
  const voiceRepo = new VoiceRepository(db);
  const narrationAttemptRepo = new NarrationAttemptRepository(db);
  const audioSegmentRepo = new AudioSegmentRepository(db);
  const providerUsageRepo = new ProviderUsageRepository(db);

  let storageDir: string;
  let storage: LocalFilesystemStorageProvider;

  beforeAll(async () => {
    storageDir = await mkdtemp(join(tmpdir(), 'lumen-narration-test-'));
  });
  afterAll(async () => {
    await rm(storageDir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await resetDatabase();
    storage = new LocalFilesystemStorageProvider(storageDir);
  });

  function deps(registry: ProviderRegistry) {
    return { storage, registry, textSegmentRepo, voiceRepo, narrationAttemptRepo, audioSegmentRepo, providerUsageRepo };
  }

  it('happy path: narrates a segment end to end with full audit trail and real storage round-trip', async () => {
    const { book, chapter, segment, voice, user } = await createTextSegmentFixture(db, 'engine1');
    await voiceRepo.createMapping({ voiceId: voice.id, provider: 'elevenlabs', providerVoiceId: 'vendor-1' });

    const registry = new ProviderRegistry();
    registry.register(elevenLabsSuccess(), 1);

    const result = await narrateSegment(deps(registry), {
      textSegmentId: segment.id,
      bookId: book.id,
      chapterId: chapter.id,
      userId: user.id,
    });

    expect(result.skipped).toBe(false);
    expect(result.failed).toBe(false);
    expect(result.attemptIds).toHaveLength(1);

    const audioSegment = await audioSegmentRepo.findById(result.audioSegmentId!);
    expect(audioSegment!.status).toBe('active');
    expect(audioSegment!.provider).toBe('elevenlabs');
    expect(audioSegment!.providerVoiceId).toBe('vendor-1');

    const storedBytes = await storage.read(audioSegment!.storageRef);
    expect(Buffer.compare(storedBytes, FAKE_MP3)).toBe(0);

    const updatedSegment = await textSegmentRepo.findById(segment.id);
    expect(updatedSegment!.currentAudioSegmentId).toBe(audioSegment!.id);
    expect(updatedSegment!.narrationStatus).toBe('ready');

    const attempt = await narrationAttemptRepo.findById(result.attemptIds[0]!);
    expect(attempt!.status).toBe('succeeded');
    expect(audioSegment!.producedByAttemptId).toBe(attempt!.id);
    expect(attempt!.requestId).not.toBe(attempt!.requestSignature);

    const usageResult: any = await db.execute(
      sql`SELECT * FROM provider_usage WHERE narration_attempt_id = ${attempt!.id}`,
    );
    const usageRows = usageResult.rows ?? usageResult;
    expect(usageRows).toHaveLength(1);
  });

  it('idempotency: a second call with unchanged content/voice/direction is a no-op skip', async () => {
    const { book, chapter, segment, voice, user } = await createTextSegmentFixture(db, 'engine2');
    await voiceRepo.createMapping({ voiceId: voice.id, provider: 'elevenlabs', providerVoiceId: 'vendor-1' });
    const registry = new ProviderRegistry();
    registry.register(elevenLabsSuccess(), 1);

    const first = await narrateSegment(deps(registry), {
      textSegmentId: segment.id,
      bookId: book.id,
      chapterId: chapter.id,
      userId: user.id,
    });
    expect(first.skipped).toBe(false);

    const second = await narrateSegment(deps(registry), {
      textSegmentId: segment.id,
      bookId: book.id,
      chapterId: chapter.id,
      userId: user.id,
    });
    expect(second.skipped).toBe(true);
    expect(second.audioSegmentId).toBe(first.audioSegmentId);
    expect(second.attemptIds).toHaveLength(0);

    const allAttempts = await narrationAttemptRepo.listByTextSegment(segment.id);
    expect(allAttempts).toHaveLength(1);
  });

  it('regenerates when contentHash changes, superseding the old audio and preserving history', async () => {
    const { book, chapter, segment, voice, user } = await createTextSegmentFixture(db, 'engine3');
    await voiceRepo.createMapping({ voiceId: voice.id, provider: 'elevenlabs', providerVoiceId: 'vendor-1' });
    const registry = new ProviderRegistry();
    registry.register(elevenLabsSuccess(), 1);

    const first = await narrateSegment(deps(registry), {
      textSegmentId: segment.id,
      bookId: book.id,
      chapterId: chapter.id,
      userId: user.id,
    });

    await db.execute(
      sql`UPDATE text_segments SET normalized_text = 'A brand new sentence.', content_hash = 'new-hash-value', text_version = 2 WHERE id = ${segment.id}`,
    );

    const second = await narrateSegment(deps(registry), {
      textSegmentId: segment.id,
      bookId: book.id,
      chapterId: chapter.id,
      userId: user.id,
    });

    expect(second.skipped).toBe(false);
    expect(second.audioSegmentId).not.toBe(first.audioSegmentId);

    const oldAudio = await audioSegmentRepo.findById(first.audioSegmentId!);
    const newAudio = await audioSegmentRepo.findById(second.audioSegmentId!);
    expect(oldAudio!.status).toBe('superseded');
    expect(newAudio!.status).toBe('active');

    const updatedSegment = await textSegmentRepo.findById(segment.id);
    expect(updatedSegment!.currentAudioSegmentId).toBe(newAudio!.id);

    const allAttempts = await narrationAttemptRepo.listByTextSegment(segment.id);
    expect(allAttempts).toHaveLength(2);
  });

  it('regenerates when deliveryDirectionVersion changes, even with content unchanged', async () => {
    const { book, chapter, segment, voice, user } = await createTextSegmentFixture(db, 'engine4');
    await voiceRepo.createMapping({ voiceId: voice.id, provider: 'elevenlabs', providerVoiceId: 'vendor-1' });
    const registry = new ProviderRegistry();
    registry.register(elevenLabsSuccess(), 1);

    const first = await narrateSegment(deps(registry), {
      textSegmentId: segment.id,
      bookId: book.id,
      chapterId: chapter.id,
      userId: user.id,
    });

    await db.execute(sql`UPDATE text_segments SET delivery_direction_version = 2 WHERE id = ${segment.id}`);

    const second = await narrateSegment(deps(registry), {
      textSegmentId: segment.id,
      bookId: book.id,
      chapterId: chapter.id,
      userId: user.id,
    });

    expect(second.skipped).toBe(false);
    expect(second.audioSegmentId).not.toBe(first.audioSegmentId);
  });

  it('fallback: ElevenLabs fails with a retryable error, Google succeeds, chain is fully traceable', async () => {
    const { book, chapter, segment, voice, user } = await createTextSegmentFixture(db, 'engine5');
    await voiceRepo.createMapping({ voiceId: voice.id, provider: 'elevenlabs', providerVoiceId: 'eleven-vendor-1' });
    await voiceRepo.createMapping({ voiceId: voice.id, provider: 'google_cloud_tts', providerVoiceId: 'en-US-Studio-O' });

    const registry = new ProviderRegistry();
    registry.register(elevenLabsFailing(503), 1);
    registry.register(googleSuccess(), 2);

    const result = await narrateSegment(deps(registry), {
      textSegmentId: segment.id,
      bookId: book.id,
      chapterId: chapter.id,
      userId: user.id,
    });

    expect(result.skipped).toBe(false);
    expect(result.failed).toBe(false);
    expect(result.attemptIds).toHaveLength(2);

    const audioSegment = await audioSegmentRepo.findById(result.audioSegmentId!);
    expect(audioSegment!.provider).toBe('google_cloud_tts');
    expect(audioSegment!.providerVoiceId).toBe('en-US-Studio-O');

    const chain = await narrationAttemptRepo.getFallbackChain(result.attemptIds[1]!);
    expect(chain).toHaveLength(2);
    expect(chain[0]!.provider).toBe('elevenlabs');
    expect(chain[0]!.status).toBe('failed');
    expect(chain[0]!.normalizedErrorCode).toBe('PROVIDER_UNAVAILABLE');
    expect(chain[1]!.provider).toBe('google_cloud_tts');
    expect(chain[1]!.status).toBe('succeeded');
    expect(chain[1]!.isFallbackAttempt).toBe(true);
    expect(chain[1]!.triggeringAttemptId).toBe(chain[0]!.id);

    const usageResult: any = await db.execute(
      sql`SELECT outcome FROM provider_usage WHERE text_segment_id = ${segment.id} ORDER BY recorded_at`,
    );
    const usageRows = usageResult.rows ?? usageResult;
    expect(usageRows).toHaveLength(2);
  });

  it('both providers fail: segment is marked failed, both attempts preserved, no audio created', async () => {
    const { book, chapter, segment, voice, user } = await createTextSegmentFixture(db, 'engine6');
    await voiceRepo.createMapping({ voiceId: voice.id, provider: 'elevenlabs', providerVoiceId: 'eleven-vendor-1' });
    await voiceRepo.createMapping({ voiceId: voice.id, provider: 'google_cloud_tts', providerVoiceId: 'en-US-Studio-O' });

    const registry = new ProviderRegistry();
    registry.register(elevenLabsFailing(503), 1);
    registry.register(googleFailing(503), 2);

    const result = await narrateSegment(deps(registry), {
      textSegmentId: segment.id,
      bookId: book.id,
      chapterId: chapter.id,
      userId: user.id,
    });

    expect(result.failed).toBe(true);
    expect(result.attemptIds).toHaveLength(2);
    expect(result.lastErrorCode).toBe('PROVIDER_UNAVAILABLE');

    const updatedSegment = await textSegmentRepo.findById(segment.id);
    expect(updatedSegment!.narrationStatus).toBe('failed');
    expect(updatedSegment!.currentAudioSegmentId).toBeNull();

    const activeAudio = await audioSegmentRepo.findActiveForTextSegment(segment.id);
    expect(activeAudio).toBeNull();
  });

  it('a non-retryable failure (AUTH_ERROR) does not attempt fallback even when a second provider is registered', async () => {
    const { book, chapter, segment, voice, user } = await createTextSegmentFixture(db, 'engine7');
    await voiceRepo.createMapping({ voiceId: voice.id, provider: 'elevenlabs', providerVoiceId: 'eleven-vendor-1' });
    await voiceRepo.createMapping({ voiceId: voice.id, provider: 'google_cloud_tts', providerVoiceId: 'en-US-Studio-O' });

    const registry = new ProviderRegistry();
    registry.register(elevenLabsFailing(401), 1);
    registry.register(googleSuccess(), 2);

    const result = await narrateSegment(deps(registry), {
      textSegmentId: segment.id,
      bookId: book.id,
      chapterId: chapter.id,
      userId: user.id,
    });

    expect(result.failed).toBe(true);
    expect(result.attemptIds).toHaveLength(1);
    expect(result.lastErrorCode).toBe('AUTH_ERROR');
  });

  it('skips a provider with no VoiceProviderMapping without creating an attempt for it', async () => {
    const { book, chapter, segment, voice, user } = await createTextSegmentFixture(db, 'engine8');
    await voiceRepo.createMapping({ voiceId: voice.id, provider: 'google_cloud_tts', providerVoiceId: 'en-US-Studio-O' });

    const registry = new ProviderRegistry();
    registry.register(elevenLabsSuccess(), 1);
    registry.register(googleSuccess(), 2);

    const result = await narrateSegment(deps(registry), {
      textSegmentId: segment.id,
      bookId: book.id,
      chapterId: chapter.id,
      userId: user.id,
    });

    expect(result.failed).toBe(false);
    expect(result.attemptIds).toHaveLength(1);
    const attempt = await narrationAttemptRepo.findById(result.attemptIds[0]!);
    expect(attempt!.provider).toBe('google_cloud_tts');
  });

  it('persists costCeilingAtRequest when a cost ceiling is provided', async () => {
    const { book, chapter, segment, voice, user } = await createTextSegmentFixture(db, 'engine9');
    await voiceRepo.createMapping({ voiceId: voice.id, provider: 'elevenlabs', providerVoiceId: 'vendor-1' });
    const registry = new ProviderRegistry();
    registry.register(elevenLabsSuccess(), 1);

    const result = await narrateSegment(deps(registry), {
      textSegmentId: segment.id,
      bookId: book.id,
      chapterId: chapter.id,
      userId: user.id,
      costCeiling: { amountMicros: 999999, currency: 'USD' },
    });

    const attempt = await narrationAttemptRepo.findById(result.attemptIds[0]!);
    expect(attempt!.costCeilingAtRequest).not.toBeNull();
  });
});
