// The row's match, derived ONE way: what the matchmaker stamps at match time,
// what a rename re-derives, and what File everything stamps on a row that was
// never matched. Every door then reads the stamp through the contract
// (scanRebuy), so the card and the bulk plan cannot reach two answers.
//
// Before, the card read the stamp written under the model's name while File
// everything asked findTracked live under the person's: a book renamed to
// "Review correction control notebook" offered +1 on its card and "Filed as
// new" in the plan (#3726). And the stamp kept only the best match, so the
// card offered +1 on the first of three teas the plan rightly left alone.
//
// The tier rule lives here: a barcode is the product saying what it is, so
// one barcode match decides and two are ambiguous; with no barcode match the
// same holds for names. `of` carries the ambiguity to the contract.

import { sql, type Kysely } from "kysely";
import { personNameOf } from "@cobblr/platform-contract/display-identity";
import { platform } from "@cobblr/platform-contract";
import { HOLDING_OF } from "@cobblr/platform-contract/holdings";
import { findTracked, placesOfCard, type TrackedMatch } from "./entity-match.js";
import { scanTargetOf } from "./scan-target.js";

export interface TrackedMatchStamp {
  kind: string;
  id: string;
  title: string;
  instance: string | null;
  matched_by: string;
  matched_label: string | null;
  qty: number | null;
  image_path: string | null;
  /** How many THINGS matched at the deciding tier (1 = decisive); places of
   *  one item are one thing. */
  of: number;
  /** How many places the matched thing is kept in (1 when one). */
  places?: number;
  /** The stamp's record is the place this scan belongs to (picked, or the
   *  place being worked in). */
  place_chosen?: boolean;
  /** The place this scan is at, when the thing is not kept there yet:
   *  filing adds it as another place of the same item. */
  new_place?: string | null;
  /** Where the thing is kept already, in words ("8 in Kitchen"). */
  held?: string | null;
}

/** Where this scan is being filed, as far as a place of the matched thing is
 *  concerned: the place somebody picked on the row, then the place being
 *  worked in (the bin or scan area). */
export interface ScanPlace {
  place_choice?: string | null;
  location_id?: string | null;
}

/** The row's own answers to "which place": its stored pick and its bin. */
export function scanPlaceOf(row: { target_location_id?: string | null; suggested_metadata?: unknown }): ScanPlace {
  const pick = ((row.suggested_metadata ?? {}) as { place_choice?: unknown }).place_choice;
  return { place_choice: typeof pick === "string" && pick ? pick : null, location_id: row.target_location_id ?? null };
}

/** The stamp for a matcher's answer, or null when nothing matched. */
export function trackedMatchStamp(tracked: { barcode_matches: TrackedMatch[]; name_matches: TrackedMatch[] } | null): TrackedMatchStamp | null {
  if (!tracked) return null;
  const tier = tracked.barcode_matches.length > 0 ? tracked.barcode_matches : tracked.name_matches;
  const best = tier[0];
  if (!best) return null;
  const things = new Set(tier.map((m) => m.card_id ?? m.id));
  return {
    kind: best.kind,
    id: best.id,
    title: best.title,
    instance: best.instance,
    matched_by: best.matched_by,
    matched_label: best.matched_label ?? null,
    // Whether the record keeps a count is what makes "+1 more" the right
    // filing (scanRebuy); a record with none is one unique thing.
    qty: best.qty,
    // The picture a person already chose for the thing they have: the card
    // shows it ahead of anything a web search found (2026-09-06).
    image_path: best.image_path,
    of: things.size,
  };
}

/** The stamp, with the place settled where it can be: one thing kept in
 *  several places is stamped at the place picked on the row or the place
 *  being worked in; with neither it says how many places and that none is
 *  chosen, and the contract asks (scanRebuy). A places lookup that fails
 *  stamps as before, one record. */
export async function trackedMatchStampAt(
  orgId: string,
  tracked: { barcode_matches: TrackedMatch[]; name_matches: TrackedMatch[] } | null,
  at: ScanPlace,
): Promise<TrackedMatchStamp | null> {
  const stamp = trackedMatchStamp(tracked);
  if (!stamp || stamp.of > 1 || !tracked) return stamp;
  const tier = tracked.barcode_matches.length > 0 ? tracked.barcode_matches : tracked.name_matches;
  const card = tier[0]?.card_id ?? stamp.id;
  const places = await placesOfCard(orgId, stamp.kind, card).catch(() => []);
  if (!at.place_choice) {
    const fresh = await newPlaceAmong(orgId, stamp.kind, stamp.instance, places, at.location_id ?? null);
    if (fresh) return { ...stamp, id: card, places: Math.max(places.length, 1), place_chosen: true, new_place: at.location_id ?? null, held: fresh.held };
  }
  if (places.length <= 1) return stamp;
  const chosen =
    places.find((p) => p.id === at.place_choice) ?? (at.location_id ? places.find((p) => p.location_id === at.location_id) : undefined);
  if (!chosen) return { ...stamp, id: card, places: places.length, place_chosen: false };
  return { ...stamp, id: chosen.id, qty: chosen.qty ?? stamp.qty, places: places.length, place_chosen: true };
}

