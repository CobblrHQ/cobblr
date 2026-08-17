// /purchases — list of orders with a detail modal that shows the
// order's line items. Same overall shape as MachinesPage /
// AssetsPage. Order items live inside the detail modal (they're a
// child collection, not their own top-level entity).

import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Plus, Receipt, Search, Store, Trash2 } from "lucide-react";
import { ApiError, api, type Order, type OrderItem, type VendorSummary } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { useFieldPresentation } from "../lib/useFieldPresentation";
import { useDetailRoute } from "../lib/useDetailRoute";
import { ReceiptSourceViewer } from "../components/ReceiptSourceViewer";
import { ModuleInstanceChooser } from "../components/ModuleInstanceChooser";
import { ModulePurposeHint } from "../components/ModulePurposeHint";
import { usePublishChatContext } from "../lib/chat-context";
import { BulkActionBar, EntityActionsBar, EntityThumb, Modal, useToast, useConfirm, usePageTitle } from "@cobblr/platform-web";
import { ContributedDetailPanels } from "../panels/registry";
import { receiptGroupSummary } from "./receiptLabel";
import { ReceiptAddressChip } from "../components/ReceiptAddressChip";

function fmtOrderDate(d: string | null): string | null {
  if (!d) return null;
  const dt = new Date(d.length <= 10 ? `${d}T00:00:00` : d);
  return Number.isNaN(dt.getTime()) ? d : dt.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function money(v: string | number | null | undefined): string | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : `$${n.toFixed(2)}`;
}

type SortKey = "vendor" | "ordered_at" | "arrived_at" | "total" | "status" | "items";
const STATUS_ORDER: Record<Order["status"], number> = {
  planned: 0,
  ordered: 1,
  "in-transit": 2,
  arrived: 3,
  cancelled: 4,
};
function sortOrders(list: Order[], sort: { key: SortKey; dir: "asc" | "desc" }): Order[] {
  const dir = sort.dir === "asc" ? 1 : -1;
  const val = (o: Order): string | number => {
    switch (sort.key) {
      case "vendor":
        return (o.vendor ?? "").toLowerCase();
      case "ordered_at":
        return o.ordered_at ?? "";
      case "arrived_at":
        return o.arrived_at ?? "";
      case "total":
        return o.total_cost ? Number(o.total_cost) : -1;
      case "status":
        return STATUS_ORDER[o.status];
      case "items":
        return o.item_count ?? 0;
    }
  };
  return [...list].sort((a, b) => {
    const av = val(a);
    const bv = val(b);
    if (av < bv) return -dir;
    if (av > bv) return dir;
    return 0;
  });
}
function orderHasReceipt(o: Order): boolean {
  return typeof (o.metadata as Record<string, unknown> | null)?.receipt_file_id === "string";
}

function VendorChip({ name }: { name: string | null }) {
  if (!name) return <span className="text-faint">—</span>;
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  return (
    <span className="inline-flex items-center gap-2 min-w-0">
      <span className="grid place-items-center w-5 h-5 rounded bg-accent/85 text-[10px] font-bold text-mortar-50 dark:text-slate-900 shrink-0">
        {initial}
      </span>
      <span className="truncate text-content dark:text-mortar-100 font-medium">{name}</span>
    </span>
  );
}

