// The shared put-away routing signal (docs/product/put-away.md §2.1).
//
// "Where should this go?" answered from the workspace's own placements: a
// BIN CENSUS of what already lives where, and a scorer that matches an item
// against it by shared significant name/category tokens. Extracted from
// organize-plan.ts (Phase 0 of the put-away consolidation) so one signal
// serves every caller:
//
//   1. the batch planner's deterministic tier (organize-plan.ts, unchanged),
//   2. a live put-away session's per-scan route (Live Sort), which adds
//      SESSION CONTEXT: what this session already filed where (fresh
//      placements the census sweep can't see yet) and the sticky
//      last-confirmed bin (piles are batchy),
//   3. any future per-item "where do siblings live" surface.
//
// Deterministic + cheap by design: no LLM here, ever. Blank beats wrong — a
// null route is a valid answer the caller degrades from (catch-all bin /
// "unassigned"), never a guess.

import { platform } from "@cobblr/platform-contract";
import { significantTokens } from "./suggest-location.js";

// ── Declared interior size (size veto — declared-only, never guessed) ───────

export interface InteriorMm {
  x?: number;
  y?: number;
  z?: number;
}

/** The largest single interior axis — the conservative "will a rigid straight
 *  thing fit at all" test. Diagonal fits are deliberately ignored: the check
 *  ANNOTATES/vetoes only what provably cannot fit along any axis. */
export function maxAxisMm(d: InteriorMm | null | undefined): number | null {
  if (!d) return null;
  const axes = [d.x, d.y, d.z].filter((n): n is number => typeof n === "number" && n > 0);
  return axes.length ? Math.max(...axes) : null;
}

export function readInteriorMm(fields: Record<string, unknown>): InteriorMm | null {
  const raw = fields.interior_mm;
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
  const out: InteriorMm = {};
  if (num(d.x)) out.x = num(d.x);
  if (num(d.y)) out.y = num(d.y);
  if (num(d.z)) out.z = num(d.z);
  return out.x || out.y || out.z ? out : null;
}

// ── Bin census ───────────────────────────────────────────────────────────────

export interface CensusBin {
  location_id: string;
  name: string;
  path: string;
  /** "container" = bin-grade (a real home). "area" = a room/zone — evidence
   *  can route there (the user's own precedent), but an evidence-less pick
   *  never may (docs/product/put-away.md: "somewhere in the garage" is the
   *  vagueness this system exists to kill). */
  kind: "container" | "area";
  item_count: number;
  /** Distinct titles of what lives there (capped) — the prompt's evidence and
   *  the deterministic scorer's corpus. */
  sample_titles: string[];
  /** DECLARED interior size in mm (a container's metadata.interior_mm),
   *  null when the workspace hasn't declared one — no dims, no size logic. */
  interior_mm: InteriorMm | null;
}

export interface Census {
  /** Occupied bins, most-populated first, capped. */
  bins: CensusBin[];
  /** Empty locations (names only) — the LLM may target one instead of minting
   *  a new bin. */
  empty: Array<{
    location_id: string;
    name: string;
    path: string;
    kind: "container" | "area";
    interior_mm: InteriorMm | null;
  }>;
  /** Every known location id → {name, path, kind, interior} (validation +
   *  display + the size check, uncapped). */
  all: Map<
    string,
    { name: string; path: string; kind: "container" | "area"; interior_mm: InteriorMm | null }
  >;
  truncated: boolean;
}

const CENSUS_MAX_BINS = 60;
const CENSUS_MAX_EMPTY = 40;
const CENSUS_TITLES_PER_BIN = 30;
export const PER_KIND_SWEEP_LIMIT = 300;

