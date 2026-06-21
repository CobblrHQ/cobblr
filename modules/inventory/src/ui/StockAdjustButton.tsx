// Stock-adjust pop-up. Explicit signed delta + reason; no accidental
// qty edits via the part form. Mirrors the explicit-save pattern
// we'd want for any destructive financial-ish action.

import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Modal } from "@cobblr/platform-web";
import { useInventory } from "./context";

export function StockAdjustButton({ partId }: { partId: string }) {
  const { api } = useInventory();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [delta, setDelta] = useState("1");
  const [reason, setReason] = useState("");

  const adjust = useMutation({
    mutationFn: () =>
      api.stockAdjust(partId, Number(delta), reason.trim() || undefined),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["inventory-part", partId] });
      void qc.invalidateQueries({ queryKey: ["inventory-parts"] });
      setOpen(false);
      setDelta("1");
      setReason("");
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    const d = Number(delta);
    if (!Number.isFinite(d) || d === 0) return;
    adjust.mutate();
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs rounded-md border border-line dark:border-slate-700 text-content dark:text-mortar-200 hover:bg-mortar-100 dark:bg-slate-800 px-2 py-1 transition"
      >
        Adjust
      </button>
      {/* Shared Modal → inherits the smart backdrop rule (closes when untouched,
          protects once you've typed a delta/reason). Was a hand-rolled overlay
          that closed on any outside click — a data-loss trap on a started edit. */}
      <Modal open={open} onClose={() => setOpen(false)} title="Adjust stock" size="sm">
        <form onSubmit={submit} className="space-y-3">
            <label className="block">
              <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
                Delta (signed)
              </span>
              <input
                type="number"
                step="any"
                value={delta}
                onChange={(e) => setDelta(e.target.value)}
                className="input font-mono"
                autoFocus
              />
            </label>
            <label className="block">
              <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
                Reason (optional)
              </span>
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. new shipment, lost some"
                className="input"
              />
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="flex-1 rounded-md border border-line dark:border-slate-700 text-sm text-content dark:text-mortar-200 hover:bg-subtle dark:bg-slate-800/70 transition py-2"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={adjust.isPending}
                className="flex-1 rounded-md bg-slate-700 hover:bg-slate-600 text-mortar-50 text-sm font-medium py-2 transition disabled:opacity-50"
              >
                {adjust.isPending ? "…" : "Apply"}
              </button>
            </div>
        </form>
      </Modal>
    </>
  );
}
