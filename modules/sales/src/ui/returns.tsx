// What came back and what was refunded, on the order's page (#8790). It only
// records: nothing here moves real money. A return puts goods back on the shelf,
// a refund is an amount; either may be recorded alone. The rules (what can come
// back, a refund never more than was paid, an exact Undo) are the server's
// (returns.ts); this asks it and says what it answered.
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Modal, NumberField, useToast } from "@cobblr/platform-web";
import { formatStoredMoney, roundMoneyAmount } from "@cobblr/platform-contract/money";
import type { SalesApi, SalesOrderDetail } from "./api.js";

const money = (n: number, currency: string) => formatStoredMoney(n, "amount", { currency }) ?? String(n);

export function ReturnsPanel({ api, order }: { api: SalesApi; order: SalesOrderDetail }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const m = order.money;
  const returns = order.returns ?? [];
  const room = (it: SalesOrderDetail["items"][number]) => Math.max(0, (Number(it.qty_fulfilled) || 0) - (Number(it.qty_returned) || 0));
  const lines = order.items.filter((it) => room(it) > 0);
  const refundable = !!m && m.paid_amount - m.refunded > 0;
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["sales-order", order.id] });
    void qc.invalidateQueries({ queryKey: ["sales-orders"] });
  };
  const undo = useMutation({
    mutationFn: (id: string) => api.undoReturn(order.id, id),
    onSuccess: () => { toast.success("Taken back."); refresh(); },
    onError: (e) => toast.error((e as Error).message),
  });
  if (!m || (lines.length === 0 && returns.length === 0 && !refundable && m.refund_due === 0)) return null;
  const currency = m.currency;
  return (
    <div data-testid="returns-panel" className="space-y-2 border border-line dark:border-slate-700 rounded p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-[10px] uppercase tracking-widest text-muted">Returns and refunds</span>
        {(lines.length > 0 || refundable) && (
          <button type="button" onClick={() => setOpen(true)} className="text-xs text-accent hover:underline">Record a return or refund…</button>
        )}
      </div>
      {m.refund_due > 0 && (
        <p data-testid="refund-due" className="text-sm font-medium text-ember-700 dark:text-ember-300">
          Refund due {money(m.refund_due, currency)}
          <span className="block text-xs font-normal text-muted">{order.status === "cancelled" ? "This order is cancelled and was paid." : "Goods came back on a paid order."} Record the refund once you have sent it; nothing here moves money.</span>
        </p>
      )}
      {(m.refunded > 0 || m.returned_value > 0) && (
        <dl className="text-sm grid grid-cols-[1fr_auto] gap-x-4 gap-y-0.5 tabular-nums">
          <dt className="text-muted">Returned goods</dt><dd>−{money(m.returned_value, currency)}</dd>
          <dt className="text-muted">Refunded</dt><dd data-testid="refunded">−{money(m.refunded, currency)}</dd>
          <dt className="font-medium">Net total</dt><dd className="font-medium" data-testid="net-total">{money(m.net_total, currency)}</dd>
        </dl>
      )}
      {returns.length > 0 && (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800 text-sm">
          {returns.map((r) => {
            const line = order.items.find((i) => i.id === r.line_id);
            return (
              <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5">
                <span className="flex-1 min-w-0">
                  {r.qty ? `${Number(r.qty)} × ${line?.description || "item"} came back` : "Refund"}
                  {r.refund_amount ? `${r.qty ? ", " : ": "}${money(Number(r.refund_amount), currency)} refunded` : ""}
                  {r.reason ? <span className="block text-xs text-muted">{r.reason}</span> : null}
                </span>
                <button type="button" disabled={undo.isPending} onClick={() => undo.mutate(r.id)} className="text-xs text-muted hover:text-accent underline">Undo</button>
              </li>
            );
          })}
        </ul>
      )}
      {open && <ReturnForm api={api} order={order} currency={currency} lines={lines} onClose={() => setOpen(false)} onDone={refresh} />}
    </div>
  );
}

function ReturnForm({ api, order, currency, lines, onClose, onDone }: { api: SalesApi; order: SalesOrderDetail; currency: string; lines: SalesOrderDetail["items"]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [lineId, setLineId] = useState(lines[0]?.id ?? "");
  const line = lines.find((l) => l.id === lineId);
  const room = line ? Math.max(0, (Number(line.qty_fulfilled) || 0) - (Number(line.qty_returned) || 0)) : 0;
  const [qty, setQty] = useState<number | null>(lines.length ? 1 : null);
  const [refund, setRefund] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const price = line?.unit_price ? Number(line.unit_price) : null;
  const m = order.money!;
  const left = Math.max(0, roundMoneyAmount(m.paid_amount - m.refunded, m.currency));
  const save = useMutation({
    mutationFn: () => api.recordReturn(order.id, {
      ...(lines.length && qty !== null && qty > 0 ? { line_id: lineId, qty } : {}),
      ...(refund !== null && refund > 0 ? { refund_amount: refund } : {}),
      ...(reason.trim() ? { reason: reason.trim() } : {}),
    }),
    onSuccess: (r) => {
      onDone();
      onClose();
      toast.action("Recorded.", { actionLabel: "Undo", duration: 8000, onAction: async () => { try { await api.undoReturn(order.id, r.return_id); toast.success("Taken back."); } catch (e) { toast.error((e as Error).message); } onDone(); } });
    },
    onError: (e) => setError((e as Error).message),
  });
  const input = "w-full rounded-lg border border-line bg-surface px-3 py-2 text-content dark:border-slate-600";
  return (
    <Modal open onClose={onClose} title="Record a return or refund" size="sm">
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); setError(null); save.mutate(); }}>
        {lines.length > 0 && (
          <>
            <label className="block space-y-1">
              <span className="text-sm font-medium">What came back</span>
              <select className={input} value={lineId} onChange={(e) => { setLineId(e.target.value); setQty(1); }}>
                {lines.map((l) => <option key={l.id} value={l.id}>{l.description || "item"}</option>)}
              </select>
            </label>
            <label className="block space-y-1">
              <span className="text-sm font-medium">How many{room ? ` (up to ${room})` : ""}</span>
              <NumberField
                label="How many"
                className={input}
                min={0}
                max={room || undefined}
                value={qty}
                onChange={(n) => { setQty(n); if (price !== null && m.paid_amount > 0) setRefund(Math.min(left, roundMoneyAmount(n * price, currency))); }}
                onClear={() => setQty(null)}
              />
            </label>
          </>
        )}
        {m.paid_amount > 0 ? (
          <label className="block space-y-1">
            <span className="text-sm font-medium">Refunded ({currency}, up to {money(left, currency)})</span>
            <NumberField label={`Refunded in ${currency}`} className={input} min={0} max={left} value={refund} onChange={setRefund} onClear={() => setRefund(null)} placeholder="Leave empty if not refunded yet" />
          </label>
        ) : (
          <p className="text-xs text-muted">Nothing has been paid on this order, so there is nothing to refund.</p>
        )}
        <label className="block space-y-1">
          <span className="text-sm font-medium">Why (optional)</span>
          <input className={input} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Chipped, wrong size…" />
        </label>
        <p className="text-xs text-muted">This only records it: nothing here sends money or contacts the customer.</p>
        {error && <p role="alert" className="text-sm text-ember-700 dark:text-ember-300">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-3 py-2 text-sm text-muted">Cancel</button>
          <button type="submit" disabled={save.isPending} className="px-3 py-2 text-sm rounded bg-cobble-600 text-white disabled:opacity-60">Record</button>
        </div>
      </form>
    </Modal>
  );
}
