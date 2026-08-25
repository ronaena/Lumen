import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { listChapters, listSegments, type Chapter, type TextSegment } from '../api/chapters';
import { getReadingProgress, putReadingProgress } from '../api/progress';
import { ApiError } from '../api/client';
import { LoadingState, ErrorBanner, EmptyState } from '../components/States';

/**
 * Segment-level reading, matching the actual backend data model -- there is no
 * chapter-level "full text" endpoint; GET /chapters/:id/segments returns ordered
 * TextSegment rows, and this page renders exactly that, in order. Format-agnostic by
 * construction: this only ever consumes already-normalized sourceText, never anything
 * about the original file (EPUB, TXT, DOCX, and text-based PDF are all normalized into
 * the same Chapter/TextSegment representation before this page ever sees the data --
 * this page has zero format-specific logic anywhere in it, confirmed by inspection).
 */
export function ReaderPage() {
  const { bookId } = useParams<{ bookId: string }>();
  const [chapters, setChapters] = useState<Chapter[] | null>(null);
  const [chapterIndex, setChapterIndex] = useState(0);
  const [segments, setSegments] = useState<TextSegment[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [segmentsLoading, setSegmentsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restoredOnce, setRestoredOnce] = useState(false);

  // Load the chapter list once, and restore the last-read chapter from saved progress.
  useEffect(() => {
    if (!bookId) return;
    let cancelled = false;
    async function init() {
      setLoading(true);
      setError(null);
      try {
        const [chapterList, progress] = await Promise.all([
          listChapters(bookId!),
          getReadingProgress(bookId!),
        ]);
        if (cancelled) return;
        setChapters(chapterList);
        if (progress) {
          const idx = chapterList.findIndex((c) => c.id === progress.chapterId);
          if (idx >= 0) setChapterIndex(idx);
        }
        setRestoredOnce(true);
      } catch (err) {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Could not load this book.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void init();
    return () => {
      cancelled = true;
    };
  }, [bookId]);

  // Load segments whenever the current chapter changes.
  useEffect(() => {
    if (!chapters || !chapters[chapterIndex]) return;
    let cancelled = false;
    async function loadSegments() {
      setSegmentsLoading(true);
      setError(null);
      try {
        const result = await listSegments(chapters![chapterIndex]!.id);
        if (!cancelled) setSegments(result);
      } catch (err) {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Could not load this chapter.');
      } finally {
        if (!cancelled) setSegmentsLoading(false);
      }
    }
    void loadSegments();
    return () => {
      cancelled = true;
    };
  }, [chapters, chapterIndex]);

  // Persist reading progress whenever the chapter changes (after the initial restore).
  useEffect(() => {
    if (!bookId || !chapters || !chapters[chapterIndex] || !restoredOnce) return;
    void putReadingProgress(bookId, { chapterId: chapters[chapterIndex]!.id, completionPct: '0.00' }).catch(() => {
      // A failed progress save shouldn't interrupt reading -- the user can keep going.
    });
  }, [bookId, chapters, chapterIndex, restoredOnce]);

  if (loading) return <LoadingState label="Loading book" />;
  if (error && !chapters) return <ErrorBanner message={error} />;
  if (!chapters || chapters.length === 0) {
    return <EmptyState title="No chapters yet" description="This book hasn't finished processing." />;
  }

  const currentChapter = chapters[chapterIndex]!;

  return (
    <div style={{ maxWidth: 680 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Link to={`/books/${bookId}`} style={{ color: 'var(--text-dim)', fontSize: 14, textDecoration: 'none' }}>
          &larr; Back to book
        </Link>
        <span style={{ color: 'var(--text-faint)', fontSize: 13 }}>
          Chapter {chapterIndex + 1} of {chapters.length}
        </span>
      </div>

      <div className="field" style={{ marginBottom: 16 }}>
        <label htmlFor="chapter-select" style={{ fontSize: 12 }}>
          Jump to chapter
        </label>
        <select
          id="chapter-select"
          value={chapterIndex}
          onChange={(e) => setChapterIndex(Number(e.target.value))}
          style={{
            padding: '10px 12px',
            borderRadius: 6,
            border: '1px solid var(--border)',
            background: 'var(--bg-raised)',
            color: 'var(--text)',
          }}
        >
          {chapters.map((chapter, i) => (
            <option key={chapter.id} value={i}>
              {i + 1}. {chapter.title ?? `Chapter ${chapter.orderIndex + 1}`}
            </option>
          ))}
        </select>
      </div>

      <h1 style={{ fontSize: 24, marginBottom: 20 }}>{currentChapter.title ?? `Chapter ${currentChapter.orderIndex + 1}`}</h1>

      {error && <ErrorBanner message={error} />}

      {segmentsLoading ? (
        <LoadingState label="Loading chapter" />
      ) : !segments || segments.length === 0 ? (
        <EmptyState title="This chapter has no text yet" />
      ) : (
        <div className="card" style={{ lineHeight: 1.8, fontSize: 16 }}>
          {segments
            .slice()
            .sort((a, b) => a.orderIndex - b.orderIndex)
            .map((segment) => (
              <p key={segment.id} style={{ marginBottom: 16 }}>
                {segment.sourceText}
              </p>
            ))}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 24 }}>
        <button
          className="btn"
          disabled={chapterIndex === 0}
          onClick={() => setChapterIndex((i) => Math.max(0, i - 1))}
        >
          &larr; Previous chapter
        </button>
        <button
          className="btn"
          disabled={chapterIndex >= chapters.length - 1}
          onClick={() => setChapterIndex((i) => Math.min(chapters.length - 1, i + 1))}
        >
          Next chapter &rarr;
        </button>
      </div>
    </div>
  );
}
