// Where a thing is kept: every place, its own count and minimum, and "keep it
// somewhere else too". On any record's detail, the card's or a place's, since
// both belong to one thing. See docs/design-decisions/holdings-and-units.md.

import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useConfirm, useToast } from "@cobblr/platform-web";
import { useInventory } from "./context";
import { HoldingRows, RollupLine } from "./HoldingRows";
import type { HoldingRow } from "./api";

export function HoldingsPanel({ partId, unit }: { partId: string; unit?: string }) {
  const { api, basePath } = useInventory();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [adding, setAdding] = useState(false);
  const [locationId, setLocationId] = useState("");
  const [qty, setQty] = useState("");
  const [min, setMin] = useState("");

  const holdings = useQuery({ queryKey: ["inventory-holdings", partId], queryFn: () => api.listHoldings(partId) });
  const locs = useQuery({ queryKey: ["inventory-locations"], queryFn: () => api.listLocations() });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["inventory-holdings"] });
    void qc.invalidateQueries({ queryKey: ["inventory-parts"] });
    void qc.invalidateQueries({ queryKey: ["inventory-part"] });
  };

  const cardId = holdings.data?.card_id ?? partId;
  const add = useMutation({
    mutationFn: () =>
      api.addHolding(cardId, {
        location_id: locationId,
        qty: qty.trim() === "" ? 0 : Number(qty),
        min_qty: min.trim() === "" ? null : Number(min),
      }),
    onSuccess: () => {
      setAdding(false);
      setLocationId("");
      setQty("");
      setMin("");
      refresh();
      toast.success("Kept there too.");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't add that place."),
  });
  const split = useMutation({
    mutationFn: (row: HoldingRow) => api.splitHolding(cardId, row.id),
    onSuccess: () => {
      refresh();
      toast.success("That place is its own record now.");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't split it out."),
  });

  const rows = holdings.data?.rows ?? [];
  const held = new Set(rows.map((r) => r.location_id).filter(Boolean));
  const several = rows.length > 1;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (locationId) add.mutate();
  };

  return (
    <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-5 space-y-3" data-testid="holdings-panel">
      <div className="text-[10px] font-mono uppercase tracking-widest text-accent">// where it's kept</div>
      {cardId !== partId && (
        <div className="text-xs text-muted dark:text-slate-400">
          One place of{" "}
          <Link to={`${basePath}/parts/${cardId}`} className="text-accent hover:underline">
            the whole item
          </Link>
          .
        </div>
      )}
      {several && holdings.data?.rollup && <RollupLine rollup={holdings.data.rollup} unit={unit} />}
      {rows.length > 0 && (
        <HoldingRows
          rows={rows}
          basePath={basePath}
          onSplit={async (row) => {
            const ok = await confirm({
              title: "Split this place into its own record?",
              message: `${row.location_name ?? "This place"} keeps its count, minimum and history, and stops being part of this item. You can combine them again later.`,
              confirmLabel: "Split into its own",
            });
            if (ok) split.mutate(row);
          }}
        />
      )}
      {!adding ? (
        <button type="button" onClick={() => setAdding(true)} className="text-xs text-accent hover:underline">
          + Keep it somewhere else too
        </button>
      ) : (
        <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col text-[11px] text-muted dark:text-slate-400 min-w-[10rem] flex-1">
            Place
            <select value={locationId} onChange={(e) => setLocationId(e.target.value)} className="input text-sm" aria-label="Place">
              <option value="">Choose a place</option>
              {(locs.data?.items ?? []).map((l) => (
                <option key={l.id} value={l.id} disabled={held.has(l.id)}>
                  {"  ".repeat(l.depth)}
                  {l.name}
                  {held.has(l.id) ? " (already here)" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col text-[11px] text-muted dark:text-slate-400 w-20">
            How many
            <input className="input text-sm" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="0" aria-label="How many" />
          </label>
          <label className="flex flex-col text-[11px] text-muted dark:text-slate-400 w-20">
            Min
            <input className="input text-sm" inputMode="decimal" value={min} onChange={(e) => setMin(e.target.value)} placeholder="—" aria-label="Minimum there" />
          </label>
          <button
            type="submit"
            disabled={!locationId || add.isPending}
            className="rounded-md bg-cobble-600 hover:bg-cobble-500 text-white text-xs font-medium px-3 py-1.5 transition disabled:opacity-50"
          >
            {add.isPending ? "Adding…" : "Add"}
          </button>
          <button type="button" onClick={() => setAdding(false)} className="text-xs text-muted hover:text-accent px-1 py-1.5">
            Cancel
          </button>
        </form>
      )}
    </div>
  );
}
