// "You already have this" — both renderings of a tracked match, in one file
// so they cannot drift apart:
//
//   TrackedMatchLine    the inbox card's condensed line (card closed)
//   TrackedMatchBanner  the full banner (card open, phone result modal)
//
// Both name the record, say how many and where, offer the three re-buy
// answers (RepurchaseControls) and the two nudges (TrackedMatchNudges). The
// banner adds what the line has no room for: the merge-in preview, Move here,
// Link barcode, Open. The line adds "Compare & merge", which opens the card.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { catalogChosen } from "../lib/scanPhoto";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CheckCircle2, ExternalLink, MapPin, X } from "lucide-react";
import { useToast } from "@cobblr/platform-web";
import { api, ApiError, type ScanInboxItem, type TrackedMatch } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { RepurchaseAnswers, useBestTrackedMatch } from "./RepurchaseControls";
import { TrackedMatchNudges } from "./TrackedMatchNudges";

/** "license_plate" → "License plate" — a friendly label for a raw field key
 *  (no field-def lookup needed for a quick merge preview). */
function humanizeField(key: string): string {
  const s = key.replace(/_/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const pill =
  "inline-flex items-center gap-1 rounded-full border border-emerald-400 dark:border-emerald-700 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100/60 dark:hover:bg-emerald-900/30 px-2.5 py-1 text-xs font-medium disabled:opacity-50";

function MatchTitle({ match, where, title, sameOne }: { match: TrackedMatch | null; where: string | null; title: string; sameOne?: boolean }) {
  return (
    <>
      <span className="font-medium text-content dark:text-mortar-100">
        {sameOne ? "Is this the same one? " : "You already have "}
        <span className="break-words">{title}</span>
        {match?.qty != null && !sameOne && <span className="text-muted"> ×{match.qty}</span>}
      </span>
      {match?.subtitle && <span className="text-muted"> · {match.subtitle}</span>}
      {where && <span className="text-muted"> · 📍{where}</span>}
    </>
  );
}

/** The closed inbox card's line. The row is stamped with the match's title at
 *  match time, so the card can say it without a round trip; the record itself
 *  is fetched for the count, the place, and the buttons. */
export function TrackedMatchLine({
  item,
  fallbackTitle,
  quantity,
  onCompare,
}: {
  item: ScanInboxItem;
  fallbackTitle: string;
  quantity: number;
  onCompare: () => void;
}) {
  const { match, where } = useBestTrackedMatch(item.id);
  return (
    <div className="mt-1.5 space-y-1 text-xs" onClick={(e) => e.stopPropagation()}>
      <div className="flex min-w-0 items-start gap-1.5">
        <CheckCircle2 size={13} className="shrink-0 mt-0.5 text-emerald-600 dark:text-emerald-400" />
        <div className="min-w-0">
          <MatchTitle match={match} where={where} title={match?.title ?? fallbackTitle} />
        </div>
      </div>
      {match && <TrackedMatchNudges item={item} match={match} />}
      <div className="flex flex-wrap items-center gap-1.5">
        {match && <RepurchaseAnswers itemId={item.id} match={match} quantity={quantity} />}
        <button
          type="button"
          onClick={onCompare}
          title="Open the card: see what this scan would fill in, or file it as something new"
          className="inline-flex items-center rounded-full px-2 py-1 text-[11px] text-muted hover:text-content underline decoration-dotted underline-offset-2"
        >
          Compare &amp; merge
        </button>
      </div>
    </div>
  );
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
    mode: "add-qty" | "replace" | "link-barcode" | "move" | "merge-fields",
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
  const all = [...(matches.data?.barcode_matches ?? []), ...(matches.data?.name_matches ?? [])];
  const best = all[0] ?? null;
  const { where } = useBestTrackedMatch(item.id, best);

  const attach = useMutation({
    mutationFn: (vars: { m: TrackedMatch; mode: "link-barcode" | "move" | "merge-fields" }) =>
      api.scanAttach(activeSlug, item.id, {
        kind: vars.m.kind,
        entity_id: vars.m.id,
        instance: vars.m.instance ?? undefined,
        mode: vars.mode,
        ...(vars.mode === "move" && locationId ? { location_id: locationId } : {}),
      }),
    onSuccess: (r, vars) => {
      void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
      toast.success(
        vars.mode === "move"
          ? `Moved ${r.entity_title}${locationName ? ` → ${locationName}` : ""}`
          : vars.mode === "merge-fields"
            ? r.merged_fields.length
              ? `Updated ${r.entity_title}: added ${r.merged_fields.map(humanizeField).join(", ")}`
              : `${r.entity_title} already had everything, nothing to add`
            : `Barcode linked to ${r.entity_title}`,
      );
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

  if (dismissed || !best) return null;
  const exact = best.matched_by === "barcode" || best.matched_by === "identifier";
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
    <div className="rounded-lg border border-emerald-300 dark:border-emerald-700/60 bg-emerald-50/70 dark:bg-emerald-950/20 px-3 py-2.5 space-y-2">
      <div className="flex items-start gap-2">
        <CheckCircle2 size={15} className="text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1 text-sm">
          <MatchTitle match={best} where={where} title={best.title} sameOne={canMerge} />
          <span className="text-[11px] text-faint">
            {" "}
            · {best.matched_by === "identifier" ? `same ${best.matched_label || "identifier"}` : exact ? "same barcode" : "matched by name"}
          </span>
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
        <div className="rounded-md bg-white/60 dark:bg-slate-900/40 border border-emerald-200/70 dark:border-emerald-800/50 px-2.5 py-2">
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
          <p className="text-[11px] text-muted mt-1.5">
            {catalogChosen(item)
              ? "Only fields it's missing are filled, and the picture you picked becomes its photo."
              : "Only fields it's missing are filled - nothing gets overwritten."}
          </p>
        </div>
      )}
      <TrackedMatchNudges item={item} match={best} />
      <div className="flex flex-wrap gap-1.5">
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
            both. */}
        <RepurchaseAnswers
          itemId={item.id}
          match={best}
          quantity={Math.max(1, item.quantity || 1)}
          onDone={(r, m, mode) => onAttached?.(r, m, mode)}
        />
        {locationId && best.location_id !== locationId && (
          <button type="button" disabled={busy} onClick={() => attach.mutate({ m: best, mode: "move" })} className={pill}>
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
            className={pill}
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
