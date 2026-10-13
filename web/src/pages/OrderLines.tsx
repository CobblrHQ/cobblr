// Adding and correcting the lines of an order, on the order itself.
//
// An order's lines could only come from a receipt or from Cobb: typing in
// what you bought, or fixing a count the receipt misread, had no control on
// the page. Here a line is added with what it bought (an item you keep, or
// just words), how many and the price; each line can be corrected or
// removed. On an order that has already arrived a new line adds its stock
// unless "Add these to stock" is unticked (a purchase filled in after the
// fact). A line whose stock was already added keeps its count: the item's own
// count is where that correction belongs, and the server refuses it too
// (line-edit.ts).

import { useState, type FormEvent } from "react";
import { parcelWords } from "../features/purchases/parcelWords";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2, ArrowUpRight } from "lucide-react";
import { Link } from "react-router-dom";
import { MoneyInput, useMoneyCurrency, RelationSelect, useConfirm, useToast } from "@cobblr/platform-web";
import { ApiError, api, type Order, type OrderItem } from "../lib/api";
import { StartReturnButton } from "./OrderReturns";
import { usePurchaseLineActions } from "./purchaseLineActions";

/** The choice an order that has already arrived carries: whether its lines
 *  add their stock. On by default; off when filling in past purchases. */
export function AddToStockChoice({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="flex items-start gap-2 text-sm text-content dark:text-mortar-100">
      <input type="checkbox" className="mt-0.5" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>
        Add these to stock
        <span className="block text-xs text-muted">Untick when logging a past purchase whose stock you already counted.</span>
      </span>
    </label>
  );
}

const orderKey = (slug: string, id: string) => ["order", slug, id];

/** Whether this line's stock was already added, so its count is settled. */
export function lineCountSettled(order: Pick<Order, "add_to_stock">, item: Pick<OrderItem, "received_at" | "part_id">): boolean {
  return !!item.received_at && !!item.part_id && order.add_to_stock !== false;
}


export function AddOrderLine({ slug, order }: { slug: string; order: Order }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [partId, setPartId] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [qty, setQty] = useState("1");
  const mainCurrency = useMoneyCurrency();
  const [currency, setCurrency] = useState(order.currency || mainCurrency);
  const [unitCost, setUnitCost] = useState<number | null>(null);
  const [addToStock, setAddToStock] = useState(order.add_to_stock !== false);
  const arrived = order.status === "arrived";

  const add = useMutation({
    mutationFn: () =>
      api.addOrderItem(slug, order.id, {
        part_id: partId,
        description: description.trim() || null,
        qty: Number(qty),
        unit_cost: unitCost,
        metadata: { currency },
        ...(arrived ? { add_to_stock: addToStock } : {}),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: orderKey(slug, order.id) });
      void qc.invalidateQueries({ queryKey: ["orders", slug] });
      setPartId(null);
      setDescription("");
      setQty("1");
      setUnitCost(null);
      setOpen(false);
      toast.success(arrived && addToStock && partId ? "Line added, and its stock with it." : "Line added.");
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Couldn't add the line."),
  });

  const qtyOk = Number(qty) > 0;
  const saysWhat = !!partId || description.trim().length > 0;
  function submit(e: FormEvent) {
    e.preventDefault();
    if (qtyOk && saysWhat) add.mutate();
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-accent hover:underline">
        <Plus size={13} /> Add a line
      </button>
    );
  }
  return (
    <form onSubmit={submit} className="mt-2 rounded-lg border border-line dark:border-slate-700 p-3 space-y-2" aria-label="Add a line">
      <label className="block">
        <span className="block text-xs text-muted mb-1">Item you keep (optional)</span>
        <RelationSelect refKind="inventory:part" label="Part" value={partId} onChange={setPartId} className="w-full" />
      </label>
      <label className="block">
        <span className="block text-xs text-muted mb-1">What it is</span>
        <input value={description} onChange={(e) => setDescription(e.target.value)} className="input" placeholder="Wood screws, 4 x 40 mm" />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="block text-xs text-muted mb-1">How many</span>
          <input type="number" inputMode="decimal" min="0" step="any" value={qty} onChange={(e) => setQty(e.target.value)} className="input" />
        </label>
        <label className="block">
          <span className="block text-xs text-muted mb-1">Cost each</span>
          <MoneyInput currency={currency} onCurrencyChange={setCurrency} value={unitCost} storage="amount" live onCommit={setUnitCost} ariaLabel="Cost each" />
        </label>
      </div>
      {arrived && <AddToStockChoice checked={addToStock} onChange={setAddToStock} />}
      {!saysWhat && <p className="text-xs text-faint">Pick the item, or say what it is.</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={() => setOpen(false)} className="px-3 py-1.5 rounded-md text-sm text-content dark:text-slate-300 hover:bg-subtle dark:hover:bg-slate-800">
          Cancel
        </button>
        <button type="submit" disabled={!qtyOk || !saysWhat || add.isPending} className="px-3 py-1.5 rounded-md text-sm font-medium bg-cobble-600 hover:bg-cobble-700 text-white disabled:opacity-50">
          {add.isPending ? "Adding…" : "Add line"}
        </button>
      </div>
    </form>
  );
}

