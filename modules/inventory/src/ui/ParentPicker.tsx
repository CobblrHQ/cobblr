// Parent / "type" picker — links a unit to its parent inventory item (e.g. a
// Spool to its Filament type). Searches a SPECIFIC instance (the parent's) and
// returns the picked part as {id, name}; the caller writes the `instance-of`
// pairing. Mirrors CatalogTypeahead, but over one inventory instance instead of
// catalogs, and inventory-aware (uses the inventory api client).

import { useEffect, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { useInventory } from "./context";

export interface ParentRef {
  id: string;
  name: string;
}

export function ParentPicker({
  instance,
  value,
  onChange,
  placeholder = "Search…",
}: {
  /** The instance to search (the parent/type instance, e.g. "filament-types"). */
  instance: string;
  value: ParentRef | null;
  onChange: (v: ParentRef | null) => void;
  placeholder?: string;
}) {
  const { api } = useInventory();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [hits, setHits] = useState<ParentRef[]>([]);
  const [loading, setLoading] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // 200ms debounce — quiet while typing.
  useEffect(() => {
    if (value) return;
    if (q.trim().length < 2) {
      setHits([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await api.searchInstanceParts(instance, q.trim());
        if (!cancelled) setHits(res.items.map((i) => ({ id: i.id, name: i.name })));
      } catch {
        if (!cancelled) setHits([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q, value, instance, api]);

  // Click-outside closes the dropdown.
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  if (value) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-cobble-300 dark:border-cobble-700 bg-cobble-50/60 dark:bg-cobble-900/30 px-2 py-1.5">
        <div className="min-w-0 flex-1 text-sm font-medium text-content dark:text-mortar-100 truncate">
          {value.name}
        </div>
        <button
          type="button"
          onClick={() => onChange(null)}
          className="text-faint hover:text-ember-500 transition p-1"
          aria-label="Clear"
          title="Clear"
        >
          <X size={14} />
        </button>
      </div>
    );
  }

  return (
    <div ref={wrapRef} className="relative">
      <div className="flex items-center gap-2 rounded-md border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-2">
        <Search size={14} className="text-faint shrink-0" />
        <input
          type="text"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder={placeholder}
          className="flex-1 bg-transparent text-sm py-1.5 focus:outline-none text-content dark:text-mortar-100 placeholder:text-faint"
        />
        {loading && <span className="text-[10px] font-mono text-faint">…</span>}
      </div>
      {open && q.trim().length >= 2 && (
        <div className="absolute left-0 right-0 top-full mt-1 z-30 rounded-md border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 shadow-lg max-h-72 overflow-y-auto">
          {hits.length === 0 && !loading && (
            <div className="text-xs text-faint italic px-3 py-2">No matches.</div>
          )}
          {hits.map((h) => (
            <button
              key={h.id}
              type="button"
              onClick={() => {
                onChange(h);
                setOpen(false);
                setQ("");
              }}
              className="w-full text-left flex items-center gap-2 px-3 py-2 hover:bg-subtle dark:hover:bg-slate-800/60 transition text-sm text-content dark:text-mortar-100 truncate"
            >
              {h.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
