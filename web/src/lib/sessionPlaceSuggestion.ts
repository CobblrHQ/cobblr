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

/** The place most of the session's unplaced waiting rows are suggested,
 *  or null when none is. Pure. */
export function sessionPlaceSuggestion(rows: readonly Row[]): PlaceSuggestion | null {
  const votes = new Map<string, { n: number; reason: string | null }>();
  for (const r of rows) {
    if (r.status !== "pending" || r.target_location_id || !r.suggested_location_id) continue;
    const v = votes.get(r.suggested_location_id) ?? { n: 0, reason: reasonOf(r.suggested_location_note) };
    v.n++;
    votes.set(r.suggested_location_id, v);
  }
  let best: [string, { n: number; reason: string | null }] | null = null;
  for (const e of votes) if (!best || e[1].n > best[1].n) best = e;
  return best ? { id: best[0], reason: best[1].reason } : null;
}
