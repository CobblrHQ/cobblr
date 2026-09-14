// The series banner over the scan inbox, and the one rule for which series
// an item is in.
//
// A split of two boxed sets from one photo gave the Holiday picture frame
// the group photo's series, "Wicked", and the inbox said "2 items are part
// of the Wicked series" over a Wicked set and a Holiday frame (#3013). The
// split no longer copies the group's series onto a piece that does not name
// it, and the rows already split that way heal (split-series-heal.ts); this
// is the last line: an item whose OWN series or theme field says another
// series is never a member here, whatever its metadata carries, and a
// series the split moved aside (`split_dropped`) is not one.

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Sparkles, X } from "lucide-react";
import { useToast } from "@cobblr/platform-web";
import { api, ApiError, type ScanInboxItem } from "../lib/api";

/** The field names a table gives the series a thing belongs to: the LEGO
 *  bundle's theme, a book table's series, a figure line's franchise. */
const OWN_SERIES_FIELDS = /^(series|theme|franchise|collection|saga|line|universe)$/;

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Two series names for one series: equal once normalised, or one inside
 *  the other ("Wicked" in "Wicked (2024)"). */
export function sameSeries(a: string, b: string): boolean {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  return na === nb || ` ${na} `.includes(` ${nb} `) || ` ${nb} `.includes(` ${na} `);
}

/** What the item's own route says it belongs to: the top candidate's
 *  series-shaped field, when it holds one. Null when no table field says. */
