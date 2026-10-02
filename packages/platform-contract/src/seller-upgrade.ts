// When a seller noted beside where things came from has earned a field.
//
// The seller rides as a note beside the place ("eBay · detroitaxle"): display
// and search only, so one place never fragments into many (arrivals.md, "the
// durable value and the one-off clarifier"). Caring is an upgrade: once the
// same seller has been noted a third time, or under two different places
// (Detroit Axle on eBay and on Amazon), the person is asked, once, whether to
// track sellers as a field of their own, so "everything from Detroit Axle" is
// a filter and not a search (#4518). Never at capture time; never on its own.

export interface UsedNote {
  value: string;
  uses: number;
}

export interface SellerUpgrade {
  /** The seller that earned it, as it was written most. */
  seller: string;
  /** The places it was noted under. */
  places: string[];
  /** How many records note it. */
  times: number;
}

const key = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

/** `details` holds each place's notes, keyed by the place lower-cased and
 *  trimmed; `placeNames` maps that key back to how the place is written.
 *  Returns the seller most worth a field, or null. */
export function sellerUpgradeDue(
  details: Record<string, readonly UsedNote[]>,
  placeNames: Record<string, string> = {},
): SellerUpgrade | null {
  const by = new Map<string, { names: Map<string, number>; places: Set<string>; times: number }>();
  for (const [place, notes] of Object.entries(details)) {
    for (const n of notes) {
      const k = key(n.value);
      if (!k) continue;
      const e = by.get(k) ?? { names: new Map(), places: new Set(), times: 0 };
      e.names.set(n.value, (e.names.get(n.value) ?? 0) + n.uses);
      e.places.add(placeNames[place] ?? place);
      e.times += n.uses;
      by.set(k, e);
    }
  }
  let best: SellerUpgrade | null = null;
  for (const e of by.values()) {
    if (e.times < 3 && e.places.size < 2) continue;
    const seller = [...e.names].sort((a, b) => b[1] - a[1])[0]![0];
    const cand = { seller, places: [...e.places].sort(), times: e.times };
    if (!best || cand.times > best.times || (cand.times === best.times && cand.places.length > best.places.length)) best = cand;
  }
  return best;
}