// Spend insights derived entirely from the orders already loaded — no extra
// fetch. Single-hue bars (brand accent) with the value always labelled, so the
// bar is a quick shape read and the number stays exact.
function PurchasesInsights({ orders }: { orders: Order[] }) {
  const withSpend = orders.filter((o) => o.total_cost != null);
  const totalSpend = withSpend.reduce((s, o) => s + Number(o.total_cost), 0);
  if (totalSpend <= 0) return null;

  const now = new Date();
  const months = Array.from({ length: 6 }, (_, idx) => {
    const d = new Date(now.getFullYear(), now.getMonth() - (5 - idx), 1);
    return {
      key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
      label: d.toLocaleDateString(undefined, { month: "short" }),
    };
  });
  const monthTotals: Record<string, number> = {};
  const vendorTotals: Record<string, number> = {};
  for (const o of withSpend) {
    const mk = (o.ordered_at ?? o.created_at).slice(0, 7);
    monthTotals[mk] = (monthTotals[mk] ?? 0) + Number(o.total_cost);
    const vn = o.vendor ?? "(no vendor)";
    vendorTotals[vn] = (vendorTotals[vn] ?? 0) + Number(o.total_cost);
  }
  const maxMonth = Math.max(1, ...months.map((m) => monthTotals[m.key] ?? 0));
  const topVendors = Object.entries(vendorTotals).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const maxVendor = Math.max(1, ...topVendors.map(([, v]) => v));
  const head = "text-[10px] font-mono uppercase tracking-widest text-accent";
  const card = "rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4";

  return (
    <div className="grid md:grid-cols-2 gap-3">
      <div className={card}>
        <div className={head}>// spend, last 6 months</div>
        <div className="flex items-end gap-2 h-28 mt-3">
          {months.map((m) => {
            const total = monthTotals[m.key] ?? 0;
            return (
              <div
                key={m.key}
                className="flex-1 flex flex-col items-center gap-1 h-full justify-end"
                title={`${m.label}: ${money(total) ?? "$0.00"}`}
              >
                <span className="text-[9px] font-mono text-faint">{total > 0 ? `$${Math.round(total)}` : ""}</span>
                <div
                  className="w-full rounded-t bg-accent/80"
                  style={{ height: `${Math.round((total / maxMonth) * 100)}%`, minHeight: total > 0 ? 3 : 0 }}
                />
                <span className="text-[9px] text-faint">{m.label}</span>
              </div>
            );
          })}
        </div>
      </div>
      <div className={card}>
        <div className={head}>// top vendors by spend</div>
        <div className="space-y-2 mt-3">
          {topVendors.map(([name, val]) => (
            <div key={name}>
              <div className="flex justify-between text-xs mb-0.5">
                <span className="truncate text-content dark:text-mortar-100">{name}</span>
                <span className="font-mono text-muted shrink-0 ml-2">{money(val)}</span>
              </div>
              <div className="h-2 rounded bg-subtle dark:bg-slate-800 overflow-hidden">
                <div className="h-full bg-accent/80 rounded" style={{ width: `${Math.round((val / maxVendor) * 100)}%` }} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-3.5 py-2.5">
      <div className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500">{label}</div>
      <div className="text-lg font-bold text-content dark:text-mortar-100 leading-tight mt-0.5">{value}</div>
      {hint && <div className="text-[10px] text-faint mt-0.5">{hint}</div>}
    </div>
  );
}

function SortTh({
  label,
  sortKey,
  sort,
  onSort,
  align = "left",
}: {
  label: string;
  sortKey: SortKey;
  sort: { key: SortKey; dir: "asc" | "desc" };
  onSort: (k: SortKey) => void;
  align?: "left" | "right";
}) {
  const active = sort.key === sortKey;
  return (
    <th className={`px-3 py-2 ${align === "right" ? "text-right" : "text-left"}`}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`inline-flex items-center gap-1 hover:text-content dark:hover:text-mortar-100 transition ${
          align === "right" ? "w-full justify-end" : ""
        } ${active ? "text-content dark:text-mortar-100" : ""}`}
      >
        {label}
        <span className={active ? "" : "opacity-0"}>{sort.dir === "asc" ? "▲" : "▼"}</span>
      </button>
    </th>
  );
}

const STATUSES: Order["status"][] = ["planned", "ordered", "in-transit", "arrived", "cancelled"];

export function PurchasesPage() {
  usePageTitle("Purchases");
  const { activeSlug } = useActiveOrg();
  const navigate = useNavigate();
  const { id } = useParams<{ id?: string }>();

  const orders = useQuery({
    queryKey: ["orders", activeSlug],
    queryFn: () => api.listOrders(activeSlug),
    enabled: !!activeSlug,
  });
  // Purchases instances (named collections of the module). With no base-table
  // orders, present these as a chooser instead of a bare "nothing here" — the
  // aggregate dashboard tile lands here. Same pattern as Machines / Assets.
  const orderInstances = useQuery({
    queryKey: ["instances", activeSlug, "purchases"],
    queryFn: () => api.listInstances(activeSlug, "purchases"),
    enabled: !!activeSlug,
    staleTime: 30_000,
  });
  // Forward-a-receipt address (platform route, works even without Scan enabled),
  // shown here so Purchases is a place you can start a receipt from — not only Scan.
  const receiptAddrQ = useQuery({
    queryKey: ["receipt-address", activeSlug],
    queryFn: () => api.getReceiptAddress(activeSlug),
    enabled: !!activeSlug,
    staleTime: 5 * 60_000,
  });
  const receiptAddress = receiptAddrQ.data?.configured ? receiptAddrQ.data.address : null;
  // Scan-owned pending receipt sessions (imported, not yet confirmed into a PO).
  const modulesQ = useQuery({
    queryKey: ["modules", activeSlug],
    queryFn: () => api.orgModules(activeSlug),
    enabled: !!activeSlug,
    staleTime: 60_000,
  });
  const scanEnabled = (modulesQ.data?.items ?? []).some((m) => m.name === "core-scan" && m.enabled);
  const pendingReceiptsQ = useQuery({
    queryKey: ["pending-receipt-groups", activeSlug],
    queryFn: () => api.getPendingReceiptGroups(activeSlug),
    enabled: !!activeSlug && scanEnabled,
    staleTime: 30_000,
  });
  const pendingReceipts = pendingReceiptsQ.data?.groups ?? [];

  const allRows = orders.data?.items ?? [];
  // Tell Ask Cobb what's on this screen (uses the order module's own statuses).
  const inTransit = allRows.filter((o) => o.status === "in-transit").length;
  const openOrders = allRows.filter(
    (o) => o.status === "planned" || o.status === "ordered" || o.status === "in-transit",
  ).length;
  usePublishChatContext({
    label: "Purchases",
    summary:
      `${allRows.length} order${allRows.length === 1 ? "" : "s"}` +
      (openOrders ? `, ${openOrders} open` : "") +
      (inTransit ? `, ${inTransit} in transit` : ""),
  });
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"" | Order["status"]>("");

  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "ordered_at", dir: "desc" });
  let filtered = allRows;
  if (statusFilter) filtered = filtered.filter((o) => o.status === statusFilter);
  if (query) {
    filtered = filtered.filter((o) =>
      [o.vendor, o.order_number, o.tracking_number, o.notes]
        .filter(Boolean)
        .some((v) => v!.toLowerCase().includes(query.toLowerCase())),
    );
  }
  const rows = sortOrders(filtered, sort);
  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" }));
  // Header stats — open pipeline + spend of what's currently filtered.
  const filteredSpend = filtered.reduce((s, o) => s + (o.total_cost ? Number(o.total_cost) : 0), 0);
  const receiptsCount = allRows.filter(orderHasReceipt).length;

  const [newOpen, setNewOpen] = useState(false);
  const [vendorsOpen, setVendorsOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const qcP = useQueryClient();
  const toastP = useToast();
  const confirmP = useConfirm();
  const bulkDelete = useMutation({
    mutationFn: async (ids: string[]) => {
      for (const id of ids) {
        await api.deleteOrder(activeSlug, id);
      }
    },
    onSuccess: () => {
      toastP.success(`Deleted ${selected.size} order${selected.size === 1 ? "" : "s"}`);
      setSelected(new Set());
      void qcP.invalidateQueries({ queryKey: ["orders", activeSlug] });
    },
    onError: (e) => toastP.error((e as Error).message),
  });
  function toggleRow(id: string, checked: boolean) {
    setSelected((s) => {
      const n = new Set(s);
      if (checked) n.add(id);
      else n.delete(id);
      return n;
    });
  }
  const allChecked = filtered.length > 0 && filtered.every((r) => selected.has(r.id));

  return (
    <div className="space-y-4">
      {/* ONE row, and it yields rather than wraps - the same order of sacrifice
          the scan header uses (interface-principles #6): the search field is the
          elastic member, button labels drop to icons, then the count goes. */}
      <div className="flex items-center gap-2 sm:gap-3 border-b border-line dark:border-slate-700 pb-3 flex-nowrap">
        <h1 className="font-display text-lg sm:text-2xl font-extrabold text-content dark:text-mortar-100 page-title shrink-0">
          purchases
        </h1>
        <span className="hidden sm:inline text-[10px] font-mono text-faint dark:text-slate-500 shrink-0">
          {filtered.length} of {allRows.length}
        </span>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as Order["status"] | "")}
          className="input !py-1 !text-xs !w-24 lg:!w-32 shrink-0"
        >
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        {/* The elastic member: it absorbs the squeeze so the row never wraps. */}
        <div className="relative flex-1 min-w-[5rem]">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-faint pointer-events-none" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="vendor / order# / notes…"
            className="input !py-1 !pl-7 !text-xs !w-full"
          />
        </div>
        {/* Receipt intake belongs WITH the other header controls, not on a line
            of its own: the address was a permanent wall of text under the title,
            and the same chip already carries it on the scan header. Same
            component, so the two cannot drift. */}
        {receiptAddress && <ReceiptAddressChip address={receiptAddress} />}
        <button
          onClick={() => setVendorsOpen(true)}
          className="rounded-md border border-line dark:border-slate-600 hover:bg-subtle dark:hover:bg-slate-800 text-content dark:text-mortar-100 text-sm font-medium px-2.5 lg:px-3 py-2 transition flex items-center gap-1.5 shrink-0"
        >
          <Store size={14} /> <span className="hidden lg:inline">Vendors</span>
        </button>
        <button
          onClick={() => setNewOpen(true)}
          className="rounded-md bg-slate-700 hover:bg-slate-600 text-mortar-50 text-sm font-medium px-2.5 lg:px-3 py-2 transition flex items-center gap-1.5 shrink-0"
        >
          <Plus size={14} /> <span className="hidden lg:inline">New order</span>
        </button>
      </div>

      {pendingReceipts.length > 0 && (
        <button
          type="button"
          onClick={() => navigate("/scan")}
          className="w-full flex items-center gap-3 rounded-xl border border-cobble-300/50 dark:border-cobble-700/50 bg-cobble-50/60 dark:bg-cobble-900/20 px-4 py-3 text-left hover:border-accent transition"
        >
          <Receipt size={18} className="text-accent shrink-0" />
          <span className="flex-1 min-w-0">
            <span className="block text-sm font-medium text-content dark:text-mortar-100">
              {pendingReceipts.length} receipt{pendingReceipts.length === 1 ? "" : "s"} pending confirmation
            </span>
            <span className="block text-xs text-muted dark:text-slate-400 truncate">
              {receiptGroupSummary(pendingReceipts)}  - not yet purchase orders
            </span>
          </span>
          <span className="text-xs font-medium text-accent whitespace-nowrap shrink-0">Review in scan inbox →</span>
        </button>
      )}

      {allRows.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <StatCard label="Orders" value={String(allRows.length)} hint={`${openOrders} open`} />
          <StatCard label="In transit" value={String(inTransit)} />
          <StatCard label="From receipts" value={String(receiptsCount)} />
          <StatCard
            label={statusFilter || query ? "Spend (filtered)" : "Total spend"}
            value={money(filteredSpend) ?? "$0.00"}
            hint={`${filtered.length} order${filtered.length === 1 ? "" : "s"}`}
          />
        </div>
      )}

      {allRows.length > 0 && <PurchasesInsights orders={allRows} />}

      {orders.isSuccess && allRows.length === 0 && <ModulePurposeHint moduleName="purchases" />}

      {allRows.length === 0 && (orderInstances.data?.items.length ?? 0) > 0 ? (
        <ModuleInstanceChooser instances={orderInstances.data!.items} icon={Store} noun="order" />
      ) : (
      <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-subtle/60 dark:bg-slate-800/40 text-[10px] font-mono uppercase tracking-widest text-muted dark:text-slate-400">
            <tr>
              <th className="w-8 px-3 py-2">
                <input
                  type="checkbox"
                  checked={allChecked}
                  onChange={(e) =>
                    setSelected(e.target.checked ? new Set(filtered.map((r) => r.id)) : new Set())
                  }
                  className="accent-cobble-600"
                  aria-label="Select all"
                />
              </th>
              <SortTh label="Vendor" sortKey="vendor" sort={sort} onSort={toggleSort} />
              <th className="text-left px-3 py-2">Order #</th>
              <SortTh label="Status" sortKey="status" sort={sort} onSort={toggleSort} />
              <SortTh label="Ordered" sortKey="ordered_at" sort={sort} onSort={toggleSort} />
              <SortTh label="Arrived" sortKey="arrived_at" sort={sort} onSort={toggleSort} />
              <SortTh label="Items" sortKey="items" sort={sort} onSort={toggleSort} align="right" />
              <SortTh label="Total" sortKey="total" sort={sort} onSort={toggleSort} align="right" />
              <th className="w-6"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line dark:divide-slate-700">
            {rows.map((o) => (
              <tr
                key={o.id}
                onClick={() => navigate(`/purchases/${o.id}`)}
                className="hover:bg-subtle dark:hover:bg-slate-800/40 transition cursor-pointer"
              >
                <td
                  className="px-3 py-2 w-8"
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(o.id)}
                    onChange={(e) => toggleRow(o.id, e.target.checked)}
                    className="accent-cobble-600"
                    aria-label={`Select ${o.vendor || o.order_number}`}
                  />
                </td>
                <td className="px-3 py-2 max-w-[220px]">
                  <VendorChip name={o.vendor} />
                </td>
                <td className="px-3 py-2 text-muted dark:text-slate-400 font-mono text-xs">
                  <span className="inline-flex items-center gap-1.5">
                    {o.order_number || "—"}
                    {orderHasReceipt(o) && (
                      <Receipt size={12} className="text-accent shrink-0" aria-label="Imported from a receipt" />
                    )}
                  </span>
                </td>
                <td className="px-3 py-2">
                  <StatusPill status={o.status} />
                </td>
                <td className="px-3 py-2 text-muted dark:text-slate-400 text-xs whitespace-nowrap">
                  {fmtOrderDate(o.ordered_at) ?? "—"}
                </td>
                <td className="px-3 py-2 text-muted dark:text-slate-400 text-xs whitespace-nowrap">
                  {fmtOrderDate(o.arrived_at) ?? "—"}
                </td>
                <td className="px-3 py-2 text-right text-muted dark:text-slate-400 font-mono text-xs">
                  {o.item_count ?? "—"}
                </td>
                <td className="px-3 py-2 text-right font-mono text-xs text-content dark:text-mortar-200">
                  {money(o.total_cost) ?? "—"}
                </td>
                <td className="px-2 py-2 text-faint dark:text-slate-600">
                  <ChevronRight size={14} />
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={9} className="px-3 py-10 text-center text-xs text-faint italic">
                  {allRows.length === 0
                    ? "No orders yet. Click + new to log one."
                    : "No matches with the current filters."}
                </td>
              </tr>
            )}
          </tbody>
          {rows.length > 0 && (
            <tfoot className="border-t-2 border-line dark:border-slate-700">
              <tr className="text-xs font-mono">
                <td colSpan={6} />
                <td className="px-3 py-2 text-right text-[10px] uppercase tracking-widest text-faint">Total</td>
                <td className="px-3 py-2 text-right font-semibold text-content dark:text-mortar-100">
                  {money(filteredSpend)}
                </td>
                <td />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      )}

      <OrderDetailModal orderId={id ?? null} onClose={() => navigate("/purchases")} />
      <NewOrderModal open={newOpen} onClose={() => setNewOpen(false)} />
      {vendorsOpen && <VendorsModal onClose={() => setVendorsOpen(false)} />}
      <BulkActionBar
        count={selected.size}
        onClear={() => setSelected(new Set())}
        actions={
          <button
            type="button"
            disabled={bulkDelete.isPending}
            onClick={async () => {
              const ok = await confirmP({
                title: `Delete ${selected.size} order${selected.size === 1 ? "" : "s"}?`,
                message: "This removes the rows from the workspace permanently.",
                confirmLabel: "Delete",
                destructive: true,
              });
              if (ok) bulkDelete.mutate(Array.from(selected));
            }}
            className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded text-ember-600 hover:text-ember-700 disabled:opacity-50"
          >
            <Trash2 size={12} /> Delete
          </button>
        }
      />
    </div>
  );
}

