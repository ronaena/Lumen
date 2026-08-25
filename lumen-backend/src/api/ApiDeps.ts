import type { StorageProvider } from '../processing/storage/StorageProvider.js';
import type { ProviderRegistry } from '../tts/ProviderRegistry.js';
import type { BookRepository } from '../repositories/BookRepository.js';
import type { ChapterRepository } from '../repositories/ChapterRepository.js';
import type { TextSegmentRepository } from '../repositories/TextSegmentRepository.js';
import type { VoiceRepository } from '../repositories/VoiceRepository.js';
import type { AudioSegmentRepository } from '../repositories/AudioSegmentRepository.js';
import type { NarrationAttemptRepository } from '../repositories/NarrationAttemptRepository.js';
import type { ProviderUsageRepository } from '../repositories/ProviderUsageRepository.js';
import type { ProcessingJobRepository } from '../repositories/ProcessingJobRepository.js';
import type { ListeningProgressRepository } from '../repositories/ListeningProgressRepository.js';
import type { ReadingProgressRepository } from '../repositories/ReadingProgressRepository.js';
import type { CharacterRepository } from '../repositories/CharacterRepository.js';
import type { CharacterVoiceAssignmentRepository } from '../repositories/CharacterVoiceAssignmentRepository.js';
import type { SceneRepository } from '../repositories/SceneRepository.js';

/**
 * ApiDeps — everything the API layer is allowed to depend on: existing repositories and
 * the existing StorageProvider/ProviderRegistry. Route handlers receive this bag and
 * call existing service functions (ingestBook, runNarrationJob, updateListeningProgress,
 * createCharacter, createScene, etc.) — they never construct new business logic.
 */
export interface ApiDeps {
  storage: StorageProvider;
  registry: ProviderRegistry;
  bookRepo: BookRepository;
  chapterRepo: ChapterRepository;
  textSegmentRepo: TextSegmentRepository;
  voiceRepo: VoiceRepository;
  audioSegmentRepo: AudioSegmentRepository;
  narrationAttemptRepo: NarrationAttemptRepository;
  providerUsageRepo: ProviderUsageRepository;
  jobRepo: ProcessingJobRepository;
  listeningProgressRepo: ListeningProgressRepository;
  readingProgressRepo: ReadingProgressRepository;
  characterRepo: CharacterRepository;
  characterVoiceAssignmentRepo: CharacterVoiceAssignmentRepository;
  sceneRepo: SceneRepository;
}
