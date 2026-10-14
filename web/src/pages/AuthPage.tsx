// Combined signup / login screen. Toggle at the bottom flips mode —
// keeps the splash → auth → dashboard journey one screen.

import { useEffect, useState, type FormEvent } from "react";
import { authEntryAt } from "../lib/deep-path";
import { rememberSource, rememberedSource } from "../lib/identity-door";
import { AccountCard } from "../components/AccountCard";
import { redeemOnce } from "../lib/redeem-once";
import { TurnstileWidget } from "../components/TurnstileWidget";
import { ForgotPasswordRow } from "../components/ForgotPasswordRow";
import { MagicLinkPanel } from "../components/MagicLinkPanel";
import { hereAsLanding, landingPath } from "../lib/landing-path";
import { shareInviteFor } from "../lib/share-invite-pending";
import { useAuth } from "../auth/AuthContext";
import { CobblestoneMark } from "../CobblestoneMark";
import { api, ApiError, setToken } from "../lib/api";
import { getManagedAppMeta } from "../lib/managed-apps";
import { isTouchPrimary } from "../lib/useIsTouch";
import { usePageTitle, PasswordInput } from "@cobblr/platform-web";
import { useDeployEnv } from "../lib/deploy-env";
import { useAuthConfig } from "../lib/useAuthConfig";
import { AuthConfigUnavailable } from "../components/AuthConfigUnavailable";
import { SignInWithProviders, useSignInProviders } from "../components/SignInWithProviders";

type Mode = "login" | "signup";

