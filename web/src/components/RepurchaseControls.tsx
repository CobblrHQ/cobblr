// "+N to it", the buy-context chips, and the three-way over-buy question.
//
// Lives on its own because TWO surfaces show "you already have this": the full
// TrackedMatchBanner (phone result card, result modal) and the scan inbox
// card's own condensed line, which draws its own markup rather than rendering
// the banner. The controls shipped inside the banner only, so on the surface
// people actually use they were simply absent - every test passed and the
// prompt could not be reached. One component, used by both, is the fix that
// keeps it that way.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PackagePlus } from "lucide-react";
import { useToast } from "@cobblr/platform-web";
import { api, ApiError, type TrackedMatch } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";

type Ctx = "normal" | "faster" | "bulk" | "one_off";
type Resolution = "over_buy" | "consumed" | "discarded";

const CONTEXTS: Array<[Ctx, string]> = [
  ["normal", "as usual"],
  ["one_off", "a one-off"],
  ["bulk", "a stock-up"],
  ["faster", "going quicker lately"],
];

const ANSWERS: Array<[Resolution, string]> = [
  ["over_buy", "Still have them"],
  ["consumed", "Gone - used them faster"],
  ["discarded", "They went bad"],
];

export function RepurchaseControls({
  itemId,
  match: matchProp,
  quantity,
  onDone,
}: {
  itemId: string;
  /** The match, when the caller already has the full record. The scan inbox
   *  card only has a title (it reads a cached hint off the item), so when this
   *  is absent the component resolves the match itself from the same endpoint
   *  the banner uses. */
  match?: TrackedMatch;
  /** How many this scan is adding. */
  quantity: number;
  onDone?: () => void;
}) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const [context, setContext] = useState<Ctx>("normal");
  const [asking, setAsking] = useState(false);

  // A workspace without the Cadence capability 404s here; `catch` turns that
  // into "no opinion", so the +N button still works and no chips appear.
  const resolved = useQuery({
    queryKey: ["scan-tracked", activeSlug, itemId],
    queryFn: () => api.scanTrackedMatches(activeSlug, itemId),
    enabled: !matchProp && !!itemId,
    staleTime: 60_000,
  });
  const match =
    matchProp ??
    (resolved.data?.barcode_matches ?? []).concat(resolved.data?.name_matches ?? [])[0] ??
    null;

  const cadence = useQuery({
    queryKey: ["cadence-state", activeSlug, match?.kind, match?.id, match?.expired],
    // `expired` is the caller's to supply: the ledger keeps events, not the
    // record's dates. With it, stock that had already gone off is classified as
    // waste outright and the three-way question is never asked.
    queryFn: () =>
      api.cadenceState(activeSlug, match!.kind, match!.id, { expired: !!match!.expired }).catch(() => null),
    enabled: !!match && match.qty != null,
    staleTime: 60_000,
  });
  const cad = cadence.data ?? null;
  /** Ask only when the ledger says stock should still be there. Everything else
   *  (no history, shelf already empty) it settles on its own. */
  const needsAnswer = cad?.repurchase_means === "ask_over_buy";
  /** What the ledger already worked out, when it did not need to ask. Skipping
   *  the question and then filing nothing is worse than asking: `discard` is
   *  precisely the "it went off" answer, and dropping it means food that rotted
   *  is recorded as food that got eaten — the inversion the split exists to
   *  prevent. Only `ask_over_buy` genuinely has no answer yet. */
  const knownResolution: Resolution | undefined =
    cad?.repurchase_means === "discard"
      ? "discarded"
      : cad?.repurchase_means === "consume"
        ? "consumed"
        : undefined;
  const daysLeft = cad?.days_until_runout != null ? Math.round(cad.days_until_runout) : null;

  const attach = useMutation({
    mutationFn: (resolution?: Resolution) =>
      api.scanAttach(activeSlug, itemId, {
        kind: match!.kind,
        entity_id: match!.id,
        instance: match!.instance ?? undefined,
        mode: "add-qty",
        cadence: { context, ...(resolution ? { resolution } : {}) },
      }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
      toast.success(`+${quantity} → ${r.entity_title}${r.new_qty != null ? ` (now ×${r.new_qty})` : ""}`);
      setAsking(false);
      onDone?.();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  if (!match || match.qty == null) return null;
  const busy = attach.isPending;

  return (
    <div className="mt-1.5 w-full" onClick={(e) => e.stopPropagation()}>
      {(cad?.cadence_rate != null || asking) && (
        <div className="mb-1.5">
          <div className="text-[11px] text-muted mb-1">
            {asking ? "Before that - what happened to the ones you had?" : "This buy was"}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {asking
              ? ANSWERS.map(([resolution, label]) => (
                  <button
                    key={resolution}
                    type="button"
                    disabled={busy}
                    onClick={() => attach.mutate(resolution)}
                    className="rounded-full border border-amber-400 dark:border-amber-700 text-amber-800 dark:text-amber-200 hover:bg-amber-100/60 dark:hover:bg-amber-900/30 px-2.5 py-1 text-[11px] font-medium disabled:opacity-50"
                  >
                    {label}
                  </button>
                ))
              : CONTEXTS.map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setContext(value)}
                    aria-pressed={context === value}
                    className={`rounded-full px-2.5 py-1 text-[11px] font-medium border transition ${
                      context === value
                        ? "border-emerald-500 bg-emerald-100/70 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-200"
                        : "border-line dark:border-slate-700 text-muted hover:text-content"
                    }`}
                  >
                    {label}
                  </button>
                ))}
            {asking && (
              <button type="button" onClick={() => setAsking(false)} className="px-2 py-1 text-[11px] text-muted hover:text-content">
                Cancel
              </button>
            )}
          </div>
          {asking && daysLeft != null && (
            <p className="text-[11px] text-muted mt-1.5">
              You bought this before and there should still be about {daysLeft} {daysLeft === 1 ? "day" : "days"} left.
            </p>
          )}
        </div>
      )}
      {!asking && (
        <button
          type="button"
          disabled={busy}
          onClick={() => (needsAnswer ? setAsking(true) : attach.mutate(knownResolution))}
          className="inline-flex items-center gap-1 rounded-full bg-emerald-600 hover:bg-emerald-500 text-white px-2.5 py-1 text-[11px] font-medium disabled:opacity-50"
        >
          <PackagePlus size={12} /> +{quantity} to it
        </button>
      )}
    </div>
  );
}
