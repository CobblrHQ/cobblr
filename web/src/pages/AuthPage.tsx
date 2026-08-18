// Combined signup / login screen. Toggle at the bottom flips mode —
// keeps the splash → auth → dashboard journey one screen.

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useAuth } from "../auth/AuthContext";
import { CobblestoneMark } from "../CobblestoneMark";
import { api, ApiError, setToken } from "../lib/api";
import { usePageTitle } from "@cobblr/platform-web";
import { useDeployEnv } from "../lib/deploy-env";

type Mode = "login" | "signup";

// Renders a Cloudflare Turnstile widget and hands the solved token upward. Only
// mounted when the server reports a captcha site key (the trial tier); a normal
// deployment never sees it. No npm dependency - the script is loaded on demand.
function TurnstileWidget({ siteKey, onToken }: { siteKey: string; onToken: (t: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    const render = () => {
      const ts = (window as unknown as { turnstile?: { render: (el: HTMLElement, o: unknown) => void } }).turnstile;
      if (ts && ref.current && !ref.current.hasChildNodes()) {
        ts.render(ref.current, {
          sitekey: siteKey,
          callback: (t: string) => onToken(t),
          "error-callback": () => onToken(""),
          "expired-callback": () => onToken(""),
        });
      }
    };
    if ((window as unknown as { turnstile?: unknown }).turnstile) {
      render();
      return;
    }
    let s = document.querySelector<HTMLScriptElement>(`script[src="${SRC}"]`);
    if (!s) {
      s = document.createElement("script");
      s.src = SRC;
      s.async = true;
      document.head.appendChild(s);
    }
    s.addEventListener("load", render);
    return () => s?.removeEventListener("load", render);
  }, [siteKey, onToken]);
  return <div ref={ref} className="mt-2 flex justify-center" />;
}