export function ownSeriesOf(it: { suggested_candidates?: Array<{ fields?: Record<string, unknown> }> }): string | null {
  const top = it.suggested_candidates?.[0];
  for (const [k, v] of Object.entries(top?.fields ?? {})) {
    if (!OWN_SERIES_FIELDS.test(k)) continue;
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/** The series this item is in, or null: its metadata's series, unless the
 *  item's own field names another (a contradiction, not a membership). */
export function seriesOf(it: ScanInboxItem): string | null {
  const s = (it.suggested_metadata as { series?: unknown } | null)?.series;
  if (typeof s !== "string" || !s.trim()) return null;
  const own = ownSeriesOf(it);
  if (own && !sameSeries(own, s)) return null;
  return s.trim();
}

/** The creator of a titled work (author/director/artist/…) from the item's
 *  candidate fields — a better subtitle than the publisher for books/media.
 *  Null for a normal product (no creator field), so the brand shows as before. */
export function creatorOf(it: { suggested_candidates?: Array<{ fields?: Record<string, unknown> }> }): string | null {
  const keys = ["author", "director", "artist", "composer", "writer"];
  for (const c of it.suggested_candidates ?? []) {
    for (const k of keys) {
      const v = (c.fields ?? {})[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return null;
}


/** Does this item already carry `tag` in its queued pending_tags? (Stashed by a
 *  prior "Tag series"; applied to the entity at confirm.) The banner keys its
 *  offer off this so it stops re-offering a tag the items already have. */
export function hasPendingTag(it: ScanInboxItem, tag: string): boolean {
  const pt = (it.suggested_metadata as { pending_tags?: unknown } | null)?.pending_tags;
  const want = tag.trim().toLowerCase();
  return Array.isArray(pt) && pt.some((t) => typeof t === "string" && t.trim().toLowerCase() === want);
}
export function SeriesBanner({ slug, items }: { slug: string; items: ScanInboxItem[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  // Series the user has ACCEPTED this session (tapped "Tag series"). We keep
  // auto-applying them to late-arriving members instead of re-surfacing the
  // banner — incremental vision identify means a book can join the group AFTER
  // the tap (that's the "1 of 9 isn't tagged yet" straggler the author hit: they tagged
  // the 8, "The Long Winter" identified two days later and was never swept in).
  // Sticky = tag the straggler and stay quiet.
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  // ids we've already fired an auto-tag for, so a slow refetch can't double-fire.
  const autoTagged = useRef<Set<string>>(new Set());
  const apply = useMutation({
    mutationFn: ({ series, ids }: { series: string; ids: string[]; silent?: boolean }) =>
      api.applyScanTheme(slug, { tag: series, tag_item_ids: ids }),
    onSuccess: (r, v) => {
      // Only toast when the user tapped (a real batch); silent for the sticky
      // auto-tag of a single straggler so it doesn't nag.
      if (!v.silent) toast.success(`Tagged ${r.tagged} as "${v.series}", applied when you confirm each.`);
      void qc.invalidateQueries({ queryKey: ["scan-inbox", slug] });
      // Remember the series so late members auto-tag. NOT `dismissed` — a dismiss
      // would also hide a genuinely-new straggler; accepted keeps sweeping it in.
      setAccepted((a) => new Set([...a, v.series.toLowerCase()]));
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't apply that."),
  });
  // Group pending items by series, splitting members by how confident the match
  // is: `vision` = the item's OWN vision series matches (canonical); `pullIn` =
  // a same-author seriesless book folded in (a weak "probably in the series"
  // guess — only when that author has exactly ONE series here, no ambiguity).
  // The split matters for stickiness: we auto-sweep late VISION members but never
  // a weak pull-in (see the effect below).
  const groups = useMemo(() => {
    const m = new Map<string, { series: string; vision: ScanInboxItem[]; pullIn: ScanInboxItem[] }>();
    for (const it of items) {
      const s = seriesOf(it);
      if (!s) continue;
      const key = s.toLowerCase();
      if (!m.has(key)) m.set(key, { series: s, vision: [], pullIn: [] });
      m.get(key)!.vision.push(it);
    }
    const authorSeries = new Map<string, Set<string>>();
    for (const g of m.values())
      for (const it of g.vision) {
        const a = creatorOf(it)?.toLowerCase();
        if (!a) continue;
        if (!authorSeries.has(a)) authorSeries.set(a, new Set());
        authorSeries.get(a)!.add(g.series.toLowerCase());
      }
    for (const it of items) {
      if (seriesOf(it)) continue; // grouped by its own series already
      const a = creatorOf(it)?.toLowerCase();
      const forAuthor = a ? authorSeries.get(a) : undefined;
      if (!forAuthor || forAuthor.size !== 1) continue; // no / ambiguous series
      const g = m.get([...forAuthor][0]!);
      if (g && !g.vision.some((x) => x.id === it.id) && !g.pullIn.some((x) => x.id === it.id)) g.pullIn.push(it);
    }
    return m;
  }, [items]);

  // Sticky sweep: for every ACCEPTED series, auto-tag any untagged VISION member
  // (its own series matches — confident), catching the late straggler without
  // re-surfacing the banner. Author pull-ins are NEVER auto-tagged (weak guess →
  // still need an explicit tap). The refetch after each tag re-runs this until
  // there's nothing left to sweep.
  useEffect(() => {
    if (apply.isPending) return;
    for (const key of accepted) {
      const g = groups.get(key);
      if (!g) continue;
      const late = g.vision.filter((it) => !hasPendingTag(it, g.series) && !autoTagged.current.has(it.id));
      if (late.length) {
        for (const it of late) autoTagged.current.add(it.id);
        apply.mutate({ series: g.series, ids: late.map((i) => i.id), silent: true });
        return; // one series per pass; the refetch re-triggers for the rest
      }
    }
  }, [groups, accepted, apply]);

  // Banners to SHOW. For an ACCEPTED series the vision members auto-sweep (above),
  // so only surface it if untagged author PULL-INS remain (those need an explicit
  // tap). For a fresh series, offer the whole untagged set as before.
  const offers = useMemo(() => {
    const out: Array<{ series: string; items: ScanInboxItem[]; untagged: ScanInboxItem[] }> = [];
    for (const [key, g] of groups) {
      if (dismissed.has(key)) continue;
      const all = [...g.vision, ...g.pullIn];
      if (all.length < 2) continue;
      const untagged = accepted.has(key)
        ? g.pullIn.filter((it) => !hasPendingTag(it, g.series)) // vision handled by the sweep
        : all.filter((it) => !hasPendingTag(it, g.series));
      if (untagged.length === 0) continue;
      out.push({ series: g.series, items: all, untagged });
    }
    return out;
  }, [groups, dismissed, accepted]);
  if (offers.length === 0) return null;
  return (
    <>
      {offers.map((g) => (
        // ONE line at every width (the owner, #2982): the sentence truncates
        // before the button moves, and the full sentence is the title.
        <div
          key={g.series}
          className="rounded-lg border border-cobble-300 dark:border-cobble-700/60 bg-cobble-50/70 dark:bg-cobble-950/20 px-3 py-2.5 max-sm:px-2.5 max-sm:py-1.5 flex items-center gap-3 max-sm:gap-2"
          title={
            g.untagged.length === g.items.length
              ? `${g.items.length} item${g.items.length === 1 ? " is" : "s are"} part of the "${g.series}" series. Tag them all "${g.series}"?`
              : `${g.untagged.length} of ${g.items.length} "${g.series}" item${g.untagged.length === 1 ? " isn't" : "s aren't"} tagged yet. Tag ${g.untagged.length === 1 ? "it" : "them"}?`
          }
        >
          <Sparkles size={15} className="text-accent shrink-0" />
          <div className="min-w-0 flex-1 truncate text-sm max-sm:text-xs text-content dark:text-mortar-100">
            {g.untagged.length === g.items.length ? (
              <>
                {/* Two whole sentences, one per width, so each reads as one
                    text node (the banner test finds the desktop one by text). */}
                <span className="hidden sm:inline">
                  {g.items.length} item{g.items.length === 1 ? " is" : "s are"} part of the <strong>"{g.series}"</strong> series.
                  <span className="text-muted"> Tag them all "{g.series}"?</span>
                </span>
                <span className="sm:hidden">
                  {g.items.length} in the <strong>"{g.series}"</strong> series.
                </span>
              </>
            ) : (
              <>
                {g.untagged.length} of {g.items.length} <strong>"{g.series}"</strong>{" "}
                {g.untagged.length === 1 ? "item isn't" : "items aren't"} tagged yet.
                <span className="text-muted hidden sm:inline"> Tag {g.untagged.length === 1 ? "it" : "them"}?</span>
              </>
            )}
          </div>
          <button
            type="button"
            disabled={apply.isPending}
            onClick={() => apply.mutate({ series: g.series, ids: g.untagged.map((i) => i.id) })}
            className="shrink-0 rounded bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1.5 max-sm:px-2.5 max-sm:py-1 text-sm max-sm:text-xs font-medium disabled:opacity-50"
          >
            {apply.isPending ? "Tagging…" : <><span className="hidden sm:inline">Tag series</span><span className="sm:hidden">Tag</span></>}
          </button>
          <button type="button" onClick={() => setDismissed((d) => new Set([...d, g.series.toLowerCase()]))} className="shrink-0 text-faint hover:text-content p-1" title="Dismiss">
            <X size={14} />
          </button>
        </div>
      ))}
    </>
  );
}

