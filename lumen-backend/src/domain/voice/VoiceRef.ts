/**
 * VoiceRef — the provider-neutral voice identity used throughout the domain layer.
 *
 * `voiceId` refers to Lumen's internal Voice entity (see db/schema/voices.ts), never a
 * vendor voice ID. Vendor voice IDs live exclusively in VoiceProviderMapping and are
 * resolved at the provider-adapter boundary, not here.
 */
export interface VoiceRef {
  voiceId: string;
  role: 'narrator' | 'character';
  characterId?: string;
}
