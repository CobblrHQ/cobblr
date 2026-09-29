// The figures a stock row derives from its count, stated once for the server
// that computes them and the screens that redraw them.
//
// A stepper's −1 used to patch the count and the available figure and leave
// the rest where they were, so a table's Available (read through what is on
// hand) did not move until a reload (#4001). A screen that changes a count
// redraws the row through withCount, the same rules the list endpoint reads
// with, so every derived figure moves together.
//
// Pure, no database: imported by the api (on-hand.ts re-exports it) and by the
// UI.

/** One open unit of a model: what is left in it, in its own unit. */
export interface OpenUnit {
  id: string;
  qty: number;
  unit: string | null;
}

/** What the list and the detail carry for a model with open units. */
export interface OpenUnitsSummary {
  count: number;
  remaining: OpenUnit[];
}

/** The count on hand: unopened plus every open unit still holding something. */
export function onHandCount(qty: number, openUnits: readonly { qty: number }[]): number {
  const base = Number.isFinite(qty) ? Math.max(0, qty) : 0;
  return base + openUnits.filter((u) => u.qty > 0).length;
}

/** Is stock low? At or below the minimum, compared on what is available to
 *  use: on hand minus what is reserved. "Re-buy when down to 1" means the
 *  last one, open or not, is the moment. No minimum, nothing is ever low;
 *  an estimate is never low, its count is 0 because nobody counted, not
 *  because the bin is empty. */
export function isLowStock(input: { onHand: number; assigned?: number; minQty: number | null; approximate?: number | null }): boolean {
  if (input.minQty == null) return false;
  if (input.approximate != null) return false;
  return input.onHand - (input.assigned ?? 0) <= input.minQty;
}

/** What a row shows as Available: what is on hand (the unopened count plus
 *  every open unit still holding something) less what is reserved. An older
 *  api answers without `on_hand`, and then this is the count face's own
 *  figure. */
export function availableOnHand(p: { qty: number | string; available_qty: number | string; on_hand?: number }): number {
  if (typeof p.on_hand !== "number") return Number(p.available_qty);
  return Number(p.available_qty) + (p.on_hand - Number(p.qty));
}

/** The fields of a stock row a count feeds. */
export interface CountedRow {
  qty: number | string;
  available_qty?: number | string;
  assigned_qty?: number | string | null;
  on_hand?: number;
  min_qty?: number | string | null;
  approximate_qty?: number | string | null;
  low_stock?: boolean;
  open_units?: OpenUnitsSummary | null;
}

/** The row after its count moved to `qty`: available, on hand and low redone
 *  the way the list endpoint does it, everything else kept. */
export function withCount<R extends CountedRow>(row: R, qty: number): R {
  const was = Number(row.qty);
  const assigned =
    row.assigned_qty != null ? Number(row.assigned_qty) : row.available_qty != null && Number.isFinite(was) ? was - Number(row.available_qty) : 0;
  const onHand = onHandCount(qty, row.open_units?.remaining ?? []);
  const minQty = row.min_qty != null ? Number(row.min_qty) : null;
  const approximate = row.approximate_qty != null ? Number(row.approximate_qty) : null;
  return {
    ...row,
    qty,
    ...(row.available_qty !== undefined ? { available_qty: qty - assigned } : {}),
    ...(row.on_hand !== undefined ? { on_hand: onHand } : {}),
    ...(row.low_stock !== undefined ? { low_stock: isLowStock({ onHand, assigned, minQty, approximate }) } : {}),
  };
}
