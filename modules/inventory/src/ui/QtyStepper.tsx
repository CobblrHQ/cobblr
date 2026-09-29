// The +/- that adjusts stock in place (no modal hop). Each tap writes a signed
// delta through the same stock-adjust ledger the old "Adjust" modal used, so
// history is preserved; it just skips the dialog for the common ±1 case.
//
// Qty is deliberately NOT an editable cell. Every other field on a part is a
// stored value you overwrite, but qty is a LEDGER — it moves by audited signed
// deltas with a reason, and "available" is derived from it. A free-text qty box
// would let a typo silently rewrite stock history with no delta to trace, so
// the stepper is the only inline path and the cell stays locked.
//
// Shared by the detail view and the list table so the two can't drift into
// different write paths for the same number.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Minus, Plus } from "lucide-react";
import { MutationError } from "@cobblr/platform-web";
import { rollupHoldings, type CardRollup } from "@cobblr/platform-contract/holdings";
import { useInventory } from "./context";
import type { HoldingRow } from "./api";
import { withCount, type CountedRow } from "../stock-derived";

/** The slice of a cached parts-list row a stock adjust touches. A card kept in
 *  several places carries its places as `holdings`, and a place's stepper
 *  moves that row and the card's top line. */
type QtyRow = CountedRow & { id: string; holdings?: HoldingRow[]; rollup?: CardRollup };
type QtyPage = { items: QtyRow[] };
type QtyCache = { pages: QtyPage[]; pageParams: unknown[] };

export function QtyStepper({
  partId,
  qty,
  size = "lg",
}: {
  partId: string;
  qty: number;
  /** "lg" on the detail hero, "sm" in a table row. */
  size?: "lg" | "sm";
}) {
  const { api } = useInventory();
  const qc = useQueryClient();
  const adjust = useMutation({
    mutationFn: (delta: number) => api.stockAdjust(partId, delta),
    onSuccess: (resp) => {
      // Patch the row in place: the list is an INFINITE query, and this stepper
      // sits on every row — invalidating the list would refetch every loaded
      // page per tap. The row is redrawn through withCount, the rules the list
      // endpoint derives with, so Available, on hand and low move with the
      // count; the list is marked stale so the next natural refetch converges.
      qc.setQueriesData<QtyCache>({ queryKey: ["inventory-parts"] }, (data) => {
        if (!data?.pages) return data;
        return {
          ...data,
          pages: data.pages.map((pg) => ({
            ...pg,
            items: pg.items.map((it) => {
              let next = it;
              if (it.holdings?.some((h) => h.id === partId)) {
                // Low here is the row's own minimum; what is reserved there
                // arrives with the next refetch, which the stale mark asks for.
                const holdings = it.holdings.map((h) =>
                  h.id === partId ? { ...h, qty: Number(resp.qty), low: h.min_qty != null && Number(resp.qty) <= h.min_qty } : h,
                );
                next = { ...next, holdings, rollup: rollupHoldings(holdings) };
              }
              if (it.id !== partId) return next;
              return withCount(next, Number(resp.qty));
            }),
          })),
        };
      });
      void qc.invalidateQueries({ queryKey: ["inventory-parts"], refetchType: "none" });
      void qc.invalidateQueries({ queryKey: ["inventory-part", partId] });
    },
  });
  const step = (delta: number) => {
    if (adjust.isPending) return;
    adjust.mutate(delta);
  };
  const display = Number.isFinite(qty)
    ? Number.isInteger(qty)
      ? String(qty)
      : String(parseFloat(qty.toFixed(3)))
    : "—";
  const btn =
    size === "lg"
      ? "w-7 h-7"
      : "w-5 h-5";
  const val =
    size === "lg"
      ? "text-lg w-10"
      : "text-sm w-8";
  return (
    // A refused change says why, under the buttons (MutationError): a member
    // without the right to change counts used to press −1 and see nothing.
    <span className="inline-flex flex-col items-start" onClick={(e) => e.stopPropagation()}>
    <span
      className="inline-flex items-center gap-1"
      title="Adjust stock"
      // In a table the row navigates to the record; stepping must not open it.
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        onClick={() => step(-1)}
        disabled={qty <= 0 || adjust.isPending}
        className={`${btn} grid place-items-center rounded-md border border-line dark:border-slate-700 text-muted dark:text-slate-400 hover:text-content dark:hover:text-mortar-100 disabled:opacity-30 disabled:cursor-not-allowed transition`}
        aria-label="Decrease quantity"
      >
        <Minus size={size === "lg" ? 13 : 11} />
      </button>
      <span className={`font-mono ${val} text-center tabular-nums text-content dark:text-mortar-100`}>
        {display}
      </span>
      <button
        type="button"
        onClick={() => step(1)}
        disabled={adjust.isPending}
        className={`${btn} grid place-items-center rounded-md border border-line dark:border-slate-700 text-muted dark:text-slate-400 hover:text-content dark:hover:text-mortar-100 disabled:opacity-30 disabled:cursor-not-allowed transition`}
        aria-label="Increase quantity"
      >
        <Plus size={size === "lg" ? 13 : 11} />
      </button>
    </span>
    <MutationError mutation={adjust} className={size === "lg" ? "mt-1 max-w-xs" : "mt-0.5 max-w-[14rem] text-[11px]"} />
    </span>
  );
}
