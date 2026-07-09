// "Where should this go?" — after an item is identified, suggest a home for it
// from where SIMILAR items already live. The other half of unbox→identify: the
// system knows what it is, so it can point at the bin its siblings are in
// ("3 resistors already live in Bin 4"). Deterministic + cheap: it reads the
// workspace's own placements via the generic entity layer — no LLM, no new
// index. A pure signal the review UI surfaces as a one-tap Accept; it never
// silently overrides a location the user set themselves.

import { platform } from "@cobblr/platform-contract";
import { isJunkName } from "./enrich.js";

export interface LocationSuggestion {
  location_id: string;
  location_name: string;
  /** How many already-placed similar items point at this location. */
  count: number;
  /** Human one-liner for the note ("3 similar items are stored here"). */
  reason: string;
}

const STOP = new Set([
  "the", "and", "for", "with", "from", "pack", "pcs", "pieces", "count",
  "set", "kit", "new", "oem", "genuine", "original", "assorted", "item", "items",
]);

/** Significant name tokens (stop-worded, 3+ chars) — shared with organize-plan.ts. */
export function significantTokens(s: string | null | undefined): string[] {
  return (
    (s ?? "")
      .toLowerCase()
      .match(/[a-z0-9]{3,}/g)
      ?.filter((t) => !STOP.has(t)) ?? []
  );
}

/** Suggest a location for a just-identified item, from where its siblings live.
 *  Queries every scannable kind for entities matching the item's name/category,
 *  reads the location each already sits in, and returns the location the
 *  plurality of them share — when the signal is strong enough to be worth
 *  showing. Null when there's nothing similar placed yet (a fresh workspace, or
 *  a genuinely new kind of thing). Best-effort by construction: any per-kind
 *  query that throws is skipped. */
export async function suggestLocationForItem(
  orgId: string,
  opts: { name?: string | null; category?: string | null; excludeId?: string | null },
): Promise<LocationSuggestion | null> {
  const name = opts.name && !isJunkName(opts.name) ? opts.name.trim() : null;
  const category = opts.category?.trim() || null;
  if (!name && !category) return null;

  const want = significantTokens(name);
  const catTokens = significantTokens(category);
  const kinds = platform().entities.listScannable();

  // Gather similar placed entities across kinds. Query by individual significant
  // TOKENS, not the full name — the entity `q` search AND-matches its words, so
  // "22k resistor" would find nothing (no sibling has "22k"), whereas "resistor"
  // finds the whole family. The longest tokens first (the type noun over a size
  // code), capped so a wordy name doesn't fan out. Category tokens ride along.
  const queries = [...new Set([...want, ...catTokens])]
    .sort((a, b) => b.length - a.length)
    .slice(0, 4);
  if (queries.length === 0) return null;
  const perQuery = await Promise.all(
    kinds.flatMap((k) =>
      queries.map(async (q) => {
        try {
          const res = await platform().entities.list(orgId, k.kind, { q, limit: 20 });
          return res.items;
        } catch {
          return [];
        }
      }),
    ),
  );

  // location_id → { weight (best overlap), count (distinct entities) }.
  const byLocation = new Map<string, { weight: number; ids: Set<string> }>();
  const seen = new Set<string>();
  for (const items of perQuery) {
    for (const e of items) {
      const key = `${e.kind}:${e.id}`;
      if (opts.excludeId && e.id === opts.excludeId) continue;
      const loc = typeof e.fields.location_id === "string" ? e.fields.location_id : null;
      if (!loc) continue;
      // Score by shared significant tokens against the name AND category, so a
      // same-category sibling with a different name still counts, and a
      // name-twin counts more.
      const have = new Set(significantTokens(e.title));
      const nameShare = want.filter((t) => have.has(t)).length;
      const catShare = catTokens.filter((t) => have.has(t)).length;
      const overlap = nameShare + catShare;
      // A single shared significant token is enough to COUNT (same head noun —
      // "resistor" — means same type of thing; a 22k and a 10k resistor share
      // only "resistor" but belong together). The real guard against noise is
      // the location plurality gate below (2+ siblings must agree on a spot),
      // not per-item strictness. Weight still tracks the strongest overlap so a
      // near-exact twin can carry a suggestion on its own.
      if (overlap < 1) continue;
      if (seen.has(key)) {
        // Already counted for this entity in another query — only upgrade weight.
        const cur = byLocation.get(loc);
        if (cur) cur.weight = Math.max(cur.weight, overlap);
        continue;
      }
      seen.add(key);
      const cur = byLocation.get(loc) ?? { weight: 0, ids: new Set<string>() };
      cur.weight = Math.max(cur.weight, overlap);
      cur.ids.add(key);
      byLocation.set(loc, cur);
    }
  }
  if (byLocation.size === 0) return null;

  // Winner: most supporting entities, breaking ties by strongest single overlap.
  const ranked = [...byLocation.entries()].sort(
    (a, b) => b[1].ids.size - a[1].ids.size || b[1].weight - a[1].weight,
  );
  const [locId, best] = ranked[0]!;
  const count = best.ids.size;
  // Confidence gate: 2+ siblings there, OR a single very-strong name twin
  // (≥3 shared tokens — an exact-ish match of the same product).
  if (count < 2 && best.weight < 3) return null;

  // Resolve the location's display name (best-effort; skip if it's gone).
  const loc = await platform()
    .entities.lookup(orgId, "core-locations:location", locId)
    .catch(() => null);
  if (!loc) return null;

  return {
    location_id: locId,
    location_name: loc.title,
    count,
    reason:
      count >= 2
        ? `${count} similar items are stored here`
        : "a matching item is stored here",
  };
}
