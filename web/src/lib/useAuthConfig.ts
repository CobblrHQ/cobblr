// What this surface allows a visitor to do, asked once of /auth/config, and
// what to show while the answer is unknown.
//
// The auth page and /start/:app both read it. Each used to fall OPEN when the
// fetch failed: signup assumed on, the form drawn, and on a hosted deployment
// where signup is invite-only the person typed everything and got
// 403 signup_disabled, the exact outage shape #2804 was filed for. A page
// that cannot learn what the server allows should say so and offer to ask
// again, not guess the answer that fails after typing. One hook so the two
// pages cannot make different choices about the same outage.
import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

export interface AuthConfigShape {
  signup_enabled: boolean;
  identity: { authorize_url: string; deployment: string; name?: string } | null;
  captcha: { provider: string; site_key: string | null } | null;
  demo_signin: { email: string; password: string; note: string | null } | null;
}

export type AuthConfigState =
  | { status: "loading"; cfg: null }
  | { status: "ready"; cfg: AuthConfigShape }
  | { status: "failed"; cfg: null };

/** Fetches /auth/config; `retry()` asks again after a failure. */
export function useAuthConfig(): AuthConfigState & { retry: () => void } {
  const [state, setState] = useState<AuthConfigState>({ status: "loading", cfg: null });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    setState({ status: "loading", cfg: null });
    api
      .authConfig()
      .then((c) => {
        if (!alive) return;
        setState({
          status: "ready",
          cfg: {
            signup_enabled: c.signup_enabled,
            identity: c.identity ?? null,
            captcha: c.captcha ?? null,
            demo_signin: c.demo_signin ?? null,
          },
        });
      })
      .catch(() => {
        if (alive) setState({ status: "failed", cfg: null });
      });
    return () => {
      alive = false;
    };
  }, [attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { ...state, retry };
}
