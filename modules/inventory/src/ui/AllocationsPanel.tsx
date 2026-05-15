// Allocations for one part — reserved / consumed / released history,
// inline consume + release controls on the reserved ones, and a
// "new reservation" form at the bottom.

import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useInventory } from "./context";
import type { AllocationStatus } from "./api";

export function AllocationsPanel({ partId }: { partId: string }) {
  const { api } = useInventory();
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ["inventory-allocations", partId],
    queryFn: () => api.listAllocations({ part_id: partId }),
  });

  const setStatus = useMutation({
    mutationFn: (v: { id: string; status: "consumed" | "released" }) =>
      api.setAllocationStatus(v.id, v.status),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["inventory-allocations", partId] });
      void qc.invalidateQueries({ queryKey: ["inventory-part", partId] });
      void qc.invalidateQueries({ queryKey: ["inventory-parts"] });
    },
  });

  const items = list.data?.items ?? [];

  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5 space-y-3">
      <div className="text-[10px] font-mono uppercase tracking-widest text-cobble-500">
        // allocations
      </div>
      {list.isLoading && <div className="text-xs text-slate-400 dark:text-slate-500">loading…</div>}
      {items.length === 0 && !list.isLoading && (
        <div className="text-xs text-slate-400 dark:text-slate-500 italic">
          No allocations yet. Reserve some below.
        </div>
      )}
      {items.length > 0 && (
        <ul className="divide-y divide-slate-100 dark:divide-slate-700 -mx-1">
          {items.map((a) => (
            <li key={a.id} className="px-1 py-2 flex items-baseline gap-3 text-sm">
              <span className="font-mono w-16 shrink-0 text-slate-700 dark:text-mortar-100">{fmt(a.qty)}</span>
              <StatusBadge status={a.status} />
              <span className="flex-1 truncate text-slate-500 dark:text-slate-400 font-mono text-xs">
                {a.target_module}/{a.target_entity_type}/{a.target_entity_id}
              </span>
              {a.reason && (
                <span className="text-xs text-slate-400 dark:text-slate-500 italic truncate max-w-[160px]">
                  {a.reason}
                </span>
              )}
              {a.status === "reserved" && (
                <span className="flex gap-1">
                  <button
                    onClick={() => setStatus.mutate({ id: a.id, status: "consumed" })}
                    className="text-[10px] uppercase tracking-widest text-cobble-600 hover:text-cobble-800"
                  >
                    consume
                  </button>
                  <span className="text-slate-300 dark:text-slate-600">·</span>
                  <button
                    onClick={() => setStatus.mutate({ id: a.id, status: "released" })}
                    className="text-[10px] uppercase tracking-widest text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:text-mortar-200"
                  >
                    release
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <ReserveForm partId={partId} />
    </div>
  );
}

function ReserveForm({ partId }: { partId: string }) {
  const { api } = useInventory();
  const qc = useQueryClient();
  const [qty, setQty] = useState("1");
  const [targetModule, setTargetModule] = useState("projects");
  const [targetType, setTargetType] = useState("task");
  const [targetId, setTargetId] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const reserve = useMutation({
    mutationFn: () =>
      api.createAllocation({
        part_id: partId,
        qty: Number(qty),
        target_module: targetModule.trim(),
        target_entity_type: targetType.trim(),
        target_entity_id: targetId.trim(),
        reason: reason.trim() || undefined,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["inventory-allocations", partId] });
      void qc.invalidateQueries({ queryKey: ["inventory-part", partId] });
      void qc.invalidateQueries({ queryKey: ["inventory-parts"] });
      setQty("1");
      setTargetId("");
      setReason("");
      setError(null);
    },
    onError: (e: unknown) => {
      setError((e as Error).message);
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!targetId.trim() || !Number(qty)) return;
    reserve.mutate();
  }

  return (
    <form onSubmit={submit} className="border-t border-slate-100 dark:border-slate-700 pt-3 mt-3 space-y-2">
      <div className="text-[10px] font-mono uppercase tracking-widest text-slate-400 dark:text-slate-500">
        Reserve for…
      </div>
      <div className="grid grid-cols-4 gap-2">
        <input
          type="number"
          step="any"
          min="0"
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          placeholder="qty"
          className="input col-span-1"
        />
        <input
          value={targetModule}
          onChange={(e) => setTargetModule(e.target.value)}
          placeholder="module"
          className="input col-span-1 font-mono text-xs"
        />
        <input
          value={targetType}
          onChange={(e) => setTargetType(e.target.value)}
          placeholder="entity type"
          className="input col-span-1 font-mono text-xs"
        />
        <input
          value={targetId}
          onChange={(e) => setTargetId(e.target.value)}
          placeholder="entity id"
          className="input col-span-1 font-mono text-xs"
        />
      </div>
      <div className="flex gap-2">
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="optional reason"
          className="input flex-1 text-xs"
        />
        <button
          type="submit"
          disabled={reserve.isPending || !targetId.trim() || !Number(qty)}
          className="rounded-md bg-slate-700 hover:bg-slate-600 text-mortar-50 text-xs font-medium px-3 py-2 transition disabled:opacity-50"
        >
          {reserve.isPending ? "…" : "Reserve"}
        </button>
      </div>
      {error && <div className="text-xs text-ember-500">{error}</div>}
    </form>
  );
}

function StatusBadge({ status }: { status: AllocationStatus }) {
  const map: Record<AllocationStatus, { label: string; cls: string }> = {
    reserved: { label: "reserved", cls: "bg-cobble-50 text-cobble-600" },
    consumed: { label: "consumed", cls: "bg-moss-50 text-moss-600" },
    released: { label: "released", cls: "bg-slate-100 text-slate-500 dark:text-slate-400" },
  };
  const v = map[status];
  return (
    <span className={`text-[9px] font-mono uppercase tracking-widest px-1.5 py-0.5 rounded shrink-0 ${v.cls}`}>
      {v.label}
    </span>
  );
}

function fmt(n: number | string): string {
  const v = typeof n === "string" ? Number(n) : n;
  if (Number.isNaN(v)) return String(n);
  return Number.isInteger(v) ? String(v) : String(parseFloat(v.toFixed(3)));
}
