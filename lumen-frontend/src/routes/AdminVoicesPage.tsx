import { useEffect, useState, type FormEvent } from 'react';
import {
  listAllVoices,
  createVoice,
  updateVoice,
  createMapping,
  updateMapping,
  type AdminVoice,
  type ProviderMapping,
} from '../api/adminVoices';
import { ApiError, apiFetch } from '../api/client';
import { LoadingState, ErrorBanner, EmptyState } from '../components/States';

interface VoiceWithMappings extends AdminVoice {
  mappings: ProviderMapping[];
}

async function loadMappings(voiceId: string): Promise<ProviderMapping[]> {
  return apiFetch<ProviderMapping[]>(`/admin/voices/${voiceId}/mappings`);
}

export function AdminVoicesPage() {
  const [voices, setVoices] = useState<VoiceWithMappings[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [newDisplayName, setNewDisplayName] = useState('');
  const [newRole, setNewRole] = useState<'narrator' | 'character'>('narrator');
  const [newLanguage, setNewLanguage] = useState('en');
  const [creating, setCreating] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const list = await listAllVoices();
      const withMappings = await Promise.all(
        list.map(async (voice) => ({ ...voice, mappings: await loadMappings(voice.id) })),
      );
      setVoices(withMappings);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load voices.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      await createVoice({ displayName: newDisplayName, role: newRole, language: newLanguage });
      setNewDisplayName('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create voice.');
    } finally {
      setCreating(false);
    }
  }

  async function handleRename(voiceId: string, currentName: string) {
    const displayName = window.prompt('New display name:', currentName);
    if (!displayName || displayName === currentName) return;
    try {
      await updateVoice(voiceId, { displayName });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update voice.');
    }
  }

  async function handleAddMapping(voiceId: string) {
    const provider = window.prompt('Provider ("elevenlabs" or "google_cloud_tts"):', 'elevenlabs');
    if (!provider || (provider !== 'elevenlabs' && provider !== 'google_cloud_tts')) return;
    const providerVoiceId = window.prompt('Provider voice ID:');
    if (!providerVoiceId) return;
    try {
      await createMapping(voiceId, { provider, providerVoiceId });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create mapping.');
    }
  }

  async function handleToggleMapping(voiceId: string, mapping: ProviderMapping) {
    try {
      await updateMapping(voiceId, mapping.id, { isActive: !mapping.isActive });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update mapping.');
    }
  }

  if (loading) return <LoadingState label="Loading voices" />;

  return (
    <div style={{ maxWidth: 720 }}>
      <h1 style={{ fontSize: 24, marginBottom: 8 }}>Voice Management</h1>
      <p style={{ color: 'var(--text-dim)', fontSize: 13, marginBottom: 24 }}>
        Admin-only. Manage system voices and their provider mappings.
      </p>

      {error && <ErrorBanner message={error} />}

      <form onSubmit={handleCreate} className="card" style={{ marginBottom: 24 }}>
        <h3 style={{ fontSize: 15, marginBottom: 12 }}>Create a voice</h3>
        <div className="field">
          <label htmlFor="new-voice-name">Display name</label>
          <input
            id="new-voice-name"
            type="text"
            required
            value={newDisplayName}
            onChange={(e) => setNewDisplayName(e.target.value)}
          />
        </div>
        <div style={{ display: 'flex', gap: 12 }}>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="new-voice-role">Role</label>
            <select
              id="new-voice-role"
              value={newRole}
              onChange={(e) => setNewRole(e.target.value as 'narrator' | 'character')}
              style={{
                padding: '10px 12px',
                borderRadius: 6,
                border: '1px solid var(--border)',
                background: 'var(--bg-raised)',
                color: 'var(--text)',
              }}
            >
              <option value="narrator">Narrator</option>
              <option value="character">Character</option>
            </select>
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="new-voice-language">Language</label>
            <input
              id="new-voice-language"
              type="text"
              required
              value={newLanguage}
              onChange={(e) => setNewLanguage(e.target.value)}
            />
          </div>
        </div>
        <button type="submit" className="btn btn-primary" disabled={creating}>
          {creating ? 'Creating…' : 'Create voice'}
        </button>
      </form>

      {!voices || voices.length === 0 ? (
        <EmptyState title="No voices yet" description="Create one above to get started." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {voices.map((voice) => {
            const hasActiveMapping = voice.mappings.some((m) => m.isActive);
            return (
              <div key={voice.id} className="card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <h3 style={{ fontSize: 16, marginBottom: 4 }}>{voice.displayName}</h3>
                    <p style={{ color: 'var(--text-faint)', fontSize: 13, margin: 0 }}>
                      {voice.role} &middot; {voice.language}
                    </p>
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span className={hasActiveMapping ? 'badge badge-ready' : 'badge badge-failed'}>
                      {hasActiveMapping ? 'usable' : 'no active mapping'}
                    </span>
                    <button className="btn btn-ghost" onClick={() => handleRename(voice.id, voice.displayName)}>
                      Rename
                    </button>
                  </div>
                </div>

                <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
                  <h4 style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 10 }}>Provider mappings</h4>
                  {voice.mappings.length === 0 ? (
                    <p style={{ color: 'var(--text-faint)', fontSize: 13, marginBottom: 10 }}>None yet.</p>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10 }}>
                      {voice.mappings.map((mapping) => (
                        <div
                          key={mapping.id}
                          style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13 }}
                        >
                          <span style={{ fontFamily: 'var(--font-mono)' }}>
                            {mapping.provider}: {mapping.providerVoiceId}
                          </span>
                          <button
                            className="btn btn-ghost"
                            style={{ padding: '4px 10px', fontSize: 12 }}
                            onClick={() => handleToggleMapping(voice.id, mapping)}
                          >
                            {mapping.isActive ? 'Disable' : 'Enable'}
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <button className="btn btn-ghost" style={{ fontSize: 13 }} onClick={() => handleAddMapping(voice.id)}>
                    + Add mapping
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
