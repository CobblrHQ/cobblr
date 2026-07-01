// A dismissible nudge shown in the app shell while the signed-in user's email
// is unverified. Non-blocking (verification doesn't gate anything) — just a
// gentle prompt with a one-click resend. email_verified is undefined on
// sessions that predate the field, so we only nag when it's explicitly false.

import { useState } from "react";
import { MailWarning, X } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { api } from "../lib/api";

export function EmailVerifyBanner() {
  const { user } = useAuth();
  // Dismissal PERSISTS (per user) — the banner used to come back on every page
  // load forever, permanently taxing the top 40px of every screen (redesign
  // A4). One dismissal = you've seen it; the account menu still shows the
  // unverified state and Resend.
  const dismissKey = user ? `cobblr.verifyBanner.dismissed:${user.id}` : "";
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try { return !!dismissKey && localStorage.getItem(dismissKey) === "1"; } catch { return false; }
  });
  const dismiss = () => {
    setDismissed(true);
    try { localStorage.setItem(dismissKey, "1"); } catch { /* ignore */ }
  };
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  if (!user || user.email_verified !== false || dismissed) return null;

  async function resend() {
    setBusy(true);
    try {
      await api.resendVerification();
      setSent(true);
    } catch {
      // Best-effort — leave the banner as-is on failure.
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-cobble-50 dark:bg-cobble-900/20 border-b border-cobble-200 dark:border-cobble-900/40">
      <div className="max-w-6xl mx-auto px-5 py-2 flex items-center gap-3 text-xs text-content dark:text-mortar-200">
        <MailWarning size={14} className="shrink-0 text-accent" />
        <span className="flex-1 min-w-0">
          {sent ? (
            "Verification email sent — check your inbox (and spam)."
          ) : (
            <>
              Verify your email <strong className="break-all">{user.email}</strong> to secure your
              account.
            </>
          )}
        </span>
        {!sent && (
          <button
            type="button"
            onClick={() => void resend()}
            disabled={busy}
            className="shrink-0 font-medium text-accent underline hover:no-underline disabled:opacity-50"
          >
            {busy ? "Sending…" : "Resend"}
          </button>
        )}
        <button
          type="button"
          onClick={dismiss}
          className="shrink-0 text-faint hover:text-content dark:hover:text-mortar-200 transition"
          title="Dismiss"
          aria-label="Dismiss"
        >
          <X size={13} />
        </button>
      </div>
    </div>
  );
}
