// A scan that is a hand-over (docs/design-decisions/share-spaces.md §6).
//
// Offered to you: who it is from, and Take / Pass / Maybe later. In a shared
// workspace, Take moves it into a workspace of your own (you pick which).
// Offered from here: who it went to. A shared workspace's other scans can be
// offered to the person who shared it.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Gift } from "lucide-react";
import { useToast } from "@cobblr/platform-web";
import { readInboxOffer } from "@cobblr/platform-contract/share-offer";
import { api, type ScanInboxItem } from "../lib/api";
import { useAuth } from "../auth/AuthContext";

export function ScanOfferStrip({ item, slug }: { item: ScanInboxItem; slug: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { orgs } = useAuth();
  const here = orgs.find((o) => o.slug === slug);
  const inShare = here?.kind === "share";
  const own = orgs.filter((o) => o.kind !== "share");
  const [into, setInto] = useState<string>(() => own[0]?.id ?? "");
  const meta = (item.suggested_metadata ?? {}) as Record<string, unknown>;
  const offer = readInboxOffer(meta);
  const given = meta.share_offered as { state?: string } | null | undefined;
  const sharer = useQuery({
    queryKey: ["share-links", slug],
    queryFn: () => api.listShareLinks(slug),
    enabled: inShare && !offer,
    staleTime: 60_000,
  });
  // The row changes state, may leave this inbox and land in another, and the
  // giver's side moves too: refresh everything rather than guess.
  const refresh = () => void qc.invalidateQueries();
  const decide = useMutation({
    mutationFn: (d: "taken" | "passed" | "maybe") => api.decideScanOffer(slug, item.id, d, d === "taken" && inShare ? into || null : null),
    onSuccess: (_r, d) => {
      const from = offer?.from ?? "them";
      toast.success(d === "taken" ? (inShare && into ? `Taken. It is in ${own.find((o) => o.id === into)?.name ?? "your workspace"}'s inbox.` : `Taken. ${from} is told.`) : d === "passed" ? `Passed. ${from} is told.` : "Left for later.");
      refresh();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const offerBack = useMutation({
    mutationFn: () => api.offerScansToSharer(slug, [item.id]),
    onSuccess: () => {
      toast.success(`Offered to ${sharer.data?.items[0]?.peer_name ?? "them"}.`);
      refresh();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const resolveSend = useMutation({
    mutationFn: (body: {send_drop_unmapped?: boolean; send_unplaced?: boolean}) => api.updateScanItem(slug, item.id, body),
    onSuccess: refresh,
    onError: (e) => toast.error((e as Error).message),
  });
  const box = "flex flex-wrap items-center gap-2 rounded-lg border border-line bg-subtle px-3 py-2 text-sm text-content dark:border-slate-600";
  const btn = "rounded border border-line px-2 py-1 text-xs text-muted hover:border-accent hover:text-accent disabled:opacity-60 dark:border-slate-600";

  if (offer?.own) return <div className={box} data-testid="scan-own-send">
    <span>{offer.mode === "copy" ? "Copied" : "Sent"} from {offer.from}</span>
    <ul className="w-full list-disc pl-5">{offer.needs?.map((need) => <li key={need}>{need}</li>)}</ul>
    {offer.needs?.some((n) => n.includes("has no field")) && <button type="button" className={btn} disabled={resolveSend.isPending || meta.send_drop_unmapped === true} onClick={() => resolveSend.mutate({send_drop_unmapped: true})}>{meta.send_drop_unmapped ? "Unmatched fields will be dropped" : "Drop unmatched fields when filing"}</button>}
    {offer.needs?.includes("Choose a placement in this workspace") && <button type="button" className={btn} disabled={resolveSend.isPending || meta.send_unplaced === true} onClick={() => resolveSend.mutate({send_unplaced: true})}>{meta.send_unplaced ? "Will arrive unplaced" : "Arrive unplaced"}</button>}
  </div>;
  if (offer) {
    const open = offer.state === "offered" || offer.state === "maybe";
    return (
      <div className={box} data-testid="scan-offer">
        <Gift size={14} className="shrink-0 text-muted" aria-hidden />
        <span className="min-w-0 flex-1">
          {open ? `Offered by ${offer.from}` : offer.state === "taken" ? `Taken from ${offer.from}` : `From ${offer.from}`}
          {offer.state === "maybe" && <span className="text-muted"> · maybe later</span>}
        </span>
        {open && (
          <span className="flex flex-wrap items-center gap-2">
            {inShare && own.length > 0 && (
              <select aria-label="Take it into" value={into} onChange={(e) => setInto(e.target.value)} className="rounded border border-line bg-surface px-2 py-1 text-base sm:text-xs dark:border-slate-600">
                {own.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            )}
            <button type="button" data-testid="scan-offer-take" disabled={decide.isPending} onClick={() => decide.mutate("taken")} className="rounded bg-cobble-600 px-2 py-1 text-xs font-medium text-white disabled:opacity-60">
              Take
            </button>
            <button type="button" data-testid="scan-offer-pass" disabled={decide.isPending} onClick={() => decide.mutate("passed")} className={btn}>
              Pass
            </button>
            {offer.state !== "maybe" && (
              <button type="button" data-testid="scan-offer-maybe" disabled={decide.isPending} onClick={() => decide.mutate("maybe")} className={btn}>
                Maybe later
              </button>
            )}
          </span>
        )}
      </div>
    );
  }
  if (given?.state && given.state !== "withdrawn") {
    return (
      <div className={box} data-testid="scan-offered">
        <Gift size={14} className="shrink-0 text-muted" aria-hidden />
        <span>{given.state === "taken" ? "Taken by the person you offered it to" : "Offered to the person who shared this workspace"}</span>
      </div>
    );
  }
  const to = sharer.data?.items[0]?.peer_name;
  if (inShare && to && item.status === "pending") {
    return (
      <div className={box}>
        <Gift size={14} className="shrink-0 text-muted" aria-hidden />
        <span className="min-w-0 flex-1">Something {to} could have?</span>
        <button type="button" data-testid="scan-offer-to-sharer" disabled={offerBack.isPending} onClick={() => offerBack.mutate()} className={btn}>
          Offer to {to}
        </button>
      </div>
    );
  }
  return null;
}
