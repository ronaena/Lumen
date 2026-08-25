import { useEffect, useState, type FormEvent } from 'react';
import { getAuditLog, type AuditLogEntry, type AuditLogFilters } from '../api/adminAuditLog';
import { ApiError } from '../api/client';
import { LoadingState, ErrorBanner, EmptyState } from '../components/States';

const PAGE_SIZE = 50;

const inputStyle = {
  padding: '8px 10px',
  borderRadius: 6,
  border: '1px solid var(--border)',
  background: 'var(--bg-raised)',
  color: 'var(--text)',
  fontSize: 13,
};

function formatMetadata(metadata: Record<string, unknown> | null): string {
  if (!metadata || Object.keys(metadata).length === 0) return '—';
  return Object.entries(metadata)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join(', ');
}

export function AdminAuditLogPage() {
  const [items, setItems] = useState<AuditLogEntry[] | null>(null);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [adminUserId, setAdminUserId] = useState('');
  const [action, setAction] = useState('');
  const [targetType, setTargetType] = useState('');
  const [targetId, setTargetId] = useState('');
  const [result, setResult] = useState<'' | 'success' | 'failure'>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [appliedFilters, setAppliedFilters] = useState<AuditLogFilters>({});

  async function load(atOffset: number, filters: AuditLogFilters) {
    setLoading(true);
    setError(null);
    try {
      const response = await getAuditLog(PAGE_SIZE, atOffset, filters);
      setItems(response.items);
      setHasMore(response.items.length === PAGE_SIZE);
      setOffset(atOffset);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the audit log.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load(0, {});
  }, []);

  function handleApplyFilters(e: FormEvent) {
    e.preventDefault();
    const filters: AuditLogFilters = {
      adminUserId: adminUserId.trim() || undefined,
      action: action.trim() || undefined,
      targetType: targetType.trim() || undefined,
      targetId: targetId.trim() || undefined,
      result: result || undefined,
      from: from ? new Date(from).toISOString() : undefined,
      to: to ? new Date(to).toISOString() : undefined,
    };
    setAppliedFilters(filters);
    void load(0, filters);
  }

  function handleClearFilters() {
    setAdminUserId('');
    setAction('');
    setTargetType('');
    setTargetId('');
    setResult('');
    setFrom('');
    setTo('');
    setAppliedFilters({});
    void load(0, {});
  }

  if (loading && !items) return <LoadingState label="Loading audit log" />;

  return (
    <div style={{ maxWidth: 900 }}>
      <h1 style={{ fontSize: 24, marginBottom: 8 }}>Audit Log</h1>
      <p style={{ color: 'var(--text-dim)', fontSize: 13, marginBottom: 20 }}>
        Admin-only. Every administrative mutation, successful or blocked, newest first.
      </p>

      <form onSubmit={handleApplyFilters} className="card" style={{ marginBottom: 20 }}>
        <h3 style={{ fontSize: 14, marginBottom: 12 }}>Filters</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 10, marginBottom: 12 }}>
          <div className="field" style={{ margin: 0 }}>
            <label style={{ fontSize: 12 }}>Admin user ID</label>
            <input style={inputStyle} value={adminUserId} onChange={(e) => setAdminUserId(e.target.value)} placeholder="uuid" />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label style={{ fontSize: 12 }}>Action</label>
            <input style={inputStyle} value={action} onChange={(e) => setAction(e.target.value)} placeholder="VOICE_CREATED" />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label style={{ fontSize: 12 }}>Target type</label>
            <input style={inputStyle} value={targetType} onChange={(e) => setTargetType(e.target.value)} placeholder="voice" />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label style={{ fontSize: 12 }}>Target ID</label>
            <input style={inputStyle} value={targetId} onChange={(e) => setTargetId(e.target.value)} placeholder="uuid" />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label style={{ fontSize: 12 }}>Result</label>
            <select style={inputStyle} value={result} onChange={(e) => setResult(e.target.value as '' | 'success' | 'failure')}>
              <option value="">Any</option>
              <option value="success">Success</option>
              <option value="failure">Failure</option>
            </select>
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label style={{ fontSize: 12 }}>From</label>
            <input style={inputStyle} type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label style={{ fontSize: 12 }}>To</label>
            <input style={inputStyle} type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="submit" className="btn btn-primary">
            Apply filters
          </button>
          <button type="button" className="btn btn-ghost" onClick={handleClearFilters}>
            Clear
          </button>
        </div>
      </form>

      {error && <ErrorBanner message={error} onRetry={() => void load(offset, appliedFilters)} />}

      {!items || items.length === 0 ? (
        <EmptyState title="No matching audit entries" description={Object.keys(appliedFilters).length > 0 ? 'Try adjusting or clearing the filters above.' : undefined} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {items.map((entry) => (
            <div key={entry.id} className="card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>{entry.action}</span>
                <span className={entry.result === 'success' ? 'badge badge-ready' : 'badge badge-failed'}>
                  {entry.result}
                </span>
              </div>
              <p style={{ color: 'var(--text-dim)', fontSize: 12, margin: 0, marginBottom: 4 }}>
                {entry.targetType}
                {entry.targetId ? ` · ${entry.targetId}` : ''} &middot; by admin {entry.adminUserId}
              </p>
              <p style={{ color: 'var(--text-faint)', fontSize: 12, margin: 0, marginBottom: 4 }}>
                {formatMetadata(entry.metadata)}
              </p>
              <p style={{ color: 'var(--text-faint)', fontSize: 11, margin: 0 }}>
                {new Date(entry.createdAt).toLocaleString()}
              </p>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 20 }}>
        <button className="btn" disabled={offset === 0} onClick={() => void load(Math.max(0, offset - PAGE_SIZE), appliedFilters)}>
          &larr; Newer
        </button>
        <button className="btn" disabled={!hasMore} onClick={() => void load(offset + PAGE_SIZE, appliedFilters)}>
          Older &rarr;
        </button>
      </div>
    </div>
  );
}
