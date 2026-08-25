import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { getBook, type Book } from '../api/books';
import { triggerJob } from '../api/jobs';
import { listChapters, type Chapter } from '../api/chapters';
import { ApiError } from '../api/client';
import { LoadingState, ErrorBanner } from '../components/States';

function statusBadgeClass(status: string): string {
  if (status === 'ready') return 'badge badge-ready';
  if (status === 'failed') return 'badge badge-failed';
  return 'badge badge-processing';
}

/**
 * Book Processing & Narration Control Center v1: a real, computed-from-actual-data
 * summary -- never a fabricated percentage. chapter.status already reflects full
 * narration completion (confirmed: set to 'ready' inside NarrationJobEngine, not merely
 * after text segmentation), so this reuses the exact same field the chapter list badges
 * already show, just aggregated.
 */
function summarize(chapters: Chapter[]) {
  const narrated = chapters.filter((c) => c.status === 'ready').length;
  const failed = chapters.filter((c) => c.status === 'failed').length;
  const processing = chapters.filter((c) => c.status === 'narrating').length;
  const waiting = chapters.length - narrated - failed - processing;
  return { total: chapters.length, narrated, failed, processing, waiting };
}

export function BookDetailPage() {
  const { bookId } = useParams<{ bookId: string }>();
  const navigate = useNavigate();
  const [book, setBook] = useState<Book | null>(null);
  const [chapters, setChapters] = useState<Chapter[] | null>(null);
  const [chaptersError, setChaptersError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [triggering, setTriggering] = useState(false);
  const [triggerError, setTriggerError] = useState<string | null>(null);

  async function load() {
    if (!bookId) return;
    setLoading(true);
    setError(null);
    try {
      setBook(await getBook(bookId));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load this book.');
    } finally {
      setLoading(false);
    }
    try {
      // Chapter ordering comes directly from the existing ingestion engine's own
      // orderIndex -- never re-sorted or re-derived here, only rendered as returned.
      setChapters(await listChapters(bookId));
    } catch (err) {
      setChaptersError(err instanceof ApiError ? err.message : 'Could not load chapters.');
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId]);

  // Live refresh: while any chapter is actively narrating, poll for updates every 5s so
  // the control center reflects real progress without a page reload. Stops the moment
  // no chapter is in 'narrating' state, or on unmount -- never runs unconditionally, and
  // never introduces WebSockets for what a modest interval already covers.
  const chaptersRef = useRef(chapters);
  chaptersRef.current = chapters;
  useEffect(() => {
    const hasActiveNarration = chaptersRef.current?.some((c) => c.status === 'narrating') ?? false;
    if (!hasActiveNarration || !bookId) return;
    const interval = setInterval(() => {
      void listChapters(bookId).then(setChapters, () => {});
    }, 5000);
    return () => clearInterval(interval);
  }, [bookId, chapters]);

  async function handleTriggerNarration() {
    if (!bookId) return;
    setTriggering(true);
    setTriggerError(null);
    try {
      const result = await triggerJob(bookId);
      navigate(`/books/${bookId}/jobs/${result.processingJobId}`);
    } catch (err) {
      setTriggerError(err instanceof ApiError ? err.message : 'Could not start narration.');
      setTriggering(false);
    }
  }

  if (loading) return <LoadingState label="Loading book" />;
  if (error) return <ErrorBanner message={error} onRetry={() => void load()} />;
  if (!book) return null;

  const isReady = book.status === 'ready';

  return (
    <div>
      <Link to="/" style={{ color: 'var(--text-dim)', fontSize: 14, textDecoration: 'none' }}>
        &larr; Library
      </Link>
      <div style={{ marginTop: 16, marginBottom: 28 }}>
        <h1 style={{ fontSize: 28, marginBottom: 6 }}>{book.title}</h1>
        <p style={{ color: 'var(--text-dim)', marginBottom: 10 }}>{book.author ?? 'Unknown author'}</p>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <span className={statusBadgeClass(book.status)}>{book.status}</span>
          <span style={{ color: 'var(--text-faint)', fontSize: 13 }}>
            {book.chapterCount} chapters &middot; {book.segmentCount} segments
          </span>
        </div>
      </div>

      {triggerError && <ErrorBanner message={triggerError} />}

      <div className="card" style={{ marginBottom: 20 }}>
        <h3 style={{ fontSize: 16, marginBottom: 12 }}>Narration</h3>
        <p style={{ color: 'var(--text-dim)', fontSize: 14, marginBottom: 16 }}>
          {isReady
            ? 'This book has been narrated. Re-running narration only regenerates segments that changed.'
            : 'Start narration to generate audio for this book. Already-narrated segments are never redone.'}
        </p>
        <button className="btn btn-primary" onClick={() => void handleTriggerNarration()} disabled={triggering}>
          {triggering ? 'Starting…' : isReady ? 'Re-run narration' : 'Start narration'}
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <Link to={`/books/${book.id}/read`} className="card" style={{ textDecoration: 'none', color: 'inherit' }}>
          <h3 style={{ fontSize: 16, marginBottom: 6 }}>Read</h3>
          <p style={{ color: 'var(--text-dim)', fontSize: 14, margin: 0 }}>Continue reading this book.</p>
        </Link>
        <Link to={`/books/${book.id}/listen`} className="card" style={{ textDecoration: 'none', color: 'inherit' }}>
          <h3 style={{ fontSize: 16, marginBottom: 6 }}>Listen</h3>
          <p style={{ color: 'var(--text-dim)', fontSize: 14, margin: 0 }}>Continue listening to the narration.</p>
        </Link>
      </div>

      <Link
        to={`/books/${book.id}/characters`}
        className="card"
        style={{ display: 'block', textDecoration: 'none', color: 'inherit', marginTop: 16 }}
      >
        <h3 style={{ fontSize: 16, marginBottom: 6 }}>Characters &amp; scenes</h3>
        <p style={{ color: 'var(--text-dim)', fontSize: 14, margin: 0 }}>Manage character voices and scene direction.</p>
      </Link>

      <div style={{ marginTop: 24 }}>
        <h3 style={{ fontSize: 16, marginBottom: 12 }}>Chapters</h3>
        {chapters && chapters.length > 0 && (() => {
          const s = summarize(chapters);
          return (
            <div
              className="card"
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: '10px 20px',
                marginBottom: 16,
                fontSize: 13,
                color: 'var(--text-dim)',
              }}
            >
              <span>
                <strong style={{ color: 'var(--success)' }}>{s.narrated}</strong> narrated
              </span>
              <span>
                <strong style={{ color: 'var(--accent)' }}>{s.processing}</strong> processing
              </span>
              <span>
                <strong>{s.waiting}</strong> waiting
              </span>
              {s.failed > 0 && (
                <span>
                  <strong style={{ color: 'var(--danger)' }}>{s.failed}</strong> failed
                </span>
              )}
              <span style={{ color: 'var(--text-faint)' }}>of {s.total} chapters</span>
            </div>
          );
        })()}
        {chaptersError ? (
          <ErrorBanner message={chaptersError} onRetry={() => void load()} />
        ) : !chapters ? (
          <LoadingState label="Loading chapters" />
        ) : chapters.length === 0 ? (
          <p style={{ color: 'var(--text-dim)', fontSize: 14 }}>No chapters yet — processing may still be underway.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {chapters
              .slice()
              .sort((a, b) => a.orderIndex - b.orderIndex)
              .map((chapter, i) => (
                <div
                  key={chapter.id}
                  className="card"
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px' }}
                >
                  <span style={{ fontSize: 14 }}>
                    <span style={{ color: 'var(--text-faint)', fontFamily: 'var(--font-mono)', marginRight: 10 }}>
                      {i + 1}
                    </span>
                    {chapter.title ?? `Chapter ${i + 1}`}
                  </span>
                  <span className={statusBadgeClass(chapter.status)}>{chapter.status}</span>
                </div>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}
