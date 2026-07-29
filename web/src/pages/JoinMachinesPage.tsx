// /join-machines/:ownerOrg/:token — accept an invite to someone else's
// edge-bridge machines. The RECIPIENT decides which of their own workspace(s) to
// add the machines to (repeatable — one invite, many workspaces). The owner's
// machine credentials never come here: each workspace gets a pointer connection
// the relay resolves to the owner's bridge at request time, enforcing the grant's
// scope + revoked/expiry status live.

import { useState } from "react";
import { useParams, Link, useLocation } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { CheckCircle2, Share2 } from "lucide-react";
import { ApiError, api } from "../lib/api";
import { useAuth } from "../auth/AuthContext";
import { displaySlug } from "../lib/workspaceSlug";
import { usePageTitle, useToast } from "@cobblr/platform-web";

export function JoinMachinesPage() {
  usePageTitle("Add shared machines");
  const { ownerOrg, token } = useParams<{ ownerOrg: string; token: string }>();
  const { user, orgs } = useAuth();
  const loc = useLocation();
  const toast = useToast();
  // You can only add machines to a workspace you own/administer (it creates a
  // connection there). Guests/members of a workspace can't.
  const addable = orgs.filter((o) => o.role === "owner" || o.role === "admin");
  const [target, setTarget] = useState(addable[0]?.slug ?? "");
  const [added, setAdded] = useState<{ name: string; count: number }[]>([]);
  const redeem = useMutation({
    mutationFn: () => api.redeemEdgeShare(target, { owner_org: ownerOrg!, token: token! }),
    onSuccess: (r) => {
      const name = addable.find((o) => o.slug === target)?.name ?? target;
      setAdded((a) => [...a.filter((x) => x.name !== name), { name, count: r.machines.length }]);
      toast.success(r.already ? "Already added to that workspace" : `Added ${r.machines.length} machine${r.machines.length === 1 ? "" : "s"}`);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't add these machines"),
  });

  const card = "w-full max-w-md rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-6 shadow-sm";

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className={card + " text-center space-y-3"}>
          <Share2 className="mx-auto text-accent" size={28} />
          <h1 className="text-lg font-semibold text-content dark:text-mortar-100">You've been invited to some machines</h1>
          <p className="text-sm text-muted dark:text-slate-400">Log in to your Cobblr account to add them to one of your workspaces.</p>
          <Link to={`/?next=${encodeURIComponent(loc.pathname)}`} className="inline-block rounded bg-cobble-600 hover:bg-cobble-700 text-white text-sm px-4 py-2">Log in</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className={card + " space-y-4"}>
        <div className="text-center space-y-1">
          <Share2 className="mx-auto text-accent" size={26} />
          <h1 className="text-lg font-semibold text-content dark:text-mortar-100">Add shared machines</h1>
          <p className="text-sm text-muted dark:text-slate-400">
            Someone shared edge-bridge machines with you. Pick which of your workspaces to add them to - you can add to more than one.
          </p>
        </div>

        {addable.length === 0 ? (
          <p className="text-sm text-amber-600 dark:text-amber-400 text-center">You need to own or administer a workspace to add machines. Create one first.</p>
        ) : (
          <div className="space-y-2">
            <label className="block">
              <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">Add to workspace</span>
              <select value={target} onChange={(e) => setTarget(e.target.value)} className="w-full px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900">
                {addable.map((o) => (
                  <option key={o.slug} value={o.slug}>{o.name} ({displaySlug(o.slug)})</option>
                ))}
              </select>
            </label>
            <button type="button" onClick={() => redeem.mutate()} disabled={redeem.isPending || !target}
              className="w-full rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white text-sm px-4 py-2">
              {redeem.isPending ? "Adding…" : "Add machines here"}
            </button>
          </div>
        )}

        {added.length > 0 && (
          <div className="space-y-2 pt-2 border-t border-line dark:border-slate-700">
            {added.map((a) => (
              <div key={a.name} className="flex items-center gap-2 text-sm text-content dark:text-mortar-100">
                <CheckCircle2 size={16} className="text-moss-600 dark:text-moss-400 shrink-0" />
                Added {a.count} machine{a.count === 1 ? "" : "s"} to <strong>{a.name}</strong>
              </div>
            ))}
            <Link to={`/${displaySlug(addable.find((o) => o.slug === target)?.slug ?? target)}/digifab`} className="inline-block text-xs text-accent hover:underline">Open Digital Fabrication →</Link>
          </div>
        )}
      </div>
    </div>
  );
}
