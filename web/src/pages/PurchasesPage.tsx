// /purchases — list of orders with a detail modal that shows the
// order's line items. Same overall shape as MachinesPage /
// AssetsPage. Order items live inside the detail modal (they're a
// child collection, not their own top-level entity).

import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Plus, Search, Trash2 } from "lucide-react";
import { ApiError, api, type Order } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { EntityActionsBar, Modal, useToast, useConfirm } from "@cobblr/platform-web";

const STATUSES: Order["status"][] = ["planned", "ordered", "in-transit", "arrived", "cancelled"];

export function PurchasesPage() {
  const { activeSlug } = useActiveOrg();
  const navigate = useNavigate();
  const { id } = useParams<{ id?: string }>();

  const orders = useQuery({
    queryKey: ["orders", activeSlug],
    queryFn: () => api.listOrders(activeSlug),
    enabled: !!activeSlug,
  });

  const allRows = orders.data?.items ?? [];
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"" | Order["status"]>("");

  let filtered = allRows;
  if (statusFilter) filtered = filtered.filter((o) => o.status === statusFilter);
  if (query) {
    filtered = filtered.filter((o) =>
      [o.vendor, o.order_number, o.tracking_number, o.notes]
        .filter(Boolean)
        .some((v) => v!.toLowerCase().includes(query.toLowerCase())),
    );
  }

  const [newOpen, setNewOpen] = useState(false);

  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-3 border-b border-slate-200 dark:border-slate-700 pb-3 flex-wrap">
        <h1 className="font-display text-2xl font-extrabold text-slate-700 dark:text-mortar-100 lowercase">
          purchases
        </h1>
        <span className="text-[10px] font-mono text-slate-400 dark:text-slate-500">
          {filtered.length} of {allRows.length}
        </span>
        <div className="flex-1" />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as Order["status"] | "")}
          className="input !py-1 !text-xs !w-32"
        >
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <div className="relative">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="vendor / order# / notes…"
            className="input !py-1 !pl-7 !text-xs !w-56"
          />
        </div>
        <button
          onClick={() => setNewOpen(true)}
          className="text-[10px] font-mono uppercase tracking-widest text-cobble-600 hover:text-cobble-700 transition flex items-center gap-1 px-2 py-1 rounded border border-slate-200 dark:border-slate-700"
        >
          <Plus size={11} /> new
        </button>
      </div>

      <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-mortar-50/60 dark:bg-slate-800/40 text-[10px] font-mono uppercase tracking-widest text-slate-500 dark:text-slate-400">
            <tr>
              <th className="text-left px-3 py-2">Vendor</th>
              <th className="text-left px-3 py-2">Order #</th>
              <th className="text-left px-3 py-2">Status</th>
              <th className="text-left px-3 py-2">Ordered</th>
              <th className="text-left px-3 py-2">Arrived</th>
              <th className="text-right px-3 py-2">Total</th>
              <th className="w-6"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
            {filtered.map((o) => (
              <tr
                key={o.id}
                onClick={() => navigate(`/purchases/${o.id}`)}
                className="hover:bg-mortar-50 dark:hover:bg-slate-800/40 transition cursor-pointer"
              >
                <td className="px-3 py-2 text-slate-700 dark:text-mortar-100 font-medium">
                  {o.vendor || "—"}
                </td>
                <td className="px-3 py-2 text-slate-500 dark:text-slate-400 font-mono text-xs">
                  {o.order_number || "—"}
                </td>
                <td className="px-3 py-2">
                  <StatusPill status={o.status} />
                </td>
                <td className="px-3 py-2 text-slate-500 dark:text-slate-400 text-xs">
                  {o.ordered_at ? new Date(o.ordered_at).toLocaleDateString() : "—"}
                </td>
                <td className="px-3 py-2 text-slate-500 dark:text-slate-400 text-xs">
                  {o.arrived_at ? new Date(o.arrived_at).toLocaleDateString() : "—"}
                </td>
                <td className="px-3 py-2 text-right font-mono text-xs text-slate-600 dark:text-mortar-200">
                  {o.total_cost ? `$${Number(o.total_cost).toFixed(2)}` : "—"}
                </td>
                <td className="px-2 py-2 text-slate-300 dark:text-slate-600">
                  <ChevronRight size={14} />
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-10 text-center text-xs text-slate-400 italic">
                  {allRows.length === 0
                    ? "No orders yet. Click + new to log one."
                    : "No matches with the current filters."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <OrderDetailModal orderId={id ?? null} onClose={() => navigate("/purchases")} />
      <NewOrderModal open={newOpen} onClose={() => setNewOpen(false)} />
    </div>
  );
}

function StatusPill({ status }: { status: Order["status"] }) {
  const palette: Record<Order["status"], string> = {
    planned: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
    ordered: "bg-cobble-100 text-cobble-700 dark:bg-cobble-700/40 dark:text-cobble-200",
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
  const remove = useMutation({
    mutationFn: () => api.deleteOrder(activeSlug, orderId!),
    onSuccess: () => {
      toast.success("Order deleted.");
      void qc.invalidateQueries({ queryKey: ["orders", activeSlug] });
      onClose();
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Couldn't delete."),
  });

  const o = order.data;
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
    <Modal
      open={!!orderId}
      onClose={onClose}
      title={o?.vendor || o?.order_number || "loading…"}
      subtitle={o ? `${o.status}${o.order_number && o.vendor ? ` · ${o.order_number}` : ""}` : undefined}
      size="lg"
    >
      {o ? (
        <div className="space-y-4">
          <EntityActionsBar entityKind="purchases:order" entityId={o.id} />
          <dl className="grid grid-cols-2 gap-3 text-xs">
            <EditField label="Vendor" value={o.vendor ?? ""} onCommit={(v) => update.mutate({ vendor: v || null })} />
            <EditField label="Order #" value={o.order_number ?? ""} onCommit={(v) => update.mutate({ order_number: v || null })} />
            <EditSelect label="Status" value={o.status} options={STATUSES} onCommit={(v) => update.mutate({ status: v as Order["status"] })} />
            <EditField label="Tracking #" value={o.tracking_number ?? ""} onCommit={(v) => update.mutate({ tracking_number: v || null })} />
            <EditField label="Ordered at" value={o.ordered_at ?? ""} type="date" onCommit={(v) => update.mutate({ ordered_at: v || null })} />
            <EditField label="Expected arrival" value={o.expected_arrival ?? ""} type="date" onCommit={(v) => update.mutate({ expected_arrival: v || null })} />
            <EditField label="Arrived at" value={o.arrived_at ?? ""} type="date" onCommit={(v) => update.mutate({ arrived_at: v || null })} />
            <EditField label="URL" value={o.url ?? ""} type="url" onCommit={(v) => update.mutate({ url: v || null })} />
            <EditField label="Total cost" value={o.total_cost ?? ""} numeric onCommit={(v) => update.mutate({ total_cost: v ? (v as unknown as string) : null })} />
            <EditField label="Shipping cost" value={o.shipping_cost ?? ""} numeric onCommit={(v) => update.mutate({ shipping_cost: v ? (v as unknown as string) : null })} />
          </dl>
          <EditField label="Notes" value={o.notes ?? ""} multiline onCommit={(v) => update.mutate({ notes: v || null })} />

          <div>
            <div className="text-[10px] font-mono uppercase tracking-widest text-cobble-500 mb-2">
              // line items ({o.items?.length ?? 0})
            </div>
            {!o.items || o.items.length === 0 ? (
              <div className="text-xs text-slate-400 italic">No items on this order.</div>
            ) : (
              <ul className="space-y-1 text-sm">
                {o.items.map((it) => (
                  <li
                    key={it.id}
                    className="flex items-baseline gap-3 px-2 py-1.5 rounded border border-slate-100 dark:border-slate-700"
                  >
                    <span className="flex-1 text-slate-700 dark:text-mortar-100">
                      {it.description ?? "—"}
                    </span>
                    <span className="font-mono text-xs text-slate-500">
                      {Number(it.qty).toFixed(0)} ×
                    </span>
                    <span className="font-mono text-xs text-slate-500">
                      {it.unit_cost ? `$${Number(it.unit_cost).toFixed(2)}` : "—"}
                    </span>
                    <span className="font-mono text-xs text-slate-700 dark:text-mortar-100">
                      {it.unit_cost ? `$${(Number(it.qty) * Number(it.unit_cost)).toFixed(2)}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="pt-3 border-t border-slate-100 dark:border-slate-700 flex items-center justify-between">
            <button
              onClick={handleDelete}
              className="text-[10px] font-mono uppercase tracking-widest text-slate-400 hover:text-ember-500 transition flex items-center gap-1"
            >
              <Trash2 size={11} /> delete order
            </button>
            <button
              onClick={onClose}
              className="px-3 py-1.5 rounded-md text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-mortar-50 dark:hover:bg-slate-800 transition"
            >
              Close
            </button>
          </div>
        </div>
      ) : (
        <div className="text-xs text-slate-400">loading…</div>
      )}
    </Modal>
  );
}

function NewOrderModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [vendor, setVendor] = useState("");
  const [orderNumber, setOrderNumber] = useState("");
  const [status, setStatus] = useState<Order["status"]>("ordered");
  useEffect(() => {
    if (open) {
      setVendor("");
      setOrderNumber("");
      setStatus("ordered");
    }
  }, [open]);

  const create = useMutation({
    mutationFn: () =>
      api.createOrder(activeSlug, {
        vendor: vendor.trim() || null,
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
    <Modal open={open} onClose={onClose} title="new order" size="sm">
      <form onSubmit={submit} className="space-y-3">
        <label className="block">
          <span className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-1">Vendor</span>
          <input value={vendor} onChange={(e) => setVendor(e.target.value)} autoFocus className="input" />
        </label>
        <label className="block">
          <span className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-1">Order #</span>
          <input value={orderNumber} onChange={(e) => setOrderNumber(e.target.value)} className="input" />
        </label>
        <label className="block">
          <span className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-1">Status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value as Order["status"])} className="input">
            {STATUSES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>
        <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-700">
          <button type="button" onClick={onClose} className="px-3 py-1.5 rounded-md text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-mortar-50 dark:hover:bg-slate-800 transition">
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
      <span className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-1">
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
      <span className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-1">
        {label}
      </span>
      <select defaultValue={value} onChange={(e) => onCommit(e.target.value)} className="input">
        {options.map((o) => (<option key={o} value={o}>{o}</option>))}
      </select>
    </label>
  );
}
