import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getJob, triggerJob, type Job } from '../api/jobs';
import { ApiError } from '../api/client';
import { LoadingState, ErrorBanner } from '../components/States';

const ACTIVE_STATUSES = new Set(['queued', 'processing']);
const POLL_INTERVAL_MS = 3000;

function statusBadgeClass(status: string): string {
  if (status === 'completed') return 'badge badge-ready';
  if (status === 'failed' || status === 'cancelled') return 'badge badge-failed';
  return 'badge badge-processing';
}

export function JobStatusPage() {
  const { bookId, jobId } = useParams<{ bookId: string; jobId: string }>();
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function poll() {
    if (!bookId || !jobId) return;
    try {
      const result = await getJob(bookId, jobId);
      setJob(result);
      setError(null);
      // Only keep polling while the job is genuinely still active -- stop the moment it
      // reaches any terminal state, never poll forever.
      if (ACTIVE_STATUSES.has(result.status)) {
        timerRef.current = setTimeout(() => void poll(), POLL_INTERVAL_MS);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load job status.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void poll();
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, jobId]);

  async function handleRetry() {
    if (!bookId) return;
    setRetrying(true);
    setError(null);
    try {
      // Retry is exactly re-calling POST /books/:bookId/jobs -- the backend's job
      // engine is idempotent, so already-narrated segments are simply skipped again.
      const result = await triggerJob(bookId);
      window.location.href = `/books/${bookId}/jobs/${result.processingJobId}`;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not retry narration.');
      setRetrying(false);
    }
  }

  if (loading) return <LoadingState label="Loading job status" />;
  if (error && !job) return <ErrorBanner message={error} onRetry={() => void poll()} />;
  if (!job) return null;

  const isTerminal = !ACTIVE_STATUSES.has(job.status);
  const isFailed = job.status === 'failed';

  return (
    <div>
      <Link to={`/books/${bookId}`} style={{ color: 'var(--text-dim)', fontSize: 14, textDecoration: 'none' }}>
        &larr; Back to book
      </Link>
      <div style={{ marginTop: 16, marginBottom: 24 }}>
        <h1 style={{ fontSize: 24, marginBottom: 10 }}>Narration status</h1>
        <span className={statusBadgeClass(job.status)}>{job.status}</span>
        {!isTerminal && (
          <span style={{ marginLeft: 10, color: 'var(--text-faint)', fontSize: 13 }}>Checking for updates&hellip;</span>
        )}
      </div>

      {error && <ErrorBanner message={error} />}

      {isFailed && (
        <div className="card" style={{ marginBottom: 20, borderColor: 'var(--danger)' }}>
          <p style={{ marginBottom: 12, color: 'var(--text-dim)' }}>Narration did not complete successfully.</p>
          <button className="btn btn-primary" onClick={() => void handleRetry()} disabled={retrying}>
            {retrying ? 'Retrying…' : 'Retry narration'}
          </button>
        </div>
      )}

      <div className="card">
        <h3 style={{ fontSize: 15, marginBottom: 14 }}>Steps</h3>
        {job.steps.length === 0 ? (
          <p style={{ color: 'var(--text-dim)', fontSize: 14, margin: 0 }}>No step detail available yet.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {job.steps.map((step, i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '10px 0',
                  borderTop: i > 0 ? '1px solid var(--border)' : 'none',
                }}
              >
                <span style={{ fontSize: 14 }}>
                  {step.stepType} <span style={{ color: 'var(--text-faint)' }}>({step.scopeType})</span>
                </span>
                <span className={statusBadgeClass(step.status)}>{step.status}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