/** Correct or remove one line, from its row. */
/** What a line is when it is not a thing, as the receipt reader marked it: a
 *  charge (a fee, a tax, delivery) or a bill of sale's add-on. */
export function orderLineKind(item: Pick<OrderItem, "metadata">): "charge" | "add-on" | null {
  const k = (item.metadata as { line_kind?: unknown } | null)?.line_kind;
  return k === "charge" || k === "add-on" ? k : null;
}

/** A charge says so; an add-on says so and offers to become an item until it
 *  is one (#4523). Nothing for an ordinary line. */
export function OrderLineKind({ slug, order, item }: { slug: string; order: Order; item: OrderItem }) {
  const toast = useToast();
  const qc = useQueryClient();
  const kind = orderLineKind(item);
  const claimed = !!item.part_id || !!item.subject_id;
  // One read per order, shared by its lines: which are already in the inbox.
  const inInbox = useQuery({
    queryKey: ["order-lines-in-inbox", slug, order.id],
    queryFn: () => api.orderLinesInInbox(slug, order.id),
    enabled: kind === "add-on" && !claimed,
    staleTime: 30_000,
  });
  const madeId = inInbox.data?.items.find((r) => r.order_item_id === item.id)?.id ?? null;
  const promote = useMutation({
    mutationFn: () =>
      api.orderLineToInbox(slug, {
        order_id: order.id,
        order_item_id: item.id,
        description: item.description ?? "Item",
        qty: Number(item.qty) || 1,
        unit_cost: item.unit_cost == null ? null : Number(item.unit_cost),
      }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["order-lines-in-inbox", slug, order.id] });
      toast.success(r.existed ? "It is already in the scan inbox." : "Added to the scan inbox, ready to file.");
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Couldn't make it an item."),
  });
  if (!kind) return null;
  if (kind === "charge") {
    return (
      <span title="A fee, tax or charge: paid, but not a thing you keep" className="shrink-0 rounded-full border border-line dark:border-slate-700 px-1.5 py-0.5 text-[10px] text-muted">
        charge
      </span>
    );
  }
  if (claimed) return null;
  return madeId ? (
    <Link to={`/scan?item=${madeId}`} className="shrink-0 inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-accent hover:underline">
      In the scan inbox <ArrowUpRight size={12} />
    </Link>
  ) : (
    <button
      type="button"
      onClick={() => promote.mutate()}
      disabled={promote.isPending}
      title="An extra on this purchase. Make it an item of its own to keep track of it."
      className="shrink-0 rounded-md border border-line dark:border-slate-700 px-2 py-1 text-xs text-content dark:text-mortar-100 hover:border-cobble-500 hover:text-accent disabled:opacity-50"
    >
      {promote.isPending ? "Adding…" : "Make it an item"}
    </button>
  );
}

/** Which parcel a line travels in, when its order ships in several (#5351):
 *  "On its way: Amazon Logistics TBA335321582286, expected Oct 11", or "Not
 *  shipped yet" for a line no parcel has named. Nothing for an order that
 *  ships in one box, and nothing once the line is received. */
export function orderLineParcel(
  order: Pick<Order, "shipments" | "tracking_number">,
  item: Pick<OrderItem, "shipment_id" | "received_at">,
): { label: string; title: string } | null {
  const parcels = order.shipments ?? [];
  if (!parcels.length || item.received_at) return null;
  const parcel = item.shipment_id ? parcels.find((p) => p.id === item.shipment_id) : null;
  if (!parcel) {
    return order.tracking_number ? null : { label: "Not shipped yet", title: "No shipping notice has named this line yet" };
  }
  const words = parcelWords(parcel);
  return { label: words, title: words };
}

