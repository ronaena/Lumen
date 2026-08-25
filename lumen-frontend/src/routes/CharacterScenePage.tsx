import { useState, type FormEvent } from 'react';
import { useParams, Link } from 'react-router-dom';
import { createCharacter, assignCharacterVoice, assignSegmentToCharacter, listScenes, createScene, updateSceneDirection, type Scene } from '../api/characters';
import { ApiError } from '../api/client';
import { ErrorBanner } from '../components/States';

/**
 * HONEST LIMITATION: there is no GET endpoint to list a book's characters (only
 * create/assign-voice/assign-segment exist), so this page cannot show "all characters"
 * -- each action below is a real, working call against the actual endpoint, not a list
 * view that doesn't exist. Scenes DO have a list endpoint (GET /chapters/:id/scenes),
 * so that part of the page is a real list, not just a form.
 */
export function CharacterScenePage() {
  const { bookId } = useParams<{ bookId: string }>();

  // Character creation
  const [charName, setCharName] = useState('');
  const [charResult, setCharResult] = useState<{ id: string } | null>(null);
  const [charError, setCharError] = useState<string | null>(null);
  const [charSaving, setCharSaving] = useState(false);

  // Voice assignment
  const [voiceCharacterId, setVoiceCharacterId] = useState('');
  const [voiceId, setVoiceId] = useState('');
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [voiceSaved, setVoiceSaved] = useState(false);

  // Segment attribution
  const [segmentId, setSegmentId] = useState('');
  const [segmentCharacterId, setSegmentCharacterId] = useState('');
  const [segmentError, setSegmentError] = useState<string | null>(null);
  const [segmentSaved, setSegmentSaved] = useState(false);

  // Scenes
  const [chapterId, setChapterId] = useState('');
  const [scenes, setScenes] = useState<Scene[] | null>(null);
  const [scenesError, setScenesError] = useState<string | null>(null);
  const [startSegmentId, setStartSegmentId] = useState('');
  const [endSegmentId, setEndSegmentId] = useState('');

  async function handleCreateCharacter(e: FormEvent) {
    e.preventDefault();
    if (!bookId) return;
    setCharSaving(true);
    setCharError(null);
    try {
      const character = await createCharacter(bookId, charName);
      setCharResult(character);
      setCharName('');
    } catch (err) {
      setCharError(err instanceof ApiError ? err.message : 'Could not create character.');
    } finally {
      setCharSaving(false);
    }
  }

  async function handleAssignVoice(e: FormEvent) {
    e.preventDefault();
    setVoiceError(null);
    setVoiceSaved(false);
    try {
      await assignCharacterVoice(voiceCharacterId, voiceId);
      setVoiceSaved(true);
    } catch (err) {
      setVoiceError(err instanceof ApiError ? err.message : 'Could not assign voice.');
    }
  }

  async function handleAssignSegment(e: FormEvent) {
    e.preventDefault();
    setSegmentError(null);
    setSegmentSaved(false);
    try {
      await assignSegmentToCharacter(segmentId, segmentCharacterId);
      setSegmentSaved(true);
    } catch (err) {
      setSegmentError(err instanceof ApiError ? err.message : 'Could not attribute segment.');
    }
  }

  async function loadScenes() {
    if (!chapterId) return;
    setScenesError(null);
    try {
      setScenes(await listScenes(chapterId));
    } catch (err) {
      setScenesError(err instanceof ApiError ? err.message : 'Could not load scenes.');
    }
  }

  async function handleCreateScene(e: FormEvent) {
    e.preventDefault();
    if (!chapterId) return;
    setScenesError(null);
    try {
      await createScene(chapterId, { startSegmentId, endSegmentId });
      await loadScenes();
      setStartSegmentId('');
      setEndSegmentId('');
    } catch (err) {
      setScenesError(err instanceof ApiError ? err.message : 'Could not create scene.');
    }
  }

  async function handleSetDirection(sceneId: string) {
    const emotion = window.prompt('Direction emotion (e.g. "tense", "calm"):');
    if (!emotion) return;
    try {
      await updateSceneDirection(sceneId, { emotion });
      await loadScenes();
    } catch (err) {
      setScenesError(err instanceof ApiError ? err.message : 'Could not set direction.');
    }
  }

  return (
    <div style={{ maxWidth: 560 }}>
      <Link to={`/books/${bookId}`} style={{ color: 'var(--text-dim)', fontSize: 14, textDecoration: 'none' }}>
        &larr; Back to book
      </Link>
      <h1 style={{ fontSize: 24, marginTop: 16, marginBottom: 20 }}>Characters &amp; scenes</h1>
      <p style={{ color: 'var(--text-dim)', fontSize: 13, marginBottom: 20 }}>
        Manual assignment only -- there is no automatic dialogue attribution or scene detection.
      </p>

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ fontSize: 15, marginBottom: 12 }}>Create a character</h3>
        {charError && <ErrorBanner message={charError} />}
        <form onSubmit={handleCreateCharacter}>
          <div className="field">
            <label htmlFor="char-name">Name</label>
            <input id="char-name" type="text" required value={charName} onChange={(e) => setCharName(e.target.value)} />
          </div>
          <button type="submit" className="btn btn-primary" disabled={charSaving}>
            {charSaving ? 'Creating…' : 'Create character'}
          </button>
          {charResult && (
            <p style={{ marginTop: 10, fontSize: 13, color: 'var(--success)', fontFamily: 'var(--font-mono)' }}>
              Created: {charResult.id}
            </p>
          )}
        </form>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ fontSize: 15, marginBottom: 12 }}>Assign a voice to a character</h3>
        {voiceError && <ErrorBanner message={voiceError} />}
        <form onSubmit={handleAssignVoice}>
          <div className="field">
            <label htmlFor="voice-char-id">Character ID</label>
            <input id="voice-char-id" type="text" required value={voiceCharacterId} onChange={(e) => setVoiceCharacterId(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="voice-id-input">Voice ID</label>
            <input id="voice-id-input" type="text" required value={voiceId} onChange={(e) => setVoiceId(e.target.value)} />
          </div>
          <button type="submit" className="btn btn-primary">
            Assign voice
          </button>
          {voiceSaved && <span style={{ marginLeft: 12, color: 'var(--success)', fontSize: 13 }}>Assigned</span>}
        </form>
      </div>

      <div className="card" style={{ marginBottom: 24 }}>
        <h3 style={{ fontSize: 15, marginBottom: 12 }}>Attribute a text segment to a character</h3>
        {segmentError && <ErrorBanner message={segmentError} />}
        <form onSubmit={handleAssignSegment}>
          <div className="field">
            <label htmlFor="segment-id">Text segment ID</label>
            <input id="segment-id" type="text" required value={segmentId} onChange={(e) => setSegmentId(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="segment-char-id">Character ID</label>
            <input id="segment-char-id" type="text" required value={segmentCharacterId} onChange={(e) => setSegmentCharacterId(e.target.value)} />
          </div>
          <button type="submit" className="btn btn-primary">
            Attribute segment
          </button>
          {segmentSaved && <span style={{ marginLeft: 12, color: 'var(--success)', fontSize: 13 }}>Attributed</span>}
        </form>
      </div>

      <div className="card">
        <h3 style={{ fontSize: 15, marginBottom: 12 }}>Scenes</h3>
        {scenesError && <ErrorBanner message={scenesError} />}
        <div className="field">
          <label htmlFor="chapter-id-scenes">Chapter ID</label>
          <input id="chapter-id-scenes" type="text" value={chapterId} onChange={(e) => setChapterId(e.target.value)} />
        </div>
        <button className="btn btn-ghost" style={{ marginBottom: 16 }} onClick={() => void loadScenes()}>
          Load scenes
        </button>

        {scenes && (
          <div style={{ marginBottom: 16 }}>
            {scenes.length === 0 ? (
              <p style={{ color: 'var(--text-dim)', fontSize: 14 }}>No scenes yet for this chapter.</p>
            ) : (
              scenes.map((scene) => (
                <div key={scene.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderTop: '1px solid var(--border)' }}>
                  <span style={{ fontSize: 13, fontFamily: 'var(--font-mono)' }}>{scene.id.slice(0, 8)}&hellip; {scene.sceneType ?? ''}</span>
                  <button className="btn btn-ghost" style={{ padding: '4px 10px' }} onClick={() => void handleSetDirection(scene.id)}>
                    Set direction
                  </button>
                </div>
              ))
            )}
          </div>
        )}

        <form onSubmit={handleCreateScene}>
          <div className="field">
            <label htmlFor="start-segment">Start segment ID</label>
            <input id="start-segment" type="text" required value={startSegmentId} onChange={(e) => setStartSegmentId(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="end-segment">End segment ID</label>
            <input id="end-segment" type="text" required value={endSegmentId} onChange={(e) => setEndSegmentId(e.target.value)} />
          </div>
          <button type="submit" className="btn btn-primary">
            Create scene
          </button>
        </form>
      </div>
    </div>
  );
}
