// A hold on the order's page (#8838): a draft order sets its lines' stock aside for
// the customer, optionally until a day. The item then shows as held, and another
// order is told only what is free. The rules (only a draft, only what stock covers
// after other holds) are the server's (holds.ts); this asks it and says what it answered.
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Modal, useToast } from "@cobblr/platform-web";
import type { SalesApi, SalesOrderDetail } from "./api.js";

export function HoldPanel({ api, order }: { api: SalesApi; order: SalesOrderDetail }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["sales-order", order.id] });
    void qc.invalidateQueries({ queryKey: ["sales-order-history", order.id] });
    void qc.invalidateQueries({ queryKey: ["sales-orders"] });
  };
  const release = useMutation({
    mutationFn: () => api.releaseHold(order.id),
    onSuccess: () => { toast.success("Hold released."); refresh(); },
    onError: (e) => toast.error((e as Error).message),
  });
  const held = !!order.held_at;
  const stocked = order.items.some((it) => it.part_id && Number(it.qty) - Number(it.qty_fulfilled) > 0);
  if (order.status !== "draft" || (!held && !stocked)) return null;
  const who = order.customer_name?.trim() || "this order";
  return (
    <div data-testid="hold-panel" className="space-y-1.5 border border-line dark:border-slate-700 rounded p-3">
      <span className="text-[10px] uppercase tracking-widest text-muted">Hold</span>
      {held ? (
        <>
          <p data-testid="hold-state" className="text-sm">
            Held for {who}{order.hold_until ? ` until ${order.hold_until.slice(0, 10)}` : ""}. Nobody else can sell it.
          </p>
          <div className="flex flex-wrap gap-3">
            <button type="button" onClick={() => setOpen(true)} className="text-xs text-accent hover:underline">Change the day…</button>
            <button type="button" disabled={release.isPending} onClick={() => release.mutate()} className="text-xs text-accent hover:underline">Release the hold</button>
          </div>
        </>
      ) : (
        <>
          <p className="text-sm text-muted">Set this order's stock aside so it is not sold to someone else.</p>
          <button type="button" onClick={() => setOpen(true)} className="text-xs text-accent hover:underline">Hold this stock…</button>
        </>
      )}
      {open && <HoldForm api={api} order={order} who={who} onClose={() => setOpen(false)} onDone={refresh} />}
    </div>
  );
}

function HoldForm({ api, order, who, onClose, onDone }: { api: SalesApi; order: SalesOrderDetail; who: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [day, setDay] = useState(order.hold_until?.slice(0, 10) ?? "");
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => api.holdOrder(order.id, day ? { until: day } : {}),
    onSuccess: () => {
      onDone();
      onClose();
      toast.action("Held.", { actionLabel: "Undo", duration: 8000, onAction: async () => { try { await api.releaseHold(order.id); toast.success("Hold released."); } catch (e) { toast.error((e as Error).message); } onDone(); } });
    },
    onError: (e) => setError((e as Error).message),
  });
  const input = "w-full rounded-lg border border-line bg-surface px-3 py-2 text-content dark:border-slate-600";
  return (
    <Modal open onClose={onClose} title="Hold this stock" size="sm">
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); setError(null); save.mutate(); }}>
        <p className="text-sm">The stock on this order's lines is set aside for {who}. It shows as held, and is never sold twice.</p>
        <label className="block space-y-1">
          <span className="text-sm font-medium">Until (optional)</span>
          <input className={input} type="date" value={day} onChange={(e) => setDay(e.target.value)} />
          <span className="block text-xs text-muted">Leave empty to hold it until you let it go. It also lets go if the order is cancelled or fulfilled.</span>
        </label>
        {error && <p role="alert" className="text-sm text-ember-700 dark:text-ember-300">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-3 py-2 text-sm text-muted">Cancel</button>
          <button type="submit" disabled={save.isPending} className="px-3 py-2 text-sm rounded bg-cobble-600 text-white disabled:opacity-60">Hold</button>
        </div>
      </form>
    </Modal>
  );
}
