// AuthProvider — holds the current session in React state + drives
// the token in localStorage. On mount, if a token is present, fetch
// /me to confirm the server still trusts it (handles "user
// deactivated" / "secret rotated" cleanly).

import { forgetSignedInWith, signedInWith } from "../lib/oidc-sign-in";
import { forgetKeptReads } from "../lib/offline";
import {
  createContext, useCallback, useContext, useEffect, useState,
  type ReactNode,
} from "react";
import {
  ApiError, api, getToken, setToken,
  type OrgMembership, type SessionUser, type AuthResponse,
} from "../lib/api";

interface AuthState {
  user: SessionUser | null;
  orgs: OrgMembership[];
  loading: boolean;
  /** Signed in, but the session could not be read because the device is
   *  offline and never kept it: not signed out, so not the sign-in page. */
  offline?: boolean;
}

interface AuthCtx extends AuthState {
  login: (email: string, password: string, extra?: { app?: string; source?: string }) => Promise<void>;
  signup: (input: {
    email: string;
    password: string;
    display_name: string;
    org_name?: string;
    invite_token?: string;
    app?: string;
    manifest?: unknown;
    captcha_token?: string;
  }) => Promise<
    { needsVerification: true } | ({ needsVerification: false } & Pick<AuthResponse, "user" | "orgs">)
  >;
  /** Create a NEW account that joins an existing workspace via a
   *  workspace-invite token (no own workspace provisioned). */
  joinViaInvite: (
    token: string,
    input: { email: string; password: string; display_name: string },
  ) => Promise<void>;
  logout: () => void;
  /** Replace the in-memory org list, e.g. after creating a new one. */
  setOrgs: (orgs: OrgMembership[]) => void;
  /** Re-fetch /me. Used after force-password-reset to release the
   *  redirect guard once the server clears must_reset_password. */
  refreshMe: () => Promise<void>;
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
        // Offline with nothing kept: still signed in, just not reachable.
        if (err instanceof ApiError && (err.code === "offline" || err.code === "network_error")) {
          setState({ user: null, orgs: [], loading: false, offline: true });
          return;
        }
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

  const login = useCallback(async (email: string, password: string, extra?: { app?: string; source?: string }) => {
    const res = await api.login({ email, password, ...extra });
    await forgetKeptReads();
    setToken(res.token);
    setState({ user: res.user, orgs: res.orgs, loading: false });
  }, []);

  const signup = useCallback(
    async (input: {
      email: string;
      password: string;
      display_name: string;
      org_name?: string;
      app?: string;
      manifest?: unknown;
      captcha_token?: string;
      source?: string;
      share_invite?: string;
    }) => {
      const res = await api.signup(input);
      // Trial email-verify gate: the server withholds the session and asks the
      // user to verify. Don't log in; tell the caller to show "check your email".
      if ("needs_verification" in res) return { needsVerification: true as const };
      setToken(res.token);
      setState({ user: res.user, orgs: res.orgs, loading: false });
      return { needsVerification: false as const, user: res.user, orgs: res.orgs };
    },
    [],
  );

  const joinViaInvite = useCallback(
    async (token: string, input: { email: string; password: string; display_name: string }) => {
      const res = await api.acceptInviteAsNewUser(token, input);
      setToken(res.token);
      setState({ user: res.user, orgs: res.orgs, loading: false });
    },
    [],
  );

  const logout = useCallback(() => {
    void forgetKeptReads();
    // Signed in through the instance's own provider: end that session too,
    // when the provider says where (RP-initiated logout, #4492).
    const via = signedInWith();
    forgetSignedInWith();
    const out = via ? api.oidcSignOut(via).then((r) => r.url).catch(() => null) : Promise.resolve(null);
    setToken(null);
    setState({ user: null, orgs: [], loading: false });
    void out.then((url) => {
      if (url) window.location.assign(url);
    });
  }, []);

  const setOrgs = useCallback((orgs: OrgMembership[]) => {
    setState((s) => ({ ...s, orgs }));
  }, []);

  const refreshMe = useCallback(async () => {
    const res = await api.me();
    setState({ user: res.user, orgs: res.orgs, loading: false });
  }, []);

  return (
    <Ctx.Provider value={{ ...state, login, signup, joinViaInvite, logout, setOrgs, refreshMe }}>
      {children}
    </Ctx.Provider>
  );
}
