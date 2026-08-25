import { useEffect, useState } from 'react';
import { listUsers, changeUserRole, setUserDisabled, type AdminUser } from '../api/adminUsers';
import { getCurrentUser } from '../api/auth';
import { useAuth } from '../auth/AuthContext';
import { ApiError } from '../api/client';
import { LoadingState, ErrorBanner, EmptyState } from '../components/States';

export function AdminUsersPage() {
  const { role: myRole } = useAuth();
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [myUserId, setMyUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const list = await listUsers();
      setUsers(list);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load users.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // Identifying "myself" is only used to gray out the Disable button as a UX hint --
    // the backend's own self-disable rule (CANNOT_DISABLE_SELF) remains the actual
    // security boundary regardless of what this client-side check shows.
    getCurrentUser()
      .then((me) => setMyUserId(me.userId))
      .catch(() => {});
  }, []);

  async function handleToggleRole(user: AdminUser) {
    const newRole = user.role === 'admin' ? 'user' : 'admin';
    if (!window.confirm(`${newRole === 'admin' ? 'Promote' : 'Demote'} ${user.email} to ${newRole}?`)) return;
    setBusyUserId(user.id);
    setError(null);
    try {
      await changeUserRole(user.id, newRole);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change role.');
    } finally {
      setBusyUserId(null);
    }
  }

  async function handleToggleDisabled(user: AdminUser) {
    const nextDisabled = !user.disabled;
    if (!window.confirm(`${nextDisabled ? 'Disable' : 'Enable'} ${user.email}?`)) return;
    setBusyUserId(user.id);
    setError(null);
    try {
      await setUserDisabled(user.id, nextDisabled);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update account status.');
    } finally {
      setBusyUserId(null);
    }
  }

  if (loading) return <LoadingState label="Loading users" />;

  return (
    <div style={{ maxWidth: 760 }}>
      <h1 style={{ fontSize: 24, marginBottom: 8 }}>User Management</h1>
      <p style={{ color: 'var(--text-dim)', fontSize: 13, marginBottom: 24 }}>
        Admin-only. Manage roles and account access. Signed in as: {myRole ?? 'unknown'}.
      </p>

      {error && <ErrorBanner message={error} />}

      {!users || users.length === 0 ? (
        <EmptyState title="No users found" />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {users.map((user) => {
            const isSelf = user.id === myUserId;
            return (
              <div
                key={user.id}
                className="card"
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
              >
                <div>
                  <p style={{ margin: 0, fontSize: 14 }}>
                    {user.email} {isSelf && <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>(you)</span>}
                  </p>
                  <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                    <span className={user.role === 'admin' ? 'badge badge-ready' : 'badge'}>{user.role}</span>
                    <span className={user.disabled ? 'badge badge-failed' : 'badge'}>
                      {user.disabled ? 'disabled' : 'active'}
                    </span>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    className="btn btn-ghost"
                    disabled={busyUserId === user.id}
                    onClick={() => handleToggleRole(user)}
                  >
                    {user.role === 'admin' ? 'Demote' : 'Promote'}
                  </button>
                  <button
                    className={user.disabled ? 'btn btn-ghost' : 'btn btn-danger'}
                    disabled={busyUserId === user.id || isSelf}
                    title={isSelf ? "You cannot disable your own account" : undefined}
                    onClick={() => handleToggleDisabled(user)}
                  >
                    {user.disabled ? 'Enable' : 'Disable'}
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
