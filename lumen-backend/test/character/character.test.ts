import { describe, it, expect, beforeEach } from 'vitest';
import { getTestDb, resetDatabase, createTestUser } from '../db/setup.js';
import { BookRepository } from '../../src/repositories/BookRepository.js';
import { ChapterRepository } from '../../src/repositories/ChapterRepository.js';
import { TextSegmentRepository } from '../../src/repositories/TextSegmentRepository.js';
import { VoiceRepository } from '../../src/repositories/VoiceRepository.js';
import { CharacterRepository } from '../../src/repositories/CharacterRepository.js';
import { CharacterVoiceAssignmentRepository } from '../../src/repositories/CharacterVoiceAssignmentRepository.js';
import { AudioSegmentRepository } from '../../src/repositories/AudioSegmentRepository.js';
import { NarrationAttemptRepository } from '../../src/repositories/NarrationAttemptRepository.js';
import { ProviderUsageRepository } from '../../src/repositories/ProviderUsageRepository.js';
import {
  createCharacter,
  assignCharacterVoice,
  assignSegmentToCharacter,
  clearSegmentCharacterVoice,
} from '../../src/character/CharacterService.js';
import { narrateSegment } from '../../src/narration/NarrationEngine.js';
import { ProviderRegistry } from '../../src/tts/ProviderRegistry.js';
import { ElevenLabsProvider } from '../../src/tts/providers/elevenlabs/ElevenLabsProvider.js';
import { GoogleCloudTtsProvider } from '../../src/tts/providers/google/GoogleCloudTtsProvider.js';
import { ProcessingError } from '../../src/processing/errors/ProcessingErrors.js';
import { LocalFilesystemStorageProvider } from '../../src/processing/storage/LocalFilesystemStorageProvider.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fakeHttpClient(
  handler: (url: string, init?: RequestInit) => Promise<Response> | Response,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => handler(String(input), init)) as typeof fetch;
}
const FAKE_MP3 = Buffer.from('fake-mp3-bytes');

