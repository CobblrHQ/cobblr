// The parcels an order went out in, on its page (#9505): each box with its
// carrier, date, what it carries and its tracking number, which a person can
// give it later. Stock taken out and not yet in a box reads "taken from stock"
// until a box is recorded for it. The server decides when the order is shipped
// (every line in a box); this only says what it answered and records boxes.
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Code, useToast } from "@cobblr/platform-web";
import type { SalesApi, SalesOrderDetail } from "./api.js";

export function ParcelsPanel({ api, order }: { api: SalesApi; order: SalesOrderDetail }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [typed, setTyped] = useState("");
  const [fresh, setFresh] = useState("");
  const [adding, setAdding] = useState<string | null>(null);
  const parcels = order.parcels ?? [];
  const waiting = order.items.filter((i) => i.part_id && Number(i.qty_fulfilled) - Number(i.qty_in_parcels ?? 0) > 0);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["sales-order", order.id] });
    void qc.invalidateQueries({ queryKey: ["sales-order-history", order.id] });
    void qc.invalidateQueries({ queryKey: ["sales-orders"] });
  };
  const record = useMutation({
    mutationFn: () => api.addParcel(order.id, { tracking_number: fresh.trim() || null }),
    onSuccess: (r) => { setFresh(""); toast.success(r.shipped ? "Parcel recorded. The order is shipped." : "Parcel recorded. The rest of the order is still open."); refresh(); },
    onError: (e) => toast.error((e as Error).message),
  });
  const track = useMutation({
    mutationFn: (parcelId: string) => api.setParcelTracking(order.id, parcelId, typed.trim()),
    onSuccess: () => { setTyped(""); setAdding(null); toast.success("Tracking number saved."); refresh(); },
    onError: (e) => toast.error((e as Error).message),
  });
  if (order.status === "cancelled" || (parcels.length === 0 && waiting.length === 0)) return null;
  return (
    <div data-testid="parcels-panel" className="space-y-2 border border-line dark:border-slate-700 rounded p-3">
      <span className="block text-[10px] uppercase tracking-widest text-muted">Parcels</span>
      {parcels.length > 0 && (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800 text-sm">
          {parcels.map((p, n) => (
            <li key={p.id} data-testid="parcel" className="py-1.5 space-y-0.5">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium">Parcel {n + 1}</span>
                <span className="text-xs text-muted">{p.carrier ? `${p.carrier}, ` : ""}{new Date(p.shipped_at).toLocaleDateString()}</span>
                {p.delivered_at
                  ? <span className="text-xs text-moss-700 dark:text-moss-300">delivered {new Date(p.delivered_at).toLocaleDateString()}</span>
                  : p.shipment_state && <span className="text-xs text-muted">{p.shipment_state.replace(/_/g, " ")}</span>}
              </div>
              <div className="text-muted">{p.lines.map((l) => `${l.qty} ${l.description ?? "item"}`).join(", ")}</div>
              {p.tracking_number ? (
                <div className="text-xs">Tracking number <Code>{p.tracking_number}</Code></div>
              ) : adding === p.id ? (
                <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (typed.trim()) track.mutate(p.id); }}>
                  <input aria-label="Tracking number" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Tracking number" className="rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-2 py-1 text-sm" />
                  <button type="submit" disabled={track.isPending || !typed.trim()} className="text-xs text-accent hover:underline disabled:opacity-50">Save</button>
                </form>
              ) : (
                <button type="button" onClick={() => { setTyped(""); setAdding(p.id); }} className="text-xs text-accent hover:underline">Add the tracking number</button>
              )}
            </li>
          ))}
        </ul>
      )}
      {waiting.length > 0 && order.status !== "shipped" && order.status !== "closed" && (
        <div className="space-y-1.5">
          <p className="text-sm text-muted">Taken from stock, not in a parcel yet: {waiting.map((i) => `${Number(i.qty_fulfilled) - Number(i.qty_in_parcels ?? 0)} ${i.description ?? "item"}`).join(", ")}.</p>
          <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); record.mutate(); }}>
            <input aria-label="Tracking number for this parcel" value={fresh} onChange={(e) => setFresh(e.target.value)} placeholder="Tracking number (optional)" className="rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-2 py-1 text-sm" />
            <button type="submit" disabled={record.isPending} className="px-3 py-1.5 text-sm rounded border border-line dark:border-slate-600 text-content dark:text-mortar-100 hover:bg-subtle dark:hover:bg-slate-800 disabled:opacity-50">Record a parcel</button>
          </form>
        </div>
      )}
    </div>
  );
}
