'use client';

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { clearSession, decodeClaims, getIdToken } from '@/lib/auth/token';

/**
 * Who is signed in.
 *
 * Replaces a 582-line provider that, together with a 1,339-line API module,
 * existed so two hooks could read a role and render a badge label. This does
 * the same job from the JWT already in localStorage — no network call on
 * mount, no user-directory fetch.
 */

export interface AuthUser {
  sub: string;
  email: string;
  name: string;
  orgId: string;
  role: string;
}

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  signOut: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

const DEV_USER: AuthUser = {
  sub: 'dev-user',
  email: 'dev@localhost',
  name: 'Development User',
  orgId: 'dev-org',
  role: 'admin',
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Dev auth mode has no session to read — the server ignores the token
    // entirely — so short-circuit rather than showing a signed-out shell.
    if (process.env.NEXT_PUBLIC_AUTH_MODE === 'dev') {
      setUser(DEV_USER);
      setLoading(false);
      return;
    }

    const claims = decodeClaims(getIdToken());
    if (claims?.sub && claims['custom:org_id']) {
      setUser({
        sub: claims.sub,
        email: claims.email ?? '',
        name: claims.name ?? claims.email ?? 'User',
        orgId: claims['custom:org_id'],
        role: claims['custom:role'] ?? 'member',
      });
    }
    setLoading(false);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      loading,
      signOut: () => {
        clearSession();
        setUser(null);
        window.location.href = '/login';
      },
    }),
    [user, loading],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within an AuthProvider');
  return context;
}
