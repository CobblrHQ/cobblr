// /invite/:token — opened from an invite link. Shows the workspace
// name + inviter, the role you'll be assigned, and an Accept button.
// If you're not signed in, we shunt you through AuthPage with a
// hint to come back here after.

import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { CheckCircle2, AlertTriangle } from "lucide-react";
import { ApiError, api } from "../lib/api";
import { useAuth } from "../auth/AuthContext";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { useToast } from "@cobblr/platform-web";

export function InviteAcceptPage() {
  const { token } = useParams<{ token: string }>();
  const { user, setOrgs } = useAuth();
  const { setActiveSlug } = useActiveOrg();
  const navigate = useNavigate();
  const toast = useToast();

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
      // Refresh the org list so the header switcher sees the new one
      // and flip the active workspace to it.
      const list = await api.listOrgs();
      setOrgs(list.items);
      setActiveSlug(r.org.slug);
      navigate("/", { replace: true });
    },
    onError: (e: unknown) => {
      toast.error(e instanceof ApiError ? e.message : "Couldn't accept invite.");
    },
  });

  if (!token) return null;

  if (preview.isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-sm text-slate-400">
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

  // Signed-out users get sent to /auth?next=/invite/:token. Sign-in
  // / sign-up flow returns here.
  if (!user) {
    return (
      <CenteredCard tone="info" title={`You're invited to ${p.org_name}`}>
        <p className="text-sm text-slate-600 dark:text-mortar-200">
          {p.invited_by_name} invited you as <strong>{p.role}</strong>.
        </p>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-3">
          Sign in or create a cobblr account to accept.
        </p>
        <button
          onClick={() =>
            navigate(`/auth?next=${encodeURIComponent(`/invite/${token}`)}`)
          }
          className="btn-primary mt-4"
        >
          Sign in to accept
        </button>
      </CenteredCard>
    );
  }

  return (
    <CenteredCard tone="info" title={`Join ${p.org_name}`}>
      <p className="text-sm text-slate-600 dark:text-mortar-200">
        <strong>{p.invited_by_name}</strong> invited you to{" "}
        <strong>{p.org_name}</strong> as <strong>{p.role}</strong>.
      </p>
      {p.expires_at && (
        <p className="text-[10px] font-mono text-slate-400 dark:text-slate-500 mt-2">
          Expires {new Date(p.expires_at).toLocaleString()}
        </p>
      )}
      <div className="flex items-center gap-2 mt-5">
        <button
          onClick={() => navigate("/")}
          className="px-3 py-1.5 rounded-md text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-mortar-50 dark:hover:bg-slate-800 transition"
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
      <div className="max-w-md w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-6">
        <div
          className={
            "flex items-center gap-2 mb-3 " +
            (tone === "error" ? "text-ember-500" : "text-cobble-500")
          }
        >
          <Icon size={16} />
          <h1 className="font-display text-lg font-bold text-slate-700 dark:text-mortar-100 lowercase">
            {title}
          </h1>
        </div>
        {children}
      </div>
    </div>
  );
}
