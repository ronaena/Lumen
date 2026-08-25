/**
 * seedSystemVoices.ts — Gap 3's approved seed mechanism.
 *
 * IMPORTANT, READ BEFORE ADDING ENTRIES:
 * This script does NOT contain any voice definitions today. A repository-wide search
 * (performed during Gap 3 discovery) confirmed no real, approved ElevenLabs/Google Cloud
 * voice IDs exist anywhere in this codebase, in any documentation, or in any prior
 * decision record. Every `providerVoiceId`/`vendorVoiceId` value that has ever appeared
 * in this project is either a type definition or an explicitly-fake test fixture value
 * (e.g. 'vendor-voice-1'). Inventing a real-looking vendor ID here to populate this list
 * would risk that fabricated value quietly becoming treated as real, approved production
 * data — exactly what was explicitly prohibited when this workstream was authorized.
 *
 * This script is real, runnable infrastructure, ready for the moment real voice
 * definitions ARE approved (once live TTS provider validation happens — see the
 * project's own standing limitation on that, unresolved since the earlier transition
 * discovery). Until then, running it is a safe no-op: zero voices, zero mappings, no
 * fabricated data ever touches the database.
 *
 * To use this once real definitions exist, populate SYSTEM_VOICE_DEFINITIONS with real,
 * externally-verified values — never guessed ones.
 */
import { createDatabase } from './client.js';
import { VoiceRepository } from '../repositories/VoiceRepository.js';

export interface SystemVoiceDefinition {
  displayName: string;
  role: 'narrator' | 'character';
  language: string;
  /** Real provider identity, verified against the actual vendor -- never guessed. */
  providerMappings: Array<{
    provider: 'elevenlabs' | 'google_cloud_tts';
    providerVoiceId: string;
    providerModel?: string;
  }>;
}

/**
 * Deliberately empty. See the module-level comment above for why, and for what must be
 * true before an entry is added here.
 */
export const SYSTEM_VOICE_DEFINITIONS: SystemVoiceDefinition[] = [];

export async function seedSystemVoices(voiceRepo: VoiceRepository): Promise<{ created: number }> {
  let created = 0;
  for (const definition of SYSTEM_VOICE_DEFINITIONS) {
    const voice = await voiceRepo.create({
      displayName: definition.displayName,
      role: definition.role,
      language: definition.language,
    });
    for (const mapping of definition.providerMappings) {
      await voiceRepo.createMapping({
        voiceId: voice.id,
        provider: mapping.provider,
        providerVoiceId: mapping.providerVoiceId,
        providerModel: mapping.providerModel,
      });
    }
    created += 1;
  }
  return { created };
}

// Allows running directly: `tsx src/db/seedSystemVoices.ts` -- mirrors migrate.ts's own
// pattern for a standalone, deliberately-run administrative script (not migrations,
// since this is data, not schema).
if (import.meta.url === `file://${process.argv[1]}`) {
  const { loadEnv } = await import('../config/env.js');
  const env = loadEnv();
  const db = createDatabase(env.DATABASE_URL);
  const voiceRepo = new VoiceRepository(db);
  const result = await seedSystemVoices(voiceRepo);
  console.log(`Seeded ${result.created} system voice(s).`);
  if (result.created === 0) {
    console.log('SYSTEM_VOICE_DEFINITIONS is currently empty -- see the comment at the top of this file.');
  }
}
