// Settings — categories + locations management. Phase 1 surface is
// create + list only. Edit / delete come when there's pressure for
// them; the server already accepts the update / delete shapes so
// adding UI is a thin layer above what's there.

import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Plus } from "lucide-react";
import { useInventory } from "./context";
import { InventoryApiError } from "./api";

export function SettingsPage() {
  return (
    <div className="grid gap-5 sm:grid-cols-2">
      <CategoriesCard />
      <LocationsCard />
    </div>
  );
}

function CategoriesCard() {
  const { api } = useInventory();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["inventory-categories"], queryFn: () => api.listCategories() });
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => api.createCategory({ name: name.trim() }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["inventory-categories"] });
      setName("");
      setError(null);
    },
    onError: (e: unknown) => {
      setError(e instanceof InventoryApiError ? e.message : "Couldn't create");
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    create.mutate();
  }

  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5">
      <div className="text-[10px] font-mono uppercase tracking-widest text-cobble-500 mb-3">
        // categories
      </div>
      <ul className="space-y-1 mb-3">
        {list.data?.items.map((c) => (
          <li key={c.id} className="flex items-baseline gap-2 text-sm">
            <span className="text-slate-700 dark:text-mortar-100">{c.name}</span>
            <span className="text-[10px] font-mono text-slate-400 dark:text-slate-500">{c.slug}</span>
          </li>
        ))}
        {list.data && list.data.items.length === 0 && (
          <li className="text-xs text-slate-400 dark:text-slate-500 italic">No categories yet.</li>
        )}
      </ul>
      <form onSubmit={submit} className="flex gap-2 border-t border-slate-100 dark:border-slate-700 pt-3">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="new category…"
          className="input flex-1 text-sm"
        />
        <button
          type="submit"
          disabled={create.isPending || !name.trim()}
          className="rounded-md bg-slate-700 hover:bg-slate-600 text-mortar-50 text-xs font-medium px-3 transition disabled:opacity-50 flex items-center gap-1"
        >
          <Plus size={12} /> Add
        </button>
      </form>
      {error && <div className="text-xs text-ember-500 mt-2">{error}</div>}
    </div>
  );
}

function LocationsCard() {
  const { api } = useInventory();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["inventory-locations"], queryFn: () => api.listLocations() });
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState("");
  const [kind, setKind] = useState<"area" | "container">("area");
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api.createLocation({
        name: name.trim(),
        parent_id: parentId || null,
        kind,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["inventory-locations"] });
      setName("");
      setError(null);
    },
    onError: (e: unknown) => {
      setError(e instanceof InventoryApiError ? e.message : "Couldn't create");
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    create.mutate();
  }

  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5">
      <div className="text-[10px] font-mono uppercase tracking-widest text-cobble-500 mb-3">
        // locations
      </div>
      <ul className="space-y-1 mb-3">
        {list.data?.items.map((l) => (
          <li
            key={l.id}
            className="flex items-baseline gap-1 text-sm"
            style={{ paddingLeft: `${l.depth * 12}px` }}
          >
            {l.depth > 0 && <ChevronRight size={11} className="text-slate-300 dark:text-slate-600 shrink-0" />}
            <span className="text-slate-700 dark:text-mortar-100">{l.name}</span>
            <span className="text-[10px] font-mono text-slate-400 dark:text-slate-500 ml-1">{l.kind}</span>
          </li>
        ))}
        {list.data && list.data.items.length === 0 && (
          <li className="text-xs text-slate-400 dark:text-slate-500 italic">No locations yet.</li>
        )}
      </ul>
      <form onSubmit={submit} className="space-y-2 border-t border-slate-100 dark:border-slate-700 pt-3">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="new location…"
          className="input text-sm w-full"
        />
        <div className="grid grid-cols-2 gap-2">
          <select value={parentId} onChange={(e) => setParentId(e.target.value)} className="input text-sm">
            <option value="">— no parent —</option>
            {list.data?.items.map((l) => (
              <option key={l.id} value={l.id}>
                {"  ".repeat(l.depth)}
                {l.name}
              </option>
            ))}
          </select>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as "area" | "container")}
            className="input text-sm"
          >
            <option value="area">area</option>
            <option value="container">container</option>
          </select>
        </div>
        <button
          type="submit"
          disabled={create.isPending || !name.trim()}
          className="w-full rounded-md bg-slate-700 hover:bg-slate-600 text-mortar-50 text-xs font-medium py-2 transition disabled:opacity-50 flex items-center justify-center gap-1"
        >
          <Plus size={12} /> Add location
        </button>
      </form>
      {error && <div className="text-xs text-ember-500 mt-2">{error}</div>}
    </div>
  );
}
