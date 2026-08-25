import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getAdminDashboard, type AdminDashboardData } from '../api/adminDashboard';
import { ApiError } from '../api/client';
import { LoadingState, ErrorBanner } from '../components/States';

function StatCard({ label, value, tone }: { label: string; value: string | number; tone?: 'ok' | 'warn' }) {
  return (
    <div className="card" style={{ flex: 1, minWidth: 140 }}>
      <p style={{ color: 'var(--text-dim)', fontSize: 13, marginBottom: 6 }}>{label}</p>
      <p
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 28,
          margin: 0,
          color: tone === 'warn' ? 'var(--danger)' : tone === 'ok' ? 'var(--success)' : 'var(--text)',
        }}
      >
        {value}
      </p>
    </div>
  );
}

export function AdminDashboardPage() {
  const [data, setData] = useState<AdminDashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setData(await getAdminDashboard());
    } catch (err) {
      // A generic, safe error only -- never a raw stack trace, SQL error, filesystem
      // path, or DATABASE_URL, matching the backend's own safe-error discipline.
      setError(err instanceof ApiError ? err.message : 'Could not load the dashboard.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  if (loading) return <LoadingState label="Loading dashboard" />;
  if (error) return <ErrorBanner message={error} onRetry={() => void load()} />;
  if (!data) return null;

  return (
    <div style={{ maxWidth: 720 }}>
      <h1 style={{ fontSize: 24, marginBottom: 24 }}>Operations Dashboard</h1>

      <h3 style={{ fontSize: 14, color: 'var(--text-dim)', marginBottom: 10 }}>System status</h3>
      <div style={{ display: 'flex', gap: 16, marginBottom: 28 }}>
        <StatCard label="Application" value={data.system.healthy ? 'healthy' : 'unhealthy'} tone={data.system.healthy ? 'ok' : 'warn'} />
        <StatCard label="Database" value={data.system.ready ? 'ready' : 'not ready'} tone={data.system.ready ? 'ok' : 'warn'} />
      </div>

      <h3 style={{ fontSize: 14, color: 'var(--text-dim)', marginBottom: 10 }}>Users</h3>
      <div style={{ display: 'flex', gap: 16, marginBottom: 28 }}>
        <StatCard label="Total users" value={data.users.total} />
        <StatCard label="Admins" value={data.users.admins} />
      </div>

      <h3 style={{ fontSize: 14, color: 'var(--text-dim)', marginBottom: 10 }}>Voices</h3>
      <div style={{ display: 'flex', gap: 16, marginBottom: 28 }}>
        <StatCard label="Total voices" value={data.voices.total} />
        <StatCard label="Active mappings" value={data.voices.activeMappings} tone="ok" />
        <StatCard label="Inactive mappings" value={data.voices.inactiveMappings} />
      </div>

      <h3 style={{ fontSize: 14, color: 'var(--text-dim)', marginBottom: 10 }}>Quick actions</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Link to="/admin/users" className="card" style={{ display: 'block', textDecoration: 'none', color: 'inherit' }}>
          <h4 style={{ fontSize: 15, marginBottom: 4 }}>User Management</h4>
          <p style={{ color: 'var(--text-dim)', fontSize: 13, margin: 0 }}>Manage roles and enable/disable account access.</p>
        </Link>
        <Link to="/admin/voices" className="card" style={{ display: 'block', textDecoration: 'none', color: 'inherit' }}>
          <h4 style={{ fontSize: 15, marginBottom: 4 }}>Voice Management</h4>
          <p style={{ color: 'var(--text-dim)', fontSize: 13, margin: 0 }}>Create, edit, and manage system voices and provider mappings.</p>
        </Link>
      </div>
    </div>
  );
}
