import { downloadBlob, useMoneyCurrency, RecordFormModal, CollectionHeader, ContributedDetailPanels, MoneyInput, useRecordInPath, CustomFieldsPanel, FieldPack, fieldNeed, fieldPackControlClass, Modal, headerButton, useFieldDraft, useToast, useConfirm, usePageTitle, SearchInput, NumberField } from "@cobblr/platform-web";
// sales UI — the host mounts <SalesUI /> at /sales. A list of sales orders; the
// detail modal carries the customer, line items (each an inventory part + qty +
// price), a running total, and the **Fulfill** button that decrements the sold
// parts from stock. Customers are managed from a header button. Modals for
// detail/create; toasts for feedback; destructive deletes confirm.

import { useEffect, useState } from "react";
import { useQuery, useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ShoppingCart, Plus, Trash2, X, Users, PackageCheck, Truck, Copy, ExternalLink, Hammer, Settings } from "lucide-react";
import {
  SalesApi, SalesApiError,
  type SalesOrder, type SalesOrderStatus, type CustomerSummary, type PartOption, type FulfilDoor, type HistoryRow, type OrderSort, type Paged,
} from "./api.js";
import { IntakeSettings } from "./intake.js";
import { invoiceCsv, invoiceHtml } from "../invoice.js";
import { Link } from "react-router-dom";
import { fieldCurrency, formatStoredMoney } from "@cobblr/platform-contract/money";
import { PickToLight } from "@cobblr/platform-web";

export const navItems = [{ label: "Sales", path: "/sales", icon: ShoppingCart }];

const STATUSES: SalesOrderStatus[] = ["draft", "confirmed", "fulfilled", "shipped", "closed", "cancelled"];
const SORTS: Array<[OrderSort, string]> = [["newest", "Newest first"], ["oldest", "Oldest first"], ["customer", "Customer A to Z"], ["number", "Order number"]];
const PAGE = 50;

/** The value, once it has stopped changing for a moment: a search box asks
 *  the server once per pause, not once per key. */
function useSettled<T>(value: T, ms = 250): T {
  // DRAFT-OK: not a record's value; the effect below follows every change
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

/** Pages of a list route, fetched as the person asks for more, with the
 *  server's count of the whole. */
function usePagedList<T>(key: unknown[], fetchPage: (offset: number) => Promise<Paged<T>>) {
  const q = useInfiniteQuery({
    queryKey: key,
    initialPageParam: 0,
    queryFn: ({ pageParam }) => fetchPage(pageParam),
    getNextPageParam: (last, all) => (last.complete ? undefined : all.reduce((n, p) => n + p.items.length, 0)),
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const total = q.data?.pages[0]?.total ?? items.length;
  return { ...q, items, total };
}

function ShowMore({ shown, total, more, loading, noun }: { shown: number; total: number; more: () => void; loading: boolean; noun: string }) {
  if (shown >= total) return null;
  return (
    <div className="flex items-center justify-center gap-3 pt-1 text-xs text-muted">
      <span>{shown} of {total} {noun}</span>
      <button type="button" onClick={more} disabled={loading} className="px-3 py-1.5 rounded border border-line dark:border-slate-600 hover:border-cobble-400 disabled:opacity-50">
        {loading ? "Loading…" : "Show more"}
      </button>
    </div>
  );
}

interface Props {
  orgSlug: string;
  getToken: () => string | null;
}

export function SalesUI({ orgSlug, getToken }: Props) {
  usePageTitle("Sales");
  const api = new SalesApi(orgSlug, getToken);
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  // An order's address (/sales/<id>) opens it, and a customer's
  // (/sales/customers/<id>) opens the customers list at that customer.
  const [open, setOpen] = useRecordInPath("sales", { reserved: ["customers"] });
  const [customerInPath, setCustomerInPath] = useRecordInPath("sales", { sub: "customers" });
  const [creating, setCreating] = useState(false);
  const [customersList, setCustomersList] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const customersOpen = customersList || !!customerInPath;
  const setCustomersOpen = (v: boolean) => {
    setCustomersList(v);
    if (!v && customerInPath) setCustomerInPath(null);
  };

  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<SalesOrderStatus | "">("");
  const [sort, setSort] = useState<OrderSort>("newest");
  const q = useSettled(search.trim());
  const orders = usePagedList(["sales-orders", orgSlug, q, status, sort], (offset) => api.listOrders({ q, status, sort, offset, limit: PAGE }));
  const narrowed = Boolean(q || status);

  const del = useMutation({
    mutationFn: (id: string) => api.deleteOrder(id),
    onSuccess: () => { toast.success("Order deleted"); void qc.invalidateQueries({ queryKey: ["sales-orders", orgSlug] }); },
    onError: (e) => toast.error(e instanceof SalesApiError ? e.message : String(e)),
  });

  return (
    <div className="space-y-4 max-w-4xl">
      <CollectionHeader
        title="sales"
        kind="sales:order"
        count={orders.data ? `${orders.items.length} of ${orders.total}` : undefined}
        search={<SearchInput value={search} onChange={setSearch} placeholder="search…" aria-label="Search orders" wrapperClassName="w-48 max-sm:w-full max-sm:flex-1" />}
        filters={
          <>
            <select value={status} onChange={(e) => setStatus(e.target.value as SalesOrderStatus | "")} aria-label="Status" className="rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-2 py-1 text-xs">
              <option value="">Any status</option>
              {STATUSES.map((st) => <option key={st} value={st}>{st}</option>)}
            </select>
            <select value={sort} onChange={(e) => setSort(e.target.value as OrderSort)} aria-label="Sort" className="rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-2 py-1 text-xs">
              {SORTS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
            </select>
          </>
        }
        actions={
          <>
            <button type="button" onClick={() => setCustomersOpen(true)} className={headerButton()}>
              <Users size={14} /> Customers
            </button>
            <button type="button" onClick={() => setSettingsOpen(true)} className={headerButton()} aria-label="Sales settings">
              <Settings size={14} />
            </button>
            <button type="button" onClick={() => setCreating(true)} className={headerButton("primary")}>
              <Plus size={14} /> New order
            </button>
          </>
        }
      />

      {orders.isLoading && <div className="text-sm text-muted">Loading…</div>}
      {orders.isError && <div className="text-sm text-red-600 dark:text-red-400">The orders could not be loaded: {orders.error instanceof Error ? orders.error.message : String(orders.error)}</div>}
      {orders.data && orders.items.length === 0 && !narrowed && (
        <div className="text-sm text-muted italic">No sales orders yet. Create one - add what you sold, then Fulfill to draw it down from stock.</div>
      )}
      {orders.data && orders.items.length === 0 && narrowed && (
        <div className="text-sm text-muted italic">No orders match{q ? ` "${q}"` : ""}{status ? ` with status ${status}` : ""}.</div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {orders.items.map((o) => (
          <OrderCard
            key={o.id}
            order={o}
            onOpen={() => setOpen(o.id)}
            onDelete={async () => {
              if (await confirm({ title: `Delete this order?`, message: "Removes the order and its line items. Stock already fulfilled is not restored.", confirmLabel: "Delete", destructive: true })) {
                del.mutate(o.id);
              }
            }}
          />
        ))}
      </div>
      <ShowMore shown={orders.items.length} total={orders.total} more={() => void orders.fetchNextPage()} loading={orders.isFetchingNextPage} noun="orders" />

      {creating && <NewOrderModal api={api} orgSlug={orgSlug} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); setOpen(id); }} />}
      {open && <OrderDetailModal api={api} orgSlug={orgSlug} orderId={open} onClose={() => setOpen(null)} />}
      {settingsOpen && <SalesSettingsModal api={api} onClose={() => setSettingsOpen(false)} />}
      {customersOpen && <CustomersModal api={api} initialEditing={customerInPath} onClose={() => setCustomersOpen(false)} />}
    </div>
  );
}

const PAUSED_WORDS: Record<string, string> = {
  busy: "Your tracking service said it was busy, so Cobblr is leaving it alone for a while.",
  quota_exhausted: "Your tracking service is at capacity. Cobblr will try again tomorrow.",
  not_connected: "You have no parcel tracking connected. Add one under Your account, Connections (your own bridge works).",
  no_driver: "Cobblr cannot follow parcels from this carrier yet.",
};

/** Sales settings: "Follow parcels I send". Off until a person turns it on;
 *  it then asks with their own tracking connection, never one Cobblr pays for. */
function SalesSettingsModal({ api, onClose }: { api: SalesApi; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const follow = useQuery({ queryKey: ["sales-follow-parcels"], queryFn: () => api.followParcels() });
  const set = useMutation({
    mutationFn: (on: boolean) => api.setFollowParcels(on),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["sales-follow-parcels"] }),
    onError: (e) => toast.error(e instanceof SalesApiError ? e.message : String(e)),
  });
  const closeDelivered = useMutation({
    mutationFn: (on: boolean) => api.setCloseDelivered(on),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["sales-follow-parcels"] }),
    onError: (e) => toast.error(e instanceof SalesApiError ? e.message : String(e)),
  });
  const check = useMutation({
    mutationFn: () => api.checkParcelsNow(),
    onSuccess: (r) => {
      toast.success(r.asked === 0 ? "Nothing due to check right now" : `Checked ${r.asked} parcel${r.asked === 1 ? "" : "s"}${r.delivered ? `, ${r.delivered} delivered` : ""}`);
      void qc.invalidateQueries({ queryKey: ["sales-follow-parcels"] });
      void qc.invalidateQueries({ queryKey: ["sales-orders"] });
    },
    onError: (e) => toast.error(e instanceof SalesApiError ? e.message : String(e)),
  });
  const f = follow.data;
  return (
    <Modal open onClose={onClose} title="Sales settings" size="md">
      <div className="space-y-3 text-sm">
        <label className="flex items-start gap-3">
          <input type="checkbox" className="mt-1" checked={!!f?.on} disabled={!f || set.isPending} onChange={(e) => set.mutate(e.target.checked)} />
          <span>
            <span className="font-medium text-content dark:text-mortar-100">Follow parcels I send</span>
            <span className="block text-xs text-muted">
              Cobblr asks where each shipped order's parcel is a few times a day, and marks the order delivered when the carrier says so. It uses your own
              tracking connection (your bridge, if you have one), never one Cobblr pays for, and stops two days after the delivered scan.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-3">
          <input type="checkbox" className="mt-1" checked={f?.close_delivered_orders ?? true} disabled={!f || closeDelivered.isPending} onChange={(e) => closeDelivered.mutate(e.target.checked)} />
          <span><span className="font-medium text-content dark:text-mortar-100">Close delivered orders automatically</span>
            <span className="block text-xs text-muted">When a delivery is recorded, close the order if it is paid and fully fulfilled. You get a notification with Undo. Parcel following still needs your tracking connection.</span>
          </span>
        </label>
        {f?.on && (
          <div className="rounded border border-line dark:border-slate-700 p-3 space-y-2">
            <div className="text-xs text-muted">Following {f.following ?? 0} parcel{f.following === 1 ? "" : "s"} that have not been delivered yet.</div>
            {f.paused_reason && <div className="text-xs text-amber-700 dark:text-amber-300">{PAUSED_WORDS[f.paused_reason]}</div>}
            <button type="button" onClick={() => check.mutate()} disabled={check.isPending} className="px-3 py-1.5 text-xs rounded border border-line dark:border-slate-600 disabled:opacity-50">
              {check.isPending ? "Checking…" : "Check now"}
            </button>
          </div>
        )}
        <IntakeSettings api={api} />
      </div>
    </Modal>
  );
}

