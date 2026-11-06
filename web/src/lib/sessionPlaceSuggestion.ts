// Where a scan session's items belong, as the picker's first answer (#3902).
//
// Each row already carries the server's suggestion (core-scan
// suggest-location.ts: where the same collection's records live, found with
// no AI) and why, in `suggested_location_note` ("Printer Room — where your
// other 3D Printers are"). The session picker never showed it, so the card's
// highlighted Location button promised a suggestion and the picker opened on
// a wall of rooms. The session's answer is the one most of its waiting rows
// agree on.

import type { ScanInboxItem } from "./api";

export interface PlaceSuggestion {
  id: string;
  /** Why, in the words the server gave: "where your other 3D Printers are". */
  reason: string | null;
}

type Row = Pick<ScanInboxItem, "status" | "target_location_id" | "suggested_location_id" | "suggested_location_note">;

/** The reason half of a note "<place> — <reason>" (or with a plain dash). */
export function reasonOf(note: string | null | undefined): string | null {
  if (!note) return null;
  const m = note.match(/\s[–—-]\s(.+)$/);
  return m ? m[1]!.trim() : null;
}

/** A row's suggested place, with why, or null. A place the system offers
 *  with no reason recorded is not shown and not used: a person cannot judge
 *  a bare "suggested", and it reads as a guess or a leftover (#4933). */
export function suggestedPlace(r: { suggested_location_id?: string | null; suggested_location_note?: string | null }): { id: string; place: string; why: string } | null {
  if (!r.suggested_location_id) return null;
  const why = reasonOf(r.suggested_location_note);
  if (!why) return null;
  return { id: r.suggested_location_id, place: placeOf(r.suggested_location_note) ?? "", why };
}

/** The place most of the session's unplaced waiting rows are suggested,
 *  or null when none is. Pure. */
export function sessionPlaceSuggestion(rows: readonly Row[]): PlaceSuggestion | null {
  const votes = new Map<string, { n: number; reason: string | null }>();
  for (const r of rows) {
    const s = suggestedPlace(r);
    if (r.status !== "pending" || r.target_location_id || !s) continue;
    const v = votes.get(s.id) ?? { n: 0, reason: s.why };
    v.n++;
    votes.set(s.id, v);
  }
  let best: [string, { n: number; reason: string | null }] | null = null;
  for (const e of votes) if (!best || e[1].n > best[1].n) best = e;
  return best ? { id: best[0], reason: best[1].reason } : null;
}

/** The place half of a note "<place> — <reason>". */
export function placeOf(note: string | null | undefined): string | null {
  if (!note) return null;
  const m = note.match(/^(.+?)\s[–—-]\s/);
  return (m ? m[1]! : note).trim() || null;
}

/** The distinct places a session's unplaced rows are suggested, as the person
 *  reads them. A count in the header expands to this (#4582). Pure. */
export function suggestedPlaceNames(rows: readonly Row[]): string[] {
  return [...new Set(suggestedPlaces(rows).map((p) => p.place))];
}

/** The distinct places a session's unplaced rows are suggested, each with
 *  why. Pure. */
export function suggestedPlaces(rows: readonly Row[]): Array<{ place: string; why: string }> {
  const out = new Map<string, { place: string; why: string }>();
  for (const r of rows) {
    const s = r.target_location_id ? null : suggestedPlace(r);
    if (s && !out.has(s.id)) out.set(s.id, { place: s.place, why: s.why });
  }
  return [...out.values()];
}

/** The one place more than half of the session's suggested rows go, with how
 *  many go elsewhere: the session says it once and only those read their own
 *  (#9269). Null when no place has the majority. Pure. */
export function sessionMostPlace(rows: readonly Row[]): { place: string; why: string; elsewhere: number } | null {
  const votes = new Map<string, { place: string; why: string; n: number }>();
  let total = 0;
  for (const r of rows) {
    const s = r.target_location_id ? null : suggestedPlace(r);
    if (!s) continue;
    total++;
    const v = votes.get(s.id) ?? { place: s.place, why: s.why, n: 0 };
    v.n++;
    votes.set(s.id, v);
  }
  for (const v of votes.values()) if (v.n * 2 > total) return { place: v.place, why: v.why, elsewhere: total - v.n };
  return null;
}

/** Reasons that more than one of the session's rows would each repeat. Pure. */
export function sessionSharedWhy(rows: readonly Row[]): Set<string> {
  const seen = new Set<string>(), twice = new Set<string>();
  for (const r of rows) {
    const s = r.target_location_id ? null : suggestedPlace(r);
    if (!s) continue;
    if (seen.has(s.why)) twice.add(s.why);
    seen.add(s.why);
  }
  return twice;
}

/** The place the session's filing line names ("Add 1 to Spices, in Kitchen ›
 *  Spice rack"): the one the session is set to, else the suggestion filing will
 *  use, said as a suggestion. Null when there is nothing to name (#4582). */
export function placeForFilingLine(
  setPlace: string | null,
  suggested: ReadonlyArray<{ place: string; why: string }>,
  most?: { place: string; why: string; elsewhere: number } | null,
): string | null {
  if (setPlace) return setPlace;
  if (suggested.length === 1) return `${suggested[0]!.place} (${suggested[0]!.why})`;
  if (most) return `${most.place} (${most.why}), ${most.elsewhere} elsewhere`;
  if (suggested.length > 1) return `${suggested.length} places, each item's own`;
  return null;
}
