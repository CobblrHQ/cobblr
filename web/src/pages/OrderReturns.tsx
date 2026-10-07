// Returns on an order, on the order itself (#4250).
//
// A return used to exist only as entries the store's email ingest wrote into
// the order's metadata: nothing showed it and nobody could start one. Here an
// arrived order can start a return on a line (how many, and why), each return
// shows where it has got to as a row of stage pills, and the next stage is
// one tap on its pill. Refunded asks the amount, prefilled with what the
// returned items cost. A store's emails land on the same row as they arrive.
//
// The consequences are the server's, once each (purchases/src/returns.ts):
// the count leaves the shelf when the store has it, and the refund comes off
// the order's total, so this page only says so.

import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Undo2 } from "lucide-react";
import { MoneyInput, useToast } from "@cobblr/platform-web";
import { formatStoredMoney, roundMoneyAmount } from "@cobblr/platform-contract/money";
import { ApiError, api, type Order, type OrderItem, type OrderReturn, type ReturnStage } from "../lib/api";

const STEPS: Array<{ stage: Exclude<ReturnStage, "cancelled">; label: string; press: string }> = [
  { stage: "requested", label: "Started", press: "Started" },
  { stage: "dropped_off", label: "Dropped off", press: "Mark dropped off" },
  { stage: "received", label: "Received by store", press: "Mark received by the store" },
  { stage: "refunded", label: "Refunded", press: "Record the refund" },
];
const RANK: Record<ReturnStage, number> = { requested: 0, dropped_off: 1, received: 2, refunded: 3, cancelled: -1 };

const returnsKey = (slug: string, orderId: string) => ["order-returns", slug, orderId];

/** What a line can still send back: its count less the returns not cancelled. */
export function returnableQty(item: Pick<OrderItem, "id" | "qty">, returns: OrderReturn[]): number {
  const out = returns.filter((r) => r.line_id === item.id && r.stage !== "cancelled").reduce((s, r) => s + r.qty, 0);
  return Math.max(0, Number(item.qty) - out);
}

/** The button a line carries on an arrived order. */
export function StartReturnButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-label="Start a return for this line" title="Start a return" className="p-1.5 rounded text-faint hover:text-accent hover:bg-subtle dark:hover:bg-slate-800">
      <Undo2 size={13} />
    </button>
  );
}

export function OrderReturns({
  slug,
  order,
  items,
  startLine,
  onStartLine,
}: {
  slug: string;
  order: Order;
  items: OrderItem[];
  /** The line a return is being started for; "" opens the form with none chosen. */
  startLine: string | null;
  onStartLine: (lineId: string | null) => void;
}) {
  const returns = useQuery({ queryKey: returnsKey(slug, order.id), queryFn: () => api.listOrderReturns(slug, order.id) });
  const list = returns.data?.items ?? [];
  const arrived = order.status === "arrived";
  const returnable = items.filter((it) => returnableQty(it, list) > 0);

  if (!list.length && startLine === null) {
    if (!arrived || !returnable.length) return null;
    return (
      <button type="button" onClick={() => onStartLine("")} className="inline-flex items-center gap-1.5 text-xs font-medium text-accent hover:underline">
        <Undo2 size={13} /> Start a return
      </button>
    );
  }

  return (
    <section aria-label="Returns" data-testid="order-returns">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[10px] font-mono uppercase tracking-widest text-accent">// returns ({list.length})</div>
        {arrived && returnable.length > 0 && startLine === null && (
          <button type="button" onClick={() => onStartLine("")} className="inline-flex items-center gap-1.5 text-xs font-medium text-accent hover:underline">
            <Undo2 size={13} /> Start a return
          </button>
        )}
      </div>
      {startLine !== null && <StartReturnForm slug={slug} order={order} items={returnable} returns={list} lineId={startLine} onDone={() => onStartLine(null)} />}
      <ul className="space-y-2">
        {list.map((r) => (
          <ReturnRow key={r.id} slug={slug} order={order} ret={r} line={items.find((it) => it.id === r.line_id) ?? null} />
        ))}
      </ul>
    </section>
  );
}

