// What the customer has paid on an order, on its page (#8838). It only
// records: nothing here moves real money. Payments are a list (a part payment
// or a split between cash and card is several rows); paid and owed are read
// from it by the server (payments.ts, orderMoney), and this says what it answered.
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Modal, NumberField, useToast } from "@cobblr/platform-web";
import { formatStoredMoney } from "@cobblr/platform-contract/money";
import type { SalesApi, SalesOrderDetail } from "./api.js";

const money = (n: number, currency: string) => formatStoredMoney(n, "amount", { currency }) ?? String(n);
const METHODS = ["cash", "card", "other"];

export function PaymentsPanel({ api, order }: { api: SalesApi; order: SalesOrderDetail }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const m = order.money;
  const payments = order.payments ?? [];
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["sales-order", order.id] });
    void qc.invalidateQueries({ queryKey: ["sales-orders"] });
    void qc.invalidateQueries({ queryKey: ["sales-owed"] });
  };
  const undo = useMutation({
    mutationFn: (id: string) => api.undoPayment(order.id, id),
    onSuccess: () => { toast.success("Payment taken back."); refresh(); },
    onError: (e) => toast.error((e as Error).message),
  });
  const payAll = useMutation({
    mutationFn: () => api.recordPayment(order.id, { amount: m!.owed, method: "other" }),
    onSuccess: () => { toast.success("Marked paid."); refresh(); },
    onError: (e) => toast.error((e as Error).message),
  });
  if (!m || order.status === "cancelled") return null;
  const currency = m.currency;
  const label = m.state === "paid" ? "Paid" : m.state === "part" ? "Part paid" : "Not paid";
  return (
    <div data-testid="payments-panel" className="space-y-2 border border-line dark:border-slate-700 rounded p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-[10px] uppercase tracking-widest text-muted">Payment</span>
        <span data-testid="payment-state" className={"text-sm font-medium " + (m.state === "paid" ? "text-moss-700 dark:text-moss-300" : "text-content dark:text-mortar-100")}>{label}</span>
      </div>
      <dl className="text-sm grid grid-cols-[1fr_auto] gap-x-4 gap-y-0.5 tabular-nums">
        <dt className="text-muted">Paid</dt><dd data-testid="paid-amount">{money(m.kept, currency)}</dd>
        <dt className="font-medium">Owed</dt><dd className="font-medium" data-testid="owed-amount">{money(m.owed, currency)}</dd>
      </dl>
      {payments.length > 0 && (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800 text-sm">
          {payments.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5">
              <span className="flex-1 min-w-0">{money(Number(p.amount), currency)} {p.method}<span className="block text-xs text-muted">{p.paid_on}</span></span>
              <button type="button" disabled={undo.isPending} onClick={() => undo.mutate(p.id)} className="text-xs text-muted hover:text-accent underline">Undo</button>
            </li>
          ))}
        </ul>
      )}
      {m.owed > 0 && (
        <div className="flex flex-wrap gap-3">
          <button type="button" onClick={() => setOpen(true)} className="text-xs text-accent hover:underline">Record a payment…</button>
          <button type="button" disabled={payAll.isPending} onClick={() => payAll.mutate()} className="text-xs text-accent hover:underline">Mark paid in full</button>
        </div>
      )}
      {open && <PaymentForm api={api} order={order} currency={currency} onClose={() => setOpen(false)} onDone={refresh} />}
    </div>
  );
}

function PaymentForm({ api, order, currency, onClose, onDone }: { api: SalesApi; order: SalesOrderDetail; currency: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const owed = order.money!.owed;
  const [amount, setAmount] = useState<number | null>(owed);
  const [method, setMethod] = useState("cash");
  const [day, setDay] = useState("");
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => api.recordPayment(order.id, { amount: amount ?? 0, method: method.trim() || "other", ...(day ? { paid_on: day } : {}) }),
    onSuccess: (r) => {
      onDone();
      onClose();
      toast.action("Recorded.", { actionLabel: "Undo", duration: 8000, onAction: async () => { try { await api.undoPayment(order.id, r.payment_id); toast.success("Payment taken back."); } catch (e) { toast.error((e as Error).message); } onDone(); } });
    },
    onError: (e) => setError((e as Error).message),
  });
  const input = "w-full rounded-lg border border-line bg-surface px-3 py-2 text-content dark:border-slate-600";
  return (
    <Modal open onClose={onClose} title="Record a payment" size="sm">
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); setError(null); save.mutate(); }}>
        <label className="block space-y-1">
          <span className="text-sm font-medium">Paid ({currency}, up to {money(owed, currency)})</span>
          <NumberField label={`Paid in ${currency}`} className={input} min={0} max={owed} value={amount} onChange={setAmount} onClear={() => setAmount(null)} />
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium">How</span>
          <input className={input} list="sales-payment-methods" value={method} onChange={(e) => setMethod(e.target.value)} />
          <datalist id="sales-payment-methods">{METHODS.map((x) => <option key={x} value={x} />)}</datalist>
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium">Day (optional, today if empty)</span>
          <input className={input} type="date" value={day} onChange={(e) => setDay(e.target.value)} />
        </label>
        <p className="text-xs text-muted">This only records it: nothing here takes money.</p>
        {error && <p role="alert" className="text-sm text-ember-700 dark:text-ember-300">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-3 py-2 text-sm text-muted">Cancel</button>
          <button type="submit" disabled={save.isPending || !(amount && amount > 0)} className="px-3 py-2 text-sm rounded bg-cobble-600 text-white disabled:opacity-60">Record</button>
        </div>
      </form>
    </Modal>
  );
}
