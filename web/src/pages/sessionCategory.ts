// The ONE category a whole scan session should file under.
//
// Every item is identified independently, so three shirts scanned together came
// back "apparel", "apparel" and "clothing" - three items, two sections, when the
// goal was one (the author, 2026-07-30). The agreement is computed with the SHARED
// reconciler (@cobblr/platform-contract/category-reconcile), the same code the
// server uses, so the header can never propose a different label than the
// pipeline would.

import {
  unifyCategories,
  categoryDisplay,
  type CategoryConsensus,
} from "@cobblr/platform-contract/category-reconcile";
import type { ScanInboxItem, ScanMenuEntry } from "../lib/api";

export { categoryDisplay };

/** The category a scan item is currently headed for: its top candidate's
 *  resolved value, else the raw one the identify wrote. */
export function itemCategory(it: ScanInboxItem): string | null {
  const cand = it.suggested_candidates?.[0];
  if (cand?.category) return cand.category;
  const meta = (it.suggested_metadata ?? {}) as { category?: unknown };
  return typeof meta.category === "string" && meta.category.trim() ? meta.category.trim() : null;
}

/**
 * The name of the field that IS this table's category axis, as the workspace
 * DECLARED it (`field_role: "category"`, carried on the scan menu).
 *
 * This replaces guessing the axis by finding the field whose value happens to
 * equal the candidate's `category`. That guess failed exactly when it mattered:
 * a row whose stored `fields.category` was "clothing" while its candidate
 * `category` read "apparel" matched nothing, so the chip fell through to the raw
 * value and one session showed "Clothing", "clothing" and "apparel" for one
 * category (the author, 2026-07-30). A declared name cannot drift from its value.
 */
export function declaredCategoryAxis(
  menu: ScanMenuEntry[] | null | undefined,
  cand: { module: string; instance?: string | null } | null | undefined,
): string | null {
  if (!cand) return null;
  const entry = (menu ?? []).find(
    (m) => m.module === cand.module && (m.instance ?? null) === (cand.instance ?? null),
  );
  return entry?.category_field?.name ?? null;
}

/**
 * Which key in a candidate's `fields` IS the category axis.
 *
 * Prefers the DECLARED axis from the menu; falls back to the value match for a
 * caller that has no menu loaded yet (the first render, before the query
 * resolves) so behaviour degrades to the old guess rather than to nothing.
 */
export function categoryAxisKey(it: ScanInboxItem, menu?: ScanMenuEntry[] | null): string | null {
  const cand = it.suggested_candidates?.[0];
  if (!cand) return null;
  const declared = declaredCategoryAxis(menu, cand);
  if (declared && cand.fields && declared in cand.fields) return declared;
  if (!cand.category) return null;
  const hit = Object.keys(cand.fields ?? {}).find((k) => cand.fields[k] === cand.category);
  return hit ?? null;
}

/** The session's agreed category, or null when there is nothing to agree on. */
export function sessionCategory(items: ScanInboxItem[]): CategoryConsensus {
  return unifyCategories(items.map(itemCategory));
}

/** `extras` for filing one item under the session's agreed category. Overrides
 *  only the axis field, and only when the item has one - everything else the
 *  candidate filled is untouched. */
export function extrasWithCategory(
  it: ScanInboxItem,
  agreed: string | null,
  menu?: ScanMenuEntry[] | null,
): Record<string, string | number | boolean> | undefined {
  const cand = it.suggested_candidates?.[0];
  if (!cand) return undefined;
  const base = { ...(cand.fields ?? {}) };
  const axis = categoryAxisKey(it, menu);
  if (agreed && axis) base[axis] = agreed;
  return base;
}

/** What a session still needs before "File all" can honestly file. */
export interface SessionFilingReadiness {
  /** The agreed category, or null when nothing proposed one. */
  category: string | null;
  /** Ready items with nowhere to go (no per-item location, no active bin). */
  missingLocation: string[];
  /** True when filing right now would land items with no home or no category. */
  needsInput: boolean;
  /** The single reason to show, most blocking first. */
  reason: "location" | "category" | null;
}

/**
 * Filing needs BOTH a sort category and a place - "at least a room" - or an
 * explicit decision from the person to go without (the author, 2026-07-30).
 *
 * `isReadyToFile` only ever checked for a name and a destination table, so "File
 * all" would happily commit items with no location at all: they land in the
 * table and are then findable only by search, which is how a scanned pile
 * becomes a pile again. This is the gate that stops that, WITHOUT blocking
 * someone who genuinely wants to file now and place later - the UI offers the
 * override rather than the gate deciding for them.
 *
 * `activeBin` is the scan page's standing filing bin: when one is set, every
 * item already has a home and nothing is missing.
 */
export function sessionFilingReadiness(
  readyItems: ScanInboxItem[],
  opts: { activeBin?: string | null } = {},
): SessionFilingReadiness {
  const category = sessionCategory(readyItems).suggestion;
  const missingLocation = opts.activeBin
    ? []
    : readyItems.filter((i) => !i.target_location_id).map((i) => i.id);
  // Location first: an item with no category is still findable in its table,
  // an item with no location is loose in the house.
  const reason = missingLocation.length > 0 ? "location" : !category ? "category" : null;
  return { category, missingLocation, needsInput: reason !== null, reason };
}

/** Where a whole session is headed, when its items agree. */
export interface SessionLocation {
  /** The one location every ready item is already set to, else null. */
  id: string | null;
  /** Items are set to DIFFERENT locations - there is no single session place. */
  mixed: boolean;
  /** How many ready items have no location at all. */
  missing: number;
}

/**
 * The session's common location.
 *
 * The header needs to SHOW this, not just gate on it: filing needs a place as
 * well as a category, and the old header only revealed that after you pressed
 * the button, which then asked instead of filing (the author, 2026-07-30: "plenty of
 * room for a set common location or no location set, so it's set location then
 * you can file"). Mixed locations are reported as mixed rather than collapsed to
 * the first, so the header never claims a place the items do not share.
 */
export function sessionLocation(readyItems: ScanInboxItem[]): SessionLocation {
  const set = new Set<string>();
  let missing = 0;
  for (const it of readyItems) {
    if (it.target_location_id) set.add(it.target_location_id);
    else missing++;
  }
  if (set.size === 0) return { id: null, mixed: false, missing };
  if (set.size > 1) return { id: null, mixed: true, missing };
  return { id: [...set][0]!, mixed: false, missing };
}
