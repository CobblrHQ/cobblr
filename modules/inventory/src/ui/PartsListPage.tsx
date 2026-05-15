// Parts list — filterable table. Search, category, location, state,
// low-stock toggle. Clicking a row opens the part detail page.

import { useState } from "react";
import { Link } from "react-router-dom";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, FileUp, Plus, Search } from "lucide-react";
import { useInventory } from "./context";
import { NewPartDialog } from "./NewPartDialog";
import { ImportDialog } from "./ImportDialog";
import type { PartListItem } from "./api";

type StateFilter = "active" | "draft" | "needs_review" | "all";

export function PartsListPage() {
  const { api } = useInventory();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [categoryId, setCategoryId] = useState<string>("");
  const [locationId, setLocationId] = useState<string>("");
  const [state, setState] = useState<StateFilter>("active");
  const [lowOnly, setLowOnly] = useState(false);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);

  const cats = useQuery({ queryKey: ["inventory-categories"], queryFn: () => api.listCategories() });
  const locs = useQuery({ queryKey: ["inventory-locations"], queryFn: () => api.listLocations() });

  // Cursor-paginated — the parts endpoint caps each page, so a
  // workshop with hundreds of parts needs "load more" to reach
  // them all. (Before this, parts past the cap were unreachable.)
  const parts = useInfiniteQuery({
    queryKey: ["inventory-parts", { search, categoryId, locationId, state, lowOnly }],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.listParts({
        search: search.trim() || undefined,
        category_id: categoryId || undefined,
        location_id: locationId || undefined,
        state: state === "all" ? undefined : state,
        low_stock: lowOnly || undefined,
        cursor: pageParam,
      }),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
  const partItems = parts.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-500" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="search parts…"
            className="input pl-9"
          />
        </div>
        <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="input !w-auto">
          <option value="">All categories</option>
          {cats.data?.items.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select value={locationId} onChange={(e) => setLocationId(e.target.value)} className="input !w-auto">
          <option value="">All locations</option>
          {locs.data?.items.map((l) => (
            <option key={l.id} value={l.id}>
              {"  ".repeat(l.depth)}
              {l.name}
            </option>
          ))}
        </select>
        <select value={state} onChange={(e) => setState(e.target.value as StateFilter)} className="input !w-auto">
          <option value="active">Active</option>
          <option value="draft">Draft</option>
          <option value="needs_review">Needs review</option>
          <option value="all">All</option>
        </select>
        <label className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-mortar-200 cursor-pointer">
          <input
            type="checkbox"
            checked={lowOnly}
            onChange={(e) => setLowOnly(e.target.checked)}
            className="accent-cobble-500"
          />
          low-stock only
        </label>
        <button
          onClick={() => setImporting(true)}
          className="ml-auto rounded-md border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-mortar-200 hover:bg-mortar-50 dark:hover:bg-slate-800/70 text-sm font-medium px-3 py-2 transition flex items-center gap-1.5"
        >
          <FileUp size={14} /> Import CSV
        </button>
        <button
          onClick={() => setAdding(true)}
          className="rounded-md bg-slate-700 hover:bg-slate-600 text-mortar-50 text-sm font-medium px-3 py-2 transition flex items-center gap-1.5"
        >
          <Plus size={14} /> New part
        </button>
      </div>

      {parts.isLoading && <div className="text-sm text-slate-400 dark:text-slate-500">loading…</div>}
      {parts.error && (
        <div className="text-sm text-ember-500">{(parts.error as Error).message}</div>
      )}
      {parts.data && partItems.length === 0 && (
        <div className="border-2 border-dashed border-slate-200 dark:border-slate-700 rounded-xl p-12 text-center text-slate-400 dark:text-slate-500">
          No parts match. Try widening the filter or add the first one.
        </div>
      )}
      {partItems.length > 0 && <PartsTable items={partItems} />}
      {parts.hasNextPage && (
        <div className="flex justify-center">
          <button
            onClick={() => void parts.fetchNextPage()}
            disabled={parts.isFetchingNextPage}
            className="text-xs font-mono uppercase tracking-widest px-4 py-2 rounded-md border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-mortar-200 hover:bg-mortar-50 dark:hover:bg-slate-800 transition disabled:opacity-40"
          >
            {parts.isFetchingNextPage
              ? "loading…"
              : `load more (${partItems.length} shown)`}
          </button>
        </div>
      )}

      {adding && (
        <NewPartDialog
          onClose={(created) => {
            setAdding(false);
            if (created) void parts.refetch();
          }}
        />
      )}
      {importing && (
        <ImportDialog
          onClose={(count) => {
            setImporting(false);
            if (count > 0) void qc.invalidateQueries({ queryKey: ["inventory-parts"] });
          }}
        />
      )}
    </div>
  );
}

function PartsTable({ items }: { items: PartListItem[] }) {
  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-mortar-100 dark:bg-slate-800 text-[10px] font-mono uppercase tracking-widest text-slate-500 dark:text-slate-400">
            <Th>Name</Th>
            <Th>Category</Th>
            <Th>Location</Th>
            <Th className="text-right">Qty</Th>
            <Th className="text-right">Available</Th>
            <Th className="text-right">Min</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {items.map((p) => (
            <tr key={p.id} className="border-t border-slate-100 dark:border-slate-700 hover:bg-mortar-50 dark:hover:bg-slate-800/70 transition">
              <td className="px-3 py-2">
                <Link to={`/inventory/parts/${p.id}`} className="font-medium text-slate-700 dark:text-mortar-100 hover:text-cobble-600">
                  {p.name}
                </Link>
                {p.manufacturer && (
                  <span className="ml-2 text-[11px] text-slate-400 dark:text-slate-500">{p.manufacturer}</span>
                )}
              </td>
              <td className="px-3 py-2 text-slate-500 dark:text-slate-400">{p.category_name ?? "—"}</td>
              <td className="px-3 py-2 text-slate-500 dark:text-slate-400">{p.location_name ?? "—"}</td>
              <td className="px-3 py-2 text-right font-mono">{fmt(p.qty)} {p.unit}</td>
              <td className="px-3 py-2 text-right font-mono">{fmt(p.available_qty)}</td>
              <td className="px-3 py-2 text-right font-mono text-slate-400 dark:text-slate-500">
                {p.min_qty == null ? "—" : fmt(p.min_qty)}
              </td>
              <td className="px-3 py-2">
                {p.low_stock && (
                  <span className="inline-flex items-center gap-1 text-[10px] text-ember-500">
                    <AlertTriangle size={11} /> low
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Th({ children, className = "" }: { children?: React.ReactNode; className?: string }) {
  return <th className={`px-3 py-2 font-medium text-left ${className}`}>{children}</th>;
}

function fmt(n: number): string {
  // Trim trailing zeros: 3.000 → 3, 3.500 → 3.5, 3.510 → 3.51.
  return Number.isInteger(n) ? String(n) : String(parseFloat(n.toFixed(3)));
}