export function AuthPage() {
  usePageTitle("Sign in");
  const { login, signup } = useAuth();
  const { badge: envBadge } = useDeployEnv();
  const [mode, setMode] = useState<Mode>("login");
  // signup_enabled gates the "create account" toggle. Default true
  // so the toggle is shown in the brief window before /auth/config
  // resolves — if the server says signup is disabled, we both hide
  // the toggle AND snap any user already on signup back to login.
  const [signupEnabled, setSignupEnabled] = useState(true);
  // Null until /auth/config says this surface can complete a hand-off. Defaulting to
  // null (rather than showing the button optimistically) means we never offer a route
  // that fails after the redirect, on a site that cannot explain what went wrong.
  const [identityCfg, setIdentityCfg] = useState<{ authorize_url: string; deployment: string; name?: string } | null>(null);
  useEffect(() => {
    api
      .authConfig()
      .then((cfg) => {
        setSignupEnabled(cfg.signup_enabled);
        setCaptchaCfg(cfg.captcha ?? null);
        setIdentityCfg(cfg.identity ?? null);
        if (!cfg.signup_enabled) setMode("login");
      })
      .catch(() => {
        // Network/early-boot — leave toggle visible; the POST will
        // surface the real error if the user clicks through.
      });
  }, []);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [orgName, setOrgName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [captchaCfg, setCaptchaCfg] = useState<{ provider: string; site_key: string | null } | null>(null);
  const [captchaToken, setCaptchaToken] = useState("");
  // Set to the email after a signup that requires verification (trial tier);
  // shows a "check your email" screen instead of entering the app.
  const [verifySent, setVerifySent] = useState<string | null>(null);

  // Signup spins up a whole tenant database + enables the starter
  // modules — several seconds of real work. Acknowledge the click
  // instantly with a dedicated "setting up your workspace" screen
  // instead of leaving the user staring at a button that says "…".
  // On success the AuthContext flips us to the dashboard; on error we
  // fall back to the form (busy=false) with the message shown.
  const provisioning = busy && mode === "signup";

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    // Defensive: strip any whitespace from the email (autofill /
    // copy-paste can sneak in tabs or trailing newlines that .trim()
    // alone won't catch if they're between chars). Trim the password
    // too — passwords *could* contain internal whitespace, but
    // leading/trailing whitespace is always a paste accident.
    const cleanEmail = email.replace(/\s+/g, "");
    const cleanPassword = password.trim();
    try {
      if (mode === "login") {
        await login(cleanEmail, cleanPassword);
      } else {
        const r = await signup({
          email: cleanEmail,
          password: cleanPassword,
          display_name: displayName.trim(),
          // Optional — blank → the API names it "<your name>'s workspace". Send
          // undefined (not ""), which the server's `?? default` relies on.
          org_name: orgName.trim() || undefined,
          captcha_token: captchaToken || undefined,
        });
        // Trial tier: the account exists but must verify its email before it can
        // sign in. Show the "check your email" screen instead of entering the app.
        if (r.needsVerification) {
          setVerifySent(cleanEmail);
          return;
        }
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  if (verifySent) {
    return (
      <div className="min-h-full flex flex-col items-center justify-center p-6">
        <div className="w-full max-w-sm text-center flex flex-col items-center gap-4">
          <CobblestoneMark size={64} />
          <h1 className="font-display text-2xl font-bold text-content dark:text-mortar-100">Check your email</h1>
          <p className="text-content-muted dark:text-mortar-300">
            We sent a verification link to <span className="font-medium">{verifySent}</span>. Click it to activate your
            account, then sign in.
          </p>
          <button
            onClick={() => {
              setVerifySent(null);
              setMode("login");
            }}
            className="mt-2 text-sm text-accent hover:underline"
          >
            Back to sign in
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-full flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center gap-4 mb-6 text-center">
          <CobblestoneMark size={64} />
          <div>
            <h1 className="font-display text-3xl font-extrabold text-content dark:text-mortar-100 lowercase tracking-tight">
              cobblr
            </h1>
            {/* Env indicator on the sign-in screen too, so testers pick the
                right instance before logging in. Prod = no chip. */}
            {envBadge && (
              <span
                className={`inline-block mt-1.5 rounded px-2 py-0.5 text-[10px] font-mono font-bold uppercase tracking-widest ${envBadge.chip}`}
              >
                {envBadge.label}
              </span>
            )}
            <p className="mt-1 text-xs text-faint dark:text-slate-500">Cobble together what works.</p>
          </div>
          <p className="text-sm text-muted dark:text-slate-300 max-w-xs">
            Build your own app to track whatever you want - your workshop,
            inventory, collection, projects, plants - by turning on just the
            pieces you need.
          </p>
        </div>

        {provisioning ? (
          <div
            role="status"
            aria-live="polite"
            className="bg-surface dark:bg-slate-900/70 backdrop-blur border border-line dark:border-slate-700 rounded-xl p-6 shadow-sm text-center space-y-4"
          >
            <div className="text-[10px] font-mono uppercase tracking-widest text-accent">
              // account created
            </div>
            <div
              className="mx-auto h-8 w-8 rounded-full border-2 border-cobble-200 border-t-cobble-600 animate-spin"
              aria-hidden
            />
            <div className="font-display text-lg font-bold text-content dark:text-mortar-100">
              Setting up your workspace…
            </div>
            <p className="text-xs leading-relaxed text-muted dark:text-slate-400">
              Spinning up a private database for{" "}
              <strong className="text-content dark:text-mortar-200">
                {orgName.trim() || "your workspace"}
              </strong>{" "}
              and signing you in. This takes a few seconds - hang tight.
            </p>
          </div>
        ) : (
        <form
          onSubmit={submit}
          className="bg-surface dark:bg-slate-900/70 backdrop-blur border border-line dark:border-slate-700 rounded-xl p-5 shadow-sm space-y-3"
        >
          <div className="text-[10px] font-mono uppercase tracking-widest text-accent mb-1">
            // {mode === "login" ? "sign in" : "create account"}
          </div>

          {mode === "signup" && (
            <>
              <Field label="Your name">
                <input
                  required
                  autoComplete="name"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  className="input"
                />
              </Field>
              <Field label="Workspace name (optional)">
                <input
                  value={orgName}
                  onChange={(e) => setOrgName(e.target.value)}
                  placeholder="Leave blank - we'll name it after you"
                  className="input"
                />
              </Field>
            </>
          )}

          <Field label="Email">
            <input
              required
              type="email"
              autoComplete="email"
              value={email}
              // Strip whitespace whenever the field value changes,
              // however it changed:
              //   onChange — keyboard input + paste
              //   onInput  — programmatic value writes (Chrome
              //              autofill, password manager) that
              //              bypass React's synthetic onChange
              //   onBlur   — last line of defense in case the value
              //              landed via some other path (form-restore,
              //              extension)
              // Emails can't legally contain whitespace, so the strip
              // is safe to run unconditionally.
              onChange={(e) =>
                setEmail(e.currentTarget.value.replace(/\s+/g, ""))
              }
              onInput={(e) =>
                setEmail(e.currentTarget.value.replace(/\s+/g, ""))
              }
              onBlur={(e) =>
                setEmail(e.currentTarget.value.replace(/\s+/g, ""))
              }
              className="input"
            />
          </Field>
          <Field label="Password">
            <input
              required
              type="password"
              minLength={mode === "signup" ? 8 : 1}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="input"
            />
          </Field>

          {mode === "login" && <ForgotPasswordRow email={email} />}

          {mode === "signup" && captchaCfg?.site_key && (
            <TurnstileWidget siteKey={captchaCfg.site_key} onToken={setCaptchaToken} />
          )}

          {error && (
            <div className="text-xs text-ember-500 bg-ember-50 rounded-md px-3 py-2">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={busy || (mode === "signup" && !!captchaCfg?.site_key && !captchaToken)}
            className="w-full rounded-md bg-slate-700 hover:bg-slate-600 text-mortar-50 text-sm font-medium px-3 py-2 transition disabled:opacity-50"
          >
            {busy ? "…" : mode === "login" ? "Sign in" : "Create account"}
          </button>

          {/* One account across every Cobblr surface. Shown only when this instance can
              actually finish the hand-off, so the button never leads somewhere that
              fails after the redirect. The account service brings you back to
              /auth/callback with a one-time code. */}
          {identityCfg && (
            <>
              <div className="flex items-center gap-3 py-1">
                <div className="h-px flex-1 bg-mortar-200 dark:bg-mortar-700" />
                <span className="text-[11px] uppercase tracking-wide text-muted">or</span>
                <div className="h-px flex-1 bg-mortar-200 dark:bg-mortar-700" />
              </div>
              <a
                href={`${identityCfg.authorize_url}?deployment=${encodeURIComponent(identityCfg.deployment)}&return_to=${encodeURIComponent(`${window.location.origin}/auth/callback`)}`}
                className="block w-full text-center rounded-md border border-mortar-300 dark:border-mortar-600 hover:bg-mortar-100 dark:hover:bg-mortar-800 text-sm font-medium px-3 py-2 transition"
              >
                Continue with your {identityCfg.name ?? "Cobblr"} account
              </a>
            </>
          )}

          {(signupEnabled || mode === "signup") && (
            <button
              type="button"
              onClick={() => {
                setMode(mode === "login" ? "signup" : "login");
                setError(null);
              }}
              className="w-full text-xs text-muted dark:text-slate-400 hover:text-accent transition"
            >
              {mode === "login"
                ? "no account yet? create one"
                : "already have an account? sign in"}
            </button>
          )}
        </form>
        )}

        {mode === "login" && !provisioning && (
          <MagicLinkPanel email={email} />
        )}

        <p className="mt-6 text-center text-[11px] font-mono text-faint dark:text-slate-500">
          cobble together what works
        </p>
      </div>
    </div>
  );
}

/** "Forgot password?" — sends a reset link to the email typed above. In dev
 *  (no email sender) the server returns the link inline so the flow is
 *  exercisable; otherwise we just confirm it's been sent. */
function ForgotPasswordRow({ email }: { email: string }) {
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [devLink, setDevLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cleanEmail = email.replace(/\s+/g, "");

  async function request() {
    if (!cleanEmail) {
      setError("Enter your email above first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.passwordForgot({ email: cleanEmail });
      setSent(true);
      if (res.dev_link) setDevLink(res.dev_link);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't send a reset link.");
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div className="text-[11px] text-muted dark:text-slate-400 bg-subtle/60 dark:bg-slate-800/40 rounded-md px-3 py-2 space-y-1">
        <div>If that email is registered, a password-reset link is on its way.</div>
        {devLink && (
          <a href={devLink} className="inline-block text-accent hover:underline font-medium">
            Dev mode - set a new password →
          </a>
        )}
      </div>
    );
  }

  return (
    <div className="text-right -mt-1">
      <button
        type="button"
        onClick={() => void request()}
        disabled={busy}
        className="text-[11px] text-faint dark:text-slate-500 hover:text-accent transition disabled:opacity-50"
      >
        {busy ? "…" : "Forgot password?"}
      </button>
      {error && <div className="mt-1 text-left text-xs text-ember-500">{error}</div>}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
        {label}
      </span>
      {children}
    </label>
  );
}

/** Passwordless: ask for a magic link emailed to the address typed
 *  above. In dev mode (no SMTP) the server returns the link in the
 *  response and this panel surfaces it as a clickable "sign in
 *  now" button. Production would deliver via email and this panel
 *  just shows the "check your inbox" confirmation. */
function MagicLinkPanel({ email }: { email: string }) {
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
      const res = await api.magicRequest({ email: cleanEmail });
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
      window.location.href = "/";
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't consume token.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 bg-surface/60 dark:bg-slate-900/40 border border-line dark:border-slate-700 rounded-xl p-4 space-y-3">
      <div className="text-[10px] font-mono uppercase tracking-widest text-accent">
        // or passwordless
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
            : "Send a magic link"}
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

/** Landing for the emailed magic-link `/auth/magic?token=...`. Reads the token
 *  from the URL, consumes it for a session, and redirects in. Without this route
 *  the emailed link just hits the SPA catch-all → login screen and nothing
 *  consumes the token (the dev flow above only handles the inline dev_token). */
/** Where account.cobblr.xyz sends you back to.
 *
 *  The account service mints a ONE-TIME CODE and redirects here with it; this trades
 *  that code for a session on this instance. The identity token never travels in the
 *  URL — the api redeems the code server to server — so nothing replayable is left in
 *  browser history or a Referer header.
 *
 *  The failures are worth distinguishing, because they mean completely different things
 *  to the person reading them: a spent code is "try again", no workspace here is "you
 *  signed in fine, there is just nothing for you on this instance", and an unverified
 *  address is a thing they can go and fix. */
export function IdentityCallbackPage() {
  usePageTitle("Signing in");
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);

  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get("code");
    if (!code) {
      setError("This sign-in link is missing its code.");
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.identityCallback({ code });
        if (cancelled) return;
        setToken(res.token);
        // Hard redirect so AuthContext re-reads the new session, same as the magic link.
        window.location.href = "/";
      } catch (err) {
        if (cancelled) return;
        const code = err instanceof ApiError ? err.code : "";
        if (code === "no_local_account") {
          setError("You are signed in, but there is no workspace for you here yet.");
          setDetail("Ask whoever runs this instance for an invite, or try a different one.");
        } else if (code === "email_unverified") {
          setError("Confirm your email address on your Cobblr account first.");
          setDetail("Open the link we sent you, then come back and try again.");
        } else if (code === "account_disabled") {
          setError("This account is disabled on this instance.");
        } else {
          setError(
            err instanceof ApiError ? err.message : "That sign-in link has expired or was already used.",
          );
          setDetail("Sign-in links work once and expire after a minute.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center p-6 text-center">
      {error ? (
        <div className="space-y-2 max-w-sm">
          <div className="text-sm text-ember-500">{error}</div>
          {detail ? <div className="text-xs text-muted">{detail}</div> : null}
          <a href="/" className="text-xs text-accent underline">
            Back to sign in
          </a>
        </div>
      ) : (
        <div className="text-sm text-muted">Signing you in…</div>
      )}
    </div>
  );
}

export function MagicConsumePage() {
  usePageTitle("Signing in");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("token");
    if (!token) {
      setError("This sign-in link is missing its token.");
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.magicConsume({ token });
        if (cancelled) return;
        setToken(res.token);
        // Hard redirect so AuthContext re-reads the new session.
        window.location.href = "/";
      } catch (err) {
        if (cancelled) return;
        setError(
          err instanceof ApiError ? err.message : "This sign-in link is invalid or has expired.",
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center p-6 text-center">
      {error ? (
        <div className="space-y-2">
          <div className="text-sm text-ember-500">{error}</div>
          <a href="/" className="text-xs text-accent underline">
            Back to sign in
          </a>
        </div>
      ) : (
        <div className="text-sm text-muted">Signing you in…</div>
      )}
    </div>
  );
}