function StartReturnForm({ slug, order, items, returns, lineId, onDone }: { slug: string; order: Order; items: OrderItem[]; returns: OrderReturn[]; lineId: string; onDone: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [line, setLine] = useState(lineId || (items.length === 1 ? items[0]!.id : ""));
  const chosen = items.find((it) => it.id === line) ?? null;
  const max = chosen ? returnableQty(chosen, returns) : 0;
  const [qty, setQty] = useState("1");
  const [reason, setReason] = useState("");
  const start = useMutation({
    mutationFn: () => api.startOrderReturn(slug, order.id, { line_id: line, qty: Number(qty), reason: reason.trim() || null }),
    onSuccess: (out) => {
      void qc.invalidateQueries({ queryKey: returnsKey(slug, order.id) });
      void qc.invalidateQueries({ queryKey: ["order", slug, order.id] });
      toast.success(out.created ? "Return started." : "That line already has a return open.");
      onDone();
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Couldn't start the return."),
  });
  const ok = !!chosen && Number(qty) > 0 && Number(qty) <= max;
  function submit(e: FormEvent) {
    e.preventDefault();
    if (ok) start.mutate();
  }
  return (
    <form onSubmit={submit} aria-label="Start a return" className="mb-3 rounded-lg border border-line dark:border-slate-700 p-3 space-y-2">
      <label className="block">
        <span className="block text-xs text-muted mb-1">Which item</span>
        <select value={line} onChange={(e) => setLine(e.target.value)} className="input">
          {!line && <option value="">Choose a line</option>}
          {items.map((it) => (
            <option key={it.id} value={it.id}>
              {it.description || "Item"} ({returnableQty(it, returns)} can go back)
            </option>
          ))}
        </select>
      </label>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <label className="block">
          <span className="block text-xs text-muted mb-1">How many</span>
          <input type="number" inputMode="decimal" min="0" max={max || undefined} step="any" value={qty} onChange={(e) => setQty(e.target.value)} className="input" />
        </label>
        <label className="block sm:col-span-2">
          <span className="block text-xs text-muted mb-1">Why (optional)</span>
          <input value={reason} onChange={(e) => setReason(e.target.value)} className="input" placeholder="Wrong size" />
        </label>
      </div>
      {chosen && Number(qty) > max && <p className="text-xs text-ember-600 dark:text-ember-300">Only {max} of this line can still go back.</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onDone} className="px-3 py-1.5 rounded-md text-sm text-content dark:text-slate-300 hover:bg-subtle dark:hover:bg-slate-800">
          Cancel
        </button>
        <button type="submit" disabled={!ok || start.isPending} className="px-3 py-1.5 rounded-md text-sm font-medium bg-cobble-600 hover:bg-cobble-700 text-white disabled:opacity-50">
          {start.isPending ? "Starting…" : "Start return"}
        </button>
      </div>
    </form>
  );
}

function ReturnRow({ slug, order, ret, line }: { slug: string; order: Order; ret: OrderReturn; line: OrderItem | null }) {
  const qc = useQueryClient();
  const toast = useToast();
  const money = (v: number | null) => formatStoredMoney(v, "amount", { currency: order.currency });
  const each = line?.unit_cost != null ? Number(line.unit_cost) : null;
  const [asking, setAsking] = useState(false);
  const [amount, setAmount] = useState<number | null>(ret.refund_amount ?? (each != null ? roundMoneyAmount(each * ret.qty, order.currency ?? "USD") : null));
  const advance = useMutation({
    mutationFn: (body: { stage: ReturnStage; refund_amount?: number | null }) => api.advanceOrderReturn(slug, ret.id, body),
    onSuccess: (out, body) => {
      void qc.invalidateQueries({ queryKey: returnsKey(slug, order.id) });
      void qc.invalidateQueries({ queryKey: ["order", slug, order.id] });
      void qc.invalidateQueries({ queryKey: ["orders", slug] });
      setAsking(false);
      if (!out.moved) toast.success("That return was already further along.");
      else if (body.stage === "received") toast.success(out.return?.off_shelf && line?.part_id ? "Received by the store. Its count came off the shelf." : "Received by the store.");
      else if (body.stage === "refunded") toast.success("Refund recorded. It comes off what this order cost.");
      else if (body.stage === "cancelled") toast.success("Return cancelled.");
      else toast.success("Return updated.");
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Couldn't update the return."),
  });
  const rank = RANK[ret.stage];
  const fromEmail = ret.history.some((h) => h.source === "email");
  const cancelled = ret.stage === "cancelled";

  return (
    <li style={{ listStyle: "none" }} className="rounded-lg border border-line dark:border-slate-700 p-2.5 space-y-2" data-testid="order-return" data-stage={ret.stage}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-sm text-content dark:text-mortar-100 min-w-0 break-words">{ret.item || line?.description || "Item"}</span>
        <span className="font-mono text-xs text-muted">× {ret.qty}</span>
        {ret.reason && <span className="text-xs text-muted">· {ret.reason}</span>}
        {fromEmail && <span className="text-[10px] text-faint">· from the store's email</span>}
      </div>
      {cancelled ? (
        <span className="inline-block px-2 py-0.5 rounded-full text-xs bg-subtle text-muted dark:bg-slate-800 dark:text-slate-400" data-testid="return-stage">
          Cancelled
        </span>
      ) : (
        <ol className="flex flex-wrap gap-1.5" aria-label="Where the return has got to">
          {STEPS.map((s, i) => {
            const done = i <= rank;
            const next = i === rank + 1;
            const base = "px-2 py-0.5 rounded-full text-xs border transition";
            if (done) {
              return (
                <li key={s.stage} className={`${base} border-moss-300 bg-moss-100 text-moss-800 dark:border-moss-700 dark:bg-moss-700/40 dark:text-moss-100`} aria-current={i === rank ? "step" : undefined} data-testid={i === rank ? "return-stage" : undefined}>
                  {s.label}
                </li>
              );
            }
            if (next) {
              return (
                <li key={s.stage}>
                  <button
                    type="button"
                    disabled={advance.isPending}
                    onClick={() => (s.stage === "refunded" ? setAsking(true) : advance.mutate({ stage: s.stage }))}
                    className={`${base} border-accent text-accent hover:bg-subtle dark:hover:bg-slate-800 disabled:opacity-50`}
                    aria-label={s.press}
                  >
                    {s.label}
                  </button>
                </li>
              );
            }
            return (
              <li key={s.stage} className={`${base} border-line text-faint dark:border-slate-700`}>
                {s.label}
              </li>
            );
          })}
        </ol>
      )}
      {asking && (
        <form
          aria-label="Record the refund"
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            advance.mutate({ stage: "refunded", refund_amount: amount });
          }}
        >
          <label className="block">
            <span className="block text-xs text-muted mb-1">Refund</span>
            <MoneyInput currency={order.currency} value={amount} storage="amount" live onCommit={setAmount} ariaLabel="Refund amount" />
          </label>
          <button type="submit" disabled={advance.isPending} className="px-3 py-1.5 rounded-md text-sm font-medium bg-cobble-600 hover:bg-cobble-700 text-white disabled:opacity-50">
            Record refund
          </button>
          <button type="button" onClick={() => setAsking(false)} className="px-3 py-1.5 rounded-md text-sm text-content dark:text-slate-300 hover:bg-subtle dark:hover:bg-slate-800">
            Not yet
          </button>
        </form>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
        <span>
          {ret.stage === "refunded" && ret.refund_amount != null ? `Refunded ${money(ret.refund_amount)}` : ret.off_shelf ? "Off the shelf" : cancelled ? "" : "Still counted on the shelf until the store has it"}
        </span>
        {(ret.stage === "requested" || ret.stage === "dropped_off") && (
          <button type="button" disabled={advance.isPending} onClick={() => advance.mutate({ stage: "cancelled" })} className="text-xs text-faint hover:text-ember-500">
            Cancel return
          </button>
        )}
      </div>
    </li>
  );
}
