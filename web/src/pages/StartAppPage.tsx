// /start/:app — the streamlined consumer signup for a managed vertical app
// ("Cobblr for Yarn"). One screen: brand + email + password → sign up → the
// server provisions the app workspace (bundle + app mode) atomically → we land
// the user straight in the app. No workspace naming, no bundle picking, no
// platform. See business-models/docs/18-managed-vertical-apps.md.

import { useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { ApiError } from "../lib/api";
import { useAuth } from "../auth/AuthContext";
import { getManagedAppMeta } from "../lib/managed-apps";

export function StartAppPage() {
  const { app } = useParams<{ app: string }>();
  const { signup } = useAuth();
  const meta = getManagedAppMeta(app);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!meta) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 text-center">
        <div className="text-sm text-muted">That app isn’t available. <a href="/" className="text-accent hover:underline">Go to Cobblr →</a></div>
      </div>
    );
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!email.trim() || password.length < 8) return;
    setBusy(true);
    setError(null);
    try {
      const res = await signup({
        email: email.trim(),
        password,
        display_name: email.trim().split("@")[0] || "there",
        // The server resolves the app's bundle from the registry — the client
        // never supplies it for a managed-app signup.
        app: meta!.id,
      });
      // The app workspace is fully provisioned (bundle + app_mode) server-side,
      // so landing in it is safe — the app-mode route guard sends the user to
      // the app home. It's the user's only workspace.
      const slug = res.orgs[0]?.slug;
      window.location.assign(slug ? `/w/${slug}/` : "/");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn’t create your account. Try again.");
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-surface dark:bg-slate-950">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="font-display text-2xl font-extrabold text-content dark:text-mortar-100">{meta.headline}</h1>
          <p className="mt-2 text-sm text-muted dark:text-slate-400">{meta.blurb}</p>
        </div>
        <form onSubmit={submit} className="space-y-3 rounded-xl border border-line dark:border-slate-700 p-5 bg-white dark:bg-slate-900">
          <label className="block">
            <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">Email</span>
            <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus
              className="w-full rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-3 py-2 text-sm" />
          </label>
          <label className="block">
            <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">Password</span>
            <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8}
              className="w-full rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-3 py-2 text-sm" />
            <span className="block text-[10px] text-faint dark:text-slate-500 mt-1">At least 8 characters.</span>
          </label>
          {error && <div className="text-xs text-red-600 dark:text-red-400">{error}</div>}
          <button type="submit" disabled={busy || !email.trim() || password.length < 8}
            className="w-full rounded-md bg-cobble-600 hover:bg-cobble-700 text-white text-sm font-medium px-3 py-2.5 transition disabled:opacity-50">
            {busy ? "Setting up your workspace…" : "Start free"}
          </button>
          <p className="text-center text-[11px] text-faint dark:text-slate-500">
            Free to start. Already have an account? <a href="/" className="text-accent hover:underline">Sign in</a>
          </p>
        </form>
      </div>
    </div>
  );
}