export async function buildBinCensus(orgId: string): Promise<Census> {
  // All locations first: names + parent chains for paths.
  const locs = await platform()
    .entities.list(orgId, "core-locations:location", { limit: 1000 })
    .then((r) => r.items)
    .catch(() => []);
  const byId = new Map(locs.map((l) => [l.id, l] as const));
  const pathOf = (id: string): string => {
    const parts: string[] = [];
    let cur: string | null = id;
    let hops = 0;
    while (cur && hops++ < 10) {
      const node = byId.get(cur);
      if (!node) break;
      parts.unshift(node.title);
      cur = typeof node.fields.parent_id === "string" ? node.fields.parent_id : null;
    }
    return parts.join(" / ");
  };
  const all = new Map<
    string,
    { name: string; path: string; kind: "container" | "area"; interior_mm: InteriorMm | null }
  >();
  for (const l of locs) {
    all.set(l.id, {
      name: l.title,
      path: pathOf(l.id),
      // The create default is "area", so an unknown kind reads as area — the
      // conservative side (areas get the stricter no-guess rule).
      kind: l.fields.kind === "container" ? "container" : "area",
      interior_mm: readInteriorMm(l.fields),
    });
  }

  // One sweep per scannable kind, grouped by location_id. Best-effort per kind.
  const occupied = new Map<string, string[]>(); // location_id → titles
  const kinds = platform().entities.listScannable();
  const sweeps = await Promise.all(
    kinds.map((k) =>
      platform()
        .entities.list(orgId, k.kind, { limit: PER_KIND_SWEEP_LIMIT })
        .then((r) => r.items)
        .catch(() => []),
    ),
  );
  for (const items of sweeps) {
    for (const e of items) {
      const loc = typeof e.fields.location_id === "string" ? e.fields.location_id : null;
      if (!loc || !all.has(loc)) continue;
      const titles = occupied.get(loc) ?? [];
      if (titles.length < CENSUS_TITLES_PER_BIN) titles.push(e.title);
      occupied.set(loc, titles);
    }
  }

  const binsAll = [...occupied.entries()]
    .map(([location_id, sample_titles]) => ({
      location_id,
      name: all.get(location_id)!.name,
      path: all.get(location_id)!.path,
      kind: all.get(location_id)!.kind,
      item_count: sample_titles.length,
      sample_titles: [...new Set(sample_titles)],
      interior_mm: all.get(location_id)!.interior_mm,
    }))
    .sort((a, b) => b.item_count - a.item_count);
  const bins = binsAll.slice(0, CENSUS_MAX_BINS);

  const empty = locs
    .filter((l) => !occupied.has(l.id))
    .slice(0, CENSUS_MAX_EMPTY)
    .map((l) => ({
      location_id: l.id,
      name: l.title,
      path: pathOf(l.id),
      kind: all.get(l.id)!.kind,
      interior_mm: readInteriorMm(l.fields),
    }));

  return {
    bins,
    empty,
    all,
    truncated: binsAll.length > CENSUS_MAX_BINS || locs.length > 1000,
  };
}

// ── The routing signal ───────────────────────────────────────────────────────

/** The subset of an item routing needs (organize-plan's OrganizeInputItem
 *  satisfies it structurally). */
export interface RoutableItem {
  id: string;
  name: string;
  category?: string | null;
  /** Longest DECLARED dimension in mm — enables the size veto; absent = no
   *  size logic (declared-only, never guessed from names). */
  longest_mm?: number | null;
}

export interface RouteHit {
  item_id: string;
  location_id: string;
  /** Distinct sibling titles at that bin sharing a significant token. */
  sibling_count: number;
  sample_names: string[];
  /** Why this bin won — session context beats the census when both fire. */
  via: "census" | "session" | "sticky";
}

/** A live session's routing context: what THIS session already filed where
 *  (placements the census sweep can't see yet — items may still be pending
 *  commit), and the sticky last-confirmed bin for batchy piles. */
export interface SessionRouteContext {
  /** location_id → titles this session filed there. */
  filed: Map<string, string[]>;
  /** The last destination the user CONFIRMED (not the last we proposed). */
  sticky_location_id?: string | null;
  /** The last confirmed item's significant tokens — the "same as last?" test. */
  sticky_tokens?: string[];
}

