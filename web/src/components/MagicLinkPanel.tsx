import { useState } from "react";
import { api, ApiError, setToken } from "../lib/api";
import { landingPath } from "../lib/landing-path";

/** Passwordless: ask for a magic link emailed to the address typed
 *  above. In dev mode (no SMTP) the server returns the link in the
 *  response and this panel surfaces it as a clickable "sign in
 *  now" button. Production would deliver via email and this panel
 *  just shows the "check your inbox" confirmation. */
/** `next`: the page the link lands on (the item they scanned), when there is one. */
export function MagicLinkPanel({ email, next }: { email: string; next?: string | null }) {
  const [busy, setBusy] = useState(false);
  const [devLink, setDevLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const cleanEmail = email.replace(/\s+/g, "");

  async function request() {
    if (!cleanEmail) {
      setError("Enter your email above first.");
      return;
    }
    setBusy(true);
    setError(null);
    setDevLink(null);
    setSent(false);
    try {
      const res = await api.magicRequest({ email: cleanEmail, ...(next ? { next } : {}) });
      setSent(true);
      if (res.dev_token) {
        setDevLink(res.dev_token);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't send link.");
    } finally {
      setBusy(false);
    }
  }

  async function signInWithDevToken() {
    if (!devLink) return;
    setBusy(true);
    try {
      const res = await api.magicConsume({ token: devLink });
      setToken(res.token);
      // Hard-redirect to reload the AuthContext with the new session.
      window.location.href = landingPath(res.next) ?? "/";
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't consume token.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 bg-surface/60 dark:bg-slate-900/40 border border-line dark:border-slate-700 rounded-xl p-4 space-y-3">
      <div className="text-[10px] font-mono uppercase tracking-widest text-accent">
        // or without a password
      </div>
      <button
        type="button"
        onClick={() => void request()}
        disabled={busy}
        className="w-full rounded-md border border-line dark:border-slate-700 text-content dark:text-mortar-200 hover:bg-subtle dark:hover:bg-slate-800 text-sm font-medium px-3 py-2 transition disabled:opacity-50"
      >
        {busy
          ? "…"
          : sent && !devLink
            ? "If that email has an account, check your inbox"
            : "Email me a sign-in link"}
      </button>
      {error && (
        <div className="text-xs text-ember-500 bg-ember-50 rounded-md px-3 py-2">
          {error}
        </div>
      )}
      {devLink && (
        <div className="text-xs text-content dark:text-mortar-200 bg-cobble-50 dark:bg-cobble-900/20 rounded-md px-3 py-2 space-y-2">
          <div>
            <strong>Dev mode</strong>  - no SMTP configured. The link
            below is what would be emailed in production. Click to
            sign in:
          </div>
          <button
            type="button"
            onClick={() => void signInWithDevToken()}
            className="w-full px-2 py-1 text-xs rounded bg-cobble-600 hover:bg-cobble-700 text-white"
          >
            Sign in with this token
          </button>
        </div>
      )}
    </div>
  );
}
