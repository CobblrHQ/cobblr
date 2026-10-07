// How a number or money field adds up when records are grouped (#5079).
//
// A group's summary added every number field, so "Length / ball" summed over
// two different yarns (167 + 211 = 378) and "Price each" summed over a shelf
// read as a price. A field says how it adds up, and every summary reads it
// here:
//   sum       added across the group: a count, an amount spent. The default for
//             a number or money field that says nothing.
//   per_unit  a property of ONE item (length per ball, price each). Never added
//             as it is; totalled as value x the kind's quantity, and called a
//             total ("Total length (m)").
//   none      never totalled (a reorder threshold, a year).
// lint:per-unit-fields-say-so refuses a field that reads as per-unit ("/ ball",
// "_per_", "each") but would be summed.

import { z } from "zod";

export const FIELD_AGGREGATES = ["sum", "per_unit", "none"] as const;
export type FieldAggregate = (typeof FIELD_AGGREGATES)[number];
export const FieldAggregateSchema = z.enum(FIELD_AGGREGATES);

/** How this field adds up: its own word, else sum for a number or money
 *  field and nothing for anything else. */
export function aggregateOf(field: { type?: string | null; aggregate?: string | null; money?: unknown }): FieldAggregate {
  if (field.aggregate === "sum" || field.aggregate === "per_unit" || field.aggregate === "none") return field.aggregate;
  return field.type === "number" || field.type === "money" || !!field.money ? "sum" : "none";
}

/** What a per-unit field's total is called: "Length / ball (m)" is
 *  "Total length (m)", "Price each" is "Total price". */
export function totalLabel(label: string): string {
  const stripped = label
    .replace(/\s*\/\s*[^()\s]+/u, "")
    .replace(/\s+(each|per\s+\S+)\b/iu, "")
    .trim();
  const base = stripped || label;
  return `Total ${base.charAt(0).toLowerCase()}${base.slice(1)}`;
}

/** Does this field read as a property of one item? The lint's question; a
 *  field that answers yes must say per_unit or none. */
export function readsPerUnit(field: { name: string; display_label?: string | null }): boolean {
  const label = field.display_label ?? "";
  return /(^|_)per_|_each$|^unit_(cost|price)$/.test(field.name) || /\s\/\s|\beach\b|\bper\s+(unit|item|ball|skein|piece|pack)\b/i.test(label);
}
