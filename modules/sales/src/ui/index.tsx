// sales UI — the host mounts <SalesUI /> at /sales. A list of sales orders; the
// detail modal carries the customer, line items (each an inventory part + qty +
// price), a running total, and the **Fulfill** button that decrements the sold
// parts from stock. Customers are managed from a header button. Modals for
// detail/create; toasts for feedback; destructive deletes confirm.

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Modal, useToast, useConfirm, usePageTitle } from "@cobblr/platform-web";
import { ShoppingCart, Plus, Trash2, X, Users, PackageCheck } from "lucide-react";
import {
  SalesApi, SalesApiError,
  type SalesOrder, type SalesOrderStatus, type CustomerSummary, type PartOption,
} from "./api.js";

export const navItems = [{ label: "Sales", path: "/sales", icon: ShoppingCart }];

const STATUSES: SalesOrderStatus[] = ["draft", "confirmed", "fulfilled", "shipped", "closed", "cancelled"];

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
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [customersOpen, setCustomersOpen] = useState(false);

  const orders = useQuery({ queryKey: ["sales-orders", orgSlug], queryFn: () => api.listOrders() });

  const del = useMutation({
    mutationFn: (id: string) => api.deleteOrder(id),
    onSuccess: () => { toast.success("Order deleted"); void qc.invalidateQueries({ queryKey: ["sales-orders", orgSlug] }); },
    onError: (e) => toast.error(e instanceof SalesApiError ? e.message : String(e)),
  });

  return (
    <div className="space-y-4 max-w-4xl">
      <div className="flex items-baseline justify-between border-b border-line dark:border-slate-700 pb-3">
        <h1 className="font-display text-2xl font-extrabold text-content dark:text-mortar-100 page-title">sales</h1>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => setCustomersOpen(true)} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border border-line dark:border-slate-600 hover:bg-subtle dark:hover:bg-slate-800 text-content dark:text-mortar-100">
            <Users size={14} /> Customers
          </button>
          <button type="button" onClick={() => setCreating(true)} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-cobble-600 text-white hover:bg-cobble-700">
            <Plus size={14} /> New order
          </button>
        </div>
      </div>

      {orders.isLoading && <div className="text-sm text-muted">Loading…</div>}
      {orders.data?.items.length === 0 && (
        <div className="text-sm text-muted italic">No sales orders yet. Create one - add what you sold, then Fulfill to draw it down from stock.</div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {orders.data?.items.map((o) => (
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

      {creating && <NewOrderModal api={api} orgSlug={orgSlug} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); setOpen(id); }} />}
      {open && <OrderDetailModal api={api} orgSlug={orgSlug} orderId={open} onClose={() => setOpen(null)} />}
      {customersOpen && <CustomersModal api={api} onClose={() => setCustomersOpen(false)} />}
    </div>
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
            {order.order_number && order.customer_name && <span>{order.order_number}</span>}
          </div>
        </button>
        <button type="button" onClick={onDelete} className="text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition shrink-0" aria-label="Delete order">
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
    <Modal open onClose={onClose} title="New sales order" size="sm">
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        <div>
          <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">Customer</span>
          <CustomerPicker api={api} customerId={customerId} customerName={customerName} onChange={(id, name) => { setCustomerId(id); setCustomerName(name); }} />
        </div>
        <div>
          <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">Order #</span>
          <input value={orderNumber} onChange={(e) => setOrderNumber(e.target.value)} className="w-full rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-3 py-2 text-sm" />
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-xs rounded bg-subtle dark:bg-slate-800">Cancel</button>
          <button type="submit" disabled={create.isPending} className="px-3 py-1.5 text-xs rounded bg-cobble-600 text-white disabled:opacity-50">Create</button>
        </div>
      </form>
    </Modal>
  );
}

