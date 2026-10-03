// /share/join#<invite> — someone shared part of their workspace with you.
//
// The invite carries where the sharer's Cobblr is and a single-use code. You
// accept it on YOUR Cobblr, the one your account is on: this one, or another
// (enter its address and the page goes there with the same invite). Accepting
// makes "<their name>'s workspace (shared)" for you here
// (docs/design-decisions/share-spaces.md).

import { dropShareInvite, holdShareInvite } from "../lib/share-invite-pending";
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { usePageTitle, useToast } from "@cobblr/platform-web";
import { ApiError, api } from "../lib/api";
import { useAuth } from "../auth/AuthContext";
import { urlHandleFor } from "../auth/ActiveOrgContext";
import { CenteredCard } from "../components/CenteredCard";

function inviteFromHash(): { raw: string; from: string | null; name: string | null; workspace: string | null } | null {
  const raw = window.location.hash.replace(/^#/, "");
  if (!raw) return null;
  try {
    const t = JSON.parse(atob(raw.replace(/-/g, "+").replace(/_/g, "/"))) as { u?: string; n?: string; w?: string };
    return { raw, from: t.u ?? null, name: t.n ?? null, workspace: t.w ?? null };
  } catch {
    return null;
  }
}

export function ShareJoinPage() {
  usePageTitle("A share for you");
  const { user } = useAuth();
  const toast = useToast();
  const invite = inviteFromHash();
  const [elsewhere, setElsewhere] = useState("");
  // Signed in and back on the invite: it is here again, so it is not held.
  useEffect(() => {
    if (user) dropShareInvite();
  }, [user]);
  const preview = useQuery({
    queryKey: ["share-invite", invite?.raw],
    queryFn: () => api.previewShareInvite(invite!.raw),
    enabled: !!invite && !!user,
    retry: false,
  });
  const accept = useMutation({
    mutationFn: () => api.acceptShareInvite(invite!.raw),
    onSuccess: async (r) => {
      const list = await api.listOrgs();
      const org = list.items.find((o) => o.slug === r.slug);
      // Outside the workspace shell: a hard navigation lands in it with the
      // new membership.
      window.location.assign(org ? `/w/${urlHandleFor(org, list.items)}` : "/");
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Could not accept the share."),
  });

  if (!invite) {
    return (
      <CenteredCard tone="error" title="This invite link is incomplete">
        <p className="text-sm text-content">Open the whole link you were sent; the part after # is the invite.</p>
      </CenteredCard>
    );
  }
  const goElsewhere = () => {
    const addr = elsewhere.trim().replace(/\/+$/, "");
    if (!addr) return;
    const base = /^https?:\/\//.test(addr) ? addr : `https://${addr}`;
    window.location.assign(`${base}/share/join#${invite.raw}`);
  };
  const otherCobblr = (
    <div className="mt-4 space-y-2 border-t border-line pt-3 dark:border-slate-700">
      <p className="text-xs text-muted">Is your account on another Cobblr? Accept it there:</p>
      <div className="flex gap-2">
        <input
          value={elsewhere}
          onChange={(e) => setElsewhere(e.target.value)}
          placeholder="Your Cobblr's address"
          data-testid="share-join-elsewhere"
          className="min-w-0 flex-1 rounded-md border border-line bg-surface px-3 py-2 text-sm text-content dark:border-slate-700"
        />
        <button type="button" onClick={goElsewhere} className="rounded-md border border-line px-3 text-sm text-muted hover:text-accent dark:border-slate-700">
          Go
        </button>
      </div>
    </div>
  );
  const who = preview.data?.owner_name ?? invite.name ?? "Someone";
  const what = preview.data?.workspace_name ?? invite.workspace ?? "their workspace";

  if (!user) {
    // Held through the sign-in or sign-up, so it opens again after (#4737).
    holdShareInvite(invite.raw);
    const back = encodeURIComponent(`/share/join#${invite.raw}`);
    return (
      <CenteredCard tone="info" title={`${who} wants to share with you`}>
        <p className="text-sm text-content">Sign in to accept, or make an account here first; this invite opens again after. You get a workspace of your own for what {who} shares.</p>
        <button
          type="button"
          data-testid="share-join-sign-in"
          onClick={() => window.location.assign(`/?next=${back}`)}
          className="mt-4 w-full rounded-md bg-cobble-600 px-3 py-2 text-sm font-medium text-white"
        >
          Sign in here
        </button>
        <button
          type="button"
          data-testid="share-join-sign-up"
          onClick={() => window.location.assign(`/?mode=signup&next=${back}`)}
          className="mt-2 w-full rounded-md border border-line px-3 py-2 text-sm text-content hover:border-accent dark:border-slate-700"
        >
          Make an account here
        </button>
        {otherCobblr}
      </CenteredCard>
    );
  }
  if (preview.isError) {
    return (
      <CenteredCard tone="error" title="This invite cannot be used">
        <p className="text-sm text-content">{(preview.error as Error).message}</p>
        {otherCobblr}
      </CenteredCard>
    );
  }
  return (
    <CenteredCard tone="info" title={`${who} wants to share with you`}>
      <p className="text-sm text-content">
        <strong>{who}</strong> shares part of <strong>{what}</strong>
        {preview.data?.from_host ? <> from <strong>{preview.data.from_host}</strong></> : null}. Accepting makes{" "}
        <strong>{who}'s workspace (shared)</strong> for you here: you can scan into it, see what is offered to you, and offer {who} things of yours.
      </p>
      <button
        type="button"
        data-testid="share-join-accept"
        disabled={accept.isPending || preview.isLoading}
        onClick={() => accept.mutate()}
        className="mt-4 w-full rounded-md bg-cobble-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-60"
      >
        {accept.isPending ? "Setting it up…" : "Accept"}
      </button>
      {otherCobblr}
    </CenteredCard>
  );
}
