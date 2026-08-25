import { Link, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

export function AppShell() {
  const { logout, isAdmin } = useAuth();

  return (
    <div style={{ minHeight: '100%', display: 'flex', flexDirection: 'column' }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '8px 16px',
          padding: '16px 20px',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <Link
          to="/"
          className="lumen-glow"
          style={{ fontFamily: 'var(--font-display)', fontSize: 22, textDecoration: 'none', color: 'var(--accent)' }}
        >
          Lumen
        </Link>
        <nav style={{ display: 'flex', gap: '4px 16px', alignItems: 'center', flexWrap: 'wrap' }}>
          <Link to="/" className="nav-link">
            Library
          </Link>
          <Link to="/upload" className="nav-link">
            Upload
          </Link>
          <Link to="/settings" className="nav-link">
            Settings
          </Link>
          {isAdmin && (
            <>
              <Link to="/admin/dashboard" className="nav-link nav-link-admin">
                Dashboard
              </Link>
              <Link to="/admin/users" className="nav-link nav-link-admin">
                Users
              </Link>
              <Link to="/admin/audit-log" className="nav-link nav-link-admin">
                Audit Log
              </Link>
              <Link to="/admin/voices" className="nav-link nav-link-admin">
                Voice Management
              </Link>
            </>
          )}
          <button className="btn btn-ghost" onClick={() => void logout()}>
            Log out
          </button>
        </nav>
      </header>
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
