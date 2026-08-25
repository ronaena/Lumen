import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from './AuthContext';

/**
 * Client-side redirect only, exactly like ProtectedRoute -- the real enforcement is the
 * backend's adminOnly guard (403 for a non-admin, verified server-side on every actual
 * request). This just avoids showing an admin screen to someone who'd immediately get
 * 403s from every action on it.
 */
export function AdminRoute() {
  const { isAdmin } = useAuth();
  if (!isAdmin) {
    return <Navigate to="/" replace />;
  }
  return <Outlet />;
}
