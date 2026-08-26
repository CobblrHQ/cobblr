// The set-a-password gate — shown when the user logged in with an
// admin-minted temp password. Login response carries
// must_reset_password=true and WorkspaceRoutes renders THIS COMPONENT in
// place of every route until the user picks their own password.
//
// There is no /me/force-password-reset URL and there should not be: a
// route would be somewhere to navigate away to, and somewhere that shows
// this screen to a user who does not need it. Six comments and two docs
// used to name that URL as if it existed (2026-08-26).
//
// No nav, no escape — full-page card. The user can sign out, but
// every other route bounces back here.

import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { LogOut, ShieldAlert } from "lucide-react";
import { usePageTitle } from "@cobblr/platform-web";
import { ApiError, api, setToken } from "../lib/api";
import { useAuth } from "../auth/AuthContext";

export function ForcePasswordResetPage() {
  usePageTitle("Set your password");
  const { user, logout, refreshMe } = useAuth();
  const navigate = useNavigate();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (next.length < 8) {
      setError("New password must be at least 8 characters.");
      return;
    }
    if (next !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setBusy(true);
    try {
      const res = await api.request<{ token: string }>("POST", "/me/password", {
        current_password: current,
        new_password: next,
      });
      // The change revoked the temp-password token; persist the re-minted one
      // so the next request isn't 401'd back to the login screen.
      if (res?.token) setToken(res.token);
      // Refresh /me so the UI sees must_reset_password=false and the
      // redirect guard releases.
      await refreshMe();
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't set password.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-canvas dark:bg-slate-900 p-6">
      <div className="w-full max-w-md rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-6 space-y-4">
        <div className="flex items-start gap-3">
          <ShieldAlert size={20} className="text-accent shrink-0 mt-0.5" />
          <div>
            <h1 className="font-display text-xl font-bold text-content dark:text-mortar-100">
              Set your own password
            </h1>
            <p className="text-xs text-muted dark:text-slate-400 mt-1">
              Your admin gave you a temporary password. Pick a new one before
              continuing.
            </p>
          </div>
        </div>

        <form onSubmit={submit} className="space-y-3">
          <label className="block">
            <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
              Current (temp) password
            </span>
            <input
              type="password"
              required
              autoFocus
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              className="input"
              autoComplete="current-password"
            />
          </label>
          <label className="block">
            <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
              New password (8+ chars)
            </span>
            <input
              type="password"
              required
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
            disabled={busy || !current || !next || !confirm}
            className="w-full rounded-md bg-slate-700 hover:bg-slate-600 text-mortar-50 text-sm font-medium py-2 transition disabled:opacity-50"
          >
            {busy ? "Setting…" : "Set password and continue"}
          </button>
        </form>

        <div className="pt-3 border-t border-line dark:border-slate-800 flex items-center justify-between text-[11px] text-faint">
          <span>Signed in as {user?.email}</span>
          <button
            type="button"
            onClick={logout}
            className="inline-flex items-center gap-1 hover:text-ember-500 transition"
          >
            <LogOut size={11} /> Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
