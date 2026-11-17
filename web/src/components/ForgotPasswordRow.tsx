import { useState } from "react";
import { api, ApiError } from "../lib/api";

/** `reaches`: false when no reset link this server mints reaches anyone
 *  (/auth/config's email_links "none", #9488). */
type ResetRequestProps = { email: string; resetHref?: string | null; reaches?: boolean };

/** "Forgot password?" — sends a reset link to the email typed above. In dev
 *  (no email sender) the server returns the link inline so the flow is
 *  exercisable; otherwise we just confirm it's been sent. */
export function ForgotPasswordRow({ email, resetHref, reaches }: ResetRequestProps) {
  const cleanEmail = email.replace(/\s+/g, "");
  return <ResetPasswordRequest key={cleanEmail.toLowerCase()} email={cleanEmail} resetHref={resetHref} reaches={reaches} />;
}

function ResetPasswordRequest({ email, resetHref, reaches = true }: ResetRequestProps) {
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

  // A central account's password lives on the account service, not here:
  // resetting this surface's copy would leave the two disagreeing.
  if (resetHref) {
    return (
      <div className="text-right -mt-1">
        <a href={resetHref} className="text-[11px] text-muted dark:text-slate-400 hover:text-accent">
          Forgot password?
        </a>
      </div>
    );
  }

  // No reset link can reach anyone from this box (no email sender): say what
  // does work here, an admin resetting it, instead of promising an email (#9488).
  if (!reaches) {
    return (
      <details className="text-right -mt-1">
        <summary className="text-[11px] text-faint dark:text-slate-500 hover:text-accent cursor-pointer list-none">Forgot password?</summary>
        <div className="mt-1 text-left text-[11px] text-muted dark:text-slate-400 bg-subtle/60 dark:bg-slate-800/40 rounded-md px-3 py-2">
          This server can't send email, so a reset link can't reach you. Ask an admin of your workspace to reset your password in Configuration, Users.
        </div>
      </details>
    );
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
