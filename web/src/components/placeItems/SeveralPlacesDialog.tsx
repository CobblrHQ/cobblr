// A thing kept in several places (#3798), dropped on one more. Moving it
// silently would have to guess: all of it, some of it from one of its places,
// or a new place beside the others. So it asks, and nothing moves until the
// person says which. Each answer goes through the holdings door.

import { useState } from "react";
import { Minus, Plus } from "lucide-react";
import { Modal } from "@cobblr/platform-web";
import type { PlaceableRecord } from "../../lib/placeableRecords";

import { countOf } from "@cobblr/platform-contract/plural";
export type SeveralPlacesAnswer =
  | { kind: "all" }
  | { kind: "some"; fromHoldingId: string; fromLocationId: string | null; qty: number }
  | { kind: "add"; qty: number };

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : String(parseFloat(n.toFixed(3)));
}

export function SeveralPlacesDialog({
  record,
  placeName,
  busy,
  onAnswer,
  onClose,
}: {
  record: PlaceableRecord;
  /** Where it was dropped, in full ("Garage › Blue toolbox › Drawer 3"). */
  placeName: string;
  busy: boolean;
  onAnswer: (a: SeveralPlacesAnswer) => void;
  onClose: () => void;
}) {
  const holdings = record.holdings ?? [];
  const total = holdings.reduce((n, h) => n + h.qty, 0);
  const [from, setFrom] = useState(holdings[0]?.id ?? "");
  const source = holdings.find((h) => h.id === from) ?? holdings[0];
  const [qty, setQty] = useState(1);
  const [addQty, setAddQty] = useState(1);
  const max = source?.qty ?? 0;
  const step = (set: (f: (n: number) => number) => void, d: number, hi: number) => set((n) => Math.min(Math.max(1, n + d), hi));
  const btn = "w-9 h-9 grid place-items-center rounded-md border border-line dark:border-slate-600 disabled:opacity-30";

  return (
    <Modal open onClose={onClose} title={`${record.name} is kept in ${countOf(holdings.length, "place")}`} subtitle={`Dropped on ${placeName}`} size="sm">
      <div className="space-y-4 text-sm" data-testid="several-places">
        <ul className="text-xs text-muted dark:text-slate-400 space-y-0.5">
          {holdings.map((h) => (
            <li key={h.id}>
              {fmt(h.qty)} in {h.location_name ?? "no place yet"}
            </li>
          ))}
        </ul>

        <button
          type="button"
          disabled={busy}
          onClick={() => onAnswer({ kind: "all" })}
          className="w-full rounded-md bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-2 font-medium disabled:opacity-50"
        >
          Move all {fmt(total)} here
        </button>

        <div className="rounded-md border border-line dark:border-slate-700 p-3 space-y-2">
          <div className="font-medium text-content dark:text-mortar-100">Move some</div>
          {holdings.length > 1 && (
            <label className="flex items-center gap-2 text-xs text-muted">
              from
              <select value={from} onChange={(e) => { setFrom(e.target.value); setQty(1); }} className="input !py-1 text-sm flex-1">
                {holdings.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.location_name ?? "no place yet"} ({fmt(h.qty)})
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="flex items-center gap-2">
            <button type="button" className={btn} aria-label="Move one fewer" disabled={qty <= 1} onClick={() => step(setQty, -1, max)}>
              <Minus size={14} />
            </button>
            <span className="min-w-[2rem] text-center font-mono tabular-nums">{fmt(qty)}</span>
            <button type="button" className={btn} aria-label="Move one more" disabled={qty >= max} onClick={() => step(setQty, 1, max)}>
              <Plus size={14} />
            </button>
            <button
              type="button"
              disabled={busy || !source || qty > max}
              onClick={() => source && onAnswer({ kind: "some", fromHoldingId: source.id, fromLocationId: source.location_id, qty })}
              className="ml-auto rounded-md border border-cobble-600 text-cobble-700 dark:text-cobble-300 px-3 py-1.5 font-medium disabled:opacity-50"
            >
              Move {fmt(qty)} here
            </button>
          </div>
        </div>

        <div className="rounded-md border border-line dark:border-slate-700 p-3 space-y-2">
          <div className="font-medium text-content dark:text-mortar-100">Add as another place</div>
          <div className="flex items-center gap-2">
            <button type="button" className={btn} aria-label="Count one fewer here" disabled={addQty <= 1} onClick={() => step(setAddQty, -1, 9999)}>
              <Minus size={14} />
            </button>
            <span className="min-w-[2rem] text-center font-mono tabular-nums">{fmt(addQty)}</span>
            <button type="button" className={btn} aria-label="Count one more here" onClick={() => step(setAddQty, 1, 9999)}>
              <Plus size={14} />
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => onAnswer({ kind: "add", qty: addQty })}
              className="ml-auto rounded-md border border-line dark:border-slate-600 px-3 py-1.5 font-medium disabled:opacity-50"
            >
              Keep {fmt(addQty)} here too
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
