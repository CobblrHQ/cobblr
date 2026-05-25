// Settings — categories management. Locations used to live here too
// but have graduated to the foundational core-locations module — the
// canonical UI for them is /configuration/locations in the host app.

import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useInventory } from "./context";
import { InventoryApiError } from "./api";
import { usePageTitle } from "@cobblr/platform-web";

export function SettingsPage() {
  usePageTitle("Inventory settings");
  return (
    <div className="grid gap-5 sm:grid-cols-2">
      <CategoriesCard />
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