function StatusPill({ status }: { status: SalesOrderStatus }) {
  const tone =
    status === "fulfilled" || status === "shipped" ? "bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300"
    : status === "cancelled" ? "bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-300"
    : status === "closed" ? "bg-slate-100 dark:bg-slate-800 text-slate-500"
    : "bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300";
  return <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${tone}`}>{status}</span>;
}

function OrderCard({ order, onOpen, onDelete }: { order: SalesOrder; onOpen: () => void; onDelete: () => void }) {
  return (
    <div className="rounded-lg border border-line dark:border-slate-700 p-3 hover:border-cobble-400 transition group">
      <div className="flex items-start justify-between">
        <button type="button" onClick={onOpen} className="text-left min-w-0">
          <div className="font-medium text-content dark:text-mortar-100 truncate">{order.customer_name || order.order_number || "(no customer)"}</div>
          <div className="text-xs text-muted mt-0.5 flex items-center gap-2">
            <StatusPill status={order.status} />
            {order.delivered_at && <span className="text-moss-700 dark:text-moss-300">delivered {new Date(order.delivered_at).toLocaleDateString()}</span>}
            {order.order_number && order.customer_name && <span>{order.order_number}</span>}
          </div>
        </button>
        <button type="button" onClick={onDelete} className="text-slate-300 hover:text-red-500 hover-reveal transition shrink-0" aria-label="Delete order">
          <Trash2 size={15} />
        </button>
      </div>
    </div>
  );
}

function NewOrderModal({ api, orgSlug, onClose, onCreated }: { api: SalesApi; orgSlug: string; onClose: () => void; onCreated: (id: string) => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [customerName, setCustomerName] = useState("");
  const [orderNumber, setOrderNumber] = useState("");

  const create = useMutation({
    mutationFn: () => api.createOrder({ customer_id: customerId, customer_name: customerName.trim() || null, order_number: orderNumber.trim() || null }),
    onSuccess: (o) => { toast.success("Order created"); void qc.invalidateQueries({ queryKey: ["sales-orders", orgSlug] }); onCreated(o.id); },
    onError: (e) => toast.error(e instanceof SalesApiError ? e.message : String(e)),
  });

  return (
    <RecordFormModal open onClose={onClose} title="New sales order">
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        <FieldPack items={[
          {
            need: fieldNeed("customer", { control: "picker", label: "Customer" }),
            node: (
              <div>
                <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">Customer</span>
                <CustomerPicker api={api} customerId={customerId} customerName={customerName} onChange={(id, name) => { setCustomerId(id); setCustomerName(name); }} />
              </div>
            ),
          },
          {
            need: fieldNeed("order_number", { control: "text", label: "Order #" }),
            node: (
              <div>
                <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">Order #</span>
                <input value={orderNumber} onChange={(e) => setOrderNumber(e.target.value)} className="w-full rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-3 py-2 text-sm" />
              </div>
            ),
          },
        ]} />
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-xs rounded bg-subtle dark:bg-slate-800">Cancel</button>
          <button type="submit" disabled={create.isPending} className="px-3 py-1.5 text-xs rounded bg-cobble-600 text-white disabled:opacity-50">Create</button>
        </div>
      </form>
    </RecordFormModal>
  );
}

function OrderDetailModal({ api, orgSlug, orderId, onClose }: { api: SalesApi; orgSlug: string; orderId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const currency = useMoneyCurrency();
  const [exporting, setExporting] = useState(false);
  const exportOrder = async (kind: "pdf" | "csv") => {
    const target = kind === "pdf" ? window.open("", "_blank") : null;
    if (kind === "pdf" && !target) { toast.error("Allow pop-ups to open the invoice, then try again."); return; }
    setExporting(true);
    try {
      const order = await api.getOrder(orderId);
      if (target) {
        target.opener = null;
        target.document.write(invoiceHtml(order, currency));
        target.document.close();
        await target.document.fonts.ready;
        target.focus();
        target.print();
      } else {
        downloadBlob(new Blob([invoiceCsv(order, currency)], { type: "text/csv;charset=utf-8" }), `invoice-${order.id}.csv`);
      }
    } catch (e) {
      target?.close();
      toast.error(e instanceof Error ? e.message : String(e));
    } finally { setExporting(false); }
  };
  const detail = useQuery({ queryKey: ["sales-order", orderId], queryFn: () => api.getOrder(orderId) });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["sales-order", orderId] });
    void qc.invalidateQueries({ queryKey: ["sales-orders", orgSlug] });
    void qc.invalidateQueries({ queryKey: ["sales-order-history", orderId] });
  };
  const update = useMutation({
    mutationFn: (patch: Partial<SalesOrder>) => api.updateOrder(orderId, patch),
    onSuccess: invalidate,
    onError: (e) => toast.error(e instanceof SalesApiError ? e.message : String(e)),
  });
  const addItem = useMutation({
    mutationFn: (b: { part_id: string | null; description: string | null; qty: number; unit_price: number | null }) => api.addItem(orderId, { ...b, metadata: { currency: fieldCurrency(detail.data?.metadata, "total", currency) } }),
    onSuccess: invalidate,
    onError: (e) => toast.error(e instanceof SalesApiError ? e.message : String(e)),
  });
  const removeItem = useMutation({
    mutationFn: (itemId: string) => api.removeItem(orderId, itemId),
    onSuccess: invalidate,
    onError: (e) => toast.error(e instanceof SalesApiError ? e.message : String(e)),
  });
  const updateItem = useMutation({
    mutationFn: (m: { itemId: string; body: { qty?: number; unit_price?: number | null } }) => api.updateItem(orderId, m.itemId, m.body),
    onSuccess: invalidate,
    onError: (e) => toast.error(e instanceof SalesApiError ? e.message : String(e)),
  });
  const confirm = useConfirm();
  // A short order is refused with a sentence and its doors (make more, ship
  // what you have). They stay on the order, where the decision is made,
  // rather than in a toast that leaves with them.
  const [short, setShort] = useState<{ message: string; doors: FulfilDoor[] } | null>(null);
  const fulfill = useMutation({
    mutationFn: (ship: "all" | "available") => api.fulfillOrder(orderId, ship),
    onSuccess: (r) => {
      setShort(null);
      const n = r.decremented.reduce((a, d) => a + d.qty, 0);
      toast.success(r.complete ? `Fulfilled: ${n} taken from stock` : `Shipped ${n} from stock. The rest of the order is still open.`);
      invalidate();
    },
    onError: (e) => {
      if (e instanceof SalesApiError && e.doors.length > 0) setShort({ message: e.message, doors: e.doors });
      else toast.error(e instanceof SalesApiError ? e.message : String(e));
    },
  });

  const [shipping, setShipping] = useState(false);
  // Cancel: an order that shipped is asked whether it came back first.
  const [askReturned, setAskReturned] = useState<string | null>(null);
  const cancel = useMutation({
    mutationFn: (returned?: boolean) => api.cancelOrder(orderId, returned),
    onSuccess: (r) => {
      setAskReturned(null);
      const back = r.restocked.reduce((n, x) => n + x.qty, 0);
      toast.success(back > 0 ? `Order cancelled: ${back} put back in stock` : "Order cancelled", {
        actionLabel: "Undo",
        onAction: async () => {
          await api.reinstateOrder(orderId, r);
          invalidate();
        },
      });
      invalidate();
    },
    onError: (e) => {
      if (e instanceof SalesApiError && e.code === "ask_returned") setAskReturned(e.message);
      else toast.error(e instanceof SalesApiError ? e.message : String(e));
    },
  });
  // "Make this": a work order for the line's part, made for this order.
  const [making, setMaking] = useState<{ lineId: string; name: string; qty: number } | null>(null);
  const [makeRefusal, setMakeRefusal] = useState<{ message: string; doors: FulfilDoor[] } | null>(null);
  const make = useMutation({
    mutationFn: (m: { lineId: string; qty: number }) => api.makeLine(orderId, m.lineId, m.qty),
    onSuccess: (r) => {
      setMaking(null);
      setMakeRefusal(null);
      toast.success(r.reused ? `Now making ${r.qty} with ${r.buildName}` : `Put in to make: ${r.qty} with ${r.buildName}`);
      invalidate();
    },
    onError: (e) => {
      if (e instanceof SalesApiError) setMakeRefusal({ message: e.message, doors: e.doors });
      else toast.error(String(e));
    },
  });
  const d = detail.data;
  const reopen = useMutation({
    mutationFn: () => api.undoDeliveryClose(orderId),
    onSuccess: () => { invalidate(); toast.success("Order reopened. It will stay open until you close it."); },
    onError: (e) => toast.error(e instanceof SalesApiError ? e.message : String(e)),
  });
  const fulfilled = d ? ["fulfilled", "shipped", "closed"].includes(d.status) : false;
  const shippable = d ? !["shipped", "closed", "cancelled"].includes(d.status) && d.items.length > 0 : false;

  return (
    <RecordFormModal open onClose={onClose} title={[d?.order_number, d?.customer_name].filter(Boolean).join(" · ") || "Sales order"}>
      <div className="space-y-4">
        {detail.isLoading && <div className="text-sm text-muted">Loading…</div>}
        {d && (
          <>
            {/* Laid out by the platform's packer, as every record form is: a
                phone gets two columns where the fields fit and a row where one
                needs it, instead of a hand grid squeezing the customer picker. */}
            {d.source_ref && <p className="text-xs text-muted break-words">Source: {d.source_name}, order {d.source_ref}{d.source_url && /^https?:\/\//.test(d.source_url) && <> · <a href={d.source_url} target="_blank" rel="noopener noreferrer" className="underline">Open source order</a></>}</p>}
            {d.metadata?.order_email && typeof d.metadata.order_email === "object" && "text" in d.metadata.order_email && <section aria-label="Original order email" className="rounded border border-line p-3 space-y-2">
              <h3 className="font-medium">Original order email</h3>
              <p className="text-sm break-words">{String((d.metadata.order_email as Record<string, unknown>).subject || "")}</p>
              <pre className="text-xs whitespace-pre-wrap break-words font-sans">{String((d.metadata.order_email as Record<string, unknown>).text || "")}</pre>
              {d.status === "draft" && <button type="button" disabled={update.isPending} onClick={() => update.mutate({ status: "confirmed" })} className="rounded border border-line px-3 py-1.5">Confirm order</button>}
            </section>}
            <FieldPack
              className="gap-y-3 text-xs"
              items={[
                {
                  need: fieldNeed("customer", { control: "picker", label: "Customer" }),
                  node: (
                    <div>
                      <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">Customer</span>
                      <CustomerPicker api={api} customerId={d.customer_id} customerName={d.customer_name ?? ""} onChange={(id, name) => update.mutate({ customer_id: id, customer_name: name || null })} />
                    </div>
                  ),
                },
                {
                  need: fieldNeed("status", { control: "choice", label: "Status", choices: STATUSES }),
                  node: (
                    <div>
                      <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">Status</span>
                      <select value={d.status} onChange={(e) => (e.target.value === "cancelled" ? cancel.mutate(undefined) : update.mutate({ status: e.target.value as SalesOrderStatus }))} className="w-full min-w-0 rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-3 py-2 text-sm">
                        {STATUSES.map((st) => <option key={st} value={st}>{st}</option>)}
                      </select>
                    </div>
                  ),
                },
                {
                  need: fieldNeed("order_number", { control: "text", label: "Order number", valueLength: (d.order_number ?? "").length }),
                  node: <OrderNumberField value={d.order_number ?? ""} onSave={(order_number) => update.mutate({ order_number })} />,
                },
                {
                  need: fieldNeed("order_date", { control: "date", label: "Order date" }),
                  node: <OrderDateField value={d.order_date ? d.order_date.slice(0, 10) : ""} onSave={(order_date) => update.mutate({ order_date })} />,
                },
                {
                  need: { key: "shipping_address", minPx: 200, full: true },
                  node: <ShipToField value={d.shipping_address ?? ""} onSave={(shipping_address) => update.mutate({ shipping_address })} />,
                },
              ]}
            />

            {/* The order's own fields: whatever a bundle adds to an order
                ("Due date", "Came in through"), editable here. */}
            <CustomFieldsPanel
              entityKind="sales:order"
              entityId={orderId}
              values={d.metadata ?? {}}
              onCommit={(name, value) => update.mutate({ metadata: { [name]: value } })}
            />

            <label className="flex items-center gap-2 text-sm text-content dark:text-mortar-100">
              <input type="checkbox" checked={!!d.paid} disabled={update.isPending} onChange={(e) => update.mutate({ paid: e.target.checked })} />
              Paid
            </label>
            {d.status === "closed" && d.auto_closed_at && <div className="text-sm text-muted flex flex-wrap items-center gap-2">
              Closed automatically after delivery.
              <button type="button" disabled={reopen.isPending} onClick={() => reopen.mutate()} className="px-3 py-1.5 rounded border border-line dark:border-slate-600">Undo</button>
            </div>}
            {d.delivered_at && d.status === "shipped" && !d.paid && <p className="text-sm text-muted">Delivered. Mark Paid when payment is received.</p>}
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className={headerButton()} disabled={exporting || update.isPending || addItem.isPending || updateItem.isPending || removeItem.isPending} onClick={() => void exportOrder("pdf")}>Invoice PDF</button>
              <button type="button" className={headerButton()} disabled={exporting || update.isPending || addItem.isPending || updateItem.isPending || removeItem.isPending} onClick={() => void exportOrder("csv")}>Export CSV</button>
              <p className="w-full text-xs text-muted">Choose Save as PDF in the print dialog. Export CSV for your accounting tool.</p>
            </div>

            <PickToLight key={orderId} lines={d.items.flatMap(it => it.part_id ? [{ id: it.id, label: `${it.description || "Part"} (${it.qty})`, ref: { kind: "inventory:part", id: it.part_id } }] : [])} />
            {/* line items */}
            <div>
              <div className="flex items-baseline justify-between mb-1.5">
                <span className="text-[10px] font-mono uppercase tracking-widest text-muted">Line items</span>
                <span className="text-sm font-semibold text-content dark:text-mortar-100">Total {formatStoredMoney(d.total, "amount", { currency: fieldCurrency(d.metadata, "total", currency) })}</span>
              </div>
              {d.items.length === 0 && <div className="text-sm text-muted italic">No line items yet. Add what was sold.</div>}
              <ul className="divide-y divide-slate-100 dark:divide-slate-800 border border-line dark:border-slate-700 rounded">
                {d.items.map((it) => (
                  <li key={it.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 text-sm group">
                    <span className="flex-1 min-w-0 text-content dark:text-mortar-100">
                      {it.description || (it.part_id ? "(part)" : "(item)")}
                      {!fulfilled && d.status !== "cancelled" && (() => {
                        const a = d.availability?.find((a) => a.line_id === it.id);
                        return a ? <span className="block text-xs text-muted" data-testid="line-availability">
                          {[`${a.in_stock} in stock`, ...(a.being_made > 0 ? [`${a.being_made} being made`] : []), ...(a.short > 0 ? [`${a.short} short`] : [])].join(" · ")}
                        </span> : null;
                      })()}
                    </span>
                    {fulfilled ? (
                      <span className="text-xs text-muted tabular-nums">
                        {Number(it.qty)}{it.unit_price ? ` × ${formatStoredMoney(it.unit_price, "amount", { currency: fieldCurrency(it.metadata, "unit_price", fieldCurrency(d.metadata, "total", currency)) })}` : ""}
                      </span>
                    ) : (
                      // A line's quantity and price are the two things a
                      // customer changes their mind about; changing them used
                      // to mean removing the line and adding it again.
                      <span className="inline-flex items-center gap-1 text-xs text-muted">
                        <NumberCell
                          label={`How many ${it.description || "of this line"}`}
                          value={String(Number(it.qty))}
                          min={0.0001}
                          onSave={(v) => v !== null && updateItem.mutate({ itemId: it.id, body: { qty: v } })}
                        />
                        <span aria-hidden>×</span>
                        <MoneyInput
                          ariaLabel={`Price each for ${it.description || "this line"}`}
                          currency={fieldCurrency(it.metadata, "unit_price", fieldCurrency(d.metadata, "total", currency))}
                          value={it.unit_price}
                          storage="amount"
                          onCommit={(v) => updateItem.mutate({ itemId: it.id, body: { unit_price: v } })}
                          className="w-28"
                        />
                      </span>
                    )}
                    {!fulfilled && it.part_id && Number(it.qty_fulfilled) > 0 && (
                      <span className="text-xs text-moss-700 dark:text-moss-300 tabular-nums">{Number(it.qty_fulfilled)} shipped</span>
                    )}
                    {it.part_id && (() => {
                      const wo = (d.work_orders ?? []).find((w) => w.output_part_id === it.part_id && w.status !== "cancelled");
                      const a = d.availability?.find((a) => a.line_id === it.id);
                      const makeButton = !fulfilled && d.status !== "cancelled" && (!a || a.short > 0) ? (
                        <button type="button"
                          onClick={() => setMaking({ lineId: it.id, name: it.description || "this part", qty: Math.max(1, a?.make_qty ?? Number(it.qty) - Number(it.qty_fulfilled || 0)) })}
                          className="inline-flex items-center gap-1 text-xs text-accent hover:underline">
                          <Hammer size={12} aria-hidden /> {wo && a ? `Make ${a.short} more` : "Make this"}
                        </button>
                      ) : null;
                      if (wo) {
                        return (
                          <>
                            <span className={"text-xs tabular-nums " + (wo.status === "done" ? "text-moss-700 dark:text-moss-300" : "text-muted")} data-testid="line-made">
                              {wo.status === "done" ? `${wo.made} made` : `${wo.made} of ${wo.qty} made`}
                            </span>
                            {wo.make_id && (
                              <Link to={`/makes/${wo.make_id}`} className="text-xs text-accent hover:underline" data-testid="line-make-link">
                                Make
                              </Link>
                            )}
                            {makeButton}
                          </>
                        );
                      }
                      return makeButton;
                    })()}
                    {!fulfilled && (
                      <button
                        type="button"
                        onClick={async () => {
                          if (await confirm({ title: "Remove this line?", message: `${it.description || "This line"} comes off the order.`, confirmLabel: "Remove", destructive: true })) removeItem.mutate(it.id);
                        }}
                        className="text-slate-300 hover:text-red-500 hover-reveal"
                        aria-label={`Remove ${it.description || "line item"}`}
                      >
                        <X size={14} />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>

            {askReturned && (
              <div role="alertdialog" aria-label="Was it returned?" className="rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-3 space-y-2">
                <p className="text-sm text-content dark:text-mortar-100">{askReturned}</p>
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={() => cancel.mutate(true)} className="px-3 py-1.5 text-xs rounded bg-cobble-600 text-white">Yes, it came back</button>
                  <button type="button" onClick={() => cancel.mutate(false)} className="px-3 py-1.5 text-xs rounded border border-line dark:border-slate-600">No, cancel it anyway</button>
                  <button type="button" onClick={() => setAskReturned(null)} className="px-3 py-1.5 text-xs rounded text-muted">Keep the order</button>
                </div>
              </div>
            )}

            {!fulfilled && <AddLineRow api={api} currency={fieldCurrency(d.metadata, "total", currency)} onAdd={(b) => addItem.mutate(b)} />}

            <div className="flex items-center justify-between pt-2 border-t border-line dark:border-slate-700">
              <span className="text-xs text-muted">
                {fulfilled ? `Fulfilled${d.fulfilled_at ? " " + new Date(d.fulfilled_at).toLocaleDateString() : ""}, stock already drawn down.` : "Fulfilling draws each line's part out of inventory stock."}
              </span>
              <button
                type="button"
                disabled={fulfilled || d.items.length === 0 || fulfill.isPending}
                onClick={() => fulfill.mutate("all")}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded bg-cobble-600 text-white hover:bg-cobble-700 disabled:opacity-50"
              >
                <PackageCheck size={15} /> Fulfill
              </button>
              {shippable && (
                <button
                  type="button"
                  onClick={() => setShipping(true)}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded border border-line dark:border-slate-600 text-content dark:text-mortar-100 hover:bg-subtle dark:hover:bg-slate-800"
                >
                  <Truck size={15} /> Ship
                </button>
              )}
            </div>
            {d.tracking_number && (
              <div className="text-xs text-muted">
                Shipped{d.carrier ? ` with ${d.carrier}` : ""}{d.shipped_at ? ` on ${new Date(d.shipped_at).toLocaleDateString()}` : ""}. Tracking number <span className="font-mono text-content dark:text-mortar-100">{d.tracking_number}</span>
              </div>
            )}
            {short && !fulfilled && (
              <div role="alert" className="rounded border border-ember-200 dark:border-ember-700 bg-ember-50 dark:bg-ember-900/30 px-3 py-2.5 space-y-2">
                <p className="text-sm text-content dark:text-mortar-100">{short.message}</p>
                <div className="flex flex-wrap gap-2">
                  {short.doors.map((door) =>
                    door.kind === "ship_available" ? (
                      <button
                        key="ship"
                        type="button"
                        disabled={fulfill.isPending}
                        onClick={() => fulfill.mutate("available")}
                        className="px-3 py-1.5 text-sm rounded bg-cobble-600 text-white hover:bg-cobble-700 disabled:opacity-50"
                      >
                        {door.label}
                      </button>
                    ) : door.kind === "make" ? (
                      <button
                        key={door.part_id}
                        type="button"
                        disabled={make.isPending}
                        onClick={() => make.mutate({ lineId: door.line_id, qty: door.qty })}
                        className="px-3 py-1.5 text-sm rounded border border-line dark:border-slate-600 text-content dark:text-mortar-100 hover:bg-subtle dark:hover:bg-slate-800 disabled:opacity-50"
                      >
                        {door.label}
                      </button>
                    ) : null,
                  )}
                </div>
              </div>
            )}
          </>
        )}

        {/* Tags and discussion, contributed at every kind. A record you
            open is a record somebody may want to say something about. */}
        <ContributedDetailPanels
          target="sales:order"
          ctx={{
            slug: orgSlug,
            entityId: orderId,
            entityTitle: d?.customer_name || d?.order_number || "Sales order",
            hints: { tracking_number: d?.tracking_number ?? undefined },
          }}
        />
        {d && <OrderHistory api={api} orderId={orderId} />}
      </div>
      {makeRefusal && (
        <Modal open onClose={() => setMakeRefusal(null)} title="Nothing to make it with" size="sm">
          <div className="space-y-3">
            <p className="text-sm text-content dark:text-mortar-100">{makeRefusal.message}</p>
            <div className="flex flex-wrap gap-2">
              {makeRefusal.doors.map((door) =>
                door.kind === "add_build" ? (
                  <Link key="add" to={door.href} className="px-3 py-1.5 text-sm rounded bg-cobble-600 text-white hover:bg-cobble-700">{door.label}</Link>
                ) : null,
              )}
            </div>
          </div>
        </Modal>
      )}
      {making && (
        <RecordFormModal open onClose={() => setMaking(null)} title={`Make ${making.name}`}>
          <form
            className="space-y-3"
            onSubmit={(e) => { e.preventDefault(); make.mutate({ lineId: making.lineId, qty: making.qty }); }}
          >
            <label className="block">
              <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">How many</span>
              <NumberField
                min={1}
                value={making.qty}
                onChange={(n) => setMaking({ ...making, qty: Math.max(1, Math.floor(n || 1)) })}
                className="w-full rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-3 py-2 text-sm"
              />
            </label>
            <p className="text-xs text-muted">A work order goes on the Builds schedule, made for this order. It closes by itself when that many good ones are made.</p>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setMaking(null)} className="px-3 py-2 text-sm rounded text-muted hover:bg-subtle dark:hover:bg-slate-800">Cancel</button>
              <button type="submit" disabled={make.isPending} className="inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded bg-cobble-600 text-white hover:bg-cobble-700 disabled:opacity-50">
                <Hammer size={15} /> Make
              </button>
            </div>
          </form>
        </RecordFormModal>
      )}
      {shipping && d && (
        <ShipDialog
          api={api}
          orderId={orderId}
          onClose={() => setShipping(false)}
          onShipped={() => { setShipping(false); invalidate(); }}
        />
      )}
    </RecordFormModal>
  );
}

/** The order's number, editable in place. Drafts through useFieldDraft so a
 *  number that changes under the open sheet (another tab, the assistant)
 *  replaces an untouched field rather than being shadowed by it. */
/** A number on a line, saved when you leave the box. Empty is "no value"
 *  only where that means something (a price not set yet). */
function NumberCell({ label, value, min, allowEmpty, onSave }: { label: string; value: string; min: number; allowEmpty?: boolean; onSave: (v: number | null) => void }) {
  const f = useFieldDraft(value);
  const save = () => {
    const raw = f.draft.trim();
    if (raw === value) return;
    if (raw === "" && allowEmpty) {
      f.committed("");
      return onSave(null);
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min) return f.reset();
    f.committed(raw);
    onSave(n);
  };
  return (
    <input
      aria-label={label}
      inputMode="decimal"
      value={f.draft}
      onChange={(e) => f.setDraft(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") f.reset();
      }}
      className="w-16 rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-1.5 py-1 text-xs text-right tabular-nums"
    />
  );
}

function OrderDateField({ value, onSave }: { value: string; onSave: (v: string | null) => void }) {
  const f = useFieldDraft(value);
  return (
    <label className="block">
      <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">Order date</span>
      <input
        type="date"
        value={f.draft}
        onChange={(e) => {
          f.setDraft(e.target.value);
          if (e.target.value !== value) {
            f.committed(e.target.value);
            onSave(e.target.value || null);
          }
        }}
        className={"rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-3 py-2 text-sm " + fieldPackControlClass}
      />
    </label>
  );
}

function ShipToField({ value, onSave }: { value: string; onSave: (v: string | null) => void }) {
  const f = useFieldDraft(value);
  const save = () => {
    const next = f.draft.trim();
    if (next === value.trim()) return;
    f.committed(next);
    onSave(next || null);
  };
  return (
    <label className="block">
      <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">Ship to</span>
      <textarea
        rows={2}
        value={f.draft}
        placeholder="The address it goes to, if it is not the customer's own"
        onChange={(e) => f.setDraft(e.target.value)}
        onBlur={save}
        className="w-full rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-3 py-2 text-sm"
      />
    </label>
  );
}

function OrderNumberField({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const f = useFieldDraft(value);
  const save = () => {
    const next = f.draft.trim();
    if (!next || next === value) return f.reset();
    f.committed(next);
    onSave(next);
  };
  return (
    <label className="block">
      <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">Order number</span>
      <input
        value={f.draft}
        onChange={(e) => f.setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") f.reset();
        }}
        className="w-full rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-3 py-2 text-sm font-mono"
      />
    </label>
  );
}

/** Ship: the tracking number, the words the customer will read shown first,
 *  Copy, and "Email the customer" only when this workspace can send it (its own
 *  outbound email is set up and the customer has an address). Nothing is
 *  emailed unless the box is ticked when Ship is pressed. */
function ShipDialog({ api, orderId, onClose, onShipped }: { api: SalesApi; orderId: string; onClose: () => void; onShipped: () => void }) {
  const toast = useToast();
  const [tracking, setTracking] = useState("");
  const [typed, setTyped] = useState("");
  const [emailIt, setEmailIt] = useState(false);
  const [short, setShort] = useState<{ message: string; doors: FulfilDoor[] } | null>(null);
  // The preview follows the number a beat after typing stops, so the carrier
  // and link in the words are the ones the number implies.
  useEffect(() => {
    const t = setTimeout(() => setTracking(typed.trim()), 400);
    return () => clearTimeout(t);
  }, [typed]);
  const preview = useQuery({ queryKey: ["sales-ship-preview", orderId, tracking], queryFn: () => api.shipPreview(orderId, tracking) });
  const p = preview.data;
  const ship = useMutation({
    mutationFn: () => api.shipOrder(orderId, { tracking_number: tracking || null, carrier: null, email_customer: emailIt && !!p?.email.available }),
    onSuccess: (r) => {
      if (r.email.asked && r.email.sent && r.email.status === "sent") toast.success(`Shipped. ${r.email.to} was emailed.`);
      else if (r.email.asked && r.email.sent) toast.error(`Shipped, but ${r.email.to} cannot receive mail, so no email went.`);
      else if (r.email.asked && !r.email.sent) toast.error(`Shipped, but the email did not go: ${r.email.reason}`);
      else toast.success("Shipped");
      onShipped();
    },
    onError: (e) => {
      if (e instanceof SalesApiError && e.doors.length > 0) setShort({ message: e.message, doors: e.doors });
      else toast.error(e instanceof SalesApiError ? e.message : String(e));
    },
  });
  const copy = async () => {
    if (!p) return;
    try {
      await navigator.clipboard.writeText(`${p.notice.subject}\n\n${p.notice.text}`);
      toast.success("Copied the message");
    } catch {
      toast.error("Could not copy. Select the text and copy it instead.");
    }
  };

  return (
    <Modal open onClose={onClose} title="Ship this order" size="md">
      <div className="space-y-4">
        <label className="block">
          <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">Tracking number</span>
          <input
            autoFocus
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="Paste the tracking number (optional)"
            className="w-full rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-3 py-2 text-sm font-mono"
          />
        </label>
        {p?.carrier && (
          <div className="text-xs text-muted flex flex-wrap items-center gap-2">
            <span>Carrier: <span className="text-content dark:text-mortar-100">{p.carrier}</span></span>
            {p.lookup && (
              <a href={p.lookup.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
                {p.lookup.isCarrier ? `Track on ${p.lookup.via}` : `Look it up on ${p.lookup.via}`} <ExternalLink size={12} aria-hidden />
              </a>
            )}
          </div>
        )}

        <div>
          <div className="flex items-baseline justify-between mb-1">
            <span className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500">
              What the customer reads{p?.notice.to ? `, to ${p.notice.to}` : ""}
            </span>
            <button type="button" onClick={copy} disabled={!p} className="inline-flex items-center gap-1 text-xs text-accent hover:underline disabled:opacity-50">
              <Copy size={12} aria-hidden /> Copy
            </button>
          </div>
          <div className="rounded border border-line dark:border-slate-700 bg-subtle dark:bg-slate-800/60 px-3 py-2 text-sm">
            {preview.isLoading && <div className="text-faint">Writing the message…</div>}
            {p && (
              <>
                <div className="font-semibold text-content dark:text-mortar-100">{p.notice.subject}</div>
                <pre className="mt-1 whitespace-pre-wrap break-words font-sans text-content dark:text-mortar-100">{p.notice.text}</pre>
              </>
            )}
          </div>
        </div>

        {p && (p.email.available ? (
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5" checked={emailIt} onChange={(e) => setEmailIt(e.target.checked)} />
            <span>
              Email the customer
              <span className="block text-xs text-muted">From {p.email.from}. Only when you press Ship with this ticked.</span>
            </span>
          </label>
        ) : (
          <p className="text-xs text-muted">{p.email.reason} Copy the message to send it yourself.</p>
        ))}

        {short && (
          <div role="alert" className="rounded border border-ember-200 dark:border-ember-700 bg-ember-50 dark:bg-ember-900/30 px-3 py-2.5 space-y-2">
            <p className="text-sm text-content dark:text-mortar-100">{short.message}</p>
            <div className="flex flex-wrap gap-2">
              {short.doors.filter((door) => door.kind === "make" && door.href).map((door) => (
                <Link key={door.kind === "make" ? door.part_id : "x"} to={door.kind === "make" ? door.href! : "#"} className="px-3 py-1.5 text-sm rounded border border-line dark:border-slate-600 text-content dark:text-mortar-100 hover:bg-subtle dark:hover:bg-slate-800">
                  {door.label}
                </Link>
              ))}
            </div>
            <p className="text-xs text-muted">An order ships once everything on it has come out of stock. To send part of it, use Fulfill's "Ship the ones you have" first.</p>
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-2 border-t border-line dark:border-slate-700">
          <button type="button" onClick={onClose} className="px-3 py-2 text-sm rounded text-muted hover:bg-subtle dark:hover:bg-slate-800">Cancel</button>
          <button
            type="button"
            onClick={() => ship.mutate()}
            disabled={ship.isPending || !p}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded bg-cobble-600 text-white hover:bg-cobble-700 disabled:opacity-50"
          >
            <Truck size={15} /> {emailIt && p?.email.available ? "Ship and email" : "Ship"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

const STATUS_WORD: Record<string, string> = {
  draft: "draft",
  confirmed: "confirmed",
  fulfilled: "fulfilled",
  shipped: "shipped",
  closed: "closed",
  cancelled: "cancelled",
};

/** One line per thing that happened, in words. */
function historyLine(h: HistoryRow): string {
  const d = h.detail ?? {};
  if (h.kind === "status") return h.from_status ? `Moved from ${STATUS_WORD[h.from_status] ?? h.from_status} to ${STATUS_WORD[h.to_status ?? ""] ?? h.to_status}` : `Created as ${STATUS_WORD[h.to_status ?? ""] ?? h.to_status}`;
  if (h.kind === "stock") {
    const taken = Array.isArray(d.taken) ? (d.taken as Array<{ qty: number }>).reduce((a, t) => a + Number(t.qty || 0), 0) : 0;
    return `${taken} taken from stock${d.complete ? "" : ", the rest still owed"}`;
  }
  if (h.kind === "work_order") return `Put in to make: ${String(d.qty ?? "")} with ${String(d.build_name ?? "a build")}`;
  if (h.kind === "shipped") return `Shipped${d.carrier ? ` with ${String(d.carrier)}` : ""}${d.tracking_number ? `, tracking ${String(d.tracking_number)}` : ""}`;
  if (h.kind === "email") {
    const to = String(d.to ?? "the customer");
    if (d.status === "sent") return `Emailed ${to}`;
    if (d.status === "skipped") return `Email to ${to} skipped: the address cannot receive mail`;
    return `Email to ${to} failed${d.error ? `: ${String(d.error)}` : ""}`;
  }
  return h.kind;
}

function OrderHistory({ api, orderId }: { api: SalesApi; orderId: string }) {
  const history = useQuery({ queryKey: ["sales-order-history", orderId], queryFn: () => api.orderHistory(orderId) });
  const rows = history.data?.items ?? [];
  if (rows.length === 0) return null;
  return (
    <div>
      <span className="block text-[10px] font-mono uppercase tracking-widest text-muted mb-1.5">History</span>
      <ol className="space-y-1">
        {rows.map((h) => (
          <li key={h.id} className="flex flex-wrap items-baseline gap-x-2 text-xs">
            <span className="text-content dark:text-mortar-100">{historyLine(h)}</span>
            <span className="text-faint">{h.by_name ? `${h.by_name} · ` : ""}{new Date(h.created_at).toLocaleString()}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function AddLineRow({ api, currency, onAdd }: { api: SalesApi; currency: string; onAdd: (b: { part_id: string | null; description: string | null; qty: number; unit_price: number | null }) => void }) {
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<PartOption | null>(null);
  const [desc, setDesc] = useState("");
  const [qty, setQty] = useState(1);
  const [price, setPrice] = useState<number | null>(null);
  const parts = useQuery({ queryKey: ["sales-part-search", q], queryFn: () => api.searchParts(q), enabled: q.length > 0 && !picked });

  function submit() {
    onAdd({
      part_id: picked?.id ?? null,
      description: (picked?.title ?? desc).trim() || null,
      qty: Math.max(1, qty),
      unit_price: price,
    });
    setPicked(null); setQ(""); setDesc(""); setQty(1); setPrice(null);
  }

  return (
    <div className="rounded-lg border border-dashed border-line dark:border-slate-700 p-3 space-y-2">
      <div className="text-xs uppercase tracking-wide text-muted">Add a line item</div>
      <div className="relative">
        {picked ? (
          <div className="flex items-center gap-2">
            <span className="flex-1 text-sm text-content dark:text-mortar-100">{picked.title}</span>
            <button type="button" onClick={() => { setPicked(null); setQ(""); }} className="text-xs text-muted hover:text-accent">change</button>
          </div>
        ) : (
          <>
            <SearchInput
              value={q}
              onChange={(v) => { setQ(v); setDesc(v); }}
              placeholder="Search a part, or type a free-text item…"
              aria-label="Search a part, or type a free-text item"
            />
            {q.length > 0 && (parts.data?.length ?? 0) > 0 && (
              <div className="absolute z-10 mt-1 w-full rounded border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 shadow-lg max-h-48 overflow-auto">
                {parts.data?.map((p) => (
                  <button key={p.id} type="button" onClick={() => { setPicked(p); setQ(p.title); }} className="w-full text-left px-3 py-2 text-sm hover:bg-subtle dark:hover:bg-slate-800">
                    {p.title}{p.subtitle && <span className="text-xs text-muted ml-2">{p.subtitle}</span>}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
      <div className="flex items-center gap-2">
        <label className="text-xs text-muted">Qty <NumberField min={1} value={qty} onChange={(n) => setQty(Math.max(1, n || 1))} className="w-16 ml-1 rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-2 py-1.5 text-sm" /></label>
        <label className="text-xs text-muted flex items-center gap-1">Each <MoneyInput value={price} currency={currency} storage="amount" live onCommit={setPrice} ariaLabel="Price each" className="w-28 text-sm" /></label>
        <div className="flex-1" />
        <button type="button" disabled={!picked && !desc.trim()} onClick={submit} className="px-3 py-1.5 text-xs rounded bg-cobble-600 text-white disabled:opacity-50">Add</button>
      </div>
    </div>
  );
}

// Customer combobox: pick a managed customer, leave unlinked, or add one inline.
function CustomerPicker({ api, customerId, customerName, onChange }: { api: SalesApi; customerId: string | null; customerName: string; onChange: (id: string | null, name: string) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [find, setFind] = useState("");
  const q = useSettled(find.trim());
  const customers = useQuery({ queryKey: ["sales-customers", "pick", q], queryFn: () => api.listCustomers({ q, limit: PAGE }) });
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const create = useMutation({
    mutationFn: (name: string) => api.createCustomer({ name }),
    onSuccess: (c) => { toast.success("Customer added"); void qc.invalidateQueries({ queryKey: ["sales-customers"] }); setCreating(false); setNewName(""); onChange(c.id, c.name); },
    onError: (e) => toast.error(e instanceof SalesApiError ? e.message : String(e)),
  });

  if (creating) {
    return (
      <div className="flex gap-2">
        <input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Customer name" className="flex-1 rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-3 py-2 text-sm" />
        <button type="button" disabled={!newName.trim() || create.isPending} onClick={() => create.mutate(newName.trim())} className="px-2.5 py-1.5 rounded text-xs bg-cobble-600 text-white disabled:opacity-50">Add</button>
        <button type="button" onClick={() => setCreating(false)} className="px-2.5 py-1.5 rounded text-xs bg-subtle dark:bg-slate-800">Cancel</button>
      </div>
    );
  }
  const shown = customers.data?.items ?? [];
  const more = (customers.data?.total ?? 0) - shown.length;
  return (
    <div className="space-y-1.5">
    {(find || more > 0) && (
      <SearchInput value={find} onChange={setFind} placeholder="find a customer…" aria-label="Find a customer" />
    )}
    <select
      value={customerId ?? ""}
      onChange={(e) => {
        const val = e.target.value;
        if (val === "__new__") { setCreating(true); return; }
        if (val === "") { onChange(null, ""); return; }
        const c = customers.data?.items.find((x) => x.id === val);
        onChange(val, c?.name ?? "");
      }}
      className="w-full rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-3 py-2 text-sm"
    >
      <option value="">{customerName && !customerId ? `(unlinked: ${customerName})` : "(none)"}</option>
      {customerId && !shown.some((c) => c.id === customerId) && <option value={customerId}>{customerName}</option>}
      {shown.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      {more > 0 && <option disabled value="__more__">{more} more: type above to find one</option>}
      <option value="__new__">+ New customer…</option>
    </select>
    </div>
  );
}

function CustomersModal({ api, initialEditing, onClose }: { api: SalesApi; initialEditing?: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [find, setFind] = useState("");
  const q = useSettled(find.trim());
  const customers = usePagedList(["sales-customers", "all", q], (offset) => api.listCustomers({ q, offset, limit: PAGE }));
  const [editing, setEditing] = useState<string | "new" | null>(initialEditing ?? null);
  // The customer an address named, read on its own when the page does not
  // hold it, so a link always opens that customer.
  const listed = customers.items;
  const addressed = useQuery({
    queryKey: ["sales-customer", initialEditing],
    queryFn: () => api.getCustomer(initialEditing!),
    enabled: !!initialEditing && !!customers.data && !listed.some((c) => c.id === initialEditing),
  });
  const shown = addressed.data && !listed.some((c) => c.id === addressed.data!.id) ? [addressed.data, ...listed] : listed;
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["sales-customers"] });
    void qc.invalidateQueries({ queryKey: ["sales-orders"] });
  };
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteCustomer(id),
    onSuccess: () => { toast.success("Customer deleted"); invalidate(); },
    onError: (e) => toast.error(e instanceof SalesApiError ? e.message : String(e)),
  });

  return (
    <RecordFormModal open onClose={onClose} title="Customers">
      <div className="space-y-3">
        {customers.isLoading && <div className="text-sm text-muted">Loading…</div>}
        {(q || customers.total > PAGE) && <SearchInput value={find} onChange={setFind} placeholder="search customers…" aria-label="Search customers" />}
        {customers.data && shown.length === 0 && !q && editing !== "new" && <div className="text-sm text-muted italic">No customers yet. Add the people you sell to.</div>}
        {customers.data && shown.length === 0 && q && <div className="text-sm text-muted italic">No customer matches "{q}".</div>}
        <ul className="space-y-2">
          {shown.map((c) => (
            <li key={c.id}>
              {editing === c.id ? (
                <CustomerForm api={api} customer={c} onDone={() => { setEditing(null); invalidate(); }} onCancel={() => setEditing(null)} />
              ) : (
                <div className="flex items-center gap-3 rounded-lg border border-line dark:border-slate-700 p-3">
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-content dark:text-mortar-100 truncate">{c.name}</div>
                    <div className="text-xs text-muted">{c.order_count} order{c.order_count === 1 ? "" : "s"}{c.email ? ` · ${c.email}` : ""}</div>
                  </div>
                  <button type="button" onClick={() => setEditing(c.id)} className="text-xs text-muted hover:text-accent shrink-0">Edit</button>
                  <button
                    type="button"
                    onClick={async () => { if (await confirm({ title: `Delete "${c.name}"?`, message: "Orders for this customer keep their name but lose the link.", confirmLabel: "Delete", destructive: true })) remove.mutate(c.id); }}
                    className="text-slate-300 hover:text-red-500 shrink-0" aria-label="Delete customer"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
        <ShowMore shown={customers.items.length} total={customers.total} more={() => void customers.fetchNextPage()} loading={customers.isFetchingNextPage} noun="customers" />
        {editing === "new" ? (
          <CustomerForm api={api} onDone={() => { setEditing(null); invalidate(); }} onCancel={() => setEditing(null)} />
        ) : (
          <button type="button" onClick={() => setEditing("new")} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-cobble-600 text-white"><Plus size={14} /> Add customer</button>
        )}
      </div>
    </RecordFormModal>
  );
}

function CustomerForm({ api, customer, onDone, onCancel }: { api: SalesApi; customer?: CustomerSummary; onDone: () => void; onCancel: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [name, setName] = useState(customer?.name ?? "");
  const [email, setEmail] = useState(customer?.email ?? "");
  const [phone, setPhone] = useState(customer?.phone ?? "");
  const [address, setAddress] = useState(customer?.address ?? "");
  const save = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), email: email.trim() || null, phone: phone.trim() || null, address: address.trim() || null };
      return customer ? api.updateCustomer(customer.id, body) : api.createCustomer(body);
    },
    onSuccess: () => { toast.success(customer ? "Customer updated" : "Customer added"); onDone(); },
    onError: (e) => toast.error(e instanceof SalesApiError ? e.message : String(e)),
  });
  // A field a bundle or a person adds to customers saves on its own, as it is
  // edited, like every other sheet's; the form's Save is for the fields above.
  const [fields, setFields] = useState<Record<string, unknown>>(customer?.metadata ?? {});
  const setField = useMutation({
    mutationFn: (m: { name: string; value: unknown }) => api.updateCustomer(customer!.id, { metadata: { [m.name]: m.value } }),
    onSuccess: (c) => { setFields(c.metadata ?? {}); void qc.invalidateQueries({ queryKey: ["sales-customers"] }); },
    onError: (e) => toast.error(e instanceof SalesApiError ? e.message : String(e)),
  });
  return (
    <form className="rounded-lg border border-line dark:border-slate-700 p-3 space-y-2" onSubmit={(e) => { e.preventDefault(); if (name.trim()) save.mutate(); }}>
      <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Name *" className="w-full rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-3 py-2 text-sm" />
      <FieldPack items={[
        {
          need: fieldNeed("email", { control: "text", label: "Email" }),
          node: (
            <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" className="w-full min-w-0 rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-3 py-2 text-sm" />
          ),
        },
        {
          need: fieldNeed("phone", { control: "text", label: "Phone" }),
          node: (
            <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Phone" className="w-full min-w-0 rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-3 py-2 text-sm" />
          ),
        },
      ]} />
      <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Address" className="w-full rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-3 py-2 text-sm" />
      {customer && (
        <CustomFieldsPanel entityKind="sales:customer" entityId={customer.id} values={fields} onCommit={(name, value) => setField.mutate({ name, value })} />
      )}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="px-2.5 py-1.5 rounded text-xs bg-subtle dark:bg-slate-800">Cancel</button>
        <button type="submit" disabled={!name.trim() || save.isPending} className="px-2.5 py-1.5 rounded text-xs bg-cobble-600 text-white disabled:opacity-50">{customer ? "Save" : "Add"}</button>
      </div>
    </form>
  );
}

export default SalesUI;