function OrderDetailModal({ api, orgSlug, orderId, onClose }: { api: SalesApi; orgSlug: string; orderId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const detail = useQuery({ queryKey: ["sales-order", orderId], queryFn: () => api.getOrder(orderId) });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["sales-order", orderId] });
    void qc.invalidateQueries({ queryKey: ["sales-orders", orgSlug] });
  };
  const update = useMutation({ mutationFn: (patch: Partial<SalesOrder>) => api.updateOrder(orderId, patch), onSuccess: invalidate });
  const addItem = useMutation({
    mutationFn: (b: { part_id: string | null; description: string | null; qty: number; unit_price: number | null }) => api.addItem(orderId, b),
    onSuccess: invalidate,
    onError: (e) => toast.error(e instanceof SalesApiError ? e.message : String(e)),
  });
  const removeItem = useMutation({ mutationFn: (itemId: string) => api.removeItem(orderId, itemId), onSuccess: invalidate });
  const fulfill = useMutation({
    mutationFn: () => api.fulfillOrder(orderId),
    onSuccess: (r) => { toast.success(`Fulfilled — ${r.decremented.length} part${r.decremented.length === 1 ? "" : "s"} drawn from stock`); invalidate(); },
    onError: (e) => toast.error(e instanceof SalesApiError ? e.message : String(e)),
  });

  const d = detail.data;
  const fulfilled = d ? ["fulfilled", "shipped", "closed"].includes(d.status) : false;

  return (
    <Modal open onClose={onClose} title={d?.customer_name || d?.order_number || "Sales order"} size="lg">
      <div className="space-y-4">
        {detail.isLoading && <div className="text-sm text-muted">Loading…</div>}
        {d && (
          <>
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div>
                <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">Customer</span>
                <CustomerPicker api={api} customerId={d.customer_id} customerName={d.customer_name ?? ""} onChange={(id, name) => update.mutate({ customer_id: id, customer_name: name || null })} />
              </div>
              <div>
                <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">Status</span>
                <select value={d.status} onChange={(e) => update.mutate({ status: e.target.value as SalesOrderStatus })} className="w-full rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-3 py-2 text-sm">
                  {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
            </div>

            {/* line items */}
            <div>
              <div className="flex items-baseline justify-between mb-1.5">
                <span className="text-[10px] font-mono uppercase tracking-widest text-muted">Line items</span>
                <span className="text-sm font-semibold text-content dark:text-mortar-100">Total ${d.total.toFixed(2)}</span>
              </div>
              {d.items.length === 0 && <div className="text-sm text-muted italic">No line items yet. Add what was sold.</div>}
              <ul className="divide-y divide-slate-100 dark:divide-slate-800 border border-line dark:border-slate-700 rounded">
                {d.items.map((it) => (
                  <li key={it.id} className="flex items-center gap-3 px-3 py-2 text-sm group">
                    <span className="flex-1 text-content dark:text-mortar-100">{it.description || (it.part_id ? "(part)" : "(item)")}</span>
                    <span className="text-xs text-muted tabular-nums">
                      {Number(it.qty)}{it.unit_price ? ` × $${Number(it.unit_price).toFixed(2)}` : ""}
                    </span>
                    {!fulfilled && (
                      <button type="button" onClick={() => removeItem.mutate(it.id)} className="text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100" aria-label="Remove line item">
                        <X size={14} />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>

            {!fulfilled && <AddLineRow api={api} onAdd={(b) => addItem.mutate(b)} />}

            <div className="flex items-center justify-between pt-2 border-t border-line dark:border-slate-700">
              <span className="text-xs text-muted">
                {fulfilled ? `Fulfilled${d.fulfilled_at ? " " + new Date(d.fulfilled_at).toLocaleDateString() : ""} — stock already drawn down.` : "Fulfilling draws each line's part out of inventory stock."}
              </span>
              <button
                type="button"
                disabled={fulfilled || d.items.length === 0 || fulfill.isPending}
                onClick={() => fulfill.mutate()}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded bg-cobble-600 text-white hover:bg-cobble-700 disabled:opacity-50"
              >
                <PackageCheck size={15} /> Fulfill
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

function AddLineRow({ api, onAdd }: { api: SalesApi; onAdd: (b: { part_id: string | null; description: string | null; qty: number; unit_price: number | null }) => void }) {
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<PartOption | null>(null);
  const [desc, setDesc] = useState("");
  const [qty, setQty] = useState(1);
  const [price, setPrice] = useState("");
  const parts = useQuery({ queryKey: ["sales-part-search", q], queryFn: () => api.searchParts(q), enabled: q.length > 0 && !picked });

  function submit() {
    onAdd({
      part_id: picked?.id ?? null,
      description: (picked?.title ?? desc).trim() || null,
      qty: Math.max(1, qty),
      unit_price: price.trim() ? Number(price) : null,
    });
    setPicked(null); setQ(""); setDesc(""); setQty(1); setPrice("");
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
            <input
              value={q}
              onChange={(e) => { setQ(e.target.value); setDesc(e.target.value); }}
              placeholder="Search a part, or type a free-text item…"
              className="w-full rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-3 py-2 text-sm"
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
        <label className="text-xs text-muted">Qty <input type="number" min={1} value={qty} onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))} className="w-16 ml-1 rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-2 py-1.5 text-sm" /></label>
        <label className="text-xs text-muted">Unit $ <input value={price} onChange={(e) => setPrice(e.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" className="w-20 ml-1 rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-2 py-1.5 text-sm" /></label>
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
  const customers = useQuery({ queryKey: ["sales-customers"], queryFn: () => api.listCustomers() });
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
  return (
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
      <option value="">{customerName && !customerId ? `(unlinked: ${customerName})` : "— none —"}</option>
      {customers.data?.items.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      <option value="__new__">+ New customer…</option>
    </select>
  );
}

function CustomersModal({ api, onClose }: { api: SalesApi; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const customers = useQuery({ queryKey: ["sales-customers"], queryFn: () => api.listCustomers() });
  const [editing, setEditing] = useState<string | "new" | null>(null);
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
    <Modal open onClose={onClose} title="Customers" size="md">
      <div className="space-y-3">
        {customers.isLoading && <div className="text-sm text-muted">Loading…</div>}
        {customers.data?.items.length === 0 && editing !== "new" && <div className="text-sm text-muted italic">No customers yet. Add the people you sell to.</div>}
        <ul className="space-y-2">
          {customers.data?.items.map((c) => (
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
        {editing === "new" ? (
          <CustomerForm api={api} onDone={() => { setEditing(null); invalidate(); }} onCancel={() => setEditing(null)} />
        ) : (
          <button type="button" onClick={() => setEditing("new")} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-cobble-600 text-white"><Plus size={14} /> Add customer</button>
        )}
      </div>
    </Modal>
  );
}

function CustomerForm({ api, customer, onDone, onCancel }: { api: SalesApi; customer?: CustomerSummary; onDone: () => void; onCancel: () => void }) {
  const toast = useToast();
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
  return (
    <form className="rounded-lg border border-line dark:border-slate-700 p-3 space-y-2" onSubmit={(e) => { e.preventDefault(); if (name.trim()) save.mutate(); }}>
      <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Name *" className="w-full rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-3 py-2 text-sm" />
      <div className="grid grid-cols-2 gap-2">
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" className="rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-3 py-2 text-sm" />
        <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Phone" className="rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-3 py-2 text-sm" />
      </div>
      <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Address" className="w-full rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-3 py-2 text-sm" />
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="px-2.5 py-1.5 rounded text-xs bg-subtle dark:bg-slate-800">Cancel</button>
        <button type="submit" disabled={!name.trim() || save.isPending} className="px-2.5 py-1.5 rounded text-xs bg-cobble-600 text-white disabled:opacity-50">{customer ? "Save" : "Add"}</button>
      </div>
    </form>
  );
}

export default SalesUI;
