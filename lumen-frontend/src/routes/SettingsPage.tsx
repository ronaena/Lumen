import { useState, type FormEvent } from 'react';
import { useAuth } from '../auth/AuthContext';
import { changePassword } from '../api/auth';
import { ApiError } from '../api/client';
import { ErrorBanner } from '../components/States';

export function SettingsPage() {
  const { logoutAll } = useAuth();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loggingOutAll, setLoggingOutAll] = useState(false);
  const [logoutAllError, setLogoutAllError] = useState<string | null>(null);

  async function handleChangePassword(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setSaving(true);
    try {
      await changePassword(currentPassword, newPassword);
      setSaved(true);
      setCurrentPassword('');
      setNewPassword('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change your password.');
    } finally {
      setSaving(false);
    }
  }

  async function handleLogoutAll() {
    setLoggingOutAll(true);
    setLogoutAllError(null);
    try {
      await logoutAll();
      // logoutAll() clears the local token and flips auth state -- ProtectedRoute
      // will redirect to /login on the next render automatically.
    } catch (err) {
      setLogoutAllError(err instanceof ApiError ? err.message : 'Could not log out of all sessions.');
      setLoggingOutAll(false);
    }
  }

  return (
    <div style={{ maxWidth: 480 }}>
      <h1 style={{ fontSize: 24, marginBottom: 20 }}>Account security</h1>

      {error && <ErrorBanner message={error} />}
      <form onSubmit={handleChangePassword} className="card" style={{ marginBottom: 24 }}>
        <h3 style={{ fontSize: 15, marginBottom: 14 }}>Change password</h3>
        <div className="field">
          <label htmlFor="current-password">Current password</label>
          <input
            id="current-password"
            type="password"
            required
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="new-password">New password</label>
          <input
            id="new-password"
            type="password"
            required
            minLength={8}
            maxLength={128}
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
          />
        </div>
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? 'Changing…' : 'Change password'}
        </button>
        {saved && <span style={{ marginLeft: 12, color: 'var(--success)', fontSize: 13 }}>Password changed</span>}
      </form>

      {logoutAllError && <ErrorBanner message={logoutAllError} />}
      <div className="card" style={{ borderColor: 'var(--danger)' }}>
        <h3 style={{ fontSize: 15, marginBottom: 8 }}>Log out everywhere</h3>
        <p style={{ color: 'var(--text-dim)', fontSize: 14, marginBottom: 14 }}>
          Ends every active session for your account, including this one.
        </p>
        <button className="btn btn-danger" onClick={() => void handleLogoutAll()} disabled={loggingOutAll}>
          {loggingOutAll ? 'Logging out…' : 'Log out of all sessions'}
        </button>
      </div>
    </div>
  );
}
