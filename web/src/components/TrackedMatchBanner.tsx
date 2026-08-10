// "✔ Already tracked" — the heads-up. Shown on the phone result
// card and the inbox triage card when a scan matches an entity the workspace
// already has (exact barcode, or name overlap). Offers acting on the EXISTING
// entity instead of creating a duplicate: +N (bump qty, adopt barcode/photo),
// Move here (file it into the active bin), link the barcode, or open it.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CheckCircle2, ExternalLink, MapPin, PackagePlus, X } from "lucide-react";
import { useToast } from "@cobblr/platform-web";
import { api, ApiError, type ScanInboxItem, type TrackedMatch } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";

/** "license_plate" → "License plate" — a friendly label for a raw field key
 *  (no field-def lookup needed for a quick merge preview). */
function humanizeField(key: string): string {
  const s = key.replace(/_/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function TrackedMatchBanner({
  item,
  locationId,
  locationName,
  autoMove,
  onAttached,
}: {
  item: ScanInboxItem;
  /** The active bin / filing location, if any — enables "Move here". */
  locationId?: string | null;
  locationName?: string | null;
  /** Move mode: when the scan finds exactly ONE exact barcode match
   *  and a bin is active, auto-fire the move — no triage stop. */
  autoMove?: boolean;
  /** Called after a successful attach (the inbox item is now resolved). */
  onAttached?: (
    result: { entity_title: string; new_qty: number | null; prev_location_id: string | null },
    match: TrackedMatch,
    mode: "add-qty" | "link-barcode" | "move" | "merge-fields",
  ) => void;
}) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [dismissed, setDismissed] = useState(false);

  const matches = useQuery({
    queryKey: ["scan-tracked", activeSlug, item.id, item.barcode_text, item.suggested_name],
    queryFn: () => api.scanTrackedMatches(activeSlug, item.id),
    enabled: !!item.id && item.status === "pending" && (!!item.barcode_text || !!item.suggested_name),
    staleTime: 60_000,
  });
  // Location names for "· 📍{where it lives}" (each match shows its location).
  const locations = useQuery({
    queryKey: ["core-locations", activeSlug],
    queryFn: () => api.listLocations(activeSlug),
    enabled: !!activeSlug,
    staleTime: 60_000,
  });
  const locName = (id: string | null) =>
    id ? ((locations.data?.items ?? []).find((l) => l.id === id)?.name ?? null) : null;

  // What the ledger makes of a purchase right now. Only asked for the single
  // best match, and only when there is a quantity to add - the other attach
  // modes buy nothing. A workspace without the Cadence capability 404s here,
  // which the `catch` turns into "no opinion", so the banner is unchanged.
  const bestMatch = (matches.data?.barcode_matches ?? []).concat(matches.data?.name_matches ?? [])[0] ?? null;
  const cadence = useQuery({
    queryKey: ["cadence-state", activeSlug, bestMatch?.kind, bestMatch?.id],
    queryFn: () => api.cadenceState(activeSlug, bestMatch!.kind, bestMatch!.id).catch(() => null),
    enabled: !!bestMatch && bestMatch.qty != null,
    staleTime: 60_000,
  });
  const cad = cadence.data ?? null;
  /** Ask only when the ledger says stock should still be there. Everything else
   *  (no history, shelf already empty, past its date) it settles on its own. */
  const needsOverBuyAnswer = cad?.repurchase_means === "ask_over_buy";
  const daysLeft = cad?.days_until_runout != null ? Math.round(cad.days_until_runout) : null;

  // Buying more of something you already have is the moment the ledger learns
  // the most, and the only moment a person can answer what happened to the old
  // stock. Asked here or not at all - nobody revisits it later.
  const [context, setContext] = useState<"normal" | "faster" | "bulk" | "one_off">("normal");
  const [asking, setAsking] = useState(false);

  const attach = useMutation({
    mutationFn: (vars: {
      m: TrackedMatch;
      mode: "add-qty" | "link-barcode" | "move" | "merge-fields";
      resolution?: "over_buy" | "consumed" | "discarded";
    }) =>
      api.scanAttach(activeSlug, item.id, {
        kind: vars.m.kind,
        entity_id: vars.m.id,
        instance: vars.m.instance ?? undefined,
        mode: vars.mode,
        ...(vars.mode === "move" && locationId ? { location_id: locationId } : {}),
        ...(vars.mode === "add-qty"
          ? { cadence: { context, ...(vars.resolution ? { resolution: vars.resolution } : {}) } }
          : {}),
      }),
    onSuccess: (r, vars) => {
      void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
      toast.success(
        vars.mode === "add-qty"
          ? `+${Math.max(1, item.quantity || 1)} → ${r.entity_title}${r.new_qty != null ? ` (now ×${r.new_qty})` : ""}`
          : vars.mode === "move"
            ? `Moved ${r.entity_title}${locationName ? ` → ${locationName}` : ""}`
            : vars.mode === "merge-fields"
              ? r.merged_fields.length
                ? `Updated ${r.entity_title} — added ${r.merged_fields.map(humanizeField).join(", ")}`
                : `${r.entity_title} already had everything — nothing to add`
              : `Barcode linked to ${r.entity_title}`,
      );
      setAsking(false);
      onAttached?.(r, vars.m, vars.mode);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  // Move mode: exactly one EXACT barcode match + an active bin → move it,
  // hands-free. Fires at most once per card; ambiguity (0 or 2+) falls back
  // to the normal banner so the human decides. Already in the bin → nothing
  // to move (only offers the move when the match is NOT in the bin).
  const autoFired = useRef(false);
  const barcodeMatches = matches.data?.barcode_matches ?? [];
  useEffect(() => {
    if (!autoMove || autoFired.current || !locationId || !matches.isFetched) return;
    if (barcodeMatches.length === 1 && barcodeMatches[0]!.location_id !== locationId) {
      autoFired.current = true;
      attach.mutate({ m: barcodeMatches[0]!, mode: "move" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoMove, locationId, matches.isFetched, barcodeMatches.length]);

  const all = [
    ...(matches.data?.barcode_matches ?? []),
    ...(matches.data?.name_matches ?? []),
  ];
  const best = all[0];
  if (dismissed || !best) return null;
  const exact = best.matched_by === "barcode";
  const busy = attach.isPending;

  // "Same one — fill it in": the fields THIS scan learned that could enrich the
  // matched entity (a plate photo's plate/color for a car the VIN scan made).
  // From the matchmaker candidate for the matched instance; the server writes
  // only the ones the entity is still missing. Offered on a NAME match (a
  // unique thing you recognised), where "+1 to it" would wrongly duplicate.
  const mergeCand = (item.suggested_candidates ?? []).find(
    (c) =>
      (c.instance ?? null) === (best.instance ?? null) &&
      c.fields &&
      Object.keys(c.fields).length > 0,
  );
  const mergeEntries = mergeCand
    ? Object.entries(mergeCand.fields).filter(([, v]) => v !== "" && v != null)
    : [];
  const canMerge = best.matched_by === "name" && mergeEntries.length > 0;

  return (
    <div className="rounded-lg border border-emerald-300 dark:border-emerald-700/60 bg-emerald-50/70 dark:bg-emerald-950/20 px-3 py-2.5">
      <div className="flex items-start gap-2">
        <CheckCircle2 size={15} className="text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1 text-sm">
          <span className="font-medium text-content dark:text-mortar-100">
            {canMerge ? (
              <>Is this the same one? - {best.title}</>
            ) : (
              <>Already tracked{exact ? "" : " (name match)"} — {best.title}</>
            )}
            {best.qty != null && !canMerge && <span className="text-muted"> ×{best.qty}</span>}
          </span>
          {best.subtitle && <span className="text-muted"> · {best.subtitle}</span>}
          {locName(best.location_id) && (
            <span className="text-muted"> · 📍{locName(best.location_id)}</span>
          )}
        </div>
        <button
          type="button"
          title="Not the same - keep this as a new item"
          onClick={() => setDismissed(true)}
          className="shrink-0 text-faint hover:text-muted p-1"
        >
          <X size={15} />
        </button>
      </div>
      {canMerge && (
        <div className="mt-2 rounded-md bg-white/60 dark:bg-slate-900/40 border border-emerald-200/70 dark:border-emerald-800/50 px-2.5 py-2">
          <div className="text-[11px] font-mono uppercase tracking-widest text-emerald-700 dark:text-emerald-300 mb-1">
            merge in
          </div>
          <dl className="text-xs space-y-0.5">
            {mergeEntries.map(([k, v]) => (
              <div key={k} className="flex gap-2">
                <dt className="text-muted min-w-[92px]">{humanizeField(k)}</dt>
                <dd className="text-content dark:text-mortar-100 font-medium min-w-0 break-words">{String(v)}</dd>
              </div>
            ))}
          </dl>
          <p className="text-[11px] text-muted mt-1.5">Only fields it's missing are filled - nothing gets overwritten.</p>
        </div>
      )}
      {best.qty != null && (cad?.cadence_rate != null || asking) && (
        <div className="mt-2">
          <div className="text-[11px] text-muted mb-1">
            {asking ? "Before that - what happened to the ones you had?" : "This buy was"}
          </div>
          {asking ? (
            <div className="flex flex-wrap gap-1.5">
              {/* Three answers, three different lessons. Recording waste as
                  consumption would raise the rate and recommend buying MORE of
                  what keeps getting binned, so the split is not cosmetic. */}
              {(
                [
                  ["over_buy", "Still have them"],
                  ["consumed", "Gone - used them faster"],
                  ["discarded", "They went bad"],
                ] as const
              ).map(([resolution, label]) => (
                <button
                  key={resolution}
                  type="button"
                  disabled={busy}
                  onClick={() => attach.mutate({ m: best, mode: "add-qty", resolution })}
                  className="rounded-full border border-amber-400 dark:border-amber-700 text-amber-800 dark:text-amber-200 hover:bg-amber-100/60 dark:hover:bg-amber-900/30 px-2.5 py-1 text-xs font-medium disabled:opacity-50"
                >
                  {label}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setAsking(false)}
                className="px-2 py-1 text-xs text-muted hover:text-content"
              >
                Cancel
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {/* Normal is the default and stays selected unless you say
                  otherwise: a stock-up or a party must not train the rate as
                  though it were an ordinary week. */}
              {(
                [
                  ["normal", "as usual"],
                  ["one_off", "a one-off"],
                  ["bulk", "a stock-up"],
                  ["faster", "going quicker lately"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setContext(value)}
                  aria-pressed={context === value}
                  className={`rounded-full px-2.5 py-1 text-xs font-medium border transition ${
                    context === value
                      ? "border-emerald-500 bg-emerald-100/70 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-200"
                      : "border-line dark:border-slate-700 text-muted hover:text-content"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          {asking && daysLeft != null && (
            <p className="text-[11px] text-muted mt-1.5">
              You bought this before and there should still be about {daysLeft} {daysLeft === 1 ? "day" : "days"} left.
            </p>
          )}
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {canMerge && (
          <button
            type="button"
            disabled={busy}
            onClick={() => attach.mutate({ m: best, mode: "merge-fields" })}
            className="inline-flex items-center gap-1 rounded-full bg-emerald-600 hover:bg-emerald-700 text-white px-2.5 py-1 text-xs font-medium disabled:opacity-50"
          >
            <CheckCircle2 size={12} /> Yes - merge these in
          </button>
        )}
        {/* Not suppressed by a mergeable scan. Buying MORE of something and
            filling in what a scan learned are different answers to different
            questions, and a barcode re-scan of a tracked item usually offers
            both. Hiding +N behind merge meant the over-buy prompt never
            appeared in the one situation it exists for. */}
        {best.qty != null && (
          <button
            type="button"
            disabled={busy}
            onClick={() => (needsOverBuyAnswer ? setAsking(true) : attach.mutate({ m: best, mode: "add-qty" }))}
            className="inline-flex items-center gap-1 rounded-full bg-emerald-600 hover:bg-emerald-700 text-white px-2.5 py-1 text-xs font-medium disabled:opacity-50"
          >
            <PackagePlus size={12} /> +{Math.max(1, item.quantity || 1)} to it
          </button>
        )}
        {locationId && best.location_id !== locationId && (
          <button
            type="button"
            disabled={busy}
            onClick={() => attach.mutate({ m: best, mode: "move" })}
            className="inline-flex items-center gap-1 rounded-full border border-emerald-400 dark:border-emerald-700 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100/60 dark:hover:bg-emerald-900/30 px-2.5 py-1 text-xs font-medium disabled:opacity-50"
          >
            <MapPin size={12} /> Move here
          </button>
        )}
        {locationId && best.location_id === locationId && (
          <span className="inline-flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-300 self-center">
            <MapPin size={12} /> already here
          </span>
        )}
        {item.barcode_text && best.matched_by === "name" && (
          <button
            type="button"
            disabled={busy}
            title="Teach this entity its barcode - the next scan matches instantly"
            onClick={() => attach.mutate({ m: best, mode: "link-barcode" })}
            className="inline-flex items-center gap-1 rounded-full border border-emerald-400 dark:border-emerald-700 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100/60 dark:hover:bg-emerald-900/30 px-2.5 py-1 text-xs font-medium disabled:opacity-50"
          >
            Link barcode
          </button>
        )}
        {best.detail_url && (
          <button
            type="button"
            onClick={() => navigate(best.detail_url!)}
            className="inline-flex items-center gap-1 rounded-full text-muted hover:text-content px-2 py-1 text-xs"
          >
            Open <ExternalLink size={11} />
          </button>
        )}
        {all.length > 1 && (
          <span className="text-[11px] text-faint self-center">+{all.length - 1} more match{all.length > 2 ? "es" : ""}</span>
        )}
      </div>
    </div>
  );
}
