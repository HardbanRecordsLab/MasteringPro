import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { accountApi, type Account } from '@/lib/accountApi';

interface AuthState {
  /** null until the first check resolves. */
  user: Account | null;
  /** true when the backend has a database (accounts possible at all). */
  enabled: boolean;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, displayName?: string) => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export const useAuth = () => {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be inside AuthProvider');
  return v;
};

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<Account | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ok = await accountApi.available();
      if (cancelled) return;
      setEnabled(ok);
      if (ok) {
        try {
          setUser(await accountApi.me());
        } catch {
          setUser(null);
        }
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    setUser(await accountApi.login(email, password));
  }, []);
  const register = useCallback(async (email: string, password: string, displayName?: string) => {
    setUser(await accountApi.register(email, password, displayName));
  }, []);
  const logout = useCallback(async () => {
    await accountApi.logout().catch(() => {});
    setUser(null);
  }, []);

  return (
    <Ctx.Provider value={{ user, enabled, loading, login, register, logout }}>
      {children}
    </Ctx.Provider>
  );
};