type Place = { id: string; location_id: string | null; qty: number | null };

/** Whether a scan at `locationId` is a place the thing is not kept yet: it is
 *  kept somewhere (a located row), not here, and its kind can keep a thing in
 *  several places (a declared holdAction). The words for where it is kept,
 *  for the card. Null when filing should add to a place it already has. */
async function newPlaceAmong(
  orgId: string,
  kind: string,
  instance: string | null,
  places: Place[],
  locationId: string | null,
): Promise<{ held: string | null } | null> {
  if (!locationId) return null;
  const located = places.filter((p) => p.location_id);
  if (!located.length || located.some((p) => p.location_id === locationId)) return null;
  const target = await scanTargetOf(orgId, kind, instance ?? undefined).catch(() => null);
  if (!target?.scannable.holdAction || !target.scannable.qtyField) return null;
  const names = await platform()
    .entities.lookupMany(orgId, [...new Set(located.map((p) => p.location_id!))].map((id) => ({ kind: "core-locations:location", id })))
    .then((ls) => new Map(ls.map((l) => [l.id, l.title])))
    .catch(() => new Map<string, string>());
  const held = located
    .map((p) => {
      const where = names.get(p.location_id!);
      return where ? `${p.qty ?? 0} in ${where}` : null;
    })
    .filter(Boolean)
    .join(", ");
  return { held: held || null };
}

/** The same question at filing time, asked fresh of the record the door was
 *  handed (a card or one of its places): the item's card when a scan at
 *  `locationId` is a new place of it, else null. */
export async function newPlaceAt(
  orgId: string,
  kind: string,
  instance: string | null,
  recordId: string,
  locationId: string | null,
): Promise<{ card: string } | null> {
  if (!locationId) return null;
  const pairs = await platform()
    .pairings.findBySources({ orgId, sourceKind: kind, sourceIds: [recordId], targetKind: kind, relationshipKind: HOLDING_OF })
    .catch(() => [] as Array<{ targetId: string }>);
  const card = pairs[0]?.targetId ?? recordId;
  const places = await placesOfCard(orgId, kind, card).catch(() => []);
  return (await newPlaceAmong(orgId, kind, instance, places, locationId)) ? { card } : null;
}

export interface MatchInput {
  /** The bin or scan area this row is being filed in, when there is one. */
  target_location_id?: string | null;
  barcode_text: string | null;
  suggested_name: string | null;
  suggested_metadata?: unknown;
  suggested_manufacturer: string | null;
}

/** What the matcher is asked with: the name the row is known by (a
 *  person's own over the model's), its code, maker, and the destination's
 *  fields. `modelName` is the name the model's pass settled on, when the
 *  caller has a newer one than the column. */
/** The part number a person gave for a scan, when they gave one. */
export function givenIdentifierOf(meta: unknown): string | null {
  const v = (meta as { identifier?: unknown } | null | undefined)?.identifier;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export function matchQuery(row: MatchInput, fields: Record<string, unknown> | null | undefined, category: string | null | undefined, modelName?: string | null) {
  return {
    barcode: row.barcode_text,
    // A part number the person gave (a hint, a typed identifier): matched as
    // exactly as a barcode.
    identifier: givenIdentifierOf(row.suggested_metadata),
    name: personNameOf(row.suggested_metadata) ?? modelName ?? row.suggested_name,
    fields: fields ?? {},
    brand: row.suggested_manufacturer,
    category: category ?? null,
  };
}

/** Re-derive a row's match and store it. Throws when the matcher fails, so
 *  a caller can tell "could not check" from "nothing matched" (the second
 *  creates a duplicate). */
export async function restampTrackedMatch(
  orgId: string,
  db: Kysely<never>,
  rowId: string,
  row: MatchInput,
  fields: Record<string, unknown> | null | undefined,
  category: string | null | undefined,
): Promise<TrackedMatchStamp | null> {
  const stamp = await trackedMatchStampAt(orgId, await findTracked(orgId, matchQuery(row, fields, category)), scanPlaceOf(row));
  await (db as unknown as Kysely<{ core_scan_inbox_items: { id: string; suggested_metadata: unknown } }>)
    .updateTable("core_scan_inbox_items")
    // jsonb merge: only the key this sets, onto the live row value.
    .set({ suggested_metadata: sql`coalesce(suggested_metadata, '{}'::jsonb) || ${JSON.stringify({ tracked_match: stamp })}::jsonb` as never })
    .where("id", "=", rowId)
    .execute();
  return stamp;
}
