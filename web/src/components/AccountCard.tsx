// Sign in, or make your account, on this page.
//
// Where a central Cobblr account is how people get in (the hosted product), this
// is the whole door: one card, Sign in or Create account, and one quiet
// "Email me a sign-in link" under it. It used to be four overlapping ways in
// (a "Make your Cobblr account" card with its own two buttons, the email and
// password form, "Continue with your Cobblr account", and the magic link), and
// making an account left for the account service's site and came back. The
// account is still the central one; the api asks the account service to make
// it (POST /auth/identity/signup) and the confirmation link lands the person
// back here, signed in. A password typed in Sign in is checked against the
// central account the same way, so nobody needs to know there are two services.
//
// Used by the sign-in page (plain entry, /signup, /carry) and /start/<app>, so
// the form, its words and what rides along (the app, the source) are one thing.
import { PasswordInput } from "@cobblr/platform-web";
import { useState, type FormEvent } from "react";
import { useAuth } from "../auth/AuthContext";
import { api, ApiError } from "../lib/api";
import { TurnstileWidget } from "./TurnstileWidget";
import { ForgotPasswordRow } from "./ForgotPasswordRow";
import { MagicLinkPanel } from "./MagicLinkPanel";

export type AccountMode = "login" | "signup";

export function AccountCard({
  initialMode,
  heading,
  lead,
  app,
  source,
  captchaSiteKey,
  resetHref,
  submitLabel,
  hosted,
  termsHref,
}: {
  initialMode: AccountMode;
  /** Overrides the card's own heading; null draws none (a page with its own). */
  heading?: string | null;
  lead?: string | null;
  /** The managed app a /start/<app> page asked for. */
  app?: string;
  /** The link or QR that sent the person (`?source=`). */
  source?: string | null;
  captchaSiteKey?: string | null;
  /** Where a forgotten password is reset: the account service, for a central account. */
  resetHref?: string | null;
  /** The create button's words, where the page says it better ("Start free"). */
  submitLabel?: string;
  /** Show what a hosted workspace shares, beside Create account. */
  hosted?: boolean;
  /** The account's terms, readable, where making the account agrees to them. */
  termsHref?: string | null;
}) {
  const { login } = useAuth();
  const [mode, setMode] = useState<AccountMode>(initialMode);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [captchaToken, setCaptchaToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const cleanEmail = email.replace(/\s+/g, "");
  const extra = { ...(app ? { app } : {}), ...(source ? { source } : {}) };

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "login") {
        await login(cleanEmail, password.trim(), extra);
      } else {
        await api.identitySignup({
          display_name: name.trim(),
          email: cleanEmail,
          password: password.trim(),
          ...(captchaToken ? { captcha_token: captchaToken } : {}),
          // Said beside the button, with the terms a tap away: pressing it agrees.
          ...(termsHref ? { accept_terms: true } : {}),
          ...extra,
        });
        setSentTo(cleanEmail);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (sentTo) {
    return (
      <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-5 text-center space-y-3" data-testid="account-card" data-mode="sent">
        <div className="font-display text-lg font-bold text-content dark:text-mortar-100">Check your email</div>
        <p className="text-sm text-muted dark:text-slate-400">
          We sent a link to <span className="font-medium text-content dark:text-mortar-100">{sentTo}</span>. Open it on any device and
          you'll come back here, signed in.
        </p>
        <button
          type="button"
          onClick={() => {
            setSentTo(null);
            setCaptchaToken("");
          }}
          className="text-xs text-muted hover:text-accent"
        >
          Use a different email
        </button>
      </div>
    );
  }

  const creating = mode === "signup";
  const title = heading === undefined ? (creating ? "Create your Cobblr account" : "Sign in to Cobblr") : heading;
  return (
    <>
      <form
        onSubmit={submit}
        className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-5 shadow-sm space-y-3"
        data-testid="account-card"
        data-mode={mode}
      >
        {title && <div className="font-display text-lg font-bold text-content dark:text-mortar-100">{title}</div>}
        {lead && <p className="text-sm text-muted dark:text-slate-400 -mt-1">{lead}</p>}

        {creating && (
          <label className="block">
            <span className="block text-[11px] text-muted mb-1">Your name</span>
            <input required autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} className="input" />
          </label>
        )}
        <label className="block">
          <span className="block text-[11px] text-muted mb-1">Email</span>
          <input
            required
            type="email"
            autoComplete="email"
            value={email}
            // Emails cannot contain whitespace; autofill and paste sneak it in.
            onChange={(e) => setEmail(e.currentTarget.value.replace(/\s+/g, ""))}
            onBlur={(e) => setEmail(e.currentTarget.value.replace(/\s+/g, ""))}
            className="input"
          />
        </label>
        <label className="block">
          <span className="block text-[11px] text-muted mb-1">Password</span>
          <PasswordInput
            required
            minLength={creating ? 8 : 1}
            autoComplete={creating ? "new-password" : "current-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="input"
          />
          {creating && <span className="block text-[11px] text-faint mt-1">At least 8 characters.</span>}
        </label>

        {!creating && <ForgotPasswordRow email={email} resetHref={resetHref} />}
        {creating && captchaSiteKey && <TurnstileWidget siteKey={captchaSiteKey} onToken={setCaptchaToken} />}
        {/* Said where the account is made, and no broader than it is: what a
            hosted workspace shares is product corrections, never the rest. */}
        {creating && termsHref && (
          <p className="text-[11px] text-faint dark:text-slate-500" data-testid="account-terms">
            Creating an account agrees to the{" "}
            <a href={termsHref} target="_blank" rel="noreferrer" className="underline hover:text-accent">
              Cobblr account terms
            </a>
            .
          </p>
        )}
        {creating && hosted && (
          <p className="text-[11px] text-faint dark:text-slate-500" data-testid="hosted-sharing-note">
            Hosted Cobblr shares product corrections to improve identifications for everyone.{" "}
            <a href="https://cobblr.xyz/privacy/#barcode-network" target="_blank" rel="noreferrer" className="underline hover:text-accent">
              Details
            </a>
          </p>
        )}

        {error && <div className="text-xs text-ember-600 dark:text-ember-400 bg-ember-50 dark:bg-ember-900/20 rounded-md px-3 py-2">{error}</div>}

        <button
          type="submit"
          disabled={busy || (creating && !!captchaSiteKey && !captchaToken)}
          className="w-full rounded-md bg-cobble-600 hover:bg-cobble-700 text-white text-sm font-medium px-3 py-2.5 transition disabled:opacity-50"
        >
          {busy ? "…" : creating ? (submitLabel ?? "Create account") : "Sign in"}
        </button>

        <button
          type="button"
          onClick={() => {
            setMode(creating ? "login" : "signup");
            setError(null);
          }}
          className="w-full text-xs text-muted dark:text-slate-400 hover:text-accent transition"
        >
          {creating ? "Have an account? Sign in" : "New here? Create an account"}
        </button>
      </form>
      {!creating && <MagicLinkPanel email={email} />}
    </>
  );
}
