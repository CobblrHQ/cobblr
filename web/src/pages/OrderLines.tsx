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
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { MoneyInput, RelationSelect, useConfirm, useToast } from "@cobblr/platform-web";
import { ApiError, api, type Order, type OrderItem } from "../lib/api";

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
        <RelationSelect refKind="inventory:part" value={partId} onChange={setPartId} className="w-full" />
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
          <MoneyInput value={unitCost} storage="amount" live onCommit={setUnitCost} ariaLabel="Cost each" />
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
export function OrderLineControls({ slug, order, item }: { slug: string; order: Order; item: OrderItem }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const [description, setDescription] = useState(item.description ?? "");
  const [qty, setQty] = useState(String(Number(item.qty)));
  const [unitCost, setUnitCost] = useState<number | null>(item.unit_cost == null ? null : Number(item.unit_cost));
  const settled = lineCountSettled(order, item);
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
      <span className="flex items-center gap-1 shrink-0">
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
        <MoneyInput value={unitCost} storage="amount" live onCommit={setUnitCost} ariaLabel="Cost each" />
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
