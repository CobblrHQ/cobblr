import { useState } from "react";
import { api, ApiError } from "../lib/api";

type ResetRequestProps = { email: string; resetHref?: string | null };

/** "Forgot password?" — sends a reset link to the email typed above. In dev
 *  (no email sender) the server returns the link inline so the flow is
 *  exercisable; otherwise we just confirm it's been sent. */
export function ForgotPasswordRow({ email, resetHref }: ResetRequestProps) {
  const cleanEmail = email.replace(/\s+/g, "");
  return <ResetPasswordRequest key={cleanEmail.toLowerCase()} email={cleanEmail} resetHref={resetHref} />;
}

function ResetPasswordRequest({ email, resetHref }: ResetRequestProps) {
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
