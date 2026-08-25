import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from './AuthContext';

/** Client-side check is a UX convenience -- the backend's 401 remains the real enforcement. */
export function ProtectedRoute() {
  const { isAuthenticated } = useAuth();
  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }
  return <Outlet />;
}