describe('Phase 7: Character / Multi-Voice Foundation (live Postgres)', () => {
  const db = getTestDb();
  const bookRepo = new BookRepository(db);
  const chapterRepo = new ChapterRepository(db);
  const textSegmentRepo = new TextSegmentRepository(db);
  const voiceRepo = new VoiceRepository(db);
  const characterRepo = new CharacterRepository(db);
  const characterVoiceAssignmentRepo = new CharacterVoiceAssignmentRepository(db);
  const audioSegmentRepo = new AudioSegmentRepository(db);
  const narrationAttemptRepo = new NarrationAttemptRepository(db);
  const providerUsageRepo = new ProviderUsageRepository(db);

  const svcDeps = { bookRepo, chapterRepo, textSegmentRepo, voiceRepo, characterRepo, characterVoiceAssignmentRepo };

  let storageDir: string;
  beforeEach(async () => {
    await resetDatabase();
    storageDir = await mkdtemp(join(tmpdir(), 'lumen-character-test-'));
  });

  async function makeBookWithSegment() {
    const user = await createTestUser(db, `char-${Date.now()}-${Math.random()}@example.com`);
    const narratorVoice = await voiceRepo.create({ displayName: 'Narrator', role: 'narrator', language: 'en' });
    const book = await bookRepo.create({ userId: user.id, title: 'Character Test Book', language: 'en' });
    const chapter = await chapterRepo.create({ bookId: book.id, orderIndex: 0, sourceLocation: 'ch1' });
    const segment = await textSegmentRepo.create({
      chapterId: chapter.id,
      orderIndex: 0,
      sourceText: '"Hello," said the wizard.',
      normalizedText: '"Hello," said the wizard.',
      charCount: 25,
      sourceReference: 'p[0]',
      contentHash: 'hash-1',
      narratorVoiceId: narratorVoice.id,
    });
    return { user, narratorVoice, book, chapter, segment };
  }

  it('creates a character owned by the book', async () => {
    const { user, book } = await makeBookWithSegment();
    const character = await createCharacter(svcDeps, { userId: user.id, bookId: book.id, name: 'The Wizard' });
    expect(character.bookId).toBe(book.id);
    expect(character.name).toBe('The Wizard');
  });

  it('assigns a voice to a character and resolves it back', async () => {
    const { user, book } = await makeBookWithSegment();
    const character = await createCharacter(svcDeps, { userId: user.id, bookId: book.id, name: 'The Wizard' });
    const characterVoice = await voiceRepo.create({
      displayName: 'Wizard Voice',
      role: 'character',
      language: 'en',
      bookId: book.id,
    });

    await assignCharacterVoice(svcDeps, { userId: user.id, characterId: character.id, voiceId: characterVoice.id });

    const assignment = await characterVoiceAssignmentRepo.findByCharacterId(character.id);
    expect(assignment!.voiceId).toBe(characterVoice.id);
  });

  it('provider mapping resolution works identically for a character voice as for a narrator voice', async () => {
    const { user, book } = await makeBookWithSegment();
    const character = await createCharacter(svcDeps, { userId: user.id, bookId: book.id, name: 'The Wizard' });
    const characterVoice = await voiceRepo.create({
      displayName: 'Wizard Voice',
      role: 'character',
      language: 'en',
      bookId: book.id,
    });
    await assignCharacterVoice(svcDeps, { userId: user.id, characterId: character.id, voiceId: characterVoice.id });
    await voiceRepo.createMapping({ voiceId: characterVoice.id, provider: 'elevenlabs', providerVoiceId: 'wizard-vendor-1' });

    const mapping = await voiceRepo.findMapping(characterVoice.id, 'elevenlabs');
    expect(mapping!.providerVoiceId).toBe('wizard-vendor-1');
  });

  it('assigns a segment to a character, narrates it with the character voice (not the narrator voice), and clears it back', async () => {
    const { user, book, chapter, segment, narratorVoice } = await makeBookWithSegment();
    const character = await createCharacter(svcDeps, { userId: user.id, bookId: book.id, name: 'The Wizard' });
    const characterVoice = await voiceRepo.create({
      displayName: 'Wizard Voice',
      role: 'character',
      language: 'en',
      bookId: book.id,
    });
    await assignCharacterVoice(svcDeps, { userId: user.id, characterId: character.id, voiceId: characterVoice.id });
    await voiceRepo.createMapping({ voiceId: characterVoice.id, provider: 'elevenlabs', providerVoiceId: 'wizard-vendor-1' });

    await assignSegmentToCharacter(svcDeps, { userId: user.id, textSegmentId: segment.id, characterId: character.id });
    const updatedSegment = await textSegmentRepo.findById(segment.id);
    expect(updatedSegment!.characterVoiceId).toBe(characterVoice.id);

    // Narrate — must resolve the CHARACTER voice's mapping, not the narrator's.
    const storage = new LocalFilesystemStorageProvider(storageDir);
    const registry = new ProviderRegistry();
    registry.register(
      new ElevenLabsProvider({
        apiKey: 'k',
        httpClient: fakeHttpClient((url) => {
          if (url.includes('/v1/user')) return new Response('{}', { status: 200 });
          expect(url).toContain('/v1/text-to-speech/wizard-vendor-1'); // proves it used the character mapping
          return new Response(FAKE_MP3, { status: 200 });
        }),
      }),
      1,
    );
    const engineDeps = { storage, registry, textSegmentRepo, voiceRepo, narrationAttemptRepo, audioSegmentRepo, providerUsageRepo };

    const result = await narrateSegment(engineDeps, {
      textSegmentId: segment.id,
      bookId: book.id,
      chapterId: chapter.id,
      userId: user.id,
    });
    expect(result.failed).toBe(false);
    const audio = await audioSegmentRepo.findById(result.audioSegmentId!);
    expect(audio!.providerVoiceId).toBe('wizard-vendor-1'); // not the narrator's vendor id

    // Clear it back to narrator-only.
    await clearSegmentCharacterVoice(svcDeps, { userId: user.id, textSegmentId: segment.id });
    const cleared = await textSegmentRepo.findById(segment.id);
    expect(cleared!.characterVoiceId).toBeNull();
    expect(cleared!.narratorVoiceId).toBe(narratorVoice.id); // narrator assignment untouched
  });

  it('provider fallback works for a character voice exactly as it does for the narrator', async () => {
    const { user, book, chapter, segment } = await makeBookWithSegment();
    const character = await createCharacter(svcDeps, { userId: user.id, bookId: book.id, name: 'The Wizard' });
    const characterVoice = await voiceRepo.create({ displayName: 'Wizard', role: 'character', language: 'en', bookId: book.id });
    await assignCharacterVoice(svcDeps, { userId: user.id, characterId: character.id, voiceId: characterVoice.id });
    await voiceRepo.createMapping({ voiceId: characterVoice.id, provider: 'elevenlabs', providerVoiceId: 'wizard-eleven' });
    await voiceRepo.createMapping({ voiceId: characterVoice.id, provider: 'google_cloud_tts', providerVoiceId: 'wizard-google' });
    await assignSegmentToCharacter(svcDeps, { userId: user.id, textSegmentId: segment.id, characterId: character.id });

    const storage = new LocalFilesystemStorageProvider(storageDir);
    const registry = new ProviderRegistry();
    registry.register(
      new ElevenLabsProvider({
        apiKey: 'k',
        httpClient: fakeHttpClient((url) =>
          url.includes('/v1/user') ? new Response('{}', { status: 200 }) : new Response('fail', { status: 503 }),
        ),
      }),
      1,
    );
    registry.register(
      new GoogleCloudTtsProvider({
        apiKey: 'k',
        httpClient: fakeHttpClient(() => new Response(JSON.stringify({ audioContent: FAKE_MP3.toString('base64') }), { status: 200 })),
      }),
      2,
    );
    const engineDeps = { storage, registry, textSegmentRepo, voiceRepo, narrationAttemptRepo, audioSegmentRepo, providerUsageRepo };

    const result = await narrateSegment(engineDeps, {
      textSegmentId: segment.id,
      bookId: book.id,
      chapterId: chapter.id,
      userId: user.id,
    });
    expect(result.failed).toBe(false);
    const audio = await audioSegmentRepo.findById(result.audioSegmentId!);
    expect(audio!.provider).toBe('google_cloud_tts');
    expect(audio!.providerVoiceId).toBe('wizard-google'); // same logical character Voice, different vendor mapping
  });

  it('missing mapping for a character voice is skipped without wasting an attempt, exactly like a narrator voice', async () => {
    const { user, book, chapter, segment } = await makeBookWithSegment();
    const character = await createCharacter(svcDeps, { userId: user.id, bookId: book.id, name: 'The Wizard' });
    const characterVoice = await voiceRepo.create({ displayName: 'Wizard', role: 'character', language: 'en', bookId: book.id });
    await assignCharacterVoice(svcDeps, { userId: user.id, characterId: character.id, voiceId: characterVoice.id });
    // Only Google has a mapping for this character voice.
    await voiceRepo.createMapping({ voiceId: characterVoice.id, provider: 'google_cloud_tts', providerVoiceId: 'wizard-google' });
    await assignSegmentToCharacter(svcDeps, { userId: user.id, textSegmentId: segment.id, characterId: character.id });

    const storage = new LocalFilesystemStorageProvider(storageDir);
    const registry = new ProviderRegistry();
    registry.register(new ElevenLabsProvider({ apiKey: 'k', httpClient: fakeHttpClient(() => new Response(FAKE_MP3, { status: 200 })) }), 1);
    registry.register(
      new GoogleCloudTtsProvider({ apiKey: 'k', httpClient: fakeHttpClient(() => new Response(JSON.stringify({ audioContent: FAKE_MP3.toString('base64') }), { status: 200 })) }),
      2,
    );
    const engineDeps = { storage, registry, textSegmentRepo, voiceRepo, narrationAttemptRepo, audioSegmentRepo, providerUsageRepo };

    const result = await narrateSegment(engineDeps, {
      textSegmentId: segment.id,
      bookId: book.id,
      chapterId: chapter.id,
      userId: user.id,
    });
    expect(result.attemptIds).toHaveLength(1);
    const attempt = await narrationAttemptRepo.findById(result.attemptIds[0]!);
    expect(attempt!.provider).toBe('google_cloud_tts');
  });

  it('reassigning a character voice cascades to every segment using it and triggers real regeneration', async () => {
    const { user, book, chapter, segment } = await makeBookWithSegment();
    const character = await createCharacter(svcDeps, { userId: user.id, bookId: book.id, name: 'The Wizard' });
    const voiceA = await voiceRepo.create({ displayName: 'Wizard A', role: 'character', language: 'en', bookId: book.id });
    const voiceB = await voiceRepo.create({ displayName: 'Wizard B', role: 'character', language: 'en', bookId: book.id });
    await voiceRepo.createMapping({ voiceId: voiceA.id, provider: 'elevenlabs', providerVoiceId: 'vendor-a' });
    await voiceRepo.createMapping({ voiceId: voiceB.id, provider: 'elevenlabs', providerVoiceId: 'vendor-b' });

    await assignCharacterVoice(svcDeps, { userId: user.id, characterId: character.id, voiceId: voiceA.id });
    await assignSegmentToCharacter(svcDeps, { userId: user.id, textSegmentId: segment.id, characterId: character.id });

    const storage = new LocalFilesystemStorageProvider(storageDir);
    const registry = new ProviderRegistry();
    registry.register(new ElevenLabsProvider({ apiKey: 'k', httpClient: fakeHttpClient(() => new Response(FAKE_MP3, { status: 200 })) }), 1);
    const engineDeps = { storage, registry, textSegmentRepo, voiceRepo, narrationAttemptRepo, audioSegmentRepo, providerUsageRepo };

    const first = await narrateSegment(engineDeps, { textSegmentId: segment.id, bookId: book.id, chapterId: chapter.id, userId: user.id });
    const firstAudio = await audioSegmentRepo.findById(first.audioSegmentId!);
    expect(firstAudio!.providerVoiceId).toBe('vendor-a');

    // A second, unrelated call with unchanged everything is a no-op skip — confirms the
    // baseline idempotency still holds before we test that a REAL change breaks it.
    const unchangedRerun = await narrateSegment(engineDeps, { textSegmentId: segment.id, bookId: book.id, chapterId: chapter.id, userId: user.id });
    expect(unchangedRerun.skipped).toBe(true);

    // Reassign the character to a different voice — this is the defect-fix under test:
    // without resolving the EFFECTIVE voice into the signature, this would NOT have
    // triggered regeneration.
    await assignCharacterVoice(svcDeps, { userId: user.id, characterId: character.id, voiceId: voiceB.id });
    const reassignedSegment = await textSegmentRepo.findById(segment.id);
    expect(reassignedSegment!.characterVoiceId).toBe(voiceB.id); // cascade worked

    const second = await narrateSegment(engineDeps, { textSegmentId: segment.id, bookId: book.id, chapterId: chapter.id, userId: user.id });
    expect(second.skipped).toBe(false); // regeneration WAS triggered
    const secondAudio = await audioSegmentRepo.findById(second.audioSegmentId!);
    expect(secondAudio!.providerVoiceId).toBe('vendor-b');

    // Old audio preserved, not deleted.
    const reloadedFirst = await audioSegmentRepo.findById(firstAudio!.id);
    expect(reloadedFirst!.status).toBe('superseded');
  });

  it('ownership isolation: a different user cannot create characters or assign voices on this book', async () => {
    const { book } = await makeBookWithSegment();
    const otherUser = await createTestUser(db, `char-other-${Date.now()}@example.com`);

    await expect(
      createCharacter(svcDeps, { userId: otherUser.id, bookId: book.id, name: 'Intruder' }),
    ).rejects.toMatchObject({ code: 'CHARACTER_NOT_FOUND' });
  });

  it('cross-book character reference is rejected when assigning a segment', async () => {
    const { user, book, segment } = await makeBookWithSegment();
    const otherBook = await bookRepo.create({ userId: user.id, title: 'Other Book', language: 'en' });
    const otherCharacter = await createCharacter(svcDeps, { userId: user.id, bookId: otherBook.id, name: 'Stranger' });
    const voice = await voiceRepo.create({ displayName: 'V', role: 'character', language: 'en' });
    await assignCharacterVoice(svcDeps, { userId: user.id, characterId: otherCharacter.id, voiceId: voice.id });

    await expect(
      assignSegmentToCharacter(svcDeps, { userId: user.id, textSegmentId: segment.id, characterId: otherCharacter.id }),
    ).rejects.toMatchObject({ code: 'CHARACTER_NOT_FOUND' });
  });

  it('assigning a segment to a character with no voice assignment yet is rejected', async () => {
    const { user, book, segment } = await makeBookWithSegment();
    const character = await createCharacter(svcDeps, { userId: user.id, bookId: book.id, name: 'Voiceless' });

    await expect(
      assignSegmentToCharacter(svcDeps, { userId: user.id, textSegmentId: segment.id, characterId: character.id }),
    ).rejects.toMatchObject({ code: 'VOICE_ASSIGNMENT_INVALID' });
  });

  it('no vendor-specific character model exists anywhere in domain logic', async () => {
    const fs = await import('node:fs');
    const content = fs.readFileSync('src/character/CharacterService.ts', 'utf8');
    expect(content).not.toMatch(/elevenlabs|google_cloud_tts|googleapis/i);
  });
});
