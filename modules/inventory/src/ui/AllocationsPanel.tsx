// Allocations for one part — reserved / consumed / released history,
// inline consume + release controls on the reserved ones, and a
// "new reservation" form at the bottom.

import { useEffect, useState, type FormEvent } from "react";
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
    <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-5 space-y-3">
      <div className="text-[10px] font-mono uppercase tracking-widest text-accent">
        // allocations
      </div>
      {list.isLoading && <div className="text-xs text-faint dark:text-slate-500">loading…</div>}
      {items.length === 0 && !list.isLoading && (
        <div className="text-xs text-faint dark:text-slate-500 italic">
          No allocations yet. Reserve some below.
        </div>
      )}
      {items.length > 0 && (
        <ul className="divide-y divide-line dark:divide-slate-700 -mx-1">
          {items.map((a) => (
            <li key={a.id} className="px-1 py-2 flex items-baseline gap-3 text-sm">
              <span className="font-mono w-16 shrink-0 text-content dark:text-mortar-100">{fmt(a.qty)}</span>
              <StatusBadge status={a.status} />
              <span className="flex-1 truncate text-muted dark:text-slate-400 font-mono text-xs">
                {a.target_module}/{a.target_entity_type}/{a.target_entity_id}
              </span>
              {a.reason && (
                <span className="text-xs text-faint dark:text-slate-500 italic truncate max-w-[160px]">
                  {a.reason}
                </span>
              )}
              {a.status === "reserved" && (
                <span className="flex gap-1">
                  <button
                    onClick={() => setStatus.mutate({ id: a.id, status: "consumed" })}
                    className="text-[10px] uppercase tracking-widest text-accent hover:text-cobble-800"
                  >
                    consume
                  </button>
                  <span className="text-faint dark:text-slate-600">·</span>
                  <button
                    onClick={() => setStatus.mutate({ id: a.id, status: "released" })}
                    className="text-[10px] uppercase tracking-widest text-faint dark:text-slate-500 hover:text-content dark:text-mortar-200"
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
  const [target, setTarget] = useState<{ module: string; type: string; id: string; label: string } | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const reserve = useMutation({
    mutationFn: () =>
      api.createAllocation({
        part_id: partId,
        qty: Number(qty),
        target_module: target!.module,
        target_entity_type: target!.type,
        target_entity_id: target!.id,
        reason: reason.trim() || undefined,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["inventory-allocations", partId] });
      void qc.invalidateQueries({ queryKey: ["inventory-part", partId] });
      void qc.invalidateQueries({ queryKey: ["inventory-parts"] });
      setQty("1");
      setTarget(null);
      setReason("");
      setError(null);
    },
    onError: (e: unknown) => {
      setError((e as Error).message);
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!target || !Number(qty)) return;
    reserve.mutate();
  }

  return (
    <form onSubmit={submit} className="border-t border-line dark:border-slate-700 pt-3 mt-3 space-y-2">
      <div className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500">
        Reserve for…
      </div>
      <div className="flex gap-2">
        <input
          type="number"
          step="any"
          min="0"
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          placeholder="qty"
          className="input w-20 shrink-0"
        />
        <div className="flex-1 min-w-0">
          <EntityPicker selected={target} onSelect={setTarget} onClear={() => setTarget(null)} />
        </div>
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
          disabled={reserve.isPending || !target || !Number(qty)}
          className="rounded-md bg-slate-700 hover:bg-slate-600 text-mortar-50 text-xs font-medium px-3 py-2 transition disabled:opacity-50"
        >
          {reserve.isPending ? "…" : "Reserve"}
        </button>
      </div>
      {error && <div className="text-xs text-ember-500">{error}</div>}
    </form>
  );
}

// Typeahead entity picker — search across kinds (core-search) and pick a
// real entity, so reserving no longer means typing a raw module/type/UUID.
function EntityPicker({
  selected,
  onSelect,
  onClear,
}: {
  selected: { label: string } | null;
  onSelect: (e: { module: string; type: string; id: string; label: string }) => void;
  onClear: () => void;
}) {
  const { api } = useInventory();
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 200);
    return () => clearTimeout(t);
  }, [q]);
  const results = useQuery({
    queryKey: ["reserve-entity-search", debounced],
    queryFn: () => api.searchEntities(debounced),
    enabled: debounced.trim().length >= 2,
  });

  if (selected) {
    return (
      <div className="input flex items-center gap-2">
        <span className="flex-1 truncate text-sm text-content dark:text-mortar-100">{selected.label}</span>
        <button
          type="button"
          onClick={onClear}
          className="text-xs text-faint hover:text-ember-500 shrink-0"
          title="Change target"
        >
          ✕
        </button>
      </div>
    );
  }

  const items = results.data?.items ?? [];
  return (
    <div className="relative">
      <input
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder="search a task, project, anything to reserve for…"
        className="input text-sm"
      />
      {open && debounced.trim().length >= 2 && (
        <ul className="absolute z-20 mt-1 w-full max-h-56 overflow-auto rounded-md border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 shadow-lg">
          {results.isLoading && <li className="px-3 py-2 text-xs text-faint">searching…</li>}
          {!results.isLoading && items.length === 0 && (
            <li className="px-3 py-2 text-xs text-faint italic">no matches</li>
          )}
          {items.map((it) => {
            const [module = "", type = ""] = it.kind.split(":");
            const label = it.title ?? it.name ?? it.id;
            return (
              <li key={`${it.kind}:${it.id}`}>
                <button
                  type="button"
                  onClick={() => {
                    onSelect({ module, type, id: it.id, label });
                    setOpen(false);
                    setQ("");
                  }}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-subtle dark:hover:bg-slate-800 flex items-center gap-2"
                >
                  <span className="flex-1 truncate text-content dark:text-mortar-100">{label}</span>
                  <span className="text-[10px] font-mono text-faint shrink-0">{it.kind}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: AllocationStatus }) {
  const map: Record<AllocationStatus, { label: string; cls: string }> = {
    reserved: { label: "reserved", cls: "bg-cobble-50 text-accent" },
    consumed: { label: "consumed", cls: "bg-moss-50 text-moss-600" },
    released: { label: "released", cls: "bg-subtle text-muted dark:text-slate-400" },
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
