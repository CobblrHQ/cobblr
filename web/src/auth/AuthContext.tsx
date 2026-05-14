// AuthProvider — holds the current session in React state + drives
// the token in localStorage. On mount, if a token is present, fetch
// /me to confirm the server still trusts it (handles "user
// deactivated" / "secret rotated" cleanly).

import {
  createContext, useCallback, useContext, useEffect, useState,
  type ReactNode,
} from "react";
import {
  ApiError, api, getToken, setToken,
  type OrgMembership, type SessionUser,
} from "../lib/api";

interface AuthState {
  user: SessionUser | null;
  orgs: OrgMembership[];
  loading: boolean;
}

interface AuthCtx extends AuthState {
  login: (email: string, password: string) => Promise<void>;
  signup: (input: {
    email: string;
    password: string;
    display_name: string;
    org_name: string;
  }) => Promise<void>;
  logout: () => void;
}

const Ctx = createContext<AuthCtx | null>(null);

export function useAuth(): AuthCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth called outside AuthProvider");
  return v;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    user: null,
    orgs: [],
    loading: true,
  });

  // Hydrate from /me on mount when a token's already present.
  useEffect(() => {
    let cancelled = false;
    const token = getToken();
    if (!token) {
      setState({ user: null, orgs: [], loading: false });
      return;
    }
    api
      .me()
      .then((res) => {
        if (cancelled) return;
        setState({ user: res.user, orgs: res.orgs, loading: false });
      })
      .catch((err) => {
        if (cancelled) return;
        // Stale/forged/expired token — clear it and fall through
        // to the unauthed view.
        if (err instanceof ApiError && err.status === 401) {
          setToken(null);
        }
        setState({ user: null, orgs: [], loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const res = await api.login({ email, password });
    setToken(res.token);
    setState({ user: res.user, orgs: res.orgs, loading: false });
  }, []);

  const signup = useCallback(
    async (input: {
      email: string;
      password: string;
      display_name: string;
      org_name: string;
    }) => {
      const res = await api.signup(input);
      setToken(res.token);
      setState({ user: res.user, orgs: res.orgs, loading: false });
    },
    [],
  );

  const logout = useCallback(() => {
    setToken(null);
    setState({ user: null, orgs: [], loading: false });
  }, []);

  return (
    <Ctx.Provider value={{ ...state, login, signup, logout }}>
      {children}
    </Ctx.Provider>
  );
}
