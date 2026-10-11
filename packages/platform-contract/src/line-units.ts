// An order line's units (#5734). The owner: "The important distinction is
// 10 different things vs qty 10 of the same thing."
//
// - 10 of the same (ten white spools): one row, one record, quantity 10.
//   Scanning a unit counts toward the line's 10; nothing new is made.
// - A pack of 10 different (a multicolour pack): ten rows and ten records,
//   each matched or created on its own.
//
// The line says which, proposed from the evidence (a mixed variant is
// different, anything else the same) and switched by the person in one tap.
// Pure: the card, the routes and the assistant read the same answer.

import { storeVariantOf } from "@cobblr/platform-contract/same-product";
import { isMixedColour } from "@cobblr/platform-contract/store-product";

export type LineUnitsMode = "same" | "different";

export interface LineUnits {
  /** How many units the line holds: the row's quantity. */
  count: number;
  mode: LineUnitsMode;
  /** "person" once someone chose; "evidence" while it is the proposal. */
  by: "person" | "evidence";
}

interface UnitsRow {
  quantity?: number | string | null;
  suggested_name?: string | null;
  suggested_metadata?: unknown;
}

/** What a line holds, or null for a row that is not several of anything. */
export function lineUnitsOf(row: UnitsRow): LineUnits | null {
  const count = Math.round(Number(row.quantity ?? 1));
  if (!Number.isFinite(count) || count < 2) return null;
  const m = (row.suggested_metadata ?? {}) as { line_units?: { mode?: unknown }; description?: unknown; store_product?: { variant?: unknown } };
  if (m.line_units?.mode === "same" || m.line_units?.mode === "different") return { count, mode: m.line_units.mode, by: "person" };
  const words = [typeof m.description === "string" ? m.description : null, row.suggested_name ?? null, typeof m.store_product?.variant === "string" ? m.store_product.variant : null];
  const mixed = words.some((w) => !!w && (storeVariantOf(w)?.options.some(isMixedColour) || isMixedColour(w)));
  return { count, mode: mixed ? "different" : "same", by: "evidence" };
}

/** The words the line shows for its units. */
export function lineUnitsSentence(u: Pick<LineUnits, "count" | "mode">): string {
  return u.mode === "same" ? `${u.count} of the same` : `A pack of ${u.count} different`;
}

/** The other choice's words, for the one-tap switch. */
export function lineUnitsSwitchLabel(u: Pick<LineUnits, "count" | "mode">): string {
  return u.mode === "same" ? `They are ${u.count} different` : `They are all the same`;
}

/** How many of a line's units have arrived: scans that filled a slot, never
 *  more than the line holds. */
export function lineReceivedSentence(received: number, count: number): string {
  return `${Math.min(received, count)} of ${count} received`;
}

/** Whether a scan may fill one of this line's slots: a line of the same
 *  thing with a slot free. A pack of different things is filled by its own
 *  rows, each matched on its own. */
export function lineTakesAUnit(units: LineUnits | null, received: number): boolean {
  return !!units && units.mode === "same" && received < units.count;
}
