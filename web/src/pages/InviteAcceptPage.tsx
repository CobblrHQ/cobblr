// /invite/:token — opened from a workspace-invite link. Shows the workspace
// name + inviter + the role you'll get. Three states: signed-in → one-click
// Join; signed-out + no account → a signup form that creates the account AND
// joins (the invite authorises it past the public-signup gate); signed-out +
// existing account → "sign in to join", which comes back here afterwards.
// `?next=` (a label scan's item, #3801) is where a join lands; a new person
// without a password may instead ask for an emailed link that joins them.

import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { ApiError, api, setToken } from "../lib/api";
import { useAuth } from "../auth/AuthContext";
import { urlHandleFor } from "../auth/ActiveOrgContext";
import { useToast, usePageTitle, PasswordInput } from "@cobblr/platform-web";
import { landingPath } from "../lib/landing-path";
import { CenteredCard } from "../components/CenteredCard";

export function InviteAcceptPage() {
  usePageTitle("Accept invite");
  const { token } = useParams<{ token: string }>();
  const { user, orgs, joinViaInvite } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [su, setSu] = useState({ email: "", password: "", displayName: "" });
  const [suBusy, setSuBusy] = useState(false);
  const [suErr, setSuErr] = useState<string | null>(null);
  const [link, setLink] = useState<{ sent: boolean; devToken?: string } | null>(null);
  // The item a label scan sent them from: where joining lands.
  const [next] = useState(() => landingPath(new URLSearchParams(window.location.search).get("next")));

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
      if (next) return window.location.assign(next);
      const list = await api.listOrgs();
      const org = list.items.find((o) => o.slug === r.org.slug);
      window.location.assign(org ? `/w/${urlHandleFor(org, list.items)}` : "/");
    },
    onError: (e: unknown) => {
      toast.error(e instanceof ApiError ? e.message : "Couldn't accept invite.");
    },
  });

  // A member scanning the club's wall QR is already in: take them straight
  // to the workspace, no button to press and nothing counted (#3801).
  const mine = preview.data ? orgs.find((o) => o.slug === preview.data!.org_slug) : undefined;
  const alreadyIn = !!user && !!mine && preview.data?.status !== "revoked";
  useEffect(() => {
    if (alreadyIn && mine) window.location.assign(next ?? `/w/${urlHandleFor(mine, orgs)}`);
  }, [alreadyIn, mine, orgs, next]);

  if (!token) return null;

  if (alreadyIn) {
    return (
      <CenteredCard tone="info" title={`You're in ${preview.data!.org_name}`}>
        <p className="text-sm">Taking you there…</p>
      </CenteredCard>
    );
  }

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
        <button onClick={() => navigate("/")} className="rounded-md border border-line dark:border-slate-700 text-content dark:text-mortar-200 hover:bg-subtle dark:hover:bg-slate-800 text-sm px-3 py-1.5 transition disabled:opacity-50 mt-4">
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
      full: "This join link has already let in everyone it was made for. Ask the workspace for a new one.",
      paused: "This join link is paused for now: more people joined than it allows in a short time. The workspace has been told and can turn it back on.",
    };
    return (
      <CenteredCard tone="error" title="Invite unavailable">
        <p className="text-sm">{reason[p.status as Exclude<typeof p.status, "open">]}</p>
        <button onClick={() => navigate("/")} className="rounded-md border border-line dark:border-slate-700 text-content dark:text-mortar-200 hover:bg-subtle dark:hover:bg-slate-800 text-sm px-3 py-1.5 transition disabled:opacity-50 mt-4">
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
    const emailLink = async () => {
      const email = effEmail.replace(/\s+/g, "");
      if (!email || !su.displayName.trim()) {
        setSuErr("Fill in your email and your name first.");
        return;
      }
      setSuBusy(true); setSuErr(null);
      try {
        const r = await api.magicRequest({
          email,
          invite: token,
          display_name: su.displayName.trim(),
          ...(next ? { next } : {}),
        });
        setLink({ sent: true, ...(r.dev_token ? { devToken: r.dev_token } : {}) });
      } catch (err) {
        setSuErr(err instanceof ApiError ? err.message : "Couldn't send the link.");
      } finally {
        setSuBusy(false);
      }
    };
    const openDevLink = async () => {
      if (!link?.devToken) return;
      try {
        const r = await api.magicConsume({ token: link.devToken });
        setToken(r.token);
        window.location.href = landingPath(r.next) ?? "/";
      } catch (err) {
        setSuErr(err instanceof ApiError ? err.message : "Couldn't open the link.");
      }
    };
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
        if (next) return window.location.assign(next);
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
          {p.reusable ? (
            <>
              Join <strong>{p.org_name}</strong> as a <strong>{p.role}</strong>. You do this once; after that,
              scan the label on anything you take.
            </>
          ) : (
            <>
              <strong>{p.invited_by_name}</strong> invited you to{" "}
              <strong>{p.org_name}</strong> as <strong>{p.role}</strong>. Create an
              account to join.
            </>
          )}
        </p>
        <form onSubmit={submit} className="mt-4 space-y-3">
          <Field label="Your email">
            <input type="email" required value={effEmail} disabled={!!lockedEmail}
              onChange={(e) => setSu((s) => ({ ...s, email: e.target.value }))}
              placeholder="you@example.com" className="input w-full" />
            {lockedEmail && <span className="mt-1 block text-[10px] text-faint dark:text-slate-500">This invite is for {lockedEmail}.</span>}
          </Field>
          <Field label="Password">
            <PasswordInput autoComplete="new-password" required minLength={8} value={su.password}
              onChange={(e) => setSu((s) => ({ ...s, password: e.target.value }))}
              placeholder="at least 8 characters" className="input w-full" />
          </Field>
          <Field label="Your name">
            <input required value={su.displayName}
              onChange={(e) => setSu((s) => ({ ...s, displayName: e.target.value }))}
              placeholder="Sam" className="input w-full" />
          </Field>
          {suErr && <div className="text-xs text-ember-500">{suErr}</div>}
          <button type="submit" data-testid="invite-create-account" disabled={suBusy}
            className="w-full rounded-md bg-slate-700 hover:bg-slate-600 text-mortar-50 text-sm font-medium px-3 py-2 transition disabled:opacity-50">
            {suBusy ? "Joining…" : `Create account & join`}
          </button>
        </form>
        <div className="mt-3 rounded-md border border-line dark:border-slate-700 p-3 text-left space-y-2">
          <p className="text-xs text-muted dark:text-slate-400">
            No password? Fill in your email and name above and we&apos;ll email you a link that joins you.
          </p>
          {link?.sent ? (
            link.devToken ? (
              <button type="button" onClick={() => void openDevLink()} data-testid="invite-dev-link"
                className="w-full rounded-md border border-line dark:border-slate-700 text-sm px-3 py-2">
                No mail on this server: open the link here
              </button>
            ) : (
              <p className="text-xs text-content dark:text-mortar-200" data-testid="invite-link-sent">
                Check your email for the link to {p.org_name}.
              </p>
            )
          ) : (
            <button type="button" onClick={() => void emailLink()} disabled={suBusy} data-testid="invite-email-link"
              className="w-full rounded-md border border-line dark:border-slate-700 text-sm px-3 py-2 disabled:opacity-50">
              Email me a link to join
            </button>
          )}
        </div>
        <button
          onClick={() => {
            // The sign-in page sends them back here (LandingRedirect reads
            // ?next=), where the session offers Join or, for a member, goes in.
            const here = `/invite/${token}${next ? `?next=${encodeURIComponent(next)}` : ""}`;
            window.location.assign(`/?next=${encodeURIComponent(here)}`);
          }}
          className="mt-3 text-xs text-accent hover:underline"
          data-testid="invite-sign-in"
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-left">
      <span className="block text-[10px] uppercase tracking-widest text-faint dark:text-slate-500 mb-1">{label}</span>
      {children}
    </label>
  );
}
