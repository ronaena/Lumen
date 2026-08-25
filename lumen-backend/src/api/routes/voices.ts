import type { ApiRequest, ApiResponse } from '../http/ApiRouter';
import type { ApiDeps } from '../ApiDeps';

/**
 * GET /voices — Gap 3. Returns system/shared voices only (voiceRepo.listSystemVoices()
 * already filters to userId IS NULL). Deliberately excludes every VoiceProviderMapping
 * field (providerVoiceId, provider, isActive) and userId/bookId (always null here
 * anyway, and omitted regardless, per the approved response shape).
 */
export async function handleListVoices(deps: ApiDeps, _req: ApiRequest): Promise<ApiResponse> {
  const voices = await deps.voiceRepo.listSystemVoices();
  return {
    status: 200,
    body: voices.map((voice) => ({
      id: voice.id,
      displayName: voice.displayName,
      role: voice.role,
      language: voice.language,
    })),
  };
}
