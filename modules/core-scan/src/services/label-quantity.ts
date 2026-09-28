// What a label says is written onto its item, marked as read from the label;
// what the person set is never replaced (#3729, #3731).
//
// The bulk bag of a yarn said "quantity contained 3" on its shipping label,
// the photo read transcribed it, and the row stayed x1. A second photo of a
// label joined to an item was only cross-checked, never read. The count, the
// lot and the colourway were on the label, in words, and nothing wrote them.

import type { Kysely } from "kysely";
import { sql } from "kysely";
import { FIELD_PROVENANCE_KEY, fieldProvenanceOf, type FieldProvenanceMap } from "@cobblr/platform-contract/acquisition-source";
import { labelFactsOf, type LabelFacts } from "./label-facts.js";

interface LabelDB {
  core_scan_inbox_items: {
    id: string;
    status: string;
    quantity: number | null;
    suggested_name: string | null;
    suggested_candidates: unknown;
    suggested_metadata: unknown;
    updated_at: Date;
  };
}

/** What a label would change on a row. `lot` and `year_made` are row facts,
 *  per unit, filed by role (lot-field.ts). */
export type LabelChange = { quantity?: number; lot?: string; year_made?: string; fields: Record<string, string> };

type Row = { quantity: number | null; suggested_name: string | null; suggested_candidates?: unknown; suggested_metadata: unknown };

/** The label facts that would change this row, the person's own values left
 *  out. Pure. The lot is a row fact (`lot`): routing seeds it into the
 *  destination's lot-role field, and filing fills that field when it arrived
 *  after routing (lot-field.ts). */
export function labelChanges(row: Row, facts: LabelFacts): LabelChange {
  const stamps = fieldProvenanceOf(row.suggested_metadata);
  const mine = (k: string) => stamps[k]?.by === "person";
  const cands = Array.isArray(row.suggested_candidates) ? (row.suggested_candidates as Array<{ fields?: Record<string, unknown> }>) : [];
  const have = cands[0]?.fields ?? {};
  const meta = (row.suggested_metadata ?? {}) as Record<string, unknown>;
  const out: LabelChange = { fields: {} };
  if (facts.quantity && facts.quantity !== row.quantity && !mine("quantity")) out.quantity = facts.quantity;
  if (facts.lot && !mine("lot") && meta.lot !== facts.lot) out.lot = facts.lot;
  if (facts.year_made && !mine("year_made") && meta.year_made !== facts.year_made) out.year_made = facts.year_made;
  for (const k of ["colorway", "sku", "pack_code"] as const) {
    const v = facts[k];
    if (!v || mine(k)) continue;
    if (typeof have[k] === "string" && have[k] === v) continue;
    out.fields[k] = v;
  }
  return out;
}

/** The count a row's own observation or name states, the person's count left
 *  alone. Pure; the photo read's transcription is the label's text. */
export function quantityFromLabel(row: Row): number | null {
  const meta = (row.suggested_metadata ?? {}) as Record<string, unknown>;
  const text = `${typeof meta.photo_observations === "string" ? meta.photo_observations : ""} ${row.suggested_name ?? ""}`;
  return labelChanges(row, labelFactsOf(text)).quantity ?? null;
}

/** Write a label's facts onto a pending row, each stamped as read from the
 *  label. `text` is the label's text; without it, the row's own observation.
 *  `read` is what a model already read off the same label in a call it was
 *  making anyway (the scan photo's cross-check); the text's own reading wins
 *  where both have an answer, being the more literal of the two. */
export async function applyLabelFacts(
  db: Kysely<LabelDB>,
  itemId: string,
  text?: string | null,
  read: LabelFacts = {},
): Promise<LabelChange | null> {
  const row = await db
    .selectFrom("core_scan_inbox_items")
    .select(["status", "quantity", "suggested_name", "suggested_candidates", "suggested_metadata"])
    .where("id", "=", itemId)
    .executeTakeFirst();
  if (!row || row.status !== "pending") return null;
  const meta = (row.suggested_metadata ?? {}) as Record<string, unknown>;
  const source = text ?? (typeof meta.photo_observations === "string" ? meta.photo_observations : null);
  const change = labelChanges(row, { ...read, ...labelFactsOf(source) });
  if (change.quantity == null && change.lot == null && change.year_made == null && Object.keys(change.fields).length === 0) return null;
  const at = new Date().toISOString();
  const stamps: FieldProvenanceMap = { ...fieldProvenanceOf(meta) };
  if (change.quantity != null) stamps.quantity = { by: "evidence", from: "label", at };
  if (change.lot != null) stamps.lot = { by: "evidence", from: "label", at };
  if (change.year_made != null) stamps.year_made = { by: "evidence", from: "label", at };
  for (const k of Object.keys(change.fields)) stamps[k] = { by: "evidence", from: "label", at };
  const cands = Array.isArray(row.suggested_candidates) ? [...(row.suggested_candidates as Array<{ fields?: Record<string, unknown> }>)] : [];
  if (cands[0] && Object.keys(change.fields).length) cands[0] = { ...cands[0], fields: { ...(cands[0].fields ?? {}), ...change.fields } };
  await db
    .updateTable("core_scan_inbox_items")
    .set({
      ...(change.quantity != null ? { quantity: change.quantity } : {}),
      ...(cands[0] && Object.keys(change.fields).length ? { suggested_candidates: JSON.stringify(cands) as never } : {}),
      suggested_metadata: sql`coalesce(suggested_metadata, '{}'::jsonb) || ${JSON.stringify({
        [FIELD_PROVENANCE_KEY]: stamps,
        ...(change.lot != null ? { lot: change.lot } : {}),
        ...(change.year_made != null ? { year_made: change.year_made } : {}),
        ...(cands[0] ? {} : { label_facts: change.fields }),
      })}::jsonb` as never,
      updated_at: new Date(),
    })
    .where("id", "=", itemId)
    .execute();
  return change;
}
