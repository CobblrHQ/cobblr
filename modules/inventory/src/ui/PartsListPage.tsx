// Parts list — filterable table. Search, category, location, state,
// low-stock toggle. Clicking a row opens the part detail page.

import { useState } from "react";
import { Link } from "react-router-dom";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Archive,
  FileDown,
  FileUp,
  Plus,
  Search,
  ShieldCheck,
  Tag as TagIcon,
} from "lucide-react";
import {
  BulkActionBar,
  EntityThumb,
  EntityTile,
  Modal,
  ViewModeToggle,
  useToast,
  useConfirm,
  usePageTitle,
  useViewMode,
} from "@cobblr/platform-web";
import { useInventory } from "./context";
import { NewPartDialog } from "./NewPartDialog";
import { ImportDialog } from "./ImportDialog";
import type { PartListItem } from "./api";

type StateFilter = "active" | "draft" | "needs_review" | "all";

export function PartsListPage() {
  usePageTitle("Inventory");
  const { api, orgSlug, getToken } = useInventory();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [categoryId, setCategoryId] = useState<string>("");
  const [locationId, setLocationId] = useState<string>("");
  const [state, setState] = useState<StateFilter>("active");
  const [lowOnly, setLowOnly] = useState(false);
  const [archivedFilter, setArchivedFilter] = useState<"hide" | "include" | "only">("hide");
  const [warrantyFilter, setWarrantyFilter] = useState<"all" | "expiring30" | "expiring90">("all");
  const [insuredOnly, setInsuredOnly] = useState(false);
  const [lifecycle, setLifecycle] = useState<"" | "bulk" | "kit" | "parted-out">("");
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [viewMode, setViewMode] = useViewMode("parts", "list");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toast = useToast();
  const confirm = useConfirm();

  const cats = useQuery({ queryKey: ["inventory-categories"], queryFn: () => api.listCategories() });
  const locs = useQuery({ queryKey: ["inventory-locations"], queryFn: () => api.listLocations() });

  // Cursor-paginated — the parts endpoint caps each page, so a
  // workshop with hundreds of parts needs "load more" to reach
  // them all. (Before this, parts past the cap were unreachable.)
  const warrantyWithin =
    warrantyFilter === "expiring30" ? 30 : warrantyFilter === "expiring90" ? 90 : undefined;
  const parts = useInfiniteQuery({
    queryKey: [
      "inventory-parts",
      { search, categoryId, locationId, state, lowOnly, archivedFilter, warrantyFilter, insuredOnly, lifecycle },
    ],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.listParts({
        search: search.trim() || undefined,
        category_id: categoryId || undefined,
        location_id: locationId || undefined,
        state: state === "all" ? undefined : state,
        low_stock: lowOnly || undefined,
        show_archived: archivedFilter === "include" || undefined,
        archived_only: archivedFilter === "only" || undefined,
        warranty_expires_within_days: warrantyWithin,
        insured_only: insuredOnly || undefined,
        lifecycle: lifecycle || undefined,
        cursor: pageParam,
      }),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });

  async function exportCsv() {
    setExporting(true);
    try {
      await api.partsExportCsv({
        search: search.trim() || undefined,
        state: state === "all" ? undefined : state,
        show_archived: archivedFilter === "include" || undefined,
        archived_only: archivedFilter === "only" || undefined,
        insured_only: insuredOnly || undefined,
      });
      toast.success("CSV downloaded.");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setExporting(false);
    }
  }
  const partItems = parts.data?.pages.flatMap((p) => p.items) ?? [];

  function toggleRow(id: string, checked: boolean) {
    setSelected((s) => {
      const n = new Set(s);
      if (checked) n.add(id);
      else n.delete(id);
      return n;
    });
  }
  function selectAll(checked: boolean) {
    setSelected(checked ? new Set(partItems.map((p) => p.id)) : new Set());
  }
  const allChecked = partItems.length > 0 && partItems.every((p) => selected.has(p.id));
  async function bulkDelete() {
    const ok = await confirm({
      title: `Delete ${selected.size} part${selected.size === 1 ? "" : "s"}?`,
      message: "This removes them from the workspace permanently.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    try {
      for (const id of Array.from(selected)) {
        await api.deletePart(id);
      }
      toast.success(`Deleted ${selected.size} part${selected.size === 1 ? "" : "s"}`);
      setSelected(new Set());
      void qc.invalidateQueries({ queryKey: ["inventory-parts"] });
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  // Bulk-tag: POST core-tags/attachments per selected id. The inventory
  // module doesn't have a typed client for core-tags so we fetch the
  // platform endpoint directly with the same Bearer.
  const [bulkTagOpen, setBulkTagOpen] = useState(false);
  const [bulkTagBusy, setBulkTagBusy] = useState(false);
  async function bulkTag(tagName: string) {
    if (!tagName.trim()) return;
    setBulkTagBusy(true);
    try {
      const token = getToken();
      for (const id of Array.from(selected)) {
        const res = await fetch(
          `/api/v1/orgs/${orgSlug}/modules/core-tags/attachments`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify({
              tag_name: tagName.trim(),
              source_module: "inventory",
              source_type: "part",
              source_id: id,
            }),
          },
        );
        if (!res.ok && res.status !== 409) {
          // 409 = already tagged with that name; ignore and continue.
          throw new Error(`HTTP ${res.status}`);
        }
      }
      toast.success(`Tagged ${selected.size} part${selected.size === 1 ? "" : "s"}`);
      setSelected(new Set());
      setBulkTagOpen(false);
      void qc.invalidateQueries({ queryKey: ["inventory-parts"] });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBulkTagBusy(false);
    }
  }

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
        <select
          value={lifecycle}
          onChange={(e) => setLifecycle(e.target.value as typeof lifecycle)}
          className="input !w-auto"
          title="Lifecycle — kits vs bulk vs parted-out (Lego-style)"
        >
          <option value="">All lifecycle</option>
          <option value="bulk">Bulk only</option>
          <option value="kit">Kits only</option>
          <option value="parted-out">Parted-out</option>
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
        <select
          value={archivedFilter}
          onChange={(e) => setArchivedFilter(e.target.value as typeof archivedFilter)}
          className="input !w-auto"
          title="Archive filter"
        >
          <option value="hide">Hide archived</option>
          <option value="include">Include archived</option>
          <option value="only">Archived only</option>
        </select>
        <select
          value={warrantyFilter}
          onChange={(e) => setWarrantyFilter(e.target.value as typeof warrantyFilter)}
          className="input !w-auto"
          title="Warranty filter"
        >
          <option value="all">Any warranty</option>
          <option value="expiring30">Warranty in 30d</option>
          <option value="expiring90">Warranty in 90d</option>
        </select>
        <label className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-mortar-200 cursor-pointer">
          <input
            type="checkbox"
            checked={insuredOnly}
            onChange={(e) => setInsuredOnly(e.target.checked)}
            className="accent-cobble-500"
          />
          insured only
        </label>
        <div className="ml-auto" />
        <ViewModeToggle mode={viewMode} onChange={setViewMode} />
        <button
          onClick={() => void exportCsv()}
          disabled={exporting}
          className="rounded-md border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-mortar-200 hover:bg-mortar-50 dark:hover:bg-slate-800/70 text-sm font-medium px-3 py-2 transition flex items-center gap-1.5 disabled:opacity-50"
        >
          <FileDown size={14} /> {exporting ? "exporting…" : "Export CSV"}
        </button>
        <button
          onClick={() => setImporting(true)}
          className="rounded-md border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-mortar-200 hover:bg-mortar-50 dark:hover:bg-slate-800/70 text-sm font-medium px-3 py-2 transition flex items-center gap-1.5"
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
      {partItems.length > 0 && viewMode === "tiles" && <PartsTileGrid items={partItems} />}
      {partItems.length > 0 && viewMode === "list" && (
        <PartsTable
          items={partItems}
          selected={selected}
          allChecked={allChecked}
          onToggle={toggleRow}
          onSelectAll={selectAll}
        />
      )}
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
      <BulkActionBar
        count={selected.size}
        onClear={() => setSelected(new Set())}
        actions={
          <>
            <button
              type="button"
              onClick={() => setBulkTagOpen(true)}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded text-cobble-600 hover:text-cobble-700"
            >
              <TagIcon size={12} /> Tag
            </button>
            <button
              type="button"
              onClick={() => void bulkDelete()}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded text-ember-600 hover:text-ember-700"
            >
              <AlertTriangle size={12} /> Delete
            </button>
          </>
        }
      />
      {bulkTagOpen && (
        <PartsBulkTagModal
          count={selected.size}
          busy={bulkTagBusy}
          onClose={() => setBulkTagOpen(false)}
          onSubmit={(n) => void bulkTag(n)}
        />
      )}
    </div>
  );
}

function PartsBulkTagModal({
  count,
  busy,
  onClose,
  onSubmit,
}: {
  count: number;
  busy: boolean;
  onClose: () => void;
  onSubmit: (tagName: string) => void;
}) {
  const [name, setName] = useState("");
  return (
    <Modal
      open
      onClose={onClose}
      title={`Tag ${count} part${count === 1 ? "" : "s"}`}
      size="sm"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          onSubmit(name.trim());
        }}
        className="space-y-3"
      >
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. urgent, archive, low-stock"
          className="w-full px-2 py-1 text-sm border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-900"
          autoFocus
        />
        <div className="text-[11px] text-slate-400">
          Existing tag? Reused. New name? Created on the fly.
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !name.trim()}
            className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white"
          >
            {busy ? "tagging…" : `Tag ${count}`}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function PartsTable({
  items,
  selected,
  allChecked,
  onToggle,
  onSelectAll,
}: {
  items: PartListItem[];
  selected: Set<string>;
  allChecked: boolean;
  onToggle: (id: string, checked: boolean) => void;
  onSelectAll: (checked: boolean) => void;
}) {
  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-mortar-100 dark:bg-slate-800 text-[10px] font-mono uppercase tracking-widest text-slate-500 dark:text-slate-400">
            <th className="w-8 px-3 py-2">
              <input
                type="checkbox"
                checked={allChecked}
                onChange={(e) => onSelectAll(e.target.checked)}
                className="accent-cobble-600"
                aria-label="Select all"
              />
            </th>
            <Th>#ID</Th>
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
              <td className="px-3 py-2 w-8">
                <input
                  type="checkbox"
                  checked={selected.has(p.id)}
                  onChange={(e) => onToggle(p.id, e.target.checked)}
                  className="accent-cobble-600"
                  aria-label={`Select ${p.name}`}
                />
              </td>
              <td className="px-3 py-2 font-mono text-[11px] text-slate-400 dark:text-slate-500 whitespace-nowrap">
                {p.asset_id != null ? `#${assetIdFmt(p.asset_id)}` : "—"}
              </td>
              <td className="px-3 py-2">
                <div className="flex items-center gap-3">
                  <EntityThumb src={p.image_path} alt={p.name} size={56} />
                  <div className="min-w-0">
                    <Link to={`/inventory/parts/${p.id}`} className="font-medium text-slate-700 dark:text-mortar-100 hover:text-cobble-600">
                      {p.name}
                    </Link>
                    {p.manufacturer && (
                      <span className="ml-2 text-[11px] text-slate-400 dark:text-slate-500">{p.manufacturer}</span>
                    )}
                    {(p.serial_number || p.model_number) && (
                      <div className="text-[10px] font-mono text-slate-400 dark:text-slate-500 mt-0.5">
                        {p.model_number && <span>m/n {p.model_number}</span>}
                        {p.model_number && p.serial_number && <span> · </span>}
                        {p.serial_number && <span>s/n {p.serial_number}</span>}
                      </div>
                    )}
                  </div>
                </div>
              </td>
              <td className="px-3 py-2 text-slate-500 dark:text-slate-400">{p.category_name ?? "—"}</td>
              <td className="px-3 py-2 text-slate-500 dark:text-slate-400">{p.location_name ?? "—"}</td>
              <td className="px-3 py-2 text-right font-mono">{fmt(p.qty)} {p.unit}</td>
              <td className="px-3 py-2 text-right font-mono">{fmt(p.available_qty)}</td>
              <td className="px-3 py-2 text-right font-mono text-slate-400 dark:text-slate-500">
                {p.min_qty == null ? "—" : fmt(p.min_qty)}
              </td>
              <td className="px-3 py-2">
                <div className="flex flex-wrap gap-1 items-center justify-end">
                  {p.low_stock && (
                    <span className="inline-flex items-center gap-1 text-[10px] text-ember-500 border border-ember-200 dark:border-ember-800 rounded px-1.5 py-0.5">
                      <AlertTriangle size={10} /> low
                    </span>
                  )}
                  {warrantyChip(p.warranty_days_until, p.lifetime_warranty)}
                  {p.insured && (
                    <span className="inline-flex items-center gap-1 text-[10px] text-cobble-600 border border-cobble-200 dark:border-cobble-800 rounded px-1.5 py-0.5">
                      <ShieldCheck size={10} /> ins
                    </span>
                  )}
                  {p.archived && (
                    <span className="inline-flex items-center gap-1 text-[10px] text-slate-500 border border-slate-300 dark:border-slate-600 rounded px-1.5 py-0.5">
                      <Archive size={10} /> arch
                    </span>
                  )}
                </div>
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

function PartsTileGrid({ items }: { items: PartListItem[] }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
      {items.map((p) => (
        <Link key={p.id} to={`/inventory/parts/${p.id}`} className="block">
          <EntityTile
            src={p.image_path}
            title={p.name}
            subtitle={p.manufacturer || p.category_name || null}
            badge={
              p.low_stock ? (
                <span className="text-ember-600 dark:text-ember-500">
                  {fmt(p.qty)} / {p.min_qty == null ? "—" : fmt(p.min_qty)}
                </span>
              ) : (
                `${fmt(p.qty)} ${p.unit}`
              )
            }
            attention={p.low_stock}
          />
        </Link>
      ))}
    </div>
  );
}

function fmt(n: number): string {
  // Trim trailing zeros: 3.000 → 3, 3.500 → 3.5, 3.510 → 3.51.
  return Number.isInteger(n) ? String(n) : String(parseFloat(n.toFixed(3)));
}

/** HomeBox-style zero-padded asset id. */
function assetIdFmt(id: number): string {
  return String(id).padStart(3, "0");
}

function warrantyChip(daysUntil: number | null, lifetime: boolean) {
  if (lifetime) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] text-moss-600 border border-moss-200 dark:border-moss-800 rounded px-1.5 py-0.5">
        lifetime
      </span>
    );
  }
  if (daysUntil == null) return null;
  if (daysUntil < 0) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] text-slate-500 border border-slate-300 dark:border-slate-600 rounded px-1.5 py-0.5">
        warranty expired
      </span>
    );
  }
  if (daysUntil <= 90) {
    const tone =
      daysUntil <= 30
        ? "text-ember-500 border-ember-200 dark:border-ember-800"
        : "text-amber-600 border-amber-200 dark:border-amber-800";
    return (
      <span className={`inline-flex items-center gap-1 text-[10px] rounded px-1.5 py-0.5 border ${tone}`}>
        w/exp {daysUntil}d
      </span>
    );
  }
  return null;
}
