// /invite/:token — opened from a workspace-invite link. Shows the workspace
// name + inviter + the role you'll get. Three states: signed-in → one-click
// Join; signed-out + no account → a signup form that creates the account AND
// joins (the invite authorises it past the public-signup gate); signed-out +
// existing account → "sign in to join".

import { useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { CheckCircle2, AlertTriangle } from "lucide-react";
import { ApiError, api } from "../lib/api";
import { useAuth } from "../auth/AuthContext";
import { urlHandleFor } from "../auth/ActiveOrgContext";
import { useToast, usePageTitle } from "@cobblr/platform-web";

export function InviteAcceptPage() {
  usePageTitle("Accept invite");
  const { token } = useParams<{ token: string }>();
  const { user, joinViaInvite } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [su, setSu] = useState({ email: "", password: "", displayName: "" });
  const [suBusy, setSuBusy] = useState(false);
  const [suErr, setSuErr] = useState<string | null>(null);

  const preview = useQuery({
    queryKey: ["invite-preview", token],
    queryFn: () => api.previewInvite(token!),
    enabled: !!token,
    retry: false,
  });

  const accept = useMutation({
    mutationFn: () => api.acceptInvite(token!),
    onSuccess: async (r) => {
      toast.success(
        r.already_member
          ? `You're already in ${r.org.name}. Switched.`
          : `Welcome to ${r.org.name}.`,
      );
      // This page renders OUTSIDE ActiveOrgProvider, so land in the new
      // workspace with a HARD navigation — it re-mounts the app with the new
      // membership and the provider initialized to that workspace.
      const list = await api.listOrgs();
      const org = list.items.find((o) => o.slug === r.org.slug);
      window.location.assign(org ? `/w/${urlHandleFor(org, list.items)}` : "/");
    },
    onError: (e: unknown) => {
      toast.error(e instanceof ApiError ? e.message : "Couldn't accept invite.");
    },
  });

  if (!token) return null;

  if (preview.isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-sm text-faint">
        loading invite…
      </div>
    );
  }

  if (preview.error || !preview.data) {
    return (
      <CenteredCard tone="error" title="Invite not found">
        <p className="text-sm">
          This invite link doesn't match any workspace. It may have been
          revoked, already used, or mistyped.
        </p>
        <button onClick={() => navigate("/")} className="btn-secondary mt-4">
          Go home
        </button>
      </CenteredCard>
    );
  }

  const p = preview.data;

  if (p.status !== "open") {
    const reason: Record<Exclude<typeof p.status, "open">, string> = {
      consumed: "This invite has already been used.",
      revoked: "This invite was revoked by the workspace owner.",
      expired: "This invite has expired.",
    };
    return (
      <CenteredCard tone="error" title="Invite unavailable">
        <p className="text-sm">{reason[p.status as Exclude<typeof p.status, "open">]}</p>
        <button onClick={() => navigate("/")} className="btn-secondary mt-4">
          Go home
        </button>
      </CenteredCard>
    );
  }

  // Signed-out + a brand-new person: create an account on the spot (the
  // invite authorises it past the public-signup gate) that joins THIS
  // workspace. Someone who already has an account uses the "sign in" link.
  if (!user) {
    const lockedEmail = p.invited_email;
    const effEmail = lockedEmail ?? su.email;
    const submit = async (e: FormEvent) => {
      e.preventDefault();
      setSuBusy(true); setSuErr(null);
      try {
        await joinViaInvite(token, {
          email: effEmail.replace(/\s+/g, ""),
          password: su.password.trim(),
          display_name: su.displayName.trim(),
        });
        toast.success(`Welcome to ${p.org_name}.`);
        const list = await api.listOrgs();
        const org = list.items.find((o) => o.slug === p.org_slug);
        window.location.assign(org ? `/w/${urlHandleFor(org, list.items)}` : "/");
      } catch (err) {
        setSuErr(err instanceof ApiError ? err.message : "Couldn't join.");
      } finally {
        setSuBusy(false);
      }
    };
    return (
      <CenteredCard tone="info" title={`Join ${p.org_name}`}>
        <p className="text-sm text-content dark:text-mortar-200">
          <strong>{p.invited_by_name}</strong> invited you to{" "}
          <strong>{p.org_name}</strong> as <strong>{p.role}</strong>. Create an
          account to join.
        </p>
        <form onSubmit={submit} className="mt-4 space-y-3">
          <Field label="Your email">
            <input type="email" required value={effEmail} disabled={!!lockedEmail}
              onChange={(e) => setSu((s) => ({ ...s, email: e.target.value }))}
              placeholder="you@example.com" className="input w-full" />
            {lockedEmail && <span className="mt-1 block text-[10px] text-faint dark:text-slate-500">This invite is for {lockedEmail}.</span>}
          </Field>
          <Field label="Password">
            <input type="password" required minLength={8} value={su.password}
              onChange={(e) => setSu((s) => ({ ...s, password: e.target.value }))}
              placeholder="at least 8 characters" className="input w-full" />
          </Field>
          <Field label="Your name">
            <input required value={su.displayName}
              onChange={(e) => setSu((s) => ({ ...s, displayName: e.target.value }))}
              placeholder="Sam" className="input w-full" />
          </Field>
          {suErr && <div className="text-xs text-ember-500">{suErr}</div>}
          <button type="submit" disabled={suBusy}
            className="w-full rounded-md bg-slate-700 hover:bg-slate-600 text-mortar-50 text-sm font-medium px-3 py-2 transition disabled:opacity-50">
            {suBusy ? "Joining…" : `Create account & join`}
          </button>
        </form>
        <button
          onClick={() => navigate(`/auth?next=${encodeURIComponent(`/invite/${token}`)}`)}
          className="mt-3 text-xs text-accent hover:underline"
        >
          Already have an account? Sign in to join
        </button>
      </CenteredCard>
    );
  }

  return (
    <CenteredCard tone="info" title={`Join ${p.org_name}`}>
      <p className="text-sm text-content dark:text-mortar-200">
        <strong>{p.invited_by_name}</strong> invited you to{" "}
        <strong>{p.org_name}</strong> as <strong>{p.role}</strong>.
      </p>
      {p.expires_at && (
        <p className="text-[10px] font-mono text-faint dark:text-slate-500 mt-2">
          Expires {new Date(p.expires_at).toLocaleString()}
        </p>
      )}
      <div className="flex items-center gap-2 mt-5">
        <button
          onClick={() => navigate("/")}
          className="px-3 py-1.5 rounded-md text-sm font-medium text-content dark:text-slate-300 hover:bg-subtle dark:hover:bg-slate-800 transition"
        >
          Not now
        </button>
        <button
          onClick={() => accept.mutate()}
          disabled={accept.isPending}
          className="px-3 py-1.5 rounded-md text-sm font-medium bg-slate-700 hover:bg-slate-600 text-mortar-50 transition disabled:opacity-50"
        >
          {accept.isPending ? "Joining…" : `Join as ${p.role}`}
        </button>
      </div>
    </CenteredCard>
  );
}

function CenteredCard({
  title,
  tone,
  children,
}: {
  title: string;
  tone: "info" | "error";
  children: React.ReactNode;
}) {
  const Icon = tone === "error" ? AlertTriangle : CheckCircle2;
  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="max-w-md w-full rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-6">
        <div
          className={
            "flex items-center gap-2 mb-3 " +
            (tone === "error" ? "text-ember-500" : "text-accent")
          }
        >
          <Icon size={16} />
          <h1 className="font-display text-lg font-bold text-content dark:text-mortar-100 page-title">
            {title}
          </h1>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-left">
      <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">{label}</span>
      {children}
    </label>
  );
}
