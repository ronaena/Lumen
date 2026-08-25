import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { listChapters, listSegments, type Chapter, type TextSegment } from '../api/chapters';
import { getListeningProgress, putListeningProgress } from '../api/progress';
import { ApiError, fetchAudioBlob } from '../api/client';
import { LoadingState, ErrorBanner, EmptyState } from '../components/States';

/**
 * Segment-sequenced playback -- there is no chapter-level concatenated audio anywhere
 * in the backend (AudioSegment is scoped to a single TextSegment), so this plays one
 * segment's audio at a time and advances on `ended`. Word-level sync / continuous
 * chapter audio are explicitly DEFERRED future capabilities, not implemented here --
 * this is the honest MVP shape given the data that actually exists.
 *
 * Reader & Player v1: now persists the ACTUAL current playback position (via the
 * native <audio> element's currentTime), never a hardcoded 0 -- and resumes by seeking
 * to that exact position within the correct segment, not just the correct chapter.
 */
export function PlayerPage() {
  const { bookId } = useParams<{ bookId: string }>();
  const [chapters, setChapters] = useState<Chapter[] | null>(null);
  const [chapterIndex, setChapterIndex] = useState(0);
  const [segments, setSegments] = useState<TextSegment[] | null>(null);
  const [segmentIndex, setSegmentIndex] = useState(0);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [restoredOnce, setRestoredOnce] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  // Remembers the exact segment/position to resume, consumed once when that specific
  // segment's audio actually loads, then cleared so it never re-applies later.
  const pendingResumeRef = useRef<{ audioSegmentId: string; positionMs: number } | null>(null);

  useEffect(() => {
    if (!bookId) return;
    let cancelled = false;
    async function init() {
      setLoading(true);
      setError(null);
      try {
        const [chapterList, progress] = await Promise.all([
          listChapters(bookId!),
          getListeningProgress(bookId!),
        ]);
        if (cancelled) return;
        setChapters(chapterList);
        if (progress) {
          const idx = chapterList.findIndex((c) => c.id === progress.chapterId);
          if (idx >= 0) setChapterIndex(idx);
          if (progress.audioSegmentId) {
            pendingResumeRef.current = { audioSegmentId: progress.audioSegmentId, positionMs: progress.playbackPositionMs };
          }
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

  useEffect(() => {
    if (!chapters || !chapters[chapterIndex]) return;
    let cancelled = false;
    async function loadSegments() {
      try {
        const result = (await listSegments(chapters![chapterIndex]!.id)).slice().sort((a, b) => a.orderIndex - b.orderIndex);
        if (cancelled) return;
        // If a pending resume target exists and is one of this chapter's segments, jump
        // straight to it instead of always restarting at segment 0.
        const pending = pendingResumeRef.current;
        const resumeIdx = pending ? result.findIndex((s) => s.currentAudioSegmentId === pending.audioSegmentId) : -1;
        setSegments(result);
        setSegmentIndex(resumeIdx >= 0 ? resumeIdx : 0);
      } catch (err) {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Could not load this chapter.');
      }
    }
    void loadSegments();
    return () => {
      cancelled = true;
    };
  }, [chapters, chapterIndex]);

  // Fetch and prepare the current segment's audio, replacing (and revoking) the prior object URL.
  useEffect(() => {
    const segment = segments?.[segmentIndex];
    if (!segment) return;

    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    setAudioUrl(null);
    setAudioError(null);

    if (!segment.currentAudioSegmentId) {
      // No wasted fetch for a segment that was never narrated -- currentAudioSegmentId
      // being null is already a reliable signal, per the discovery report.
      setAudioError('This part has not been narrated yet.');
      return;
    }

    let cancelled = false;
    async function loadAudio() {
      try {
        const blob = await fetchAudioBlob(`/segments/${segment!.id}/audio`);
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        objectUrlRef.current = url;
        setAudioUrl(url);
      } catch (err) {
        if (!cancelled) setAudioError(err instanceof ApiError ? err.message : 'Could not load audio.');
      }
    }
    void loadAudio();

    return () => {
      cancelled = true;
    };
  }, [segments, segmentIndex]);

  // Revoke the object URL on unmount, in addition to the per-segment revocation above.
  useEffect(() => {
    return () => {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };
  }, []);

  /** Persists the ACTUAL current playback position -- never a hardcoded 0. Best-effort: a failed save must never interrupt playback. */
  function persistCurrentPosition() {
    if (!bookId || !chapters?.[chapterIndex]) return;
    const segment = segments?.[segmentIndex];
    const audioEl = audioRef.current;
    if (!audioEl || Number.isNaN(audioEl.currentTime)) return;
    const playbackPositionMs = Math.round(audioEl.currentTime * 1000);
    const completionPct =
      audioEl.duration > 0 && Number.isFinite(audioEl.duration) ? ((audioEl.currentTime / audioEl.duration) * 100).toFixed(2) : '0.00';
    void putListeningProgress(bookId, {
      chapterId: chapters[chapterIndex]!.id,
      audioSegmentId: segment?.currentAudioSegmentId ?? undefined,
      playbackPositionMs,
      completionPct,
    }).catch(() => {});
  }

  // Persists a coarse "which chapter" marker as soon as the chapter changes -- covers
  // chapters with no narrated audio at all, where persistCurrentPosition never runs.
  // Superseded by the real position the moment audio actually plays.
  useEffect(() => {
    if (!bookId || !chapters?.[chapterIndex] || !restoredOnce) return;
    void putListeningProgress(bookId, {
      chapterId: chapters[chapterIndex]!.id,
      playbackPositionMs: 0,
      completionPct: '0.00',
    }).catch(() => {});
  }, [bookId, chapters, chapterIndex, restoredOnce]);

  // Best-effort: persist the real position if the user navigates away mid-playback.
  useEffect(() => {
    return () => {
      persistCurrentPosition();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapters, chapterIndex, segments, segmentIndex]);

  function handleLoadedMetadata() {
    const segment = segments?.[segmentIndex];
    const pending = pendingResumeRef.current;
    if (segment && pending && segment.currentAudioSegmentId === pending.audioSegmentId && audioRef.current) {
      audioRef.current.currentTime = pending.positionMs / 1000;
      pendingResumeRef.current = null; // consumed -- never re-applied to an unrelated later segment
    }
  }

  function handlePause() {
    persistCurrentPosition();
  }

  function handleEnded() {
    persistCurrentPosition();
    if (!segments) return;
    // Advance to the next segment that actually has audio -- skip un-narrated ones
    // rather than stopping playback entirely.
    for (let next = segmentIndex + 1; next < segments.length; next += 1) {
      if (segments[next]!.currentAudioSegmentId) {
        setSegmentIndex(next);
        return;
      }
    }
    // No more narrated segments in this chapter -- advance to the next chapter, if any.
    if (chapters && chapterIndex < chapters.length - 1) {
      setChapterIndex((i) => i + 1);
    }
  }

  if (loading) return <LoadingState label="Loading book" />;
  if (error && !chapters) return <ErrorBanner message={error} />;
  if (!chapters || chapters.length === 0) {
    return <EmptyState title="No chapters yet" description="This book hasn't finished processing." />;
  }

  const currentChapter = chapters[chapterIndex]!;

  return (
    <div style={{ maxWidth: 480 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Link to={`/books/${bookId}`} style={{ color: 'var(--text-dim)', fontSize: 14, textDecoration: 'none' }}>
          &larr; Back to book
        </Link>
        <span style={{ color: 'var(--text-faint)', fontSize: 13 }}>
          Chapter {chapterIndex + 1} of {chapters.length}
        </span>
      </div>

      <div className="field" style={{ marginBottom: 16 }}>
        <label htmlFor="chapter-select-player" style={{ fontSize: 12 }}>
          Jump to chapter
        </label>
        <select
          id="chapter-select-player"
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

      <div className="card" style={{ marginBottom: 20 }}>
        {segments && segments.length > 0 && (
          <p style={{ color: 'var(--text-dim)', fontSize: 13, marginBottom: 14 }}>
            Segment {segmentIndex + 1} of {segments.length}
          </p>
        )}
        {audioError ? (
          <p style={{ color: 'var(--text-dim)', fontSize: 14 }}>{audioError}</p>
        ) : audioUrl ? (
          <audio
            ref={audioRef}
            src={audioUrl}
            controls
            autoPlay
            onEnded={handleEnded}
            onPause={handlePause}
            onLoadedMetadata={handleLoadedMetadata}
            style={{ width: '100%' }}
          />
        ) : (
          <LoadingState label="Loading audio" />
        )}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
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
