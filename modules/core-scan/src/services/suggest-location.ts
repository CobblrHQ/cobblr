// "Where should this go?" — after an item is identified, suggest a home for it.
// Deterministic + cheap: it reads the workspace's own placements through the
// generic entity layer, no LLM and no new index. A pure signal the review UI
// surfaces as a one-tap Accept; it never silently overrides a location the user
// set themselves.
//
// TWO SIGNALS, and the second exists because the first is silent exactly when
// it is needed most:
//
//   WHERE SIBLINGS LIVE — "3 resistors already live in Bin 4". This is how the
//     system learns a person's own habits, and it is the better answer whenever
//     it fires, because it is about THIS workspace rather than about food.
//
//   HOW IT MUST BE KEPT — a thing that has to stay cold, and a workspace that
//     has a Fridge. Needs no history, which is the point: somebody's first shop
//     has no siblings placed yet, so the sibling signal says nothing about all
//     thirty items and every one of them files with no home. That is the report
//     this was written for - scanned a shop, nothing got a location, and the
//     storage check then complained afterwards about items it could have placed
//     correctly to begin with.
//
// The two are not independent. A sibling location that CONTRADICTS the
// requirement is never suggested: three yoghurts sitting wrongly in a cupboard
// must not teach the system to put the fourth there, and suggesting a spot the
// storage warning would immediately complain about is the worst thing this file
// could do.

import { platform } from "@cobblr/platform-contract";
import { scanTargetsForOrg } from "./scan-target.js";
import { isJunkName } from "./enrich.js";
import { satisfiesRequirement, type StorageRequirement } from "./storage-requirement.js";

export interface LocationSuggestion {
  location_id: string;
  location_name: string;
  /** How many already-placed similar items point at this location. */
  count: number;
  /** Human one-liner for the note ("3 similar items are stored here"). */
  reason: string;
}

/** Every location in the workspace. Best-effort: a workspace whose locations
 *  cannot be read gets no requirement-based suggestion, same as having none. */
async function workspaceLocations(orgId: string): Promise<Array<{ id: string; title: string }>> {
  try {
    const res = await platform().entities.list(orgId, "core-locations:location", { limit: 1000 });
    return res.items.map((l) => ({ id: l.id, title: l.title }));
  } catch {
    return [];
  }
}

/**
 * The place a thing HAS to live, when the workspace has one.
 *
 * Shortest satisfying name wins, so "Fridge" beats "Fridge - top shelf - back".
 * Both are correct; the shorter one is what a person would have said, and
 * "in the fridge" is a smaller claim than a particular shelf - the kind of
 * claim a suggestion is allowed to make on somebody's behalf.
 */
export function requirementSpot(
  requirement: StorageRequirement | null | undefined,
  locations: ReadonlyArray<{ id: string; title: string }>,
): { id: string; title: string } | null {
  if (!requirement || requirement === "ambient") return null;
  const fits = locations.filter((l) => satisfiesRequirement(requirement, l.title));
  if (fits.length === 0) return null;
  return fits.sort((a, b) => a.title.length - b.title.length || a.title.localeCompare(b.title))[0]!;
}

/** A place that only makes sense for things kept cold. Never the answer to
 *  "where do these usually go" - a fridge is a special-purpose spot, and
 *  defaulting anything into one because that is where the yoghurt lives would
 *  put the pasta in there too. */
const isColdPlace = (title: string): boolean =>
  satisfiesRequirement("refrigerated", title) || satisfiesRequirement("frozen", title);

/**
 * Where the rest of these already live.
 *
 * The broad half of learning from somebody: not "where do this workspace's
 * OTHER cans of tomatoes live" (that is the sibling signal above, and it is
 * silent until there are two of a kind), but "where do the Groceries live". A
 * shop is thirty things that have never been scanned before and one obvious
 * home, and the specific signal cannot see that.
 *
 * Deliberately kind-shaped rather than food-shaped. Nothing here knows what a
 * grocery is: it asks where records of THIS kind are kept, so it answers for
 * Books and Spices and Parts on the same terms.
 */
