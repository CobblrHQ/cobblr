// "You already have this" — both renderings of a tracked match, in one file
// so they cannot drift apart:
//
//   TrackedMatchLine    the inbox card's condensed line (card closed)
//   TrackedMatchBanner  the full banner (card open, phone result modal)
//
// Both name the record once (its picture, how many, where), carry the ONE
// count control (ScanCountBlock: Change by / Set total) and the nudges
// (TrackedMatchNudges). The banner adds what the line has no room for: the
// merge-in preview, Move here, Link barcode, Open. The line adds "Compare &
// merge", which opens the card.
//
// It used to say "you already have this, add to it" four ways on one card: the
// line, three re-buy buttons, the card's own "+1 more" and a destination
// picker naming the same record (#3884). One line, one control.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { catalogChosen } from "../lib/scanPhoto";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CheckCircle2, HelpCircle, ExternalLink, MapPin, X } from "lucide-react";
import { rovingRadio, useToast } from "@cobblr/platform-web";
import { api, ApiError, type ScanInboxItem, type TrackedMatch } from "../lib/api";
import { useTrackedMatchList } from "../lib/useTrackedMatchList";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { useBestTrackedMatch } from "./RepurchaseControls";
import { useMatchAmount } from "../lib/useMatchAmount";
import { ScanCountBlock } from "./ScanCountBlock";
import { AddPlaceBlock } from "./AddPlaceBlock";

/** The thing this scan matched, when the scan is at a place it is not kept
 *  yet: filing adds the place, and the count control would add to another. */
function newPlaceOf(item: Parameters<typeof scanRowState>[0]) {
  const m = scanRowState(item).merge;
  return m?.new_place ? m : null;
}
import { scanAddCount, type ScanCountMode, type ScanCountSessionMode } from "@cobblr/platform-contract/scan-count";
import { EntityThumb } from "@cobblr/platform-web";
import { useHandheld } from "../lib/useHandheld";
import { TrackedMatchNudges } from "./TrackedMatchNudges";
import { PaperworkThisOne, isPaperworkMatch } from "./PaperworkThisOne";
import { scanPurpose, scanPurposeReview, scanRowState, scanTrackedMatch } from "@cobblr/platform-contract/scan-triage";
import { evidencedFill } from "@cobblr/platform-contract/scan-evidence";
import { scanInboxKeys } from "../lib/scan-inbox-keys";

import { countOf } from "@cobblr/platform-contract/plural";
import { fieldKindOf } from "@cobblr/platform-contract/kind-label";
import { useKindLabels } from "../lib/useKindLabels";
/** "license_plate" → "License plate" — a friendly label for a raw field key
 *  (no field-def lookup needed for a quick merge preview). */
