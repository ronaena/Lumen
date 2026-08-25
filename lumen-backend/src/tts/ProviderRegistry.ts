import type { TtsProvider } from './TtsProvider';
import type { NarrationRequest } from '../domain/narration/NarrationRequest';
import type { ProviderId } from '../domain/shared/types';

/**
 * ProviderRegistry — holds every registered TtsProvider and filters eligible providers
 * for a given request by capability, availability, and cost — never by hard-coded
 * provider identity. Adding a future provider is `register(new XProvider(), priority)`;
 * nothing here or in the narration engine needs to change.
 *
 * ElevenLabsProvider and GoogleCloudTtsProvider are both fully implemented (see
 * src/tts/providers/). The production entrypoint (src/main.ts) registers ElevenLabs
 * only when ELEVENLABS_API_KEY is present in the environment; Google remains
 * implemented but deliberately unwired, available for a future provider-enablement
 * workstream. This registry itself has no knowledge of which providers exist or are
 * configured — that's entirely the caller's responsibility, by design.
 */
export class ProviderRegistry {
  private readonly providers: Array<{ provider: TtsProvider; priority: number }> = [];

  register(provider: TtsProvider, priority: number): void {
    this.providers.push({ provider, priority });
    this.providers.sort((a, b) => a.priority - b.priority);
  }

  /**
   * Read-only introspection of what's registered, without triggering any provider's
   * checkAvailability() (which for a real provider means a real network call). Added
   * specifically to make "was ElevenLabs registered when a key is present" testable
   * without ever attempting network access from a test — it has no effect on
   * getEligibleProviders()'s actual eligibility logic.
   */
  listRegisteredProviderIds(): ProviderId[] {
    return this.providers.map(({ provider }) => provider.id);
  }

  /**
   * Returns providers that:
   *  (a) are currently available,
   *  (b) satisfy request.requiredCapabilities,
   *  (c) are under request.costCeiling (when specified),
   * ordered by registration priority, with providerPreference (if set and eligible) first.
   */
  async getEligibleProviders(request: NarrationRequest): Promise<TtsProvider[]> {
    const eligible: TtsProvider[] = [];

    for (const { provider } of this.providers) {
      const availability = await provider.checkAvailability();
      if (!availability.available) continue;

      if (request.requiredCapabilities && request.requiredCapabilities.length > 0) {
        const capabilities = await provider.getCapabilities();
        const flatCapabilities: Record<string, boolean> = {
          longFormNarration: capabilities.narration.longFormNarration,
          streaming: capabilities.narration.streaming,
          batchGeneration: capabilities.narration.batchGeneration,
          asynchronousJobs: capabilities.narration.asynchronousJobs,
          emotionControl: capabilities.expressiveness.emotionControl,
          pacingControl: capabilities.expressiveness.pacingControl,
          pauseControl: capabilities.expressiveness.pauseControl,
          voiceCloning: capabilities.voices.cloning !== 'none',
          multiVoiceProjects: capabilities.voices.multiVoiceProjects,
          characterVoiceConsistency: capabilities.voices.characterVoiceConsistency,
        };
        const satisfiesAll = request.requiredCapabilities.every(
          (key) => flatCapabilities[key] === true,
        );
        if (!satisfiesAll) continue;
      }

      if (request.costCeiling) {
        const estimate = await provider.estimateCost(request);
        if (estimate.amountMicros > request.costCeiling.amountMicros) continue;
      }

      eligible.push(provider);
    }

    if (request.providerPreference) {
      eligible.sort((a, b) => {
        if (a.id === request.providerPreference) return -1;
        if (b.id === request.providerPreference) return 1;
        return 0;
      });
    }

    return eligible;
  }
}
