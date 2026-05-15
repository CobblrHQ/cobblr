// Modal to create a new part. Minimum fields only — name + qty +
// optional category/location. Detail page handles every other field
// after creation.

import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useInventory } from "./context";
import { InventoryApiError } from "./api";

export function NewPartDialog({ onClose }: { onClose: (created: boolean) => void }) {
  const { api } = useInventory();
  const navigate = useNavigate();
  const cats = useQuery({ queryKey: ["inventory-categories"], queryFn: () => api.listCategories() });
  const locs = useQuery({ queryKey: ["inventory-locations"], queryFn: () => api.listLocations() });

  const [name, setName] = useState("");
  const [qty, setQty] = useState("1");
  const [unit, setUnit] = useState("each");
  const [categoryId, setCategoryId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const part = await api.createPart({
        name: name.trim(),
        qty: Number(qty) || 0,
        unit: unit.trim() || "each",
        category_id: categoryId || null,
        location_id: locationId || null,
      });
      onClose(true);
      navigate(`/inventory/parts/${part.id}`);
    } catch (err) {
      setError(err instanceof InventoryApiError ? err.message : "Couldn't create part");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={() => onClose(false)}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-label="New part"
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 max-w-md w-full p-5 shadow-2xl space-y-3"
      >
        <div className="text-[10px] font-mono uppercase tracking-widest text-cobble-500">
          // new part
        </div>
        <Field label="Name">
          <input
            autoFocus
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="input"
          />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Qty">
            <input
              type="number"
              step="any"
              min="0"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              className="input"
            />
          </Field>
          <Field label="Unit">
            <input
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
              className="input"
            />
          </Field>
        </div>
        <Field label="Category">
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="input">
            <option value="">— none —</option>
            {cats.data?.items.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Location">
          <select value={locationId} onChange={(e) => setLocationId(e.target.value)} className="input">
            <option value="">— none —</option>
            {locs.data?.items.map((l) => (
              <option key={l.id} value={l.id}>
                {"  ".repeat(l.depth)}
                {l.name}
              </option>
            ))}
          </select>
        </Field>
        {error && (
          <div className="text-xs text-ember-500 bg-ember-50 rounded-md px-3 py-2">{error}</div>
        )}
        <div className="flex gap-2 pt-2">
          <button
            type="button"
            onClick={() => onClose(false)}
            className="flex-1 rounded-md border border-slate-200 dark:border-slate-700 text-sm text-slate-600 dark:text-mortar-200 hover:bg-mortar-50 dark:bg-slate-800/70 transition py-2"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !name.trim()}
            className="flex-1 rounded-md bg-slate-700 hover:bg-slate-600 text-mortar-50 text-sm font-medium py-2 transition disabled:opacity-50"
          >
            {busy ? "…" : "Create"}
          </button>
        </div>
      </form>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-1">
        {label}
      </span>
      {children}
    </label>
  );
}
