import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import * as authApi from '../api/auth';
import { getToken, clearToken } from '../api/client';

interface AuthContextValue {
  isAuthenticated: boolean;
  /** null while unauthenticated or not yet loaded -- callers should treat null as "not an admin", never assume. */
  role: 'user' | 'admin' | null;
  isAdmin: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  logoutAll: () => Promise<void>;
  handleUnauthenticated: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(() => getToken() !== null);
  const [role, setRole] = useState<'user' | 'admin' | null>(null);

  const refreshRole = useCallback(async () => {
    if (!getToken()) {
      setRole(null);
      return;
    }
    try {
      const me = await authApi.getCurrentUser();
      setRole(me.role);
    } catch {
      setRole(null);
    }
  }, []);

  useEffect(() => {
    void refreshRole();
  }, [refreshRole]);

  const login = useCallback(
    async (email: string, password: string) => {
      await authApi.login(email, password);
      setIsAuthenticated(true);
      await refreshRole();
    },
    [refreshRole],
  );

  const register = useCallback(async (email: string, password: string) => {
    await authApi.register(email, password);
  }, []);

  const logout = useCallback(async () => {
    await authApi.logout();
    setIsAuthenticated(false);
    setRole(null);
  }, []);

  const logoutAll = useCallback(async () => {
    await authApi.logoutAll();
    setIsAuthenticated(false);
    setRole(null);
  }, []);

  const handleUnauthenticated = useCallback(() => {
    clearToken();
    setIsAuthenticated(false);
    setRole(null);
  }, []);

  return (
    <AuthContext.Provider
      value={{
        isAuthenticated,
        role,
        isAdmin: role === 'admin',
        login,
        register,
        logout,
        logoutAll,
        handleUnauthenticated,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
