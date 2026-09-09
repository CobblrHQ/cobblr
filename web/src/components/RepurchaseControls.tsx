// The three answers to "you already have one of these, and you just scanned
// another": Replaced the one that ran out / +N, still had some / Old one went
// bad. ONE implementation, because TWO surfaces show the match: the full
// TrackedMatchBanner (expanded card, result modal) and the scan inbox card's
// own condensed line. When each drew its own buttons they drifted within a
// day: the banner had these three while the card still showed the retired
// "this buy was" chips and a bare "+1 to it" (reported 2026-09-09).
//
// Which answer is primary is decided by what the ledger and the record
// already know: stock that is past its expiry date makes "went bad" the
// obvious one; an empty shelf leaves only "+N to it"; otherwise the everyday
// re-buy, "replaced", leads.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PackagePlus, RefreshCw } from "lucide-react";
import { useToast } from "@cobblr/platform-web";
import { api, ApiError, type TrackedMatch } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { leadAnswer } from "../lib/repurchaseAnswer";

export type RepurchaseMode = "add-qty" | "replace";
type Resolution = "over_buy" | "consumed" | "discarded";

export interface AttachResult {
  entity_title: string;
  new_qty: number | null;
  prev_location_id: string | null;
}

/** The best tracked match for a scan and the name of where it lives. The inbox
 *  card only carries a cached title, so this resolves the record from the same
 *  endpoint the banner uses; a caller that already holds the match passes it
 *  and no request is made. */
export function useBestTrackedMatch(itemId: string, matchProp?: TrackedMatch | null) {
  const { activeSlug } = useActiveOrg();
  const resolved = useQuery({
    queryKey: ["scan-tracked", activeSlug, itemId],
    queryFn: () => api.scanTrackedMatches(activeSlug, itemId),
    enabled: !matchProp && !!itemId,
    staleTime: 60_000,
  });
  const match: TrackedMatch | null =
    matchProp ??
    (resolved.data?.barcode_matches ?? []).concat(resolved.data?.name_matches ?? [])[0] ??
    null;
  const locations = useQuery({
    queryKey: ["core-locations", activeSlug],
    queryFn: () => api.listLocations(activeSlug),
    enabled: !!activeSlug && !!match?.location_id,
    staleTime: 60_000,
  });
  const where = match?.location_id
    ? ((locations.data?.items ?? []).find((l) => l.id === match.location_id)?.name ?? null)
    : null;
  return { match, where };
}

const pill = {
  primary: "bg-emerald-600 hover:bg-emerald-700 text-white",
  secondary:
    "border border-emerald-400 dark:border-emerald-700 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100/60 dark:hover:bg-emerald-900/30",
};

export function RepurchaseAnswers({
  itemId,
  match,
  quantity,
  onDone,
}: {
  itemId: string;
  match: TrackedMatch;
  /** How many this scan is adding. */
  quantity: number;
  onDone?: (result: AttachResult, match: TrackedMatch, mode: RepurchaseMode) => void;
}) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();

  // What the ledger makes of a purchase right now. A workspace without the
  // Cadence capability 404s here; `catch` turns that into "no opinion".
  const cadence = useQuery({
    queryKey: ["cadence-state", activeSlug, match.kind, match.id, match.expired],
    queryFn: () => api.cadenceState(activeSlug, match.kind, match.id, { expired: !!match.expired }).catch(() => null),
    enabled: match.qty != null && match.qty > 0,
    staleTime: 60_000,
  });
  const cad = cadence.data ?? null;
  const daysLeft = cad?.days_until_runout != null ? Math.round(cad.days_until_runout) : null;
  const lead = leadAnswer(match, cad?.repurchase_means);

  const attach = useMutation({
    mutationFn: (vars: { mode: RepurchaseMode; resolution?: Resolution }) =>
      api.scanAttach(activeSlug, itemId, {
        kind: match.kind,
        entity_id: match.id,
        instance: match.instance ?? undefined,
        mode: vars.mode,
        ...(vars.resolution ? { cadence: { resolution: vars.resolution } } : {}),
      }),
    onSuccess: (r, vars) => {
      void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
      toast.success(
        vars.mode === "replace"
          ? `${r.entity_title}: replaced${r.new_qty != null ? ` (now ×${r.new_qty})` : ""}`
          : `+${quantity} → ${r.entity_title}${r.new_qty != null ? ` (now ×${r.new_qty})` : ""}`,
      );
      onDone?.(r, match, vars.mode);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  if (match.qty == null || !lead) return null;
  const busy = attach.isPending;
  const hasSome = match.qty > 0;
  const cls = (primary: boolean) =>
    `inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium disabled:opacity-50 ${primary ? pill.primary : pill.secondary}`;

  return (
    <>
      {hasSome && (
        <button
          type="button"
          disabled={busy}
          title="The one you had ran out; this is the new one. The count stays what you scanned, and the ledger learns how long the last one lasted."
          onClick={() => attach.mutate({ mode: "replace", resolution: "consumed" })}
          className={cls(lead === "replaced")}
        >
          <RefreshCw size={12} /> Replaced the one that ran out
        </button>
      )}
      <button
        type="button"
        disabled={busy}
        title={hasSome ? "You still have the old one; this goes on top." : undefined}
        onClick={() => attach.mutate({ mode: "add-qty", ...(hasSome ? { resolution: "over_buy" as const } : {}) })}
        className={cls(lead === "add")}
      >
        <PackagePlus size={12} /> +{quantity}
        {hasSome ? ", still had some" : " to it"}
      </button>
      {hasSome && (
        <button
          type="button"
          disabled={busy}
          title="The old one went bad and this replaces it. Recorded as waste, never as consumption."
          onClick={() => attach.mutate({ mode: "replace", resolution: "discarded" })}
          className={cls(lead === "went_bad")}
        >
          Old one went bad
        </button>
      )}
      {hasSome && daysLeft != null && daysLeft > 0 && (
        <span className="self-center text-[11px] text-muted" title="What the cadence ledger expects from your past buys">
          ~{daysLeft} {daysLeft === 1 ? "day" : "days"} of the last one left
        </span>
      )}
    </>
  );
}