function StatusPill({ status }: { status: Order["status"] }) {
  const palette: Record<Order["status"], string> = {
    planned: "bg-subtle text-content dark:bg-slate-800 dark:text-slate-300",
    ordered: "bg-cobble-100 text-accent dark:bg-cobble-700/40 dark:text-cobble-200",
    "in-transit": "bg-moss-100 text-moss-700 dark:bg-moss-700/40 dark:text-moss-200",
    arrived: "bg-moss-200 text-moss-800 dark:bg-moss-700 dark:text-moss-100",
    cancelled: "bg-ember-100 text-ember-700 dark:bg-ember-700/40 dark:text-ember-200",
  };
  return (
    <span className={"inline-block px-1.5 py-0.5 rounded font-mono uppercase tracking-widest text-[9px] " + palette[status]}>
      {status}
    </span>
  );
}

// A clean, paper-styled render of a receipt built from the order's own parsed
// data (vendor, order #, date, line items, totals) — far nicer than dumping the
// raw email body / text source. Stays truthful: any gap between the line-item
// subtotal + shipping and the recorded total shows as a "Tax / other" line so
// the figures always reconcile, and "View original" keeps the raw source one tap
// away for full fidelity (reported 2026-07-26).
function ReceiptRenderModal({
  order,
  onViewOriginal,
  onClose,
}: {
  order: Order & { items: OrderItem[] };
  onViewOriginal: (() => void) | null;
  onClose: () => void;
}) {
  const items = order.items ?? [];
  const subtotal = items.reduce((s, it) => s + (it.unit_cost != null ? Number(it.qty) * Number(it.unit_cost) : 0), 0);
  const shipping = order.shipping_cost != null ? Number(order.shipping_cost) : 0;
  const total = order.total_cost != null ? Number(order.total_cost) : subtotal + shipping;
  const other = total - subtotal - shipping;
  const host = order.url ? order.url.replace(/^https?:\/\//, "").replace(/\/.*$/, "") : null;
  const meta = [host, order.order_number ? `Order #${order.order_number}` : null, fmtOrderDate(order.ordered_at)]
    .filter(Boolean)
    .join("  ·  ");
  return (
    <Modal open onClose={onClose} title="Receipt" size="content">
      <div className="mx-auto w-full max-w-sm rounded-lg bg-[#efe9dc] text-[#33302a] p-6 font-mono shadow-inner">
        <div className="text-lg font-bold tracking-wide">{(order.vendor || "Receipt").toUpperCase()}</div>
        {meta && <div className="text-[11px] text-[#7a7263] mb-4">{meta}</div>}
        {items.length === 0 ? (
          <div className="text-xs text-[#7a7263] italic py-2">No itemised lines were parsed from this receipt.</div>
        ) : (
          <div>
            {items.map((it) => {
              const qty = Number(it.qty);
              const ext = it.unit_cost != null ? qty * Number(it.unit_cost) : null;
              return (
                <div key={it.id} className="flex justify-between gap-3 text-sm border-b border-dotted border-[#bcb4a2] py-1.5">
                  <span className="min-w-0 break-words">
                    {it.description ?? "—"}
                    {qty > 1 ? `  ×${qty}` : ""}
                  </span>
                  <span className="shrink-0 tabular-nums">{ext != null ? ext.toFixed(2) : ""}</span>
                </div>
              );
            })}
          </div>
        )}
        <div className="mt-3 space-y-1 text-xs">
          <div className="flex justify-between">
            <span>Subtotal</span>
            <span className="tabular-nums">{subtotal.toFixed(2)}</span>
          </div>
          {shipping > 0 && (
            <div className="flex justify-between">
              <span>Shipping</span>
              <span className="tabular-nums">{shipping.toFixed(2)}</span>
            </div>
          )}
          {Math.abs(other) >= 0.01 && (
            <div className="flex justify-between">
              <span>Tax / other</span>
              <span className="tabular-nums">{other.toFixed(2)}</span>
            </div>
          )}
          <div className="flex justify-between font-bold text-sm border-t border-[#bcb4a2] pt-1.5 mt-1.5">
            <span>TOTAL</span>
            <span className="tabular-nums">{total.toFixed(2)}</span>
          </div>
        </div>
        {onViewOriginal && (
          <button
            onClick={onViewOriginal}
            className="mt-5 text-[11px] text-[#7a7263] hover:text-[#33302a] underline underline-offset-2"
          >
            View original email / photo
          </button>
        )}
      </div>
    </Modal>
  );
}

function OrderDetailModal({ orderId, onClose }: { orderId: string | null; onClose: () => void }) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const order = useQuery({
    queryKey: ["order", activeSlug, orderId],
    queryFn: () => api.getOrder(activeSlug, orderId!),
    enabled: !!orderId,
  });
  const update = useMutation({
    mutationFn: (patch: Partial<Order>) => api.updateOrder(activeSlug, orderId!, patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["order", activeSlug, orderId] });
      void qc.invalidateQueries({ queryKey: ["orders", activeSlug] });
    },
  });
  // Native-field presentation (relabel + show/hide via bundle/config); no-op
  // until an override exists. Same pattern as AssetsPage.
  const fp = useFieldPresentation("purchases:order");
  const routeFor = useDetailRoute(activeSlug);
  const remove = useMutation({
    mutationFn: () => api.deleteOrder(activeSlug, orderId!),
    onSuccess: () => {
      toast.success("Order deleted.");
      void qc.invalidateQueries({ queryKey: ["orders", activeSlug] });
      onClose();
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Couldn't delete."),
  });
  const [receiptView, setReceiptView] = useState<"none" | "render" | "original">("none");

  const o = order.data;
  const items: OrderItem[] = o?.items ?? [];
  const receiptFileId = typeof o?.metadata?.receipt_file_id === "string" ? (o.metadata.receipt_file_id as string) : null;
  // Reconcile the line items against the order total so a mis-parsed receipt is
  // obvious: Σ(qty × unit) + shipping vs the recorded total.
  const subtotal = items.reduce((s, it) => s + (it.unit_cost != null ? Number(it.qty) * Number(it.unit_cost) : 0), 0);
  const shipping = o?.shipping_cost != null ? Number(o.shipping_cost) : 0;
  const computed = subtotal + shipping;
  const totalNum = o?.total_cost != null ? Number(o.total_cost) : null;
  const reconciles = totalNum != null && Math.abs(totalNum - computed) < 0.01;

  async function handleDelete() {
    if (!o) return;
    const ok = await confirm({
      title: `Delete order from ${o.vendor || "(unknown vendor)"}?`,
      message: `This deletes the order and all ${o.items?.length ?? 0} line item${o.items?.length === 1 ? "" : "s"}. Stock that was already received is NOT rolled back.`,
      confirmLabel: "Delete order",
      destructive: true,
    });
    if (ok) remove.mutate();
  }

  return (
    <>
    {receiptView === "render" && o && (
      <ReceiptRenderModal
        order={o}
        onViewOriginal={receiptFileId ? () => setReceiptView("original") : null}
        onClose={() => setReceiptView("none")}
      />
    )}
    {receiptView === "original" && receiptFileId && (
      <ReceiptSourceViewer slug={activeSlug} fileId={receiptFileId} onClose={() => setReceiptView("none")} />
    )}
    <Modal
      open={!!orderId}
      onClose={onClose}
      title={
        o ? (
          <span className="inline-flex items-baseline gap-1.5">
            <span className="font-bold">{o.vendor || "Order"}</span>
            {o.order_number && (
              <span className="font-mono text-[0.8em] font-medium text-muted dark:text-slate-400">#{o.order_number}</span>
            )}
          </span>
        ) : (
          "loading…"
        )
      }
      subtitle={
        o ? (
          <span className="inline-flex items-center gap-2 flex-wrap">
            {fmtOrderDate(o.ordered_at) && <span>{fmtOrderDate(o.ordered_at)}</span>}
            <StatusPill status={o.status} />
            {money(o.total_cost) && (
              <span className="font-mono text-content dark:text-mortar-100 font-semibold">
                {money(o.total_cost)}
                <span className="text-faint font-normal"> · {items.length} item{items.length === 1 ? "" : "s"}</span>
              </span>
            )}
          </span>
        ) : undefined
      }
      size="lg"
    >
      {o ? (
        <div className="space-y-4">
          <EntityActionsBar entityKind="purchases:order" entityId={o.id} />
          {receiptFileId && (
            <button
              type="button"
              onClick={() => setReceiptView(items.length > 0 ? "render" : "original")}
              className="w-full flex items-center gap-3 rounded-xl border border-line dark:border-slate-700 bg-subtle dark:bg-slate-800/40 px-3.5 py-2.5 text-left hover:border-accent transition"
            >
              <span className="grid place-items-center w-9 h-9 rounded-lg bg-surface dark:bg-slate-900 border border-line dark:border-slate-700 shrink-0">
                <Receipt size={16} className="text-accent" />
              </span>
              <span className="flex-1 min-w-0">
                <span className="block text-sm font-medium text-content dark:text-mortar-100">Receipt{o.vendor ? ` · ${o.vendor}` : ""}</span>
                <span className="block text-xs text-faint">
                  {[fmtOrderDate(o.ordered_at), o.order_number ? `#${o.order_number}` : null, `${items.length} line${items.length === 1 ? "" : "s"}`]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
              <span className="text-xs font-medium text-accent whitespace-nowrap">View receipt →</span>
            </button>
          )}
          <dl className="grid grid-cols-2 gap-3 text-xs">
            {!fp.hidden("vendor") && (
              <div>
                <dt className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">{fp.label("vendor", "Vendor")}</dt>
                <VendorPicker
                  slug={activeSlug}
                  vendorId={o.vendor_id}
                  vendorName={o.vendor ?? ""}
                  onChange={(id, name) => update.mutate({ vendor_id: id, vendor: name || null })}
                />
              </div>
            )}
            {!fp.hidden("order_number") && <EditField label={fp.label("order_number", "Order #")} value={o.order_number ?? ""} onCommit={(v) => update.mutate({ order_number: v || null })} />}
            {!fp.hidden("status") && <EditSelect label={fp.label("status", "Status")} value={o.status} options={STATUSES} onCommit={(v) => update.mutate({ status: v as Order["status"] })} />}
            {!fp.hidden("tracking_number") && <EditField label={fp.label("tracking_number", "Tracking #")} value={o.tracking_number ?? ""} onCommit={(v) => update.mutate({ tracking_number: v || null })} />}
            {!fp.hidden("ordered_at") && <EditField label={fp.label("ordered_at", "Ordered at")} value={o.ordered_at ?? ""} type="date" onCommit={(v) => update.mutate({ ordered_at: v || null })} />}
            {!fp.hidden("expected_arrival") && <EditField label={fp.label("expected_arrival", "Expected arrival")} value={o.expected_arrival ?? ""} type="date" onCommit={(v) => update.mutate({ expected_arrival: v || null })} />}
            {!fp.hidden("arrived_at") && <EditField label={fp.label("arrived_at", "Arrived at")} value={o.arrived_at ?? ""} type="date" onCommit={(v) => update.mutate({ arrived_at: v || null })} />}
            {!fp.hidden("url") && <EditField label={fp.label("url", "URL")} value={o.url ?? ""} type="url" onCommit={(v) => update.mutate({ url: v || null })} />}
            {!fp.hidden("total_cost") && <EditField label={fp.label("total_cost", "Total cost")} value={o.total_cost ?? ""} numeric onCommit={(v) => update.mutate({ total_cost: v ? (v as unknown as string) : null })} />}
            {!fp.hidden("shipping_cost") && <EditField label={fp.label("shipping_cost", "Shipping cost")} value={o.shipping_cost ?? ""} numeric onCommit={(v) => update.mutate({ shipping_cost: v ? (v as unknown as string) : null })} />}
          </dl>
          <EditField label="Notes" value={o.notes ?? ""} multiline onCommit={(v) => update.mutate({ notes: v || null })} />

          {/* Contributed detail panels (e.g. core-shipments' Shipment) — the
              panel registry renders whatever enabled modules declare for
              purchases:order; this page names no contributor. The tracking
              number rides along as a hint because it is the order's, not the
              contributor's, to read. */}
          <ContributedDetailPanels
            target="purchases:order"
            ctx={{
              slug: activeSlug,
              entityId: o.id,
              entityTitle: o.vendor ?? o.order_number ?? "Order",
              hints: { tracking_number: o.tracking_number ?? undefined },
            }}
          />

          <div>
            <div className="text-[10px] font-mono uppercase tracking-widest text-accent mb-2">
              // line items ({items.length})
            </div>
            {items.length === 0 ? (
              <div className="text-xs text-faint italic">No items on this order.</div>
            ) : (
              <>
                <ul className="space-y-1.5">
                  {items.map((it) => (
                    <OrderLineItem key={it.id} slug={activeSlug} item={it} routeFor={routeFor} />
                  ))}
                </ul>
                <div className="mt-3 pt-2.5 border-t border-dashed border-line dark:border-slate-700 space-y-1 text-sm">
                  <div className="flex justify-between text-muted">
                    <span>Subtotal ({items.length} line{items.length === 1 ? "" : "s"})</span>
                    <span className="font-mono">{money(subtotal)}</span>
                  </div>
                  {shipping > 0 && (
                    <div className="flex justify-between text-muted">
                      <span>Shipping</span>
                      <span className="font-mono">{money(shipping)}</span>
                    </div>
                  )}
                  {totalNum != null && (
                    <div className="flex justify-between font-semibold text-content dark:text-mortar-100">
                      <span className="inline-flex items-center gap-2">
                        Total
                        {reconciles ? (
                          <span className="text-[10px] font-mono text-moss-600 dark:text-moss-400">✓ matches</span>
                        ) : (
                          <span className="text-[10px] font-mono text-ember-500" title={`Line items + shipping = ${money(computed)}`}>
                            ⚠ off by {money(Math.abs(totalNum - computed))}
                          </span>
                        )}
                      </span>
                      <span className="font-mono">{money(totalNum)}</span>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          <div className="pt-3 border-t border-line dark:border-slate-700 flex items-center justify-between">
            <button
              onClick={handleDelete}
              className="text-[10px] font-mono uppercase tracking-widest text-faint hover:text-ember-500 transition flex items-center gap-1"
            >
              <Trash2 size={11} /> delete order
            </button>
            <button
              onClick={onClose}
              className="px-3 py-1.5 rounded-md text-sm font-medium text-content dark:text-slate-300 hover:bg-subtle dark:hover:bg-slate-800 transition"
            >
              Close
            </button>
          </div>
        </div>
      ) : (
        <div className="text-xs text-faint">loading…</div>
      )}
    </Modal>
    </>
  );
}

// One order line item: resolves its part (inventory:part) to a live thumbnail +
// name that links to the item's page. If the part was deleted (lookup 404s) the
// line stays visible but is struck through + flagged, never a silent dead row.
function OrderLineItem({
  slug,
  item,
  routeFor,
}: {
  slug: string;
  item: OrderItem;
  routeFor: (kind: string, id: string) => string | null;
}) {
  const resolved = useQuery({
    queryKey: ["entity", slug, "inventory:part", item.part_id],
    queryFn: () => api.lookupEntity(slug, "inventory:part", item.part_id!),
    enabled: !!item.part_id,
    retry: false,
    staleTime: 60_000,
  });
  const ent = resolved.data;
  const partDeleted = !!item.part_id && resolved.isError;
  const name = ent?.title ?? item.description ?? "—";
  const href = ent?.detailUrl ?? (item.part_id ? routeFor("inventory:part", item.part_id) : null);
  const qty = Number(item.qty);
  const unit = item.unit_cost != null ? Number(item.unit_cost) : null;
  const ext = unit != null ? qty * unit : null;

  const inner = (
    <>
      <EntityThumb
        src={partDeleted ? null : (ent?.image_path ?? null)}
        alt={name}
        size={36}
        className="rounded-lg ring-1 ring-line dark:ring-slate-700 shrink-0"
      />
      <span className="flex-1 min-w-0">
        <span className={partDeleted ? "text-faint line-through text-sm" : "text-content dark:text-mortar-100 text-sm"}>{name}</span>
        {partDeleted && (
          <span className="ml-2 text-[9px] font-mono uppercase tracking-wider text-ember-500 border border-ember-500/40 bg-ember-500/10 rounded px-1.5 py-0.5">
            part deleted
          </span>
        )}
      </span>
      <span className="font-mono text-xs text-muted whitespace-nowrap">
        {qty.toFixed(0)} × {unit != null ? `$${unit.toFixed(2)}` : "—"}
      </span>
      <span className="font-mono text-xs text-content dark:text-mortar-100 w-16 text-right shrink-0">
        {ext != null ? `$${ext.toFixed(2)}` : ""}
      </span>
    </>
  );

  const cls =
    "flex items-center gap-3 px-2.5 py-2 rounded-lg border border-line dark:border-slate-700 transition";
  return (
    <li style={{ listStyle: "none" }}>
      {href && !partDeleted ? (
        <Link to={href} className={`${cls} hover:border-accent hover:bg-subtle dark:hover:bg-slate-800/50`}>
          {inner}
        </Link>
      ) : (
        <div className={cls}>{inner}</div>
      )}
    </li>
  );
}

function NewOrderModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [vendorId, setVendorId] = useState<string | null>(null);
  const [vendorName, setVendorName] = useState<string>("");
  const [orderNumber, setOrderNumber] = useState("");
  const [status, setStatus] = useState<Order["status"]>("ordered");
  useEffect(() => {
    if (open) {
      setVendorId(null);
      setVendorName("");
      setOrderNumber("");
      setStatus("ordered");
    }
  }, [open]);

  const create = useMutation({
    mutationFn: () =>
      api.createOrder(activeSlug, {
        vendor_id: vendorId,
        vendor: vendorName.trim() || null,
        order_number: orderNumber.trim() || null,
        status,
      }),
    onSuccess: (o) => {
      toast.success("Order created.");
      void qc.invalidateQueries({ queryKey: ["orders", activeSlug] });
      onClose();
      navigate(`/purchases/${o.id}`);
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Couldn't create."),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    create.mutate();
  }

  return (
    <Modal open={open} onClose={onClose} title="New order" size="sm">
      <form onSubmit={submit} className="space-y-3">
        <label className="block">
          <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">Vendor</span>
          <VendorPicker
            slug={activeSlug}
            vendorId={vendorId}
            vendorName={vendorName}
            onChange={(id, name) => { setVendorId(id); setVendorName(name); }}
          />
        </label>
        <label className="block">
          <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">Order #</span>
          <input value={orderNumber} onChange={(e) => setOrderNumber(e.target.value)} className="input" />
        </label>
        <label className="block">
          <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">Status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value as Order["status"])} className="input">
            {STATUSES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>
        <div className="flex items-center justify-end gap-2 pt-2 border-t border-line dark:border-slate-700">
          <button type="button" onClick={onClose} className="px-3 py-1.5 rounded-md text-sm font-medium text-content dark:text-slate-300 hover:bg-subtle dark:hover:bg-slate-800 transition">
            Cancel
          </button>
          <button type="submit" disabled={create.isPending} className="px-3 py-1.5 rounded-md text-sm font-medium bg-slate-700 hover:bg-slate-600 text-mortar-50 transition disabled:opacity-50">
            {create.isPending ? "Creating…" : "Create"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function EditField({
  label,
  value,
  onCommit,
  numeric,
  multiline,
  type,
}: {
  label: string;
  value: string;
  onCommit: (v: string) => void;
  numeric?: boolean;
  multiline?: boolean;
  type?: string;
}) {
  const Cmp = multiline ? "textarea" : "input";
  return (
    <label className={"block " + (multiline ? "col-span-2" : "")}>
      <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
        {label}
      </span>
      <Cmp
        type={type ?? (numeric ? "number" : "text")}
        defaultValue={value}
        onBlur={(e) => { if (e.target.value !== value) onCommit(e.target.value); }}
        onKeyDown={(e) => { if (!multiline && e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        rows={multiline ? 3 : undefined}
        className="input"
      />
    </label>
  );
}

function EditSelect({
  label,
  value,
  options,
  onCommit,
}: {
  label: string;
  value: string;
  options: readonly string[];
  onCommit: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
        {label}
      </span>
      <select defaultValue={value} onChange={(e) => onCommit(e.target.value)} className="input">
        {options.map((o) => (<option key={o} value={o}>{o}</option>))}
      </select>
    </label>
  );
}

// Vendor combobox for the order form: pick a managed vendor, leave it unlinked,
// or add a new vendor inline. Reports both the id (for linking) and the name
// (dual-written to the order's legacy `vendor` text).
function VendorPicker({
  slug,
  vendorId,
  vendorName,
  onChange,
}: {
  slug: string;
  vendorId: string | null;
  vendorName: string;
  onChange: (vendorId: string | null, vendorName: string) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const vendors = useQuery({ queryKey: ["vendors", slug], queryFn: () => api.listVendors(slug), enabled: !!slug });
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const create = useMutation({
    mutationFn: (name: string) => api.createVendor(slug, { name }),
    onSuccess: (v) => {
      toast.success("Vendor added.");
      void qc.invalidateQueries({ queryKey: ["vendors", slug] });
      setCreating(false);
      setNewName("");
      onChange(v.id, v.name);
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Couldn't add vendor."),
  });

  if (creating) {
    return (
      <div className="flex gap-2">
        <input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Vendor name" className="input flex-1" />
        <button type="button" disabled={!newName.trim() || create.isPending} onClick={() => create.mutate(newName.trim())} className="px-2.5 py-1.5 rounded-md text-xs font-medium bg-slate-700 hover:bg-slate-600 text-mortar-50 disabled:opacity-50">Add</button>
        <button type="button" onClick={() => setCreating(false)} className="px-2.5 py-1.5 rounded-md text-xs text-content dark:text-slate-300 hover:bg-subtle dark:hover:bg-slate-800">Cancel</button>
      </div>
    );
  }

  return (
    <select
      value={vendorId ?? ""}
      onChange={(e) => {
        const val = e.target.value;
        if (val === "__new__") { setCreating(true); return; }
        if (val === "") { onChange(null, ""); return; }
        const v = vendors.data?.items.find((x) => x.id === val);
        onChange(val, v?.name ?? "");
      }}
      className="input"
    >
      <option value="">{vendorName && !vendorId ? `(unlinked: ${vendorName})` : "— none —"}</option>
      {vendors.data?.items.map((v) => (<option key={v.id} value={v.id}>{v.name}</option>))}
      <option value="__new__">+ New vendor…</option>
    </select>
  );
}

// Vendor management surface: list with order-count + spend rollup, add, edit,
// delete. Opened from the Purchases header.
function VendorsModal({ onClose }: { onClose: () => void }) {
  const { activeSlug } = useActiveOrg();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const vendors = useQuery({ queryKey: ["vendors", activeSlug], queryFn: () => api.listVendors(activeSlug), enabled: !!activeSlug });
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const openOrder = (orderId: string) => {
    onClose();
    navigate(`/purchases/${orderId}`);
  };

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["vendors", activeSlug] });
    void qc.invalidateQueries({ queryKey: ["orders", activeSlug] });
  };
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteVendor(activeSlug, id),
    onSuccess: () => { toast.success("Vendor deleted."); invalidate(); },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Couldn't delete."),
  });

  if (viewing) {
    return (
      <Modal open onClose={onClose} title="Vendor" size="md">
        <VendorDetailPane
          slug={activeSlug}
          vendorId={viewing}
          onBack={() => setViewing(null)}
          onOpenOrder={openOrder}
          onChanged={invalidate}
        />
      </Modal>
    );
  }

  return (
    <Modal open onClose={onClose} title="Vendors" size="md">
      <div className="space-y-3">
        {vendors.isLoading && <div className="text-sm text-muted">Loading…</div>}
        {vendors.data?.items.length === 0 && editing !== "new" && (
          <div className="text-sm text-muted italic">No vendors yet. Add the places you buy from to track spend and reuse them across orders.</div>
        )}

        <ul className="space-y-2">
          {vendors.data?.items.map((v) => (
            <li key={v.id}>
              {editing === v.id ? (
                <VendorForm slug={activeSlug} vendor={v} onDone={() => { setEditing(null); invalidate(); }} onCancel={() => setEditing(null)} />
              ) : (
                <div
                  onClick={() => setViewing(v.id)}
                  className="flex items-center gap-3 rounded-lg border border-line dark:border-slate-700 p-3 cursor-pointer hover:border-accent transition"
                >
                  <span className="grid place-items-center w-7 h-7 rounded bg-accent/85 text-xs font-bold text-mortar-50 dark:text-slate-900 shrink-0">
                    {v.name.trim().charAt(0).toUpperCase() || "?"}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-content dark:text-mortar-100 truncate">{v.name}</div>
                    <div className="text-xs text-muted">
                      {v.order_count} order{v.order_count === 1 ? "" : "s"}
                      {v.total_spend > 0 && ` · $${v.total_spend.toFixed(2)} spent`}
                      {v.lead_time_days != null && ` · ~${v.lead_time_days}d lead`}
                    </div>
                  </div>
                  {v.website && (
                    <a href={v.website} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="text-xs text-accent hover:underline shrink-0">site ↗</a>
                  )}
                  <button type="button" onClick={(e) => { e.stopPropagation(); setEditing(v.id); }} className="text-xs text-muted hover:text-accent shrink-0">Edit</button>
                  <button
                    type="button"
                    onClick={async (e) => {
                      e.stopPropagation();
                      if (await confirm({ title: `Delete "${v.name}"?`, message: "Orders linked to this vendor keep their vendor name but lose the link.", confirmLabel: "Delete", destructive: true })) {
                        remove.mutate(v.id);
                      }
                    }}
                    className="text-slate-300 hover:text-red-500 shrink-0"
                    aria-label="Delete vendor"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>

        {editing === "new" ? (
          <VendorForm slug={activeSlug} onDone={() => { setEditing(null); invalidate(); }} onCancel={() => setEditing(null)} />
        ) : (
          <button type="button" onClick={() => setEditing("new")} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md bg-slate-700 hover:bg-slate-600 text-mortar-50">
            <Plus size={14} /> Add vendor
          </button>
        )}
      </div>
    </Modal>
  );
}

function VendorDetailPane({
  slug,
  vendorId,
  onBack,
  onOpenOrder,
  onChanged,
}: {
  slug: string;
  vendorId: string;
  onBack: () => void;
  onOpenOrder: (orderId: string) => void;
  onChanged: () => void;
}) {
  const [edit, setEdit] = useState(false);
  const vendor = useQuery({
    queryKey: ["vendor", slug, vendorId],
    queryFn: () => api.getVendor(slug, vendorId),
    enabled: !!vendorId,
  });
  const v = vendor.data;
  const back = (
    <button onClick={onBack} className="text-xs text-muted hover:text-accent inline-flex items-center gap-1">
      <ChevronRight size={12} className="rotate-180" /> All vendors
    </button>
  );
  if (edit && v) {
    return (
      <div className="space-y-3">
        {back}
        <VendorForm
          slug={slug}
          vendor={v}
          onDone={() => {
            setEdit(false);
            onChanged();
            void vendor.refetch();
          }}
          onCancel={() => setEdit(false)}
        />
      </div>
    );
  }
  return (
    <div className="space-y-4">
      {back}
      {vendor.isLoading || !v ? (
        <div className="text-sm text-muted">Loading…</div>
      ) : (
        <>
          <div className="flex items-center gap-3">
            <span className="grid place-items-center w-10 h-10 rounded-lg bg-accent/85 text-sm font-bold text-mortar-50 dark:text-slate-900 shrink-0">
              {v.name.trim().charAt(0).toUpperCase() || "?"}
            </span>
            <div className="min-w-0">
              <div className="text-lg font-bold text-content dark:text-mortar-100 truncate">{v.name}</div>
              {v.website && (
                <a href={v.website} target="_blank" rel="noreferrer" className="text-xs text-accent hover:underline">
                  {v.website.replace(/^https?:\/\//, "")} ↗
                </a>
              )}
            </div>
            <div className="flex-1" />
            <button onClick={() => setEdit(true)} className="text-xs text-muted hover:text-accent shrink-0">
              Edit
            </button>
          </div>

          <div className="grid grid-cols-3 gap-2">
            <StatCard label="Orders" value={String(v.order_count)} />
            <StatCard label="Total spent" value={money(v.total_spend) ?? "$0.00"} />
            <StatCard label="Lead time" value={v.lead_time_days != null ? `${v.lead_time_days}d` : "—"} />
          </div>

          {(v.account_number || v.contact || v.notes) && (
            <dl className="text-xs space-y-1">
              {v.account_number && (
                <div className="flex gap-2">
                  <dt className="text-faint w-20 shrink-0">Account #</dt>
                  <dd className="text-content dark:text-mortar-100">{v.account_number}</dd>
                </div>
              )}
              {v.contact && (
                <div className="flex gap-2">
                  <dt className="text-faint w-20 shrink-0">Contact</dt>
                  <dd className="text-content dark:text-mortar-100">{v.contact}</dd>
                </div>
              )}
              {v.notes && (
                <div className="flex gap-2">
                  <dt className="text-faint w-20 shrink-0">Notes</dt>
                  <dd className="text-muted">{v.notes}</dd>
                </div>
              )}
            </dl>
          )}

          <div>
            <div className="text-[10px] font-mono uppercase tracking-widest text-accent mb-2">// orders ({v.orders.length})</div>
            {v.orders.length === 0 ? (
              <div className="text-xs text-faint italic">No orders from this vendor yet.</div>
            ) : (
              <ul className="space-y-1">
                {v.orders.map((o) => (
                  // An anchor per order, so anything that knows an order id can
                  // link to THAT order rather than to this page. The browser
                  // does the scrolling; no code needed on this side.
                  <li key={o.id} id={`order-${o.id}`} className="scroll-mt-24">
                    <button
                      type="button"
                      onClick={() => onOpenOrder(o.id)}
                      className="w-full flex items-center gap-3 px-2.5 py-2 rounded-lg border border-line dark:border-slate-700 hover:border-accent hover:bg-subtle dark:hover:bg-slate-800/50 transition text-left"
                    >
                      <span className="font-mono text-xs text-muted w-24 shrink-0 truncate">{o.order_number || "—"}</span>
                      <StatusPill status={o.status} />
                      <span className="text-xs text-muted flex-1 whitespace-nowrap">{fmtOrderDate(o.ordered_at) ?? ""}</span>
                      <span className="font-mono text-xs text-content dark:text-mortar-100">{money(o.total_cost) ?? "—"}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function VendorForm({
  slug,
  vendor,
  onDone,
  onCancel,
}: {
  slug: string;
  vendor?: VendorSummary;
  onDone: () => void;
  onCancel: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(vendor?.name ?? "");
  const [website, setWebsite] = useState(vendor?.website ?? "");
  const [account, setAccount] = useState(vendor?.account_number ?? "");
  const [contact, setContact] = useState(vendor?.contact ?? "");
  const [lead, setLead] = useState(vendor?.lead_time_days != null ? String(vendor.lead_time_days) : "");
  const [notes, setNotes] = useState(vendor?.notes ?? "");

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: name.trim(),
        website: website.trim() || null,
        account_number: account.trim() || null,
        contact: contact.trim() || null,
        lead_time_days: lead.trim() ? Number(lead) : null,
        notes: notes.trim() || null,
      };
      return vendor ? api.updateVendor(slug, vendor.id, body) : api.createVendor(slug, body);
    },
    onSuccess: () => { toast.success(vendor ? "Vendor updated." : "Vendor added."); onDone(); },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Couldn't save."),
  });

  return (
    <form
      className="rounded-lg border border-line dark:border-slate-700 p-3 space-y-2"
      onSubmit={(e) => { e.preventDefault(); if (name.trim()) save.mutate(); }}
    >
      <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Vendor name *" className="input" />
      <div className="grid grid-cols-2 gap-2">
        <input value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="Website (https://…)" className="input" />
        <input value={account} onChange={(e) => setAccount(e.target.value)} placeholder="Account #" className="input" />
        <input value={contact} onChange={(e) => setContact(e.target.value)} placeholder="Contact (email / phone)" className="input" />
        <input value={lead} onChange={(e) => setLead(e.target.value.replace(/[^0-9]/g, ""))} placeholder="Lead time (days)" inputMode="numeric" className="input" />
      </div>
      <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes" className="input" />
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="px-2.5 py-1.5 rounded-md text-xs text-content dark:text-slate-300 hover:bg-subtle dark:hover:bg-slate-800">Cancel</button>
        <button type="submit" disabled={!name.trim() || save.isPending} className="px-2.5 py-1.5 rounded-md text-xs font-medium bg-slate-700 hover:bg-slate-600 text-mortar-50 disabled:opacity-50">{vendor ? "Save" : "Add"}</button>
      </div>
    </form>
  );
}
