// /join/:token — redeem a single-use signup invite. Lets a brand-new person
// create their OWN account + workspace while public signup is disabled. The
// token authorises the signup past the gate (validated server-side too).

import { useState, type FormEvent } from "react";
import { useParams, useNavigate, Navigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, AlertTriangle } from "lucide-react";
import { ApiError, api } from "../lib/api";
import { useAuth } from "../auth/AuthContext";
import { usePageTitle } from "@cobblr/platform-web";

export function JoinPage() {
  usePageTitle("Join");
  const { token } = useParams<{ token: string }>();
  const { user, signup } = useAuth();
  const navigate = useNavigate();

  const preview = useQuery({
    queryKey: ["signup-invite", token],
    queryFn: () => api.previewSignupInvite(token!),
    enabled: !!token,
    retry: false,
  });

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [orgName, setOrgName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Already signed in — an invite is for new accounts, send them home.
  if (user) return <Navigate to="/" replace />;

  const lockedEmail = preview.data?.invited_email ?? null;
  const effEmail = lockedEmail ?? email;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await signup({
        email: effEmail.replace(/\s+/g, ""),
        password: password.trim(),
        display_name: displayName.trim(),
        org_name: orgName.trim(),
        invite_token: token,
      });
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-full flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center gap-3 mb-6 text-center">
          <span className="font-display text-2xl font-extrabold text-content dark:text-mortar-100 lowercase">cobblr</span>
          <p className="text-sm text-muted dark:text-slate-400">You've been invited to create a workspace.</p>
        </div>

        {preview.isLoading && (
          <div className="text-xs font-mono text-faint dark:text-slate-500 text-center">checking your invite…</div>
        )}

        {preview.isError && (
          <InviteProblem title="Invite not found" body="This link doesn't match an invite. Double-check the URL, or ask whoever invited you for a fresh one." />
        )}

        {preview.data && preview.data.status !== "open" && (
          <InviteProblem
            title={preview.data.status === "consumed" ? "Already used" : preview.data.status === "expired" ? "Invite expired" : "Invite revoked"}
            body={preview.data.status === "consumed"
              ? "This invite has already been redeemed. If that wasn't you, ask for a new one."
              : preview.data.status === "expired"
                ? "This invite link has expired. Ask whoever invited you for a fresh one."
                : "This invite was revoked. Ask whoever invited you for a fresh one."}
          />
        )}

        {preview.data && preview.data.status === "open" && (
          <form onSubmit={submit} className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-5 space-y-3">
            {preview.data.note && (
              <div className="text-xs text-muted dark:text-slate-400 flex items-center gap-1.5">
                <CheckCircle2 size={13} className="text-accent" /> {preview.data.note}
              </div>
            )}
            {preview.data.blueprint_name && (
              <div className="text-xs text-moss-700 dark:text-moss-300 flex items-center gap-1.5 rounded border border-moss-500/40 bg-moss-50 dark:bg-moss-950/30 p-2">
                <CheckCircle2 size={13} className="shrink-0" /> Your workspace comes pre-configured:{" "}
                <strong>{preview.data.blueprint_name}</strong>  - everything will be set up the moment you sign up.
              </div>
            )}
            <Field label="Your email">
              <input type="email" required value={effEmail} onChange={(e) => setEmail(e.target.value)} disabled={!!lockedEmail} placeholder="you@example.com" className="input w-full" />
              {lockedEmail && <span className="mt-1 block text-[10px] text-faint dark:text-slate-500">This invite is for {lockedEmail}.</span>}
            </Field>
            <Field label="Password">
              <input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="at least 8 characters" className="input w-full" />
            </Field>
            <Field label="Your name">
              <input required value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Sam" className="input w-full" />
            </Field>
            <Field label="Workspace name">
              <input required value={orgName} onChange={(e) => setOrgName(e.target.value)} placeholder="Sam's Workshop" className="input w-full" />
            </Field>
            {error && <div className="text-xs text-ember-500">{error}</div>}
            <button type="submit" disabled={busy} className="w-full rounded-md bg-slate-700 hover:bg-slate-600 text-mortar-50 text-sm font-medium px-3 py-2 transition disabled:opacity-50">
              {busy ? "Creating your workspace…" : "Create my workspace"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

function InviteProblem({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-5 text-center space-y-2">
      <AlertTriangle size={20} className="text-ember-500 mx-auto" />
      <div className="font-medium text-content dark:text-mortar-100">{title}</div>
      <div className="text-xs text-muted dark:text-slate-400">{body}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">{label}</span>
      {children}
    </label>
  );
}