export function AuthPage({ initialMode, carrying }: { initialMode?: Mode; carrying?: boolean } = {}) {
  usePageTitle("Sign in");
  const { login, signup } = useAuth();
  const { badge: envBadge } = useDeployEnv();
  // The instance's own sign-in providers, and whether password sign-in is on.
  const providers = useSignInProviders();
  // `/?mode=signup` opens on the signup form. A link that says "Make an
  // account instead" (the sandbox start page, when the captcha turns someone
  // away) must land on the account form, not on a login form with a small
  // toggle underneath it. Snapped back to login below if signup is off.
  const [mode, setMode] = useState<Mode>(() => {
    if (initialMode) return initialMode;
    try {
      return authEntryAt(window.location.pathname) === "/signup" || new URLSearchParams(window.location.search).get("mode") === "signup" ? "signup" : "login";
    } catch {
      return "login";
    }
  });
  // What this surface allows, from /auth/config through the shared hook. The
  // toggle is shown while the answer is on its way (the brief window at
  // boot); if the server says signup is disabled, both the toggle goes AND
  // anyone already on signup is snapped back to login. A fetch that FAILS is
  // not "signup on": the page says it could not check and offers to retry,
  // rather than drawing a form the server may refuse after typing (#2804).
  const authCfg = useAuthConfig();
  const signupEnabled = authCfg.cfg ? authCfg.cfg.signup_enabled : true;
  // Null until /auth/config says this surface can complete a hand-off. Defaulting to
  // null (rather than showing the button optimistically) means we never offer a route
  // that fails after the redirect, on a site that cannot explain what went wrong.
  const identityCfg = authCfg.cfg?.identity ?? null;
  // The central account is the door and can be made on this page: one card,
  // Sign in or Create account (AccountCard), and nothing else to choose between.
  const onPage = !!identityCfg?.signup_on_page && !signupEnabled;
  // Sent here to sign up: /signup, ?mode=signup, or a sandbox arriving to be
  // made someone's. Where the Cobblr account is the door, that account's
  // Create form comes first.
  // What was ASKED for, read once: the form's own mode is snapped back to sign
  // in when this surface's sign-up is off, which is exactly this case.
  // `mode` on the first render is the ?mode the page arrived with.
  const [wantsSignup] = useState(() => !!carrying || mode === "signup" || authEntryAt(window.location.pathname) === "/signup");
  // The link or QR that sent them (?source=), kept for the sign-up it leads to.
  const [source] = useState(() => {
    rememberSource(window.location.search);
    return rememberedSource();
  });
  const demoCfg = authCfg.cfg?.demo_signin ?? null;
  useEffect(() => {
    if (!authCfg.cfg) return;
    setCaptchaCfg(authCfg.cfg.captcha);
    // A public demo pre-fills its shared login, so the first thing a visitor
    // does is press one button rather than copy two strings. Only when the
    // fields are still untouched: someone who has started typing their own
    // credentials must never have them overwritten by a late config reply.
    const demo = authCfg.cfg.demo_signin;
    if (demo) {
      setEmail((cur) => (cur ? cur : demo.email));
      setPassword((cur) => (cur ? cur : demo.password));
    }
    if (!authCfg.cfg.signup_enabled) setMode("login");
  }, [authCfg.cfg]);
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
          ...(source ? { source } : {}),
          // Signing up to accept a share: the invite is the invitation where
          // public signup is off (#4737).
          ...(shareInviteFor(window.location.search) ? { share_invite: shareInviteFor(window.location.search)! } : {}),
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
            <h1 className="font-display text-3xl font-extrabold text-content dark:text-mortar-100 tracking-tight">
              Cobblr
            </h1>
            {/* Env indicator on the sign-in screen too, so testers pick the
                right instance before logging in. Prod = no chip. */}
            {envBadge && (
              <span
                className={`inline-block mt-1.5 rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest ${envBadge.chip}`}
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

        {onPage ? (
          <div data-testid={carrying ? "carry-welcome" : undefined}>
            <AccountCard
              initialMode={wantsSignup ? "signup" : "login"}
              heading={carrying ? "Make your sandbox yours" : undefined}
              lead={
                carrying
                  ? "Make a free account, or sign in to one you have. What you added in the sandbox moves into it, photos too."
                  : wantsSignup
                    ? "One free account. It signs you in to Cobblr everywhere."
                    : null
              }
              source={source}
              captchaSiteKey={authCfg.cfg?.captcha?.site_key ?? null}
              resetHref={new URL("/reset", identityCfg!.authorize_url).toString()}
              termsHref={new URL("/terms", identityCfg!.authorize_url).toString()}
              hosted={authCfg.cfg?.hosted === true}
            />
          </div>
        ) : provisioning ? (
          <div
            role="status"
            aria-live="polite"
            className="bg-surface dark:bg-slate-900/70 backdrop-blur border border-line dark:border-slate-700 rounded-xl p-6 shadow-sm text-center space-y-4"
          >
            <div className="text-[10px] uppercase tracking-widest text-accent">
              account created
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
        ) : authCfg.status === "failed" ? (
          <AuthConfigUnavailable failure={authCfg.failure} onRetry={authCfg.retry} />
        ) : !providers.passwordOn && providers.items.length > 0 ? (
          // The operator turned password sign-in off: the provider is the way in.
          <SignInWithProviders items={providers.items} onlyWay next={new URLSearchParams(window.location.search).get("next")} />
        ) : (
        <>
        <SignInWithProviders items={providers.items} onlyWay={false} next={new URLSearchParams(window.location.search).get("next")} />
        <form
          onSubmit={submit}
          className="bg-surface dark:bg-slate-900/70 backdrop-blur border border-line dark:border-slate-700 rounded-xl p-5 shadow-sm space-y-3"
        >
          <div className="text-[10px] uppercase tracking-widest text-accent mb-1">
            {mode === "login" ? "sign in" : "create account"}
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

          {/* A public demo says so, and hands over its shared login rather than
              making a visitor find it elsewhere. The fields are already filled;
              this is here so the credentials are legible when they are not (a
              password manager overwriting them, a visitor clearing the form). */}
          {demoCfg && mode === "login" && (
            <div className="rounded-lg border border-cobble-300 dark:border-cobble-700 bg-cobble-50 dark:bg-slate-900 px-3 py-2.5 text-sm">
              <div className="font-medium text-content dark:text-mortar-100">This is a live demo. Just press Sign in.</div>
              <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs">
                <dt className="text-muted">Email</dt>
                <dd className="font-mono break-all">{demoCfg.email}</dd>
                <dt className="text-muted">Password</dt>
                <dd className="font-mono break-all">{demoCfg.password}</dd>
              </dl>
              {demoCfg.note && <p className="mt-1.5 text-xs text-muted">{demoCfg.note}</p>}
            </div>
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
            <PasswordInput
              required
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
        </>
        )}

        {!onPage && mode === "login" && !provisioning && (
          <MagicLinkPanel email={email} next={hereAsLanding()} />
        )}

        <p className="mt-6 text-center text-[11px] font-mono text-faint dark:text-slate-500">
          cobble together what works
        </p>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[10px] uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
        {label}
      </span>
      {children}
    </label>
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
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    // /start/<app> put the app on return_to, so a NEW account is provisioned as
    // the app and lands in it rather than on the generic home.
    const app = params.get("app") ?? undefined;
    // The source the sign-up link carried, back on return_to beside the app.
    const source = params.get("source") ?? undefined;
    if (!code) {
      setError("This sign-in link is missing its code.");
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await redeemOnce(code, () => api.identityCallback({ code, ...(app ? { app } : {}), ...(source ? { source } : {}) }));
        // A session that came back is used even if this mount was cleaned up:
        // the code is spent, and dropping the one session it made is the bug.
        setToken(res.token);
        // Hard redirect so AuthContext re-reads the new session, same as the magic link.
        const made = res.provisioned;
        const meta = made?.app ? getManagedAppMeta(made.app) : null;
        const first = meta?.firstRunPath && isTouchPrimary() ? meta.firstRunPath.replace(/^\//, "") : "";
        window.location.href = made && meta ? `/w/${made.slug}/${first}` : "/";
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
        const res = await redeemOnce(token, () => api.magicConsume({ token }));
        setToken(res.token);
        // Hard redirect so AuthContext re-reads the new session, back to the
        // page the link was asked from (the item they scanned) when there is one.
        window.location.href = landingPath(res.next) ?? "/";
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
