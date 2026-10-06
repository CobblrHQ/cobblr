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
import { StockStepper } from "@cobblr/platform-web";
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
  unit,
  label,
  size = "lg",
}: {
  partId: string;
  qty: number;
  /** The unit it is kept in: a measured one (kg, m) is used by amount. */
  unit: string | null | undefined;
  /** What is counted, for the buttons' names ("Black PLA"). */
  label: string;
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
  // The one stepper (platform-web StockStepper): a counted thing steps by one,
  // a thing kept in a measured unit (a spool in kg) takes what was used,
  // never a whole kilogram per tap (#4030).
  return (
    // In a table the row navigates to the record; stepping must not open it.
    <span className="inline-flex" onClick={(e) => e.stopPropagation()}>
      <StockStepper
        fractionDigits={9}
        qty={qty}
        unit={unit}
        label={label}
        size={size === "lg" ? "md" : "sm"}
        onStep={async (delta) => Number((await adjust.mutateAsync(delta)).qty)}
      />
    </span>
  );
}