function humanizeField(key: string): string {
  const s = key.replace(/_/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const pill =
  "inline-flex items-center gap-1 rounded-full border border-emerald-400 dark:border-emerald-700 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100/60 dark:hover:bg-emerald-900/30 px-2.5 py-1 text-xs font-medium disabled:opacity-50";

function MatchTitle({ match, where, title, sameOne }: { match: TrackedMatch | null; where: string | null; title: string; sameOne?: boolean }) {
  const { held } = useMatchAmount(match?.unit);
  return (
    <>
      <span className="font-medium text-content dark:text-mortar-100">
        {sameOne ? "Is this the same one? " : "You already have "}
        <span className="break-words">{title}</span>
        {match?.qty != null && !sameOne && <span className="text-muted"> {held(match.qty)}</span>}
      </span>
      {match?.subtitle && <span className="text-muted"> · {match.subtitle}</span>}
      {where && <span className="text-muted"> · 📍{where}</span>}
    </>
  );
}

/** One candidate's amount in the "which one" list, in its own unit. */
function HeldAmount({ qty, unit }: { qty: number; unit?: string | null }) {
  const { held } = useMatchAmount(unit);
  return <span className="shrink-0 opacity-75">{held(qty)}</span>;
}

/** The closed inbox card's line. The row is stamped with the match's title at
 *  match time, so the card can say it without a round trip; the record itself
 *  is fetched for the count, the place, and the buttons. */
export function TrackedMatchLine({
  item,
  fallbackTitle,
  stamped,
  onCompare,
}: {
  item: ScanInboxItem;
  fallbackTitle: string;
  /** The match as the row was stamped with it. The card decides from this
   *  that the count files the scan, so the count must show even while the
   *  live lookup is loading or came back empty: otherwise the card offers
   *  nothing to press. */
  stamped?: TrackedMatch | null;
  onCompare: () => void;
}) {
  const { match, where } = useBestTrackedMatch(item.id);
  const counted = match && match.qty != null ? match : (stamped ?? null);
  // Whether this match is affirmed or a proposal is the row's resolved
  // state (scanRowState): a match on a record the workspace COUNTS is a
  // re-purchase, "+1 more" on the button, so the line affirms it; a match
  // on one unique thing (two records may or may not be one printer, and
  // the screenshot alone cannot say, #3009) is a "Possible match" in the
  // asking colour that leads with Compare and holds back the answers that
  // assume it IS the same thing for the open card, where the comparison is.
  const by = match?.matched_by ?? scanTrackedMatch(item)?.matched_by ?? null;
  const exact = by === "barcode" || by === "identifier";
  const purpose = scanPurpose(item);
  const inventoryCheck = purpose !== "arrival";
  const possible = !inventoryCheck && !scanRowState(item).merge;
  return (
    <div className="mt-1.5 space-y-1.5 text-xs" onClick={(e) => e.stopPropagation()} data-match={possible ? "possible" : "exact"}>
      <div className="flex min-w-0 items-start gap-1.5">
        {match?.image_path ? (
          <EntityThumb src={match.image_path} alt={match.title} size={28} className="shrink-0" />
        ) : possible ? (
          <HelpCircle size={13} className="shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
        ) : (
          <CheckCircle2 size={13} className="shrink-0 mt-0.5 text-emerald-600 dark:text-emerald-400" />
        )}
        <div className="min-w-0">
          {possible ? (
            <>
              <span className="font-medium text-content dark:text-mortar-100">
                Possible match: <span className="break-words">{match?.title ?? fallbackTitle}</span>
              </span>
              {match?.subtitle && <span className="text-muted"> · {match.subtitle}</span>}
              {where && <span className="text-muted"> · 📍{where}</span>}
              <span className="text-[11px] text-faint"> · matched by name</span>
            </>
          ) : (
            <>
              <MatchTitle match={match} where={where} title={match?.title ?? fallbackTitle} />
              {/* A vehicle found by name while its VIN did not read is a question
                  only, and says so (#5921). */}
              <span className={`text-[11px] ${(match as { confirm?: string | null } | null)?.confirm ? "text-amber-700 dark:text-amber-300" : "text-faint"}`} data-match-confirm={(match as { confirm?: string | null } | null)?.confirm ? "" : undefined}> · {(match as { confirm?: string | null } | null)?.confirm ?? (by === "identifier" ? `same ${match?.matched_label || "identifier"}` : exact ? "same barcode" : "matched by name")}</span>
            </>
          )}
        </div>
      </div>
      {match && !possible && <TrackedMatchNudges item={item} match={match} />}
      {match && isPaperworkMatch(item, match) ? (
        <PaperworkThisOne item={item} match={match} />
      ) : counted && !possible && newPlaceOf(item) ? (
        // The card's own button says "Add as another place"; a count here
        // would add to the place it is kept already.
        null
      ) : (
        counted && !possible && (purpose === "arrival" || purpose === "count") && <ScanCountBlock itemId={item.id} match={counted} where={where} scanned={scanAddCount(item.quantity)} initialMode={purpose === "count" ? "set" : "change"} confirmsCount={purpose === "count"} />
      )}
      {inventoryCheck && <p role="status">{scanPurposeReview(item)}</p>}
      <div className="flex flex-wrap items-center gap-1.5">
        {possible ? (
          <button
            type="button"
            onClick={onCompare}
            title="Open the card and see the two side by side: what this scan would fill in, or file it as something new. Nothing is combined until you say so."
            className="inline-flex items-center rounded-full border border-amber-400/70 dark:border-amber-700 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-900/30"
          >
            Compare
          </button>
        ) : (
          <button
            type="button"
            onClick={onCompare}
            title="Open the card: see what this scan would fill in, or file it as something new"
            className="inline-flex items-center rounded-full px-2 py-1 text-[11px] text-muted hover:text-content underline decoration-dotted underline-offset-2"
          >
            Compare &amp; merge, or a different one
          </button>
        )}
      </div>
    </div>
  );
}

export function TrackedMatchBanner({
  item,
  locationId,
  locationName,
  autoMove,
  countMode = "change",
  sessionMode,
  stamped,
  onAttached,
}: {
  item: ScanInboxItem;
  /** The active bin / filing location, if any — enables "Move here". */
  locationId?: string | null;
  locationName?: string | null;
  /** Move mode: when the scan finds exactly ONE exact barcode match
   *  and a bin is active, auto-fire the move — no triage stop. */
  autoMove?: boolean;
  /** The camera's Count mode opens the count in Set total (a stocktake);
   *  everywhere else a scan starts in Change by. */
  countMode?: ScanCountMode;
  sessionMode?: ScanCountSessionMode;
  /** The match the row was stamped with, used while the live lookup has
   *  nothing: the card hides its own "+1 more" when the count files the scan,
   *  so the count must be here whatever the lookup answered. */
  stamped?: TrackedMatch | null;
  /** Called after a successful attach (the inbox item is now resolved). */
  onAttached?: (
    result: { entity_title: string; new_qty: number | null; prev_location_id: string | null },
    match: TrackedMatch,
    mode: "add-qty" | "replace" | "link-barcode" | "move" | "merge-fields" | "count",
  ) => void;
}) {
  const purpose = scanPurpose(item);
  const { activeSlug } = useActiveOrg();
  const kindLabels = useKindLabels(activeSlug);
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const handheld = useHandheld();
  const [dismissed, setDismissed] = useState(false);

  const { matches, all } = useTrackedMatchList(item);
  // Several records could be this one: the person picks which, here, rather
  // than a second panel telling them to "open it to pick" (#3884). One thing
  // kept in several places is one record to pick, never one per place.
  const cards = all.filter((m, i) => all.findIndex((o) => (o.card_id ?? o.id) === (m.card_id ?? m.id)) === i);
  const [pickedCard, setPicked] = useState(0);
  const chosen = cards[pickedCard] ?? cards[0] ?? stamped ?? null;
  // One thing kept in several places: which place this scan goes to is the
  // one question left. The pick is stored on the row (a reload never asks
  // twice); the place being worked in answers it too. Adding goes to that
  // place, never to whichever record the matcher listed first. The places
  // are the top match's, so they ask only while that is the one chosen.
  const places = matches.data?.places ?? [];
  const top = all[0];
  const several = places.length > 1 && !!chosen && !!top && (chosen.card_id ?? chosen.id) === (top.card_id ?? top.id);
  const pickedId = matches.data?.place_choice ?? (locationId ? places.find((p) => p.location_id === locationId)?.id : undefined) ?? null;
  const picked = several ? places.find((p) => p.id === pickedId) ?? null : null;
  const best: TrackedMatch | null =
    chosen && picked ? { ...chosen, id: picked.id, location_id: picked.location_id, qty: picked.qty ?? chosen.qty } : chosen;
  const { where } = useBestTrackedMatch(item.id, best);
  const pickPlace = useMutation({
    mutationFn: (recordId: string) => api.scanPickPlace(activeSlug, item.id, recordId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["scan-tracked", activeSlug, item.id] });
      void qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  // "Not the same" is kept on the row, so the pill, +1 more and File all
  // stop treating the scan as this record everywhere, not only here (#3707).
  const keepSeparate = useMutation({
    mutationFn: () => api.updateScanItem(activeSlug, item.id, { keep_separate: true }),
    onMutate: () => setDismissed(true),
    onSuccess: () => void qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) }),
    onError: (e) => {
      setDismissed(false);
      toast.error(e instanceof ApiError ? e.message : String(e));
    },
  });

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
      void qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) });
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
    if (purpose === "count" || !autoMove || autoFired.current || !locationId || !matches.isFetched) return;
    if (barcodeMatches.length === 1 && barcodeMatches[0]!.location_id !== locationId) {
      autoFired.current = true;
      attach.mutate({ m: barcodeMatches[0]!, mode: "move" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [purpose, autoMove, locationId, matches.isFetched, barcodeMatches.length]);

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
  // What the server will write, by the rule it writes by (scan-evidence.ts,
  // evidencedFill): an identifier the item gives no evidence for is never
  // offered as a fill, and the preview says it was left out (#3647).
  const mergeFill = mergeCand
    ? evidencedFill(item, Object.fromEntries(Object.entries(mergeCand.fields).filter(([, v]) => v !== "" && v != null)))
    : { fill: {}, held: [] as string[] };
  const mergeEntries = Object.entries(mergeFill.fill);
  const mergeHeld = mergeFill.held.map((k) => [k, mergeCand?.fields?.[k]] as const);
  // Paperwork goes through its own door (every field by meaning, the
  // purchase linked); the generic merge would fill a fraction of it (#4633).
  const canMerge = best.matched_by === "name" && mergeEntries.length > 0 && !isPaperworkMatch(item, best);

  // On a phone the card must not grow (#3339): the "same barcode" tag that
  // wrapped alone onto its own line rides in the tick's label instead, Open
  // flows at the end of the heading's own text rather than on a line of its
  // own (in the header it narrowed the heading and cost a wrap instead), and
  // the three answers stack at one size in the room those two lines gave back.
  const matchedHow = best.matched_by === "identifier" ? `same ${best.matched_label || "identifier"}` : exact ? "same barcode" : "matched by name";
  return (
    <div className="rounded-lg border border-emerald-300 dark:border-emerald-700/60 bg-emerald-50/70 dark:bg-emerald-950/20 px-3 py-2.5 space-y-2">
      <div className="flex items-start gap-2">
        <CheckCircle2 size={15} className="text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" aria-label={matchedHow} role="img" />
        <div className="min-w-0 flex-1 text-sm">
          <MatchTitle match={best} where={where} title={best.title} sameOne={canMerge} />
          {!handheld && (
            <span className="text-[11px] text-faint">
              {" "}
              · {matchedHow}
            </span>
          )}
          {handheld && best.detail_url && (
            <>
              <span className="text-muted"> · </span>
              <button
                type="button"
                title="Open the record"
                onClick={() => navigate(best.detail_url!)}
                className="inline-flex items-center gap-0.5 align-baseline text-xs text-muted underline decoration-dotted underline-offset-2 hover:text-content"
              >
                Open <ExternalLink size={11} />
              </button>
            </>
          )}
        </div>
        <button
          aria-label="Not the same - keep this as a new item"
          type="button"
          title="Not the same - keep this as a new item"
          onClick={() => keepSeparate.mutate()}
          className="shrink-0 text-faint hover:text-muted p-1"
        >
          <X size={15} />
        </button>
      </div>
      {cards.length > 1 && (
        <div data-testid="match-pick" className="space-y-1">
          <div className="text-xs text-content dark:text-mortar-100">
            This could be any of {countOf(cards.length, "thing")} you have. Which is it?
          </div>
          <div role="radiogroup" aria-label="Which one this is" className="flex flex-wrap gap-1.5">
            {cards.map((m, i) => (
              <button
                key={`${m.kind}:${m.id}`}
                type="button"
                {...rovingRadio(i, chosen ? cards.indexOf(chosen) : -1)}
                role="radio"
                aria-checked={m === chosen}
                onClick={() => setPicked(i)}
                className={`inline-flex max-w-full min-h-11 items-center gap-1 rounded-full border px-2.5 py-1 text-xs ${
                  m === chosen
                    ? "border-emerald-600 bg-emerald-600 text-white"
                    : "border-emerald-300 dark:border-emerald-700 text-emerald-800 dark:text-emerald-200 hover:bg-emerald-100/60 dark:hover:bg-emerald-900/30"
                }`}
              >
                <span className="min-w-0 break-words">{m.title}</span>
                <span className="shrink-0 opacity-75">· {kindLabels.noun(fieldKindOf(m))}</span>
                {m.subtitle && <span className="shrink-0 opacity-75">· {m.subtitle}</span>}
                {m.qty != null && <HeldAmount qty={m.qty} unit={m.unit} />}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => keepSeparate.mutate()}
            disabled={keepSeparate.isPending}
            className="text-xs text-muted underline decoration-dotted underline-offset-2 min-h-11"
          >
            None of these - keep as a new item
          </button>
        </div>
      )}
      {canMerge && (
        // Folded: the question, the record and the answers are what a person
        // reads; which fields a fill would write is one tap away (the owner,
        // 2026-09-24: "a wealth of info here (possibly even too much)").
        <details data-testid="merge-in" className="rounded-md bg-white/60 dark:bg-slate-900/40 border border-emerald-200/70 dark:border-emerald-800/50 px-2.5 py-2">
          <summary className="cursor-pointer text-[11px] text-emerald-700 dark:text-emerald-300">What gets filled in</summary>
          <div className="text-[11px] font-mono uppercase tracking-widest text-emerald-700 dark:text-emerald-300 mb-1 mt-1">
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
          {mergeHeld.length > 0 && (
            <p data-testid="merge-held" className="text-[11px] text-amber-700 dark:text-amber-400 mt-1">
              Not filled in: {mergeHeld.map(([k, v]) => `${humanizeField(k)} ${String(v)}`).join(", ")}. Nothing on the item shows {mergeHeld.length === 1 ? "it" : "them"}; type it on the record if it is right.
            </p>
          )}
          <p className="text-[11px] text-muted mt-1.5">
            {/* This is the one offer that changes a record you own (#3009):
                say which, what it writes, and what becomes of this row. */}
            {catalogChosen(item)
              ? `Writes these onto ${best.title}, only where it is empty, and the picture you picked becomes its photo; this row is then filed as that record.`
              : `Writes these onto ${best.title}, only where it is empty; nothing there is overwritten, and this row is then filed as that record.`}
          </p>
        </details>
      )}
      {several && (
        <div data-testid="which-place">
          <div className="text-[11px] text-muted mb-1">
            {picked ? "Adds to" : `You keep this in ${countOf(places.length, "place")}. Which one is this?`}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {places.map((p) => (
              <button
                key={p.id}
                type="button"
                aria-pressed={picked?.id === p.id}
                disabled={pickPlace.isPending}
                onClick={() => pickPlace.mutate(p.id)}
                className={
                  "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs border transition " +
                  (picked?.id === p.id
                    ? "bg-emerald-600 border-emerald-600 text-white"
                    : "border-emerald-300 dark:border-emerald-700 text-content dark:text-mortar-100 hover:bg-white/70 dark:hover:bg-slate-900/40")
                }
              >
                <MapPin size={11} /> {p.location_name ?? "No place set"}
                {p.qty != null ? <span className="opacity-80"> · {p.qty}</span> : null}
              </button>
            ))}
          </div>
        </div>
      )}
      <TrackedMatchNudges item={item} match={best} />
      {isPaperworkMatch(item, best) && <PaperworkThisOne item={item} match={best} />}
      {/* Counting into one of several places waits for the place. */}
      {best.qty != null && newPlaceOf(item) && !isPaperworkMatch(item, best) && (
        <AddPlaceBlock
          itemId={item.id}
          merge={newPlaceOf(item)!}
          sentence={scanRowState(item).sentence}
          scanned={Math.max(1, item.quantity || 1)}
        />
      )}
      {best.qty != null && (purpose === "arrival" || purpose === "count") && (!several || picked) && !isPaperworkMatch(item, best) && !newPlaceOf(item) && (
        <ScanCountBlock
          itemId={item.id}
          match={best}
          scanned={scanAddCount(item.quantity)}
          where={where}
          initialMode={purpose === "count" ? "set" : countMode}
          confirmsCount={purpose === "count"}
          sessionMode={sessionMode}
          onDone={(r, m) => onAttached?.(r, m, "count")}
        />
      )}
      <div className="flex flex-wrap gap-1.5">
        {canMerge && (
          <button
            type="button"
            disabled={busy}
            onClick={() => attach.mutate({ m: best, mode: "merge-fields" })}
            title={`Writes the fields above onto ${best.title}, the record you already have, only where it is empty; this row is then filed as that record.`}
            className="inline-flex items-center gap-1 rounded-full bg-emerald-600 hover:bg-emerald-700 text-white px-2.5 py-1 text-xs font-medium disabled:opacity-50"
          >
            <CheckCircle2 size={12} /> Yes, fill it in from this scan
          </button>
        )}
        {locationId && !several && best.location_id !== locationId && (
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
        {!handheld && best.detail_url && (
          <button
            type="button"
            onClick={() => navigate(best.detail_url!)}
            className="inline-flex items-center gap-1 rounded-full text-muted hover:text-content px-2 py-1 text-xs"
          >
            Open <ExternalLink size={11} />
          </button>
        )}

      </div>
    </div>
  );
}
