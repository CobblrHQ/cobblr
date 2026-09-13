// /start/:app — the streamlined consumer signup for a managed vertical app
// ("Cobblr for Yarn"). One screen: brand + name + email + password → sign up →
// the server provisions the app workspace (bundle + app mode) atomically → we
// land the user straight in the app. No workspace naming, no bundle picking, no
// platform. See business-models/docs/18-managed-vertical-apps.md.
//
// The page follows what the server allows. It used to draw the form regardless,
// and on a surface with signup off that ended in 403 signup_disabled after the
// person had typed everything, with no sign of the identity door the ordinary
// auth page offers. So it asks /auth/config first: signup on, the form; signup
// off with a central account service, "Continue with your Cobblr account",
// which carries the app through the hand-off so a new account is provisioned
// AS the app rather than as a plain workspace; neither, a plain sentence and
// the waitlist, and nothing to fill in.

import { useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { ApiError } from "../lib/api";
import { useAuth } from "../auth/AuthContext";
import { getManagedAppMeta } from "../lib/managed-apps";
import { isTouchPrimary } from "../lib/useIsTouch";
import { useAuthConfig } from "../lib/useAuthConfig";
import { AuthConfigUnavailable } from "../components/AuthConfigUnavailable";

/** Where the marketing site states hosted availability and takes the ask. */
const WAITLIST_URL = "https://cobblr.xyz/#start";

type StartConfig = {
  signup_enabled: boolean;
  identity: { authorize_url: string; deployment: string; name?: string } | null;
};

export function StartAppPage() {
  const { app } = useParams<{ app: string }>();
  const { signup } = useAuth();
  const meta = getManagedAppMeta(app);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Null until the server has said what it allows. Nothing to fill in is
  // drawn before then: a form that appears and is then refused is the bug.
  // A fetch that FAILS is not "signup on": it used to be, and on a hosted
  // deployment that reproduced the 403-after-typing during a config outage.
  // The shared hook says failed, and the page says so and offers to retry.
  const authCfg = useAuthConfig();
  const cfg: StartConfig | null = authCfg.cfg ? { signup_enabled: authCfg.cfg.signup_enabled, identity: authCfg.cfg.identity } : null;

  if (!meta) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 text-center">
        <div className="text-sm text-muted">That app isn’t available. <a href="/" className="text-accent hover:underline">Go to Cobblr →</a></div>
      </div>
    );
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || !email.trim() || password.length < 8) return;
    setBusy(true);
    setError(null);
    try {
      const res = await signup({
        email: email.trim(),
        password,
        // The name the user typed — falls back to the email local-part only if
        // somehow blank (the field is required, so this is belt-and-braces).
        display_name: name.trim() || email.trim().split("@")[0] || "there",
        // The server resolves the app's bundle from the registry — the client
        // never supplies it for a managed-app signup.
        app: meta!.id,
      });
      // The app workspace is fully provisioned (bundle + app_mode) server-side,
      // so landing in it is safe — the app-mode route guard sends the user to
      // the app home. It's the user's only workspace.
      if (res.needsVerification) {
        setError("Please verify your email to continue.");
        setBusy(false);
        return;
      }
      const slug = res.orgs[0]?.slug;
      // An app whose promise is "point your phone at it" opens ON the camera
      // when there is one; a desktop lands on the app home and pairs a phone
      // from there.
      const first = meta!.firstRunPath && isTouchPrimary() ? meta!.firstRunPath.replace(/^\//, "") : "";
      window.location.assign(slug ? `/w/${slug}/${first}` : "/");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn’t create your account. Try again.");
      setBusy(false);
    }
  }

  const appName = meta.label;
  // The hand-off comes back to /auth/callback with the app in the query, so
  // the callback can ask the server to provision AS the app. Without it a new
  // central account lands in a plain workspace, with the platform chrome this
  // page exists to hide.
  const identityHref = cfg?.identity
    ? `${cfg.identity.authorize_url}?deployment=${encodeURIComponent(cfg.identity.deployment)}&return_to=${encodeURIComponent(
        `${window.location.origin}/auth/callback?app=${encodeURIComponent(meta.id)}`,
      )}`
    : null;
  const identityDoor = identityHref && (
    <a
      href={identityHref}
      className="block w-full text-center rounded-md border border-mortar-300 dark:border-mortar-600 hover:bg-mortar-100 dark:hover:bg-mortar-800 text-sm font-medium px-3 py-2.5 transition"
    >
      Continue with your {cfg?.identity?.name ?? "Cobblr"} account
    </a>
  );

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-surface dark:bg-slate-950">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="font-display text-2xl font-extrabold text-content dark:text-mortar-100">{meta.headline}</h1>
          <p className="mt-2 text-sm text-muted dark:text-slate-400">{meta.blurb}</p>
        </div>
        {authCfg.status === "failed" ? (
          <AuthConfigUnavailable onRetry={authCfg.retry} />
        ) : cfg === null ? null : !cfg.signup_enabled ? (
          <div className="space-y-3 rounded-xl border border-line dark:border-slate-700 p-5 bg-white dark:bg-slate-900">
            {identityDoor ? (
              <>
                {identityDoor}
                <p className="text-center text-[11px] text-faint dark:text-slate-500">
                  Signing up here directly is invite-only while it's early. A Cobblr account gets you in, and sets up {appName} for you.
                </p>
              </>
            ) : (
              <>
                <p className="text-sm text-content dark:text-mortar-100">
                  <strong>Hosted {appName} is invite-only while it's early.</strong> Ask for an invite and we'll email you when there's room.
                </p>
                <a
                  href={WAITLIST_URL}
                  className="block w-full text-center rounded-md bg-cobble-600 hover:bg-cobble-700 text-white text-sm font-medium px-3 py-2.5 transition"
                >
                  Ask for an invite
                </a>
              </>
            )}
            <p className="text-center text-[11px] text-faint dark:text-slate-500">
              Already have an account? <a href="/" className="text-accent hover:underline">Sign in</a>
            </p>
          </div>
        ) : (
        <form onSubmit={submit} className="space-y-3 rounded-xl border border-line dark:border-slate-700 p-5 bg-white dark:bg-slate-900">
          <label className="block">
            <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">Your name</span>
            <input type="text" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus
              className="w-full rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-3 py-2 text-sm" />
          </label>
          <label className="block">
            <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">Email</span>
            <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required
              className="w-full rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-3 py-2 text-sm" />
          </label>
          <label className="block">
            <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">Password</span>
            <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8}
              className="w-full rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-3 py-2 text-sm" />
            <span className="block text-[10px] text-faint dark:text-slate-500 mt-1">At least 8 characters.</span>
          </label>
          {error && <div className="text-xs text-red-600 dark:text-red-400">{error}</div>}
          <button type="submit" disabled={busy || !name.trim() || !email.trim() || password.length < 8}
            className="w-full rounded-md bg-cobble-600 hover:bg-cobble-700 text-white text-sm font-medium px-3 py-2.5 transition disabled:opacity-50">
            {busy ? "Setting up your workspace…" : "Start free"}
          </button>
          {identityDoor && (
            <>
              <div className="flex items-center gap-3 py-1">
                <div className="h-px flex-1 bg-mortar-200 dark:bg-mortar-700" />
                <span className="text-[11px] uppercase tracking-wide text-muted">or</span>
                <div className="h-px flex-1 bg-mortar-200 dark:bg-mortar-700" />
              </div>
              {identityDoor}
            </>
          )}
          <p className="text-center text-[11px] text-faint dark:text-slate-500">
            Free to start. Already have an account? <a href="/" className="text-accent hover:underline">Sign in</a>
          </p>
        </form>
        )}
      </div>
    </div>
  );
}