/** Route one item against the census (and, for live sessions, the session
 *  context). Same scoring the batch planner's deterministic tier has always
 *  used: shared significant tokens, the plurality gate (2+ siblings agree, or
 *  a single near-twin with 3+ shared tokens), and the declared-dims size veto.
 *  Null = no defensible answer; the caller degrades, never guesses. */
export function routeItem(
  item: RoutableItem,
  census: Census,
  session?: SessionRouteContext,
): RouteHit | null {
  const want = new Set([
    ...significantTokens(item.name),
    ...significantTokens(item.category),
  ]);
  if (want.size === 0) return null;

  // ── Session tier (live only): the pile in front of you is better evidence
  // than a stale sweep. A sticky same-as-last match routes instantly; things
  // this session filed count as siblings even though the census can't see
  // them yet.
  if (session) {
    const sticky = session.sticky_location_id;
    if (sticky && (session.sticky_tokens ?? []).some((t) => want.has(t))) {
      const loc = census.all.get(sticky);
      if (!loc || fitsBin(item, loc.interior_mm)) {
        return {
          item_id: item.id,
          location_id: sticky,
          sibling_count: session.filed.get(sticky)?.length ?? 1,
          sample_names: (session.filed.get(sticky) ?? []).slice(0, 3),
          via: "sticky",
        };
      }
    }
    let best: RouteHit | null = null;
    let bestStrength = 0;
    for (const [locId, titles] of session.filed) {
      const loc = census.all.get(locId);
      if (loc && !fitsBin(item, loc.interior_mm)) continue;
      const scored = scoreTitles(titles, want);
      if (!scored) continue;
      if (scored.strength > bestStrength) {
        bestStrength = scored.strength;
        best = {
          item_id: item.id,
          location_id: locId,
          sibling_count: scored.count,
          sample_names: scored.samples,
          via: "session",
        };
      }
    }
    if (best) return best;
  }

  // ── Census tier: the batch planner's scorer, verbatim.
  let best: RouteHit | null = null;
  let bestStrength = 0;
  for (const bin of census.bins) {
    // Size veto (declared-only): a bin whose max interior axis is smaller
    // than the item's longest declared dimension is never a candidate.
    if (!fitsBin(item, bin.interior_mm)) continue;
    const scored = scoreTitles(bin.sample_titles, want);
    if (!scored) continue;
    if (scored.strength > bestStrength) {
      bestStrength = scored.strength;
      best = {
        item_id: item.id,
        location_id: bin.location_id,
        sibling_count: scored.count,
        sample_names: scored.samples,
        via: "census",
      };
    }
  }
  return best;
}

function fitsBin(item: RoutableItem, interior: InteriorMm | null | undefined): boolean {
  const binMax = maxAxisMm(interior);
  return !(item.longest_mm != null && binMax != null && item.longest_mm > binMax);
}

/** Token-overlap scoring over a bin's titles, with the plurality gate
 *  (2+ siblings agree, or a single very-strong near-twin with 3+ shared
 *  significant tokens) — the same gate suggest-location.ts uses. Exported so
 *  the batch planner can compute POST-HOC evidence for an AI-chosen bin (the
 *  model's say-so is never evidence; overlap with what actually lives there
 *  is). */
export function scoreTitles(
  titles: string[],
  want: Set<string>,
): { count: number; strongest: number; strength: number; samples: string[] } | null {
  let count = 0;
  let strongest = 0;
  const samples: string[] = [];
  for (const title of titles) {
    const overlap = significantTokens(title).filter((t) => want.has(t)).length;
    if (overlap < 1) continue;
    count++;
    strongest = Math.max(strongest, overlap);
    if (samples.length < 3) samples.push(title);
  }
  if (count < 2 && strongest < 3) return null;
  return { count, strongest, strength: count * 10 + strongest, samples };
}
