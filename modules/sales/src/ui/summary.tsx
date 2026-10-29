// A month of sales at a glance (#8786): sold, received, still owed, refunded and
// owed back. One band under the header, for the orders the page is showing (the
// same search, status and month), from the same figures an order's own page
// reads, so they add up to what the file and the orders say.
import { useQuery } from "@tanstack/react-query";
import { formatStoredMoney } from "@cobblr/platform-contract/money";
import { useState } from "react";
import { Link } from "react-router-dom";
import type { MoneySummaryView, SalesApi, SalesOrderStatus } from "./api.js";

const say = (n: number, currency: string) => formatStoredMoney(n, "amount", { currency }) ?? String(n);

export function SalesSummary({ api, orgSlug, q, status, month }: { api: SalesApi; orgSlug: string; q: string; status: SalesOrderStatus | ""; month: string }) {
  const summary = useQuery({ queryKey: ["sales-orders", orgSlug, "summary", q, status, month], queryFn: () => api.ordersSummary({ q, status, month }) });
  const rows = summary.data?.by_currency ?? [];
  if (!summary.data || rows.length === 0) return null;
  return (
    <div data-testid="sales-summary" className="space-y-1.5">
      {rows.map((m) => <SummaryRow key={m.currency} m={m} many={rows.length > 1} />)}
      <WhoOwesYou api={api} orgSlug={orgSlug} />
    </div>
  );
}

function SummaryRow({ m, many }: { m: MoneySummaryView; many: boolean }) {
  const cell = (label: string, value: number, tone?: "bad") => (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-widest text-muted">{label}</div>
      <div className={"text-sm font-semibold tabular-nums " + (tone === "bad" && value > 0 ? "text-ember-700 dark:text-ember-300" : "text-content dark:text-mortar-100")}>{say(value, m.currency)}</div>
    </div>
  );
  return (
    <div className="rounded-lg border border-line dark:border-slate-700 px-3 py-2">
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-5">
        {cell("Sold", m.sold)}
        {cell("Received", m.received)}
        {cell("Owed to you", m.owed)}
        {cell("Refunded", m.refunded)}
        {cell("Refund due", m.refund_due, "bad")}
      </div>
      <p className="mt-1 text-xs text-muted">
        {m.orders} {m.orders === 1 ? "order" : "orders"}{m.cancelled ? `, ${m.cancelled} cancelled (not counted as sold)` : ""}{many ? ` in ${m.currency}` : ""}.
      </p>
    </div>
  );
}

/** The orders behind "Owed to you", oldest first (#8838). */
function WhoOwesYou({ api, orgSlug }: { api: SalesApi; orgSlug: string }) {
  const [open, setOpen] = useState(false);
  const owed = useQuery({ queryKey: ["sales-owed", orgSlug, "list"], queryFn: () => api.owed() });
  const items = owed.data?.items ?? [];
  if (items.length === 0) return null;
  return (
    <div data-testid="who-owes-you">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="text-xs text-accent hover:underline">
        {open ? "Hide who owes you" : `Who owes you (${items.length})`}
      </button>
      {open && (
        <ul className="mt-1 divide-y divide-slate-100 dark:divide-slate-800 rounded-lg border border-line dark:border-slate-700 text-sm">
          {items.map((o) => (
            <li key={o.id}>
              <Link to={`/sales/${o.id}`} className="flex flex-wrap items-baseline gap-x-3 px-3 py-2 hover:bg-subtle dark:hover:bg-slate-800">
                <span className="flex-1 min-w-0">{o.customer_name || "No customer"}<span className="block text-xs text-muted">{o.order_number ?? ""}{o.order_date ? ` · ${o.order_date.slice(0, 10)}` : ""}{o.state === "part" ? " · part paid" : ""}</span></span>
                <span className="font-semibold tabular-nums">{say(o.owed, o.currency)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
