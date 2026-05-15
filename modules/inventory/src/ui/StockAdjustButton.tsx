// Stock-adjust pop-up. Explicit signed delta + reason; no accidental
// qty edits via the part form. Mirrors the explicit-save pattern
// we'd want for any destructive financial-ish action.

import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
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
        className="text-xs rounded-md border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-mortar-200 hover:bg-mortar-100 dark:bg-slate-800 px-2 py-1 transition"
      >
        Adjust
      </button>
      {open && (
        <div
          className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setOpen(false)}
        >
          <form
            onSubmit={submit}
            onClick={(e) => e.stopPropagation()}
            className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 max-w-sm w-full p-5 shadow-2xl space-y-3"
          >
            <div className="text-[10px] font-mono uppercase tracking-widest text-cobble-500">
              // stock adjust
            </div>
            <label className="block">
              <span className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-1">
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
              <span className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-1">
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
                className="flex-1 rounded-md border border-slate-200 dark:border-slate-700 text-sm text-slate-600 dark:text-mortar-200 hover:bg-mortar-50 dark:bg-slate-800/70 transition py-2"
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
        </div>
      )}
    </>
  );
}