function OrderLineParcel({ order, item }: { order: Order; item: OrderItem }) {
  const parcel = orderLineParcel(order, item);
  if (!parcel) return null;
  return (
    <span title={parcel.title} className="shrink-0 max-w-[14rem] truncate rounded-full border border-line dark:border-slate-700 px-1.5 py-0.5 text-[10px] text-muted">
      {parcel.label}
    </span>
  );
}

/** The lines a new parcel starts with: every line still to come that no
 *  parcel carries yet. A line already in a parcel stays there unless the
 *  person ticks it. */
export function trackingSheetStart(items: Array<Pick<OrderItem, "id" | "shipment_id" | "received_at">>): string[] {
  return items.filter((i) => !i.received_at && !i.shipment_id).map((i) => i.id);
}

/** The lines to send with a hand-added parcel. Nothing (the whole order) only
 *  when the order has no parcel yet and every line still to come is ticked;
 *  once it ships in parcels, the ticked lines are always named, so a line in
 *  another parcel is never moved by leaving the boxes as they were. */
export function trackingSheetLines(
  order: Pick<Order, "shipments">,
  items: Array<Pick<OrderItem, "id" | "received_at">>,
  picked: ReadonlySet<string>,
): string[] | undefined {
  const open = items.filter((i) => !i.received_at);
  const ticked = open.filter((i) => picked.has(i.id)).map((i) => i.id);
  if (!(order.shipments ?? []).length && ticked.length === open.length) return undefined;
  return ticked;
}

/** Add tracking to an order by hand (#5351): the number, or the carrier's
 *  tracking link pasted whole, and the lines in that box. The lines no
 *  parcel carries yet are ticked to begin with; a first box with all of them
 *  is the whole order, and its number goes on the order itself. */
export function AddTrackingSheet({ slug, order, items, onClose }: { slug: string; order: Order; items: OrderItem[]; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const open = items.filter((i) => !i.received_at);
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<Set<string>>(() => new Set(trackingSheetStart(items)));
  const add = useMutation({
    mutationFn: () => {
      const lineIds = trackingSheetLines(order, items, picked);
      return api.addShipment(slug, order.id, { tracking_number: text.trim(), ...(lineIds ? { line_ids: lineIds } : {}) });
    },
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: orderKey(slug, order.id) });
      void qc.invalidateQueries({ queryKey: ["orders", slug] });
      toast.success(r.mode === "order" ? `Tracking ${r.tracking_number} added to the order.` : `Tracking ${r.tracking_number} added to ${r.lines.length} line${r.lines.length === 1 ? "" : "s"}.`);
      onClose();
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Couldn't add the tracking number."),
  });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        add.mutate();
      }}
      aria-label="Add tracking"
      className="mt-2 rounded-md border border-line dark:border-slate-700 p-3 space-y-2"
    >
      <label className="block">
        <span className="block text-xs text-muted mb-1">Tracking number, or the tracking link from the email</span>
        <input value={text} onChange={(e) => setText(e.target.value)} className="input" autoFocus placeholder="TBA335321582286" />
      </label>
      {open.length > 1 && (
        <fieldset className="space-y-1">
          <legend className="text-xs text-muted mb-1">What is in this box</legend>
          {open.map((i) => (
            <label key={i.id} className="flex items-start gap-2 text-sm text-content dark:text-mortar-100">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={picked.has(i.id)}
                onChange={(e) =>
                  setPicked((prev) => {
                    const next = new Set(prev);
                    if (e.target.checked) next.add(i.id);
                    else next.delete(i.id);
                    return next;
                  })
                }
              />
              <span className="min-w-0 break-words">
                {i.description ?? "Item"}
                {i.shipment_id && <span className="block text-xs text-muted">{orderLineParcel(order, i)?.label}</span>}
              </span>
            </label>
          ))}
        </fieldset>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className="px-3 py-1.5 rounded-md text-sm text-content dark:text-slate-300 hover:bg-subtle dark:hover:bg-slate-800">
          Cancel
        </button>
        <button type="submit" disabled={!text.trim() || picked.size === 0 || add.isPending} className="px-3 py-1.5 rounded-md text-sm font-medium bg-cobble-600 hover:bg-cobble-700 text-white disabled:opacity-50">
          {add.isPending ? "Adding…" : "Add tracking"}
        </button>
      </div>
    </form>
  );
}

