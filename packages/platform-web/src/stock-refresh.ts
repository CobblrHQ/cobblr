// After a stock change, every read of that stock is refreshed: the one rule,
// for inventory's screens (useStockWrites) and the app's (a view row's
// stepper, a place's Stock here). Workshop stock reads its remaining by its
// own key (["stock-shape", slug, id]) and kept the old number until a reload
// when a screen refreshed only what it knew (#5811, #5895).

import type { QueryClient } from "@tanstack/react-query";

const STOCK_FAMILIES = new Set(["stock-shape", "stock-at", "inventory-part", "inventory-holdings", "inventory-sheet", "inventory-units", "inventory-consumption"]);
/** Lists a stepper sits on every row of: marked stale, not refetched page by
 *  page on every tap (each stepper patches its own row in place). */
const LISTS = new Set(["inventory-parts", "view-data"]);

/** Refresh every read of the stock these records hold. */
export async function refreshAfterStockChange(qc: QueryClient, ids: readonly string[]): Promise<void> {
  await Promise.all([
    qc.invalidateQueries({
      predicate: (q) => !LISTS.has(String(q.queryKey[0])) && (STOCK_FAMILIES.has(String(q.queryKey[0])) || q.queryKey.some((part) => typeof part === "string" && ids.includes(part))),
    }),
    qc.invalidateQueries({ predicate: (q) => LISTS.has(String(q.queryKey[0])), refetchType: "none" }),
  ]);
}
