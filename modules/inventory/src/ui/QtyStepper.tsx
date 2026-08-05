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
import { useInventory } from "./context";

/** The slice of a cached parts-list row a stock adjust touches. */
type QtyRow = { id: string; qty: number | string; available_qty: number | string };
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
      // page per tap. Available moves by the same delta as qty (it derives as
      // qty minus allocations, which a stock adjust doesn't touch); the list is
      // marked stale so the next natural refetch converges the rest (low_stock).
      qc.setQueriesData<QtyCache>({ queryKey: ["inventory-parts"] }, (data) => {
        if (!data?.pages) return data;
        return {
          ...data,
          pages: data.pages.map((pg) => ({
            ...pg,
            items: pg.items.map((it) => {
              if (it.id !== partId) return it;
              const delta = Number(resp.qty) - Number(it.qty);
              return {
                ...it,
                qty: resp.qty,
                available_qty: Number(it.available_qty) + delta,
              };
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
  );
}
