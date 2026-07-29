// Dashboard callout: a member offered to share their AI with this workspace and
// the OWNER hasn't approved it yet. Until they do, Ask Cobb + other AI stay
// off — a real dead-end we hit in the field (offer sat pending for weeks; the
// only signal was an unread in-app notification). This surfaces it loudly, on
// the dashboard, with the approve action inline so the owner never has to hunt
// for the settings panel. Renders nothing unless the viewer is an owner with a
// pending offer.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Sparkles } from "lucide-react";
import { useToast } from "@cobblr/platform-web";
import { api, type WorkspaceAiOffer } from "../lib/api";
import { usePendingAiShares } from "../lib/usePendingAiShares";

export function PendingAiShareCallout({ slug, role }: { slug: string; role: string }) {
  const isOwner = role === "owner";
  const pending = usePendingAiShares(slug, isOwner);
  const qc = useQueryClient();
  const toast = useToast();

  const onItems = (r: { items: WorkspaceAiOffer[] }) => {
    qc.setQueryData(["ai-shares", slug], r);
    // Availability just changed — refresh so the chat's "AI off" strip clears
    // without a reload (useAiStatus caches for minutes).
    void qc.invalidateQueries({ queryKey: ["ai-status"] });
  };
  // Approve with active=false — the server auto-activates it when the workspace
  // has no active AI yet (the common case), so one tap lights up the chat.
  const approve = useMutation({
    mutationFn: (cid: string) => api.approveAiShare(slug, cid),
    onSuccess: (r) => {
      onItems(r);
      toast.success("Approved - this AI now powers the workspace.");
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const reject = useMutation({
    mutationFn: (cid: string) => api.rejectAiShare(slug, cid),
    onSuccess: (r) => {
      onItems(r);
      toast.success("Offer declined.");
    },
    onError: (e) => toast.error((e as Error).message),
  });

  if (!isOwner || pending.length === 0) return null;

  return (
    <div className="rounded-xl border border-amber-300 dark:border-amber-700/60 bg-amber-50 dark:bg-amber-950/30 p-4 space-y-3">
      <div className="flex items-start gap-2">
        <Sparkles size={18} className="text-amber-600 dark:text-amber-500 shrink-0 mt-0.5" />
        <div className="text-sm text-content dark:text-mortar-100">
          <span className="font-medium">
            {pending.length === 1
              ? `${pending[0]!.offered_by_name} offered to share their AI`
              : `${pending.length} people offered to share their AI`}
          </span>{" "}
          with this workspace. Approve it to turn on Ask Cobb and other AI features.
        </div>
      </div>

      {pending.map((o) => (
        <div key={o.credential_id} className="flex items-center gap-2 text-sm pl-6">
          <div className="flex-1 min-w-0 text-muted dark:text-slate-400 truncate">
            {/* The sharer's connection label is private to them — show a generic
                unless it's the owner's own share (backend blanks it otherwise). */}
            {o.label ? `${o.offered_by_name} · ${o.label}` : `${o.offered_by_name}'s AI`}
          </div>
          <button
            type="button"
            disabled={approve.isPending}
            onClick={() => approve.mutate(o.credential_id)}
            className="rounded bg-cobble-600 hover:bg-cobble-700 text-white text-xs font-medium px-2.5 py-1 disabled:opacity-50"
          >
            Approve
          </button>
          <button
            type="button"
            disabled={reject.isPending}
            onClick={() => reject.mutate(o.credential_id)}
            className="rounded border border-line dark:border-slate-600 text-muted hover:text-ember-500 text-xs font-medium px-2.5 py-1"
          >
            Decline
          </button>
        </div>
      ))}

      <div className="pl-6">
        <Link to="/configuration" className="text-[11px] text-muted hover:text-accent">
          Manage in Settings → AI sharing
        </Link>
      </div>
    </div>
  );
}
