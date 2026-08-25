import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ingestBook } from '../api/books';
import { listVoices, type Voice } from '../api/voices';
import { ApiError } from '../api/client';
import { ErrorBanner, LoadingState } from '../components/States';

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // FileReader's data URL is "data:<mime>;base64,<payload>" -- only the payload
      // after the comma is what the backend's fileBase64 field expects.
      resolve(result.split(',')[1] ?? '');
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function UploadPage() {
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [voices, setVoices] = useState<Voice[] | null>(null);
  const [voicesError, setVoicesError] = useState<string | null>(null);
  const [narratorVoiceId, setNarratorVoiceId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    listVoices()
      .then((list) => {
        setVoices(list);
        if (list.length > 0) setNarratorVoiceId(list[0]!.id);
      })
      .catch((err) => setVoicesError(err instanceof ApiError ? err.message : 'Could not load available voices.'));
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!file) {
      setError('Choose an EPUB file first.');
      return;
    }
    if (!narratorVoiceId) {
      setError('Select a narrator voice.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const fileBase64 = await fileToBase64(file);
      const result = await ingestBook({
        filename: file.name,
        mimeType: file.type || 'application/epub+zip',
        fileBase64,
        narratorVoiceId,
      });
      // Direct path into the imported book, rather than only the job-status page --
      // Book Details is the more natural landing spot; the trigger already navigated
      // the job as part of ingestBook, so this goes straight to the book itself.
      navigate(`/books/${result.bookId}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Upload failed. Please try again.');
      setSubmitting(false);
    }
  }

  return (
    <div style={{ maxWidth: 480 }}>
      <h1 style={{ fontSize: 24, marginBottom: 20 }}>Upload a book</h1>
      {error && <ErrorBanner message={error} />}
      <form onSubmit={handleSubmit} className="card">
        <div className="field">
          <label htmlFor="epub-file">EPUB file</label>
          <input
            id="epub-file"
            type="file"
            accept=".epub,application/epub+zip"
            required
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <p style={{ fontSize: 12, color: 'var(--text-faint)', margin: 0 }}>
            Currently supported: EPUB only.
          </p>
        </div>
        <div className="field">
          <label htmlFor="voice-select">Narrator voice</label>
          {voicesError ? (
            <ErrorBanner message={voicesError} />
          ) : !voices ? (
            <LoadingState label="Loading voices" />
          ) : voices.length === 0 ? (
            <p style={{ fontSize: 13, color: 'var(--text-dim)' }}>
              No system voices are configured yet. An administrator needs to add one before books can be narrated.
            </p>
          ) : (
            <select
              id="voice-select"
              required
              value={narratorVoiceId}
              onChange={(e) => setNarratorVoiceId(e.target.value)}
              style={{
                padding: '10px 12px',
                borderRadius: 6,
                border: '1px solid var(--border)',
                background: 'var(--bg-raised)',
                color: 'var(--text)',
              }}
            >
              {voices.map((voice) => (
                <option key={voice.id} value={voice.id}>
                  {voice.displayName} ({voice.language})
                </option>
              ))}
            </select>
          )}
        </div>
        <button type="submit" className="btn btn-primary" style={{ width: '100%' }} disabled={submitting || !voices || voices.length === 0}>
          {submitting ? 'Uploading…' : 'Upload and start narration'}
        </button>
      </form>
    </div>
  );
}
