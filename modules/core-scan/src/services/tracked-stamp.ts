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
import { findTracked, type TrackedMatch } from "./entity-match.js";

export interface TrackedMatchStamp {
  kind: string;
  id: string;
  title: string;
  instance: string | null;
  matched_by: string;
  matched_label: string | null;
  qty: number | null;
  image_path: string | null;
  /** How many records matched at the deciding tier (1 = decisive). */
  of: number;
}

/** The stamp for a matcher's answer, or null when nothing matched. */
export function trackedMatchStamp(tracked: { barcode_matches: TrackedMatch[]; name_matches: TrackedMatch[] } | null): TrackedMatchStamp | null {
  if (!tracked) return null;
  const tier = tracked.barcode_matches.length > 0 ? tracked.barcode_matches : tracked.name_matches;
  const best = tier[0];
  if (!best) return null;
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
    of: tier.length,
  };
}

export interface MatchInput {
  barcode_text: string | null;
  suggested_name: string | null;
  suggested_metadata?: unknown;
  suggested_manufacturer: string | null;
}

/** What the matcher is asked with: the name the row is known by (a
 *  person's own over the model's), its code, maker, and the destination's
 *  fields. `modelName` is the name the model's pass settled on, when the
 *  caller has a newer one than the column. */
export function matchQuery(row: MatchInput, fields: Record<string, unknown> | null | undefined, category: string | null | undefined, modelName?: string | null) {
  return {
    barcode: row.barcode_text,
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
  const stamp = trackedMatchStamp(await findTracked(orgId, matchQuery(row, fields, category)));
  await (db as unknown as Kysely<{ core_scan_inbox_items: { id: string; suggested_metadata: unknown } }>)
    .updateTable("core_scan_inbox_items")
    // jsonb merge: only the key this sets, onto the live row value.
    .set({ suggested_metadata: sql`coalesce(suggested_metadata, '{}'::jsonb) || ${JSON.stringify({ tracked_match: stamp })}::jsonb` as never })
    .where("id", "=", rowId)
    .execute();
  return stamp;
}
