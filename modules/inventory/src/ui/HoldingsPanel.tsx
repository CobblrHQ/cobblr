// Where a thing is kept: every place, its own count and minimum, and "keep it
// somewhere else too". On any record's detail, the card's or a place's, since
// both belong to one thing. See docs/design-decisions/holdings-and-units.md.

import { useStockWrites } from "./stock-writes";
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useConfirm, useToast } from "@cobblr/platform-web";
import { useInventory } from "./context";
import { HoldingRows, RollupLine, lotWords } from "./HoldingRows";
import { CombineSuggestionFor } from "./CombineSuggestions";
import type { HoldingRow } from "./api";

type Open = { row: string; form: "restock" | "arrived" } | null;

/** "Restock from…" for one place: pick where it comes from, how many, and
 *  (optionally) which lot; soonest-expiring first when none is chosen. */
function RestockForm({ to, rows, onDone }: { to: HoldingRow; rows: HoldingRow[]; onDone: () => void }) {
  const stock = useStockWrites();
  const toast = useToast();
  const sources = rows.filter((r) => r.id !== to.id && r.qty > 0);
  const [from, setFrom] = useState(sources[0]?.id ?? "");
  const [qty, setQty] = useState("");
  const [lot, setLot] = useState("");
  const src = sources.find((r) => r.id === from);
  const move = useMutation({
    mutationFn: () => {
      const [kind, value] = lot.split(":", 2) as [string, string | undefined];
      return stock.transferStock(from, {
        to_id: to.id,
        qty: Number(qty),
        ...(kind === "lot" && value ? { lot: value } : {}),
        ...(kind === "exp" && value ? { expires_on: value } : {}),
      });
    },
    onSuccess: (r) => {
      toast.success(`Moved ${r.qty} to ${to.location_name ?? "that place"}.`);
      onDone();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't move it."),
  });
  if (!sources.length) return <div className="text-[11px] text-muted pt-1">Nothing is kept anywhere else to restock from.</div>;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (from && Number(qty) > 0) move.mutate();
      }}
      className="flex flex-wrap items-end gap-2 pt-1.5"
      data-testid="restock-form"
    >
      <label className="flex flex-col text-[11px] text-muted dark:text-slate-400 min-w-[8rem] flex-1">
        From
        <select value={from} onChange={(e) => { setFrom(e.target.value); setLot(""); }} className="input text-sm" aria-label="Restock from">
          {sources.map((r) => (
            <option key={r.id} value={r.id}>
              {r.location_name ?? "No place set"} ({r.qty})
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col text-[11px] text-muted dark:text-slate-400 w-20">
        How many
        <input className="input text-sm" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} aria-label="How many to move" />
      </label>
      {(src?.lots?.length ?? 0) > 0 && (
        <label className="flex flex-col text-[11px] text-muted dark:text-slate-400 min-w-[10rem] flex-1">
          Which
          <select value={lot} onChange={(e) => setLot(e.target.value)} className="input text-sm" aria-label="Which lot">
            <option value="">Soonest to expire first</option>
            {src!.lots!.map((l, i) => (
              <option key={i} value={l.lot ? `lot:${l.lot}` : `exp:${l.expires_on}`}>
                {lotWords(l)}
              </option>
            ))}
          </select>
        </label>
      )}
      <button type="submit" disabled={!from || !(Number(qty) > 0) || move.isPending} className="rounded-md bg-cobble-600 hover:bg-cobble-500 text-white text-xs font-medium px-3 py-1.5 transition disabled:opacity-50">
        {move.isPending ? "Moving…" : "Move"}
      </button>
    </form>
  );
}

/** Stock arrived at one place, with the date printed on it and its lot number. */
function ArrivedForm({ at, onDone }: { at: HoldingRow; onDone: () => void }) {
  const stock = useStockWrites();
  const toast = useToast();
  const [qty, setQty] = useState("");
  const [expires, setExpires] = useState("");
  const [lot, setLot] = useState("");
  const receive = useMutation({
    mutationFn: () => stock.receiveLot(at.id, { qty: Number(qty), expires_on: expires || null, lot: lot.trim() || null }),
    onSuccess: () => {
      toast.success(`Added ${qty} at ${at.location_name ?? "that place"}.`);
      onDone();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't add it."),
  });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (Number(qty) > 0) receive.mutate();
      }}
      className="flex flex-wrap items-end gap-2 pt-1.5"
      data-testid="arrived-form"
    >
      <label className="flex flex-col text-[11px] text-muted dark:text-slate-400 w-20">
        How many
        <input className="input text-sm" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} aria-label="How many arrived" />
      </label>
      <label className="flex flex-col text-[11px] text-muted dark:text-slate-400 w-36">
        Expires
        <input type="date" className="input text-sm" value={expires} onChange={(e) => setExpires(e.target.value)} aria-label="Expiry printed on it" />
      </label>
      <label className="flex flex-col text-[11px] text-muted dark:text-slate-400 w-24">
        Lot
        <input className="input text-sm" value={lot} onChange={(e) => setLot(e.target.value)} placeholder="—" aria-label="Lot number" />
      </label>
      <button type="submit" disabled={!(Number(qty) > 0) || receive.isPending} className="rounded-md bg-cobble-600 hover:bg-cobble-500 text-white text-xs font-medium px-3 py-1.5 transition disabled:opacity-50">
        {receive.isPending ? "Adding…" : "Add"}
      </button>
    </form>
  );
}

/** `gone`: the record is marked gone, so nothing arrives at or moves between
 *  its places until it is brought back (#6153). */
export function HoldingsPanel({ partId, unit, gone = false }: { partId: string; unit?: string; gone?: boolean }) {
  const { api, basePath } = useInventory();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<Open>(null);
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
      <CombineSuggestionFor partId={cardId} />
      {several && holdings.data?.rollup && <RollupLine rollup={holdings.data.rollup} unit={unit} />}
      {rows.length > 0 && (
        <HoldingRows
          rows={rows}
          unit={unit}
          onSplit={async (row) => {
            const ok = await confirm({
              title: "Split this place into its own record?",
              // base-noun-ok: "part of", the English phrase, not the kind
              message: `${row.location_name ?? "This place"} keeps its count, minimum and history, and stops being part of this item. You can combine them again later.`,
              confirmLabel: "Split into its own",
            });
            if (ok) split.mutate(row);
          }}
          actions={(row) => {
            if (gone) return null;
            const toggle = (form: "restock" | "arrived") =>
              setOpen((o) => (o && o.row === row.id && o.form === form ? null : { row: row.id, form }));
            const done = () => {
              setOpen(null);
              refresh();
            };
            return (
              <div>
                <div className="flex gap-3 text-[11px]">
                  {several && (
                    <button type="button" onClick={() => toggle("restock")} className="text-accent hover:underline">
                      Restock from…
                    </button>
                  )}
                  <button type="button" onClick={() => toggle("arrived")} className="text-accent hover:underline">
                    Stock arrived
                  </button>
                </div>
                {open?.row === row.id && open.form === "restock" && <RestockForm to={row} rows={rows} onDone={done} />}
                {open?.row === row.id && open.form === "arrived" && <ArrivedForm at={row} onDone={done} />}
              </div>
            );
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
