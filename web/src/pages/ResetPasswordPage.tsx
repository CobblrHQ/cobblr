// /reset/:token — set a new password from a password-reset email link.
// Public (the token is the secret). On success the server returns a fresh
// session, so we store it and hard-redirect into the app, logged in.

import { useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { KeyRound } from "lucide-react";
import { usePageTitle } from "@cobblr/platform-web";
import { ApiError, api, setToken } from "../lib/api";
import { CobblestoneMark } from "../CobblestoneMark";

export function ResetPasswordPage() {
  usePageTitle("Reset password");
  const { token = "" } = useParams();
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (next.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (next !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setBusy(true);
    try {
      const res = await api.passwordReset({ token, password: next });
      setToken(res.token);
      // Hard-redirect so the AuthContext loads the new session.
      window.location.href = "/";
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't reset your password.");
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-canvas dark:bg-slate-900 p-6">
      <div className="w-full max-w-sm rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-6 space-y-4">
        <div className="flex flex-col items-center gap-3 text-center">
          <CobblestoneMark size={48} />
          <div className="flex items-center gap-2">
            <KeyRound size={18} className="text-accent" />
            <h1 className="font-display text-xl font-bold text-content dark:text-mortar-100">
              Choose a new password
            </h1>
          </div>
        </div>

        <form onSubmit={submit} className="space-y-3">
          <label className="block">
            <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
              New password (8+ chars)
            </span>
            <input
              type="password"
              required
              autoFocus
              value={next}
              onChange={(e) => setNext(e.target.value)}
              className="input"
              autoComplete="new-password"
            />
          </label>
          <label className="block">
            <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
              Confirm new password
            </span>
            <input
              type="password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className="input"
              autoComplete="new-password"
            />
          </label>
          {error && (
            <div className="text-xs text-ember-500 bg-ember-50 dark:bg-ember-900/20 rounded-md px-3 py-2">
              {error}
            </div>
          )}
          <button
            type="submit"
            disabled={busy || !next || !confirm}
            className="w-full rounded-md bg-slate-700 hover:bg-slate-600 text-mortar-50 text-sm font-medium py-2 transition disabled:opacity-50"
          >
            {busy ? "Setting…" : "Reset password and sign in"}
          </button>
        </form>

        <p className="text-center text-[11px] text-faint dark:text-slate-500">
          <a href="/" className="hover:text-accent transition">Back to sign in</a>
        </p>
      </div>
    </div>
  );
}