export function OrderLineControls({ slug, order, item, onStartReturn }: { slug: string; order: Order; item: OrderItem; onStartReturn?: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const [description, setDescription] = useState(item.description ?? "");
  const [qty, setQty] = useState(String(Number(item.qty)));
  const mainCurrency = useMoneyCurrency();
  const [currency, setCurrency] = useState(item.currency || order.currency || mainCurrency);
  const [unitCost, setUnitCost] = useState<number | null>(item.unit_cost == null ? null : Number(item.unit_cost));
  const settled = lineCountSettled(order, item);
  const actions = usePurchaseLineActions(slug, order, item);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: orderKey(slug, order.id) });
    void qc.invalidateQueries({ queryKey: ["orders", slug] });
  };

  const save = useMutation({
    mutationFn: () =>
      api.updateOrderItem(slug, order.id, item.id, {
        description: description.trim() || null,
        ...(settled ? {} : { qty: Number(qty) }),
        unit_cost: unitCost,
        currency,
      }),
    onSuccess: () => {
      refresh();
      setEditing(false);
      toast.success("Line saved.");
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Couldn't save the line."),
  });
  const remove = useMutation({
    mutationFn: () => api.removeOrderItem(slug, order.id, item.id),
    onSuccess: () => {
      refresh();
      toast.success("Line removed.");
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Couldn't remove the line."),
  });

  async function askRemove() {
    const ok = await confirm({
      title: "Remove this line?",
      message: settled ? "The order forgets it. The stock it added stays where it is; change the item's count if that is wrong too." : "The order forgets it.",
      confirmLabel: "Remove line",
      destructive: true,
    });
    if (ok) remove.mutate();
  }

  if (!editing) {
    return (
      // A line with a label or a button keeps the line itself at full width on
      // a phone: beside them its name and price were squeezed into each other.
      <span className={`flex items-center gap-1 shrink-0 ${orderLineKind(item) || orderLineParcel(order, item) ? "max-sm:basis-full max-sm:justify-end" : ""}`}>
        <OrderLineParcel order={order} item={item} />
        <OrderLineKind slug={slug} order={order} item={item} />
        {onStartReturn && actions.startReturn.offered && <StartReturnButton onClick={onStartReturn} />}
        <button type="button" onClick={() => setEditing(true)} aria-label="Correct this line" title="Correct this line" className="p-1.5 rounded text-faint hover:text-accent hover:bg-subtle dark:hover:bg-slate-800">
          <Pencil size={13} />
        </button>
        <button type="button" onClick={() => void askRemove()} aria-label="Remove this line" title="Remove this line" className="p-1.5 rounded text-faint hover:text-ember-500 hover:bg-subtle dark:hover:bg-slate-800">
          <Trash2 size={13} />
        </button>
      </span>
    );
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
      className="basis-full mt-2 grid grid-cols-2 sm:grid-cols-4 gap-2 items-end"
      aria-label="Correct this line"
    >
      <label className="col-span-2">
        <span className="block text-xs text-muted mb-1">What it is</span>
        <input value={description} onChange={(e) => setDescription(e.target.value)} className="input" />
      </label>
      <label>
        <span className="block text-xs text-muted mb-1">How many</span>
        <input
          type="number"
          inputMode="decimal"
          min="0"
          step="any"
          value={qty}
          disabled={settled}
          title={settled ? "Its stock was already added. Change the item's count instead." : undefined}
          onChange={(e) => setQty(e.target.value)}
          className="input disabled:opacity-60"
        />
      </label>
      <label>
        <span className="block text-xs text-muted mb-1">Cost each</span>
        <MoneyInput currency={currency} onCurrencyChange={setCurrency} value={unitCost} storage="amount" live onCommit={setUnitCost} ariaLabel="Cost each" />
      </label>
      {settled && <p className="col-span-2 sm:col-span-4 text-xs text-faint">Its stock was already added, so its count stays. Change the item's own count if that is wrong.</p>}
      <div className="col-span-2 sm:col-span-4 flex justify-end gap-2">
        <button type="button" onClick={() => setEditing(false)} className="px-3 py-1.5 rounded-md text-sm text-content dark:text-slate-300 hover:bg-subtle dark:hover:bg-slate-800">
          Cancel
        </button>
        <button type="submit" disabled={save.isPending || (!settled && !(Number(qty) > 0))} className="px-3 py-1.5 rounded-md text-sm font-medium bg-cobble-600 hover:bg-cobble-700 text-white disabled:opacity-50">
          {save.isPending ? "Saving…" : "Save line"}
        </button>
      </div>
    </form>
  );
}