async function kindHome(
  orgId: string,
  kind: string,
  locations: ReadonlyArray<{ id: string; title: string }>,
  excludeId?: string | null,
): Promise<{ id: string; title: string; count: number } | null> {
  const byId = new Map(locations.map((l) => [l.id, l.title]));
  let items: Array<{ id: string; fields: Record<string, unknown> }>;
  try {
    const res = await platform().entities.list(orgId, kind, { limit: 200 });
    items = res.items;
  } catch {
    return null;
  }
  const counts = new Map<string, number>();
  for (const e of items) {
    if (excludeId && e.id === excludeId) continue;
    const loc = typeof e.fields.location_id === "string" ? e.fields.location_id : null;
    const title = loc ? byId.get(loc) : null;
    if (!loc || !title || isColdPlace(title)) continue;
    counts.set(loc, (counts.get(loc) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const top = ranked[0];
  // Two, the same bar the sibling signal uses: one stray is not a habit.
  if (!top || top[1] < 2) return null;
  return { id: top[0], title: byId.get(top[0])!, count: top[1] };
}

/** Names a room-temperature food home goes by, best first. Only consulted for
 *  something the vocabulary positively calls shelf-stable, so a workspace with
 *  a Pantry never gets a widget filed into it. */
const AMBIENT_NAMES = [/\bpantry\b/, /\blarder\b/, /\bcupboard\b/, /\bkitchen\b/];

/**
 * The room-temperature home, for a workspace with no habit yet.
 *
 * The first shop into an empty workspace has no history at all, which is
 * exactly when everything files with no location. A tin of tomatoes is
 * positively shelf-stable - `ambient` is an assertion, not a shrug - and a
 * Pantry is what a Pantry is for.
 */
export function ambientHome(
  requirement: StorageRequirement | null | undefined,
  locations: ReadonlyArray<{ id: string; title: string }>,
): { id: string; title: string } | null {
  if (requirement !== "ambient") return null;
  for (const want of AMBIENT_NAMES) {
    const hit = locations.filter((l) => want.test(l.title.toLowerCase()));
    if (hit.length > 0) {
      return hit.sort((a, b) => a.title.length - b.title.length || a.title.localeCompare(b.title))[0]!;
    }
  }
  return null;
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
  opts: {
    name?: string | null;
    category?: string | null;
    excludeId?: string | null;
    /** How this thing must be KEPT, when the item says so. Turns on the second
     *  signal and, more importantly, vetoes a learned spot that contradicts it. */
    requirement?: StorageRequirement | null;
    /** The kind this is being filed as, when routing has decided. Turns on the
     *  broad half of learning from somebody: where the rest of these live. */
    kind?: string | null;
  },
): Promise<LocationSuggestion | null> {
  const name = opts.name && !isJunkName(opts.name) ? opts.name.trim() : null;
  const category = opts.category?.trim() || null;
  const requirement = opts.requirement ?? null;
  const cold = requirement === "frozen" || requirement === "refrigerated";
  // The locations are needed to answer the requirement question at all, and the
  // read is skipped entirely for the ordinary case where nothing has to stay
  // cold - which is almost every item in almost every workspace.
  //
  // Read once, then answered from three tiers below in order of how specific
  // each is: this thing must be cold; where its own siblings live; where the
  // rest of its kind lives; and, for a workspace with no habit at all, what a
  // Pantry is for. Skipped entirely only when nothing could use them.
  const wantsPlace = cold || requirement === "ambient" || !!opts.kind;
  const locations = wantsPlace ? await workspaceLocations(orgId) : [];
  const mustGo = requirementSpot(requirement, locations);

  /** What to say when the specific signals find nothing. Computed lazily: the
   *  broad tiers cost a query, and an item whose siblings answer never pays. */
  const broadFallback = async (): Promise<LocationSuggestion | null> => {
    if (mustGo) {
      return {
        location_id: mustGo.id,
        location_name: mustGo.title,
        count: 0,
        reason:
          requirement === "frozen" ? "it needs to be kept frozen" : "it needs to be kept refrigerated",
      };
    }
    if (opts.kind) {
      const home = await kindHome(orgId, opts.kind, locations, opts.excludeId);
      if (home) {
        return {
          location_id: home.id,
          location_name: home.title,
          count: home.count,
          reason: `${home.count} others are kept here`,
        };
      }
    }
    const ambient = ambientHome(requirement, locations);
    if (ambient) {
      return {
        location_id: ambient.id,
        location_name: ambient.title,
        count: 0,
        reason: "it keeps at room temperature",
      };
    }
    return null;
  };

  if (!name && !category) return broadFallback();

  const want = significantTokens(name);
  const catTokens = significantTokens(category);
  // The kinds that hold records HERE, instances included: two tomatoes in
  // the Pantry live under groceries:item, which the base registry never
  // lists, so the sibling tier learned nothing from fifty groceries (#3132).
  const kinds = await scanTargetsForOrg(orgId);

  // Gather similar placed entities across kinds. Query by individual significant
  // TOKENS, not the full name — the entity `q` search AND-matches its words, so
  // "22k resistor" would find nothing (no sibling has "22k"), whereas "resistor"
  // finds the whole family. The longest tokens first (the type noun over a size
  // code), capped so a wordy name doesn't fan out. Category tokens ride along.
  const queries = [...new Set([...want, ...catTokens])]
    .sort((a, b) => b.length - a.length)
    .slice(0, 4);
  if (queries.length === 0) return broadFallback();
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
  if (byLocation.size === 0) return broadFallback();

  // Winner: most supporting entities, breaking ties by strongest single overlap.
  const ranked = [...byLocation.entries()].sort(
    (a, b) => b[1].ids.size - a[1].ids.size || b[1].weight - a[1].weight,
  );
  const [locId, best] = ranked[0]!;
  const count = best.ids.size;
  // Confidence gate: 2+ siblings there, OR a single very-strong name twin
  // (≥3 shared tokens — an exact-ish match of the same product).
  if (count < 2 && best.weight < 3) return broadFallback();

  // Resolve the location's display name (best-effort; skip if it's gone).
  const loc = await platform()
    .entities.lookup(orgId, "core-locations:location", locId)
    .catch(() => null);
  if (!loc) return broadFallback();

  // THE VETO. Siblings record what somebody DID, which is not always what they
  // meant: three yoghurts already in a cupboard are three mistakes, and copying
  // them would make a fourth and then complain about it. Where the two signals
  // disagree, how a thing must be KEPT wins over where its siblings ended up.
  if (cold && !satisfiesRequirement(requirement, loc.title)) return broadFallback();

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
