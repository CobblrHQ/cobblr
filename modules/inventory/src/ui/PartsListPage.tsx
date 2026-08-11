// Parts list — filterable table. Search, category, location, state,
// low-stock toggle. Clicking a row opens the part detail page.

import { useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Archive,
  ArrowRightLeft,
  Download,
  ExternalLink,
  FileDown,
  FileUp,
  Plus,
  Printer,
  ScanLine,
  Search,
  ShieldCheck,
  Tag as TagIcon,
} from "lucide-react";
import {
  BulkActionBar,
  EditableCell,
  EntityThumb,
  EntityTile,
  Modal,
  MoveToInstanceModal,
  ViewModeToggle,
  useToast,
  useConfirm,
  usePageTitle,
  useViewMode,
  usePlatformWeb,
  usePublishChatContext,
  makeAreaResolver,
  LOCATION_GROUP_KEY,
  type EditableCellDef,
} from "@cobblr/platform-web";
import { useInventory } from "./context";
import { QtyStepper } from "./QtyStepper";
import { assortedQty, isAssorted } from "./assorted";
import { useFieldPresentation } from "./useFieldPresentation";
import { useDisclosure } from "./useDisclosure";
import { NewPartDialog } from "./NewPartDialog";
import { ImportDialog } from "./ImportDialog";
import { PartDetailModal } from "./PartDetailPage";
import type { PartListItem, InvFieldDef } from "./api";

type StateFilter = "active" | "draft" | "needs_review" | "all";

type SavedViewLite = {
  id: string;
  name: string;
  view_type: string;
  pinned?: boolean;
  is_default?: boolean;
  config?: { group_by?: string; visible_fields?: string[] };
};

export function PartsListPage() {
  usePageTitle("Inventory");
  const { api, orgSlug, getToken, entityKind, itemNoun, itemNounPlural, basePath, instance } = useInventory();
  const { appMode } = usePlatformWeb();
  const qc = useQueryClient();
  // /inventory/parts/:id keeps this list mounted and opens the detail
  // modal (D4). Closing returns to /inventory.
  const { id: detailId } = useParams<{ id?: string }>();
  const navigate = useNavigate();
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
  const [spoolmanOpen, setSpoolmanOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [ravImporting, setRavImporting] = useState(false);
  const [viewMode, setViewMode] = useViewMode("parts", "list");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkMoveOpen, setBulkMoveOpen] = useState(false);
  const toast = useToast();
  const confirm = useConfirm();

  // Custom-field columns for the table: the entity's field defs (bundle- or
  // user-defined) become columns, rendered with their own renderer (color
  // swatch, url link, …) from each part's metadata. Capped so the table stays
  // readable; ordered by the field's position (which the user controls).
  const fieldDefs = useQuery({
    queryKey: ["platform-field-defs", orgSlug, entityKind, "effective"],
    queryFn: () => api.listFieldDefs(entityKind, true),
    staleTime: 60_000,
  });
  const allCustomCols = (fieldDefs.data?.items ?? [])
    .filter((d) => d.type !== "computed")
    .sort((a, b) => a.position - b.position);

  // Saved views for inventory:part — bundles ship pinned ones ("My yarn
  // stash"). When `?view=<id>` is set, the list renders AS that view: its
  // group_by groups the rows, its visible_fields pick the columns. A chip bar
  // lets the user switch (and "All parts" returns to the native list). The
  // inventory module has no typed views client, so hit the core-views endpoint
  // directly with the same Bearer (same pattern as bulk-tag below).
  const [params, setParams] = useSearchParams();
  const viewId = params.get("view");
  const savedViews = useQuery({
    queryKey: ["inv-saved-views", orgSlug, entityKind],
    queryFn: async (): Promise<{ items: SavedViewLite[] }> => {
      const token = getToken();
      const res = await fetch(
        `/api/v1/orgs/${orgSlug}/modules/core-views/views?kind=${encodeURIComponent(entityKind)}`,
        { headers: token ? { Authorization: `Bearer ${token}` } : {} },
      );
      if (!res.ok) return { items: [] };
      return res.json();
    },
    staleTime: 60_000,
  });
  const views = savedViews.data?.items ?? [];
  const activeView = viewId ? views.find((v) => v.id === viewId) ?? null : null;
  const groupBy = activeView?.config?.group_by;
  const viewFields = activeView?.config?.visible_fields;
  // When a view is active, restrict the custom columns to its visible_fields;
  // otherwise show the first 6 (the prior behaviour).
  const customCols = viewFields
    ? allCustomCols.filter((c) => viewFields.includes(c.name))
    : allCustomCols.slice(0, 6);
  function selectView(id: string | null) {
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (id) n.set("view", id);
        else n.delete("view");
        return n;
      },
      { replace: true },
    );
  }

  const cats = useQuery({ queryKey: ["inventory-categories"], queryFn: () => api.listCategories() });
  const locs = useQuery({ queryKey: ["inventory-locations"], queryFn: () => api.listLocations() });
  // Rolls a row's location up to its room (area) so a `group_by: "location"` view
  // buckets by room, not by every individual bin. Rebuilt only when locations change.
  const areaOf = useMemo(
    () =>
      makeAreaResolver(locs.data?.items ?? [], {
        id: (l) => l.id,
        parentId: (l) => l.parent_id,
        position: () => 0, // unused by the area rollup (position only orders siblings)
        name: (l) => l.name,
        isContainer: (l) => l.kind === "container",
      }),
    [locs.data],
  );

  // Cursor-paginated — the parts endpoint caps each page, so a
  // workshop with hundreds of parts needs "load more" to reach
  // them all. (Before this, parts past the cap were unreachable.)
  const warrantyWithin =
    warrantyFilter === "expiring30" ? 30 : warrantyFilter === "expiring90" ? 90 : undefined;
  const parts = useInfiniteQuery({
    // entityKind (`<instance>:item`, or `inventory:part` for the default) MUST
    // be in the key — yarn + hooks are both inventory instances and the API is
    // instance-scoped, so without it they collide on one cache entry and show
    // each other's items / blank on re-click (beta report: "weird all over").
    queryKey: [
      "inventory-parts",
      entityKind,
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

  // Import a Ravelry stash into this Yarn instance (a713b84c). The connection is
  // user-scoped (Profile → Connections); if it isn't set up yet, route there.
  // The import endpoint also pulls projects → the Designs instance when present.
  async function importRavelry() {
    setRavImporting(true);
    try {
      const token = getToken();
      const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
      const statusRes = await fetch(`/api/v1/me/ravelry`, { headers });
      const status = (await statusRes.json().catch(() => null)) as { connected?: boolean } | null;
      if (!status?.connected) {
        toast.info("Connect your Ravelry account first - opening Connections.");
        navigate("/me/connections");
        return;
      }
      const res = await fetch(`/api/v1/orgs/${orgSlug}/ravelry/import`, { method: "POST", headers });
      if (!res.ok) throw new Error((await res.text()) || `import failed (${res.status})`);
      const r = (await res.json()) as {
        designs_imported: boolean;
        stash: { created: number; updated: number };
        designs: { created: number; updated: number };
        errors: number;
      };
      const summary: string[] = [];
      if (r.stash.created || r.stash.updated)
        summary.push(`yarn: ${r.stash.created} added${r.stash.updated ? `, ${r.stash.updated} updated` : ""}`);
      if (r.designs_imported && (r.designs.created || r.designs.updated))
        summary.push(`designs: ${r.designs.created} added${r.designs.updated ? `, ${r.designs.updated} updated` : ""}`);
      if (r.errors) summary.push(`${r.errors} skipped`);
      toast.success(summary.length ? `Imported from Ravelry — ${summary.join(" · ")}` : "Ravelry: nothing new to import");
      await parts.refetch();
    } catch (err) {
      toast.error(`Ravelry import failed: ${(err as Error).message}`);
    } finally {
      setRavImporting(false);
    }
  }

  const partItems = parts.data?.pages.flatMap((p) => p.items) ?? [];
  // Tell Ask Cobb what's on this screen — `low_stock` is the module's own flag.
  const lowStock = partItems.filter((p) => p.low_stock).length;
  usePublishChatContext({
    label: itemNounPlural ? itemNounPlural.replace(/^\w/, (ch) => ch.toUpperCase()) : "Inventory",
    summary:
      `${partItems.length} ${partItems.length === 1 ? itemNoun : itemNounPlural}` +
      (lowStock ? `, ${lowStock} low on stock` : ""),
  });

  // Progressive column density (redesign B6): a young table used to open as a
  // wall of "—" (every bundle field = a column, mostly empty at 1-5 rows).
  // While the table is SPARSE (≤25 loaded rows, no active view), show only the
  // columns that actually hold data somewhere + offer "+N more columns".
  // Established tables (>25 rows) and saved views keep the full/declared grid.
  const [showAllCols, setShowAllCols] = useState(false);
  const sparse = !viewFields && partItems.length > 0 && partItems.length <= 25 && !showAllCols;
  const filledCols = sparse
    ? customCols.filter((c) =>
        partItems.some((p) => {
          const v = (p.metadata as Record<string, unknown> | null)?.[c.name];
          return v !== undefined && v !== null && v !== "";
        }),
      )
    : customCols;
  const shownCols = sparse ? filledCols : customCols;
  const hiddenColCount = customCols.length - shownCols.length;

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

  // Bulk print-labels: mint a navigate QR token per selected part and
  // enqueue a label, so labels can be queued straight from the list
  // (not just one part at a time on the detail page).
  const [bulkLabelBusy, setBulkLabelBusy] = useState(false);
  async function bulkPrintLabels() {
    setBulkLabelBusy(true);
    let queued = 0;
    try {
      for (const id of Array.from(selected)) {
        const p = partItems.find((x) => x.id === id);
        const assetId = (p as { asset_id?: number } | undefined)?.asset_id;
        const desc =
          assetId != null
            ? `#${String(assetId).padStart(3, "0")} ${p?.name ?? ""}`.trim()
            : (p?.name ?? "Part");
        try {
          const { scan_url } = await api.mintQrToken({
            entity_kind: "inventory:part",
            entity_id: id,
            mode: "navigate",
            auth: "session",
          });
          await api.enqueueLabel({
            module_name: "inventory",
            entity_type: "part",
            entity_id: id,
            qr_payload: scan_url,
            description: desc,
            qty: 1,
          });
          queued++;
        } catch {
          /* skip this one, keep going */
        }
      }
      toast.success(`Queued ${queued} label${queued === 1 ? "" : "s"} — open Labels → Queue to print.`);
      setSelected(new Set());
    } finally {
      setBulkLabelBusy(false);
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
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint dark:text-slate-500" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={`search ${itemNounPlural.toLowerCase()}…`}
            className="input pl-9"
          />
        </div>
        {/* The generic inventory filters (category / location / state /
            lifecycle / low-stock / archived / warranty / insured) are
            base-inventory concepts — noise on a skinned instance (Yarn). Hide
            them when scoped; search + the saved-view chips are the navigation. */}
        {!instance && (
        <>
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
          title="Lifecycle - kits vs bulk vs parted-out (Lego-style)"
        >
          <option value="">All lifecycle</option>
          <option value="bulk">Bulk only</option>
          <option value="kit">Kits only</option>
          <option value="parted-out">Parted-out</option>
        </select>
        <label className="flex items-center gap-1.5 text-xs text-content dark:text-mortar-200 cursor-pointer">
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
        <label className="flex items-center gap-1.5 text-xs text-content dark:text-mortar-200 cursor-pointer">
          <input
            type="checkbox"
            checked={insuredOnly}
            onChange={(e) => setInsuredOnly(e.target.checked)}
            className="accent-cobble-500"
          />
          insured only
        </label>
        </>
        )}
        <div className="ml-auto" />
        <ViewModeToggle mode={viewMode} onChange={setViewMode} />
        <button
          onClick={() => void exportCsv()}
          disabled={exporting}
          className="rounded-md border border-line dark:border-slate-700 text-content dark:text-mortar-200 hover:bg-subtle dark:hover:bg-slate-800/70 text-sm font-medium px-3 py-2 transition flex items-center gap-1.5 disabled:opacity-50"
        >
          <FileDown size={14} /> {exporting ? "exporting…" : "Export CSV"}
        </button>
        <button
          onClick={() => setImporting(true)}
          className="rounded-md border border-line dark:border-slate-700 text-content dark:text-mortar-200 hover:bg-subtle dark:hover:bg-slate-800/70 text-sm font-medium px-3 py-2 transition flex items-center gap-1.5"
        >
          <FileUp size={14} /> Import CSV
        </button>
        {/* Spoolman syncs 3D-printing FILAMENT spool weights — irrelevant on a
            food pantry / medications / generic inventory, where it was just
            clutter. Gate it to the filament spools instance, the same way the
            Ravelry import below is gated to the yarn instance. */}
        {instance === "filament" && (
          <button
            onClick={() => setSpoolmanOpen(true)}
            className="rounded-md border border-line dark:border-slate-700 text-content dark:text-mortar-200 hover:bg-subtle dark:hover:bg-slate-800/70 text-sm font-medium px-3 py-2 transition flex items-center gap-1.5"
            title="Sync remaining weight from Spoolman"
          >
            <Download size={14} /> Spoolman
          </button>
        )}
        {/* Import a Ravelry stash straight into the Yarn table (a713b84c). Only
            the yarn instance — the bundle names it "yarn" — since the importer
            maps to yarn fields + the Designs table. */}
        {instance === "yarn" && (
          <button
            onClick={() => void importRavelry()}
            disabled={ravImporting}
            className="rounded-md border border-line dark:border-slate-700 text-content dark:text-mortar-200 hover:bg-subtle dark:hover:bg-slate-800/70 text-sm font-medium px-3 py-2 transition flex items-center gap-1.5 disabled:opacity-50"
            title="Import your Ravelry stash + projects"
          >
            <Download size={14} /> {ravImporting ? "importing…" : "Import from Ravelry"}
          </button>
        )}
        {/* Scan into THIS instance — lands the scanned item in the yarn table
            (core-scan is always on). The /scan page reads the target params. */}
        {instance && (
          <Link
            to={`/scan?into=${instance}&module=inventory&kind=part&label=${encodeURIComponent(
              itemNoun.charAt(0).toUpperCase() + itemNoun.slice(1),
            )}`}
            className="rounded-md border border-line dark:border-slate-700 text-content dark:text-mortar-200 hover:bg-subtle dark:hover:bg-slate-800/70 text-sm font-medium px-3 py-2 transition flex items-center gap-1.5"
            title={`Scan a barcode into ${itemNoun}`}
          >
            <ScanLine size={14} /> Scan
          </Link>
        )}
        <button
          onClick={() => setAdding(true)}
          className="rounded-md bg-cobble-600 hover:bg-cobble-700 text-white text-sm font-medium px-3 py-2 transition flex items-center gap-1.5"
        >
          <Plus size={14} /> New {itemNoun}
        </button>
      </div>

      {/* Saved-view chips — bundles ship pinned ones; the wizard lands here. */}
      {views.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <ViewChip active={!activeView} onClick={() => selectView(null)}>
            All {itemNounPlural}
          </ViewChip>
          {views.map((v) => (
            <ViewChip key={v.id} active={activeView?.id === v.id} onClick={() => selectView(v.id)}>
              {v.name}
            </ViewChip>
          ))}
        </div>
      )}

      {parts.isLoading && <div className="text-sm text-faint dark:text-slate-500">loading…</div>}
      {parts.error && (
        <div className="text-sm text-ember-500">{(parts.error as Error).message}</div>
      )}
      {parts.data && partItems.length === 0 && (() => {
        // A first-time user on an empty instance (a beta tester's empty "Yarn"/"Hooks")
        // needs the add action right here, not a grey note pointing at a button
        // lost in the toolbar. Show a real "New <item>" button — unless the
        // emptiness is just a filter/search hiding rows (then guide to widen it).
        const hasFilters = !!(
          search || categoryId || locationId || lowOnly || insuredOnly ||
          lifecycle || warrantyFilter !== "all" || archivedFilter !== "hide"
        );
        // Lowercase for mid-sentence use (buttons keep the stored casing).
        const plural = itemNounPlural.toLowerCase();
        const noun = itemNoun.toLowerCase();
        // A locked managed app's first screen — give a warm welcome + a clear
        // "what to do", not a bare table (beta report: "no call to action").
        const welcome = appMode && !hasFilters && !activeView;
        return (
          <div className="border-2 border-dashed border-line dark:border-slate-700 rounded-xl p-10 text-center space-y-3">
            {welcome && (
              <h2 className="font-display text-xl font-bold text-content dark:text-mortar-100">
                Welcome! Let’s add your first {noun}.
              </h2>
            )}
            <p className="text-sm text-muted dark:text-slate-400">
              {activeView
                ? `Nothing in “${activeView.name}” yet.`
                : hasFilters
                  ? "No matches — try widening the filter."
                  : welcome
                    ? `Tap below to add a ${noun} by hand, or use Scan in the top bar to add one from a label.`
                    : `No ${plural} here yet. Add your first ${noun} to get started.`}
            </p>
            {!hasFilters && (
              <button
                onClick={() => setAdding(true)}
                className="inline-flex items-center gap-1.5 rounded-md bg-cobble-600 hover:bg-cobble-700 text-white text-sm font-medium px-4 py-2 transition"
              >
                <Plus size={15} /> {welcome ? `Add a ${itemNoun}` : `New ${itemNoun}`}
              </button>
            )}
          </div>
        );
      })()}
      {hiddenColCount > 0 && (
        <button
          type="button"
          onClick={() => setShowAllCols(true)}
          className="self-end text-[11px] text-faint dark:text-slate-500 hover:text-accent transition"
          title="Show every field as a column, including ones with no data yet"
        >
          + {hiddenColCount} more column{hiddenColCount === 1 ? "" : "s"}
        </button>
      )}
      {showAllCols && !viewFields && partItems.length <= 25 && (
        <button
          type="button"
          onClick={() => setShowAllCols(false)}
          className="self-end text-[11px] text-faint dark:text-slate-500 hover:text-accent transition"
        >
          hide empty columns
        </button>
      )}
      {/* Grouped (a view with group_by) → one section per group; else flat. */}
      {partItems.length > 0 && groupBy
        ? groupItems(partItems, groupBy, areaOf).map((g) => (
            <div key={g.key} className="space-y-2">
              <h3 className="text-xs font-mono uppercase tracking-widest text-accent">{g.key}</h3>
              {viewMode === "tiles" ? (
                <PartsTileGrid items={g.rows} basePath={basePath} />
              ) : (
                <PartsTable
                  items={g.rows}
                  basePath={basePath}
                  customCols={shownCols}
                  selected={selected}
                  allChecked={g.rows.every((r) => selected.has(r.id))}
                  onToggle={toggleRow}
                  onSelectAll={(checked) =>
                    setSelected((s) => {
                      const n = new Set(s);
                      for (const r of g.rows) checked ? n.add(r.id) : n.delete(r.id);
                      return n;
                    })
                  }
                />
              )}
            </div>
          ))
        : (
          <>
            {partItems.length > 0 && viewMode === "tiles" && <PartsTileGrid items={partItems} basePath={basePath} />}
            {partItems.length > 0 && viewMode === "list" && (
              <PartsTable
                items={partItems}
                basePath={basePath}
                customCols={shownCols}
                selected={selected}
                allChecked={allChecked}
                onToggle={toggleRow}
                onSelectAll={selectAll}
              />
            )}
          </>
        )}
      {parts.hasNextPage && (
        <div className="flex justify-center">
          <button
            onClick={() => void parts.fetchNextPage()}
            disabled={parts.isFetchingNextPage}
            className="text-xs font-mono uppercase tracking-widest px-4 py-2 rounded-md border border-line dark:border-slate-700 text-content dark:text-mortar-200 hover:bg-subtle dark:hover:bg-slate-800 transition disabled:opacity-40"
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
      {detailId && (
        <PartDetailModal
          id={detailId}
          onClose={() => navigate(basePath)}
        />
      )}
      {spoolmanOpen && (
        <SpoolmanModal
          instance={instance}
          onClose={() => setSpoolmanOpen(false)}
          onSynced={() => void qc.invalidateQueries({ queryKey: ["inventory-parts"] })}
        />
      )}
      <BulkActionBar
        count={selected.size}
        onClear={() => setSelected(new Set())}
        actions={
          <>
            <button
              type="button"
              disabled={bulkLabelBusy}
              onClick={() => void bulkPrintLabels()}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded text-accent hover:text-accent disabled:opacity-50"
            >
              <Printer size={12} /> {bulkLabelBusy ? "Queuing…" : "Print labels"}
            </button>
            <button
              type="button"
              onClick={() => setBulkTagOpen(true)}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded text-accent hover:text-accent"
            >
              <TagIcon size={12} /> Tag
            </button>
            <button
              type="button"
              onClick={() => setBulkMoveOpen(true)}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded text-accent hover:text-accent"
            >
              <ArrowRightLeft size={12} /> Move to…
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
      <MoveToInstanceModal
        open={bulkMoveOpen}
        onClose={() => setBulkMoveOpen(false)}
        slug={orgSlug}
        getToken={getToken}
        moduleName="inventory"
        fromInstance={instance ?? "inventory"}
        ids={Array.from(selected)}
        noun={itemNoun}
        onMoved={(n, where) => {
          toast.success(`Moved ${n} ${n === 1 ? itemNoun : `${itemNoun}s`} to ${where}`);
          setSelected(new Set());
          void qc.invalidateQueries();
        }}
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
          className="w-full px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
          autoFocus
        />
        <div className="text-[11px] text-faint">
          Existing tag? Reused. New name? Created on the fly.
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded text-content hover:bg-subtle dark:hover:bg-slate-800"
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

/** A native (non-field-def) column described the way EditableCell wants it, so
 *  the stock columns edit through the exact same control as a bundle's custom
 *  fields — one behaviour, not two that drift. */
const nativeDef = (
  name: string,
  label: string,
  type: EditableCellDef["type"],
  required = false,
): EditableCellDef => ({ name, display_label: label, type, required });

/** The native columns a cell may patch directly. The closed union is a
 *  guardrail, not bookkeeping: an unknown top-level key on PATCH /:id is
 *  treated as a CUSTOM FIELD NAME (the server hoists it into metadata), so a
 *  custom field sent through `patch` would be a metadata write down the wrong
 *  path — this makes that a compile error instead of a runtime surprise. */
type NativePartCol = "name" | "category_id" | "location_id" | "min_qty" | "supplier_url";

/** One infinite-query page of the parts list, as cached. */
type PartsPage = { items: PartListItem[]; next_cursor?: string | null };
type PartsCache = { pages: PartsPage[]; pageParams: unknown[] };

/** Commit a single cell edit on a part. A native column patches its own column;
 *  a custom field merges its one key into the metadata bag server-side (never a
 *  read-spread-write from a list row, which would revert a concurrent writer). */
function useCellCommit() {
  const { api } = useInventory();
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({
      id,
      patch,
      meta,
    }: {
      id: string;
      patch?: Partial<Record<NativePartCol, unknown>>;
      meta?: Record<string, unknown>;
    }) => (meta ? api.patchPartMetadata(id, meta) : api.updatePart(id, patch ?? {})),
    onSuccess: (_r, { id, patch, meta }) => {
      // Patch the edited row in place across every cached list variant. The
      // list is an INFINITE query: invalidating it refetches every loaded page
      // (10 pages deep = 10 requests) per keystroke-commit, so the row edit we
      // already know is applied locally and the list is only marked stale —
      // the next natural refetch (focus, filter change) converges any derived
      // fields (low_stock etc.) with the server.
      qc.setQueriesData<PartsCache>({ queryKey: ["inventory-parts"] }, (data) => {
        if (!data?.pages) return data;
        return {
          ...data,
          pages: data.pages.map((pg) => ({
            ...pg,
            items: pg.items.map((it) => {
              if (it.id !== id) return it;
              const next = { ...it, ...(patch ?? {}) } as PartListItem;
              if (meta) {
                const md = { ...((it.metadata as Record<string, unknown> | null) ?? {}) };
                for (const [k, v] of Object.entries(meta)) {
                  // Mirror the server's merge: null CLEARS (removes) the key.
                  if (v == null) delete md[k];
                  else md[k] = v;
                }
                next.metadata = md;
              }
              return next;
            }),
          })),
        };
      });
      void qc.invalidateQueries({ queryKey: ["inventory-parts"], refetchType: "none" });
      void qc.invalidateQueries({ queryKey: ["inventory-part", id] });
    },
    // A cell edit has no Save button to leave in a failed state, so a silent
    // reject would look like a save that stuck until the next refetch proved
    // otherwise. Say so — leading with what FAILED, because the server detail
    // alone can mislead (a bare "Not found" reads as the part missing when it's
    // an api that predates the metadata route) — and refetch to put the true
    // value back on screen.
    onError: (e: unknown, { id }) => {
      const detail = e instanceof Error && e.message ? ` (${e.message})` : "";
      toast.error(`Couldn't save that change${detail}`);
      void qc.invalidateQueries({ queryKey: ["inventory-parts"] });
      void qc.invalidateQueries({ queryKey: ["inventory-part", id] });
    },
  });
}

function PartsTable({
  items,
  basePath,
  customCols,
  selected,
  allChecked,
  onToggle,
  onSelectAll,
}: {
  items: PartListItem[];
  basePath: string;
  customCols: InvFieldDef[];
  selected: Set<string>;
  allChecked: boolean;
  onToggle: (id: string, checked: boolean) => void;
  onSelectAll: (checked: boolean) => void;
}) {
  const navigate = useNavigate();
  const { api } = useInventory();
  const commit = useCellCommit();
  // Candidate lists for the two native FK columns. Same query keys the page
  // already uses, so this is the cache, not a second fetch.
  const cats = useQuery({ queryKey: ["inventory-categories"], queryFn: () => api.listCategories() });
  const locs = useQuery({ queryKey: ["inventory-locations"], queryFn: () => api.listLocations() });
  const catOptions = useMemo(
    () => (cats.data?.items ?? []).map((c) => ({ id: c.id, label: c.name })),
    [cats.data],
  );
  const locOptions = useMemo(
    () => (locs.data?.items ?? []).map((l) => ({ id: l.id, label: l.name })),
    [locs.data],
  );
  const setCol = (p: PartListItem, col: NativePartCol, v: unknown) =>
    commit.mutate({ id: p.id, patch: { [col]: v } });
  // Send only the edited key: the server merges it into the metadata bag. A
  // list row can be minutes stale, so spreading the row's cached metadata here
  // would write those stale siblings back over anything changed since.
  const setMeta = (p: PartListItem, name: string, v: unknown) =>
    commit.mutate({ id: p.id, meta: { [name]: v } });
  // Honor the workspace's native-field overrides the way the create/detail
  // modals already do — a yarn instance that hides Category/Location/Min
  // shouldn't see them as table columns either. Overrides are scoped to the
  // instance kind ("yarn:item"), so read it from context like NewPartDialog.
  const { entityKind } = useInventory();
  const fp = useFieldPresentation(entityKind);
  // Compose the workspace override with the stock-vs-catalog disclosure: a lean
  // catalog instance (films, books) hides the whole stock column set (qty,
  // available, min, ...) so its list reads as its own fields, not inventory's.
  const disclosure = useDisclosure();
  const hide = (name: string): boolean => fp.hidden(name) || disclosure.hides(name);
  const anySupplier = items.some((p) => !!p.supplier_url) && !hide("supplier_url");
  const showCategory = !hide("category");
  const showLocation = !hide("location");
  const showMin = !hide("min_qty");
  const showQty = !hide("qty");
  return (
    <>
      {/* Desktop: the full table. Mobile: a stacked-card list (D7) —
          a 9-column table side-scrolling on a phone reads poorly, so
          below md we render one card per row with label:value pairs. */}
      <div className="hidden md:block rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 overflow-x-auto">
      <table className="w-full min-w-[640px] text-sm">
        <thead>
          <tr className="bg-mortar-100 dark:bg-slate-800 text-[10px] font-mono uppercase tracking-widest text-muted dark:text-slate-400">
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
            {showCategory && <Th>{fp.label("category", "Category")}</Th>}
            {showLocation && <Th>{fp.label("location", "Location")}</Th>}
            {customCols.map((c) => (
              <Th key={c.id}>{c.display_label}</Th>
            ))}
            {showQty && <Th className="text-right">Qty</Th>}
            {showQty && <Th className="text-right">Available</Th>}
            {showMin && <Th className="text-right">{fp.label("min_qty", "Min")}</Th>}
            {anySupplier && <Th>Supplier</Th>}
            <Th />
          </tr>
        </thead>
        <tbody>
          {items.map((p) => (
            <tr
              key={p.id}
              onClick={() => navigate(`${basePath}/parts/${p.id}`)}
              className="group/row border-t border-line dark:border-slate-700 hover:bg-subtle dark:hover:bg-slate-800/70 transition cursor-pointer"
            >
              <td className="px-3 py-2 w-8" onClick={(e) => e.stopPropagation()}>
                <input
                  type="checkbox"
                  checked={selected.has(p.id)}
                  onChange={(e) => onToggle(p.id, e.target.checked)}
                  className="accent-cobble-600"
                  aria-label={`Select ${p.name}`}
                />
              </td>
              <td className="px-3 py-2 font-mono text-[11px] text-faint dark:text-slate-500 whitespace-nowrap">
                {p.asset_id != null ? `#${assetIdFmt(p.asset_id)}` : "—"}
              </td>
              <td className="px-3 py-2">
                <div className="flex items-center gap-3">
                  <EntityThumb
                    src={p.image_path}
                    alt={p.name}
                    size={56}
                    color={(p.metadata as Record<string, unknown> | null)?.color as string | undefined}
                    values={p.metadata as Record<string, unknown> | null}
                  />
                  <div className="min-w-0 flex-1">
                    {/* The name is both the way into the record and an editable
                        cell, so the link keeps the click and the pencil edits. */}
                    <EditableCell
                      def={nativeDef("name", "Name", "text", true)}
                      value={p.name}
                      onCommit={(v) => setCol(p, "name", v)}
                    >
                      <Link
                        to={`${basePath}/parts/${p.id}`}
                        className="font-medium text-content dark:text-mortar-100 hover:text-accent truncate"
                      >
                        {p.name}
                      </Link>
                    </EditableCell>
                    {p.manufacturer && (
                      <span className="ml-2 text-[11px] text-faint dark:text-slate-500">{p.manufacturer}</span>
                    )}
                    {((p.serial_number && !fp.hidden("serial_number")) ||
                      (p.model_number && !fp.hidden("model_number"))) && (
                      <div className="text-[10px] font-mono text-faint dark:text-slate-500 mt-0.5">
                        {p.model_number && !fp.hidden("model_number") && <span>m/n {p.model_number}</span>}
                        {p.model_number && !fp.hidden("model_number") && p.serial_number && !fp.hidden("serial_number") && <span> · </span>}
                        {p.serial_number && !fp.hidden("serial_number") && <span>s/n {p.serial_number}</span>}
                      </div>
                    )}
                  </div>
                </div>
              </td>
              {/* fallbackLabel = the row's server-joined name, so the cell
                  shows the real value while the options list loads (or fails)
                  instead of a lying "—". */}
              {showCategory && (
                <td className="px-3 py-2 text-muted dark:text-slate-400">
                  <EditableCell
                    def={nativeDef("category_id", fp.label("category", "Category"), "text")}
                    value={p.category_id}
                    options={catOptions}
                    fallbackLabel={p.category_name}
                    onCommit={(v) => setCol(p, "category_id", v)}
                  />
                </td>
              )}
              {showLocation && (
                <td className="px-3 py-2 text-muted dark:text-slate-400">
                  <EditableCell
                    def={nativeDef("location_id", fp.label("location", "Location"), "text")}
                    value={p.location_id}
                    options={locOptions}
                    fallbackLabel={p.location_name}
                    onCommit={(v) => setCol(p, "location_id", v)}
                  />
                </td>
              )}
              {customCols.map((c) => (
                <td key={c.id} className="px-3 py-2 text-muted dark:text-slate-400">
                  <EditableCell
                    def={c}
                    value={(p.metadata as Record<string, unknown> | null)?.[c.name]}
                    onCommit={(v) => setMeta(p, c.name, v)}
                  />
                </td>
              ))}
              {/* Qty is a ledger, not a cell — the stepper writes an audited
                  signed delta. See QtyStepper for why it isn't editable text. */}
              {showQty && (
                <td className="px-3 py-2 text-right font-mono">
                  <span className="inline-flex items-center gap-1.5">
                    {/* A stepper on an estimate would turn "roughly 50" into a
                        count claim with one click, so an assortment reads its
                        number rather than offering to nudge it. Counting is a
                        deliberate act on the detail card. */}
                    {isAssorted(p) ? (
                      <span className="text-accent" title="Estimated, not counted">
                        {assortedQty(p)}
                      </span>
                    ) : (
                      <QtyStepper partId={p.id} qty={Number(p.qty)} size="sm" />
                    )}
                    <span className="text-faint dark:text-slate-500">{p.unit}</span>
                  </span>
                </td>
              )}
              {showQty && (
                <td
                  className="px-3 py-2 text-right font-mono"
                  title="Derived from qty minus what's allocated"
                >
                  {/* Available derives from a count. An estimate has none, and
                      printing 0 here would contradict the ~50 beside it. */}
                  {isAssorted(p) ? (
                    <span className="text-faint dark:text-slate-500">—</span>
                  ) : (
                    fmt(p.available_qty)
                  )}
                </td>
              )}
              {showMin && (
                <td className="px-3 py-2 text-right font-mono text-faint dark:text-slate-500">
                  <EditableCell
                    def={nativeDef("min_qty", fp.label("min_qty", "Min"), "number")}
                    value={p.min_qty}
                    align="right"
                    onCommit={(v) => setCol(p, "min_qty", v)}
                  />
                </td>
              )}
              {anySupplier && (
                <td className="px-3 py-2">
                  {/* "visit" opens the page, the pencil edits the address —
                      one control can't do both jobs. */}
                  <EditableCell
                    def={nativeDef("supplier_url", "Supplier", "url")}
                    value={p.supplier_url}
                    onCommit={(v) => setCol(p, "supplier_url", v)}
                  >
                    {p.supplier_url ? (
                      <a
                        href={/^https?:\/\//i.test(p.supplier_url) ? p.supplier_url : undefined}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="inline-flex items-center gap-1 text-accent hover:underline text-xs"
                        title="Open supplier page"
                      >
                        <ExternalLink size={13} /> visit
                      </a>
                    ) : (
                      <span className="text-faint dark:text-slate-600">—</span>
                    )}
                  </EditableCell>
                </td>
              )}
              <td className="px-3 py-2">
                <div className="flex flex-wrap gap-1 items-center justify-end">
                  {p.low_stock && (
                    <span className="inline-flex items-center gap-1 text-[10px] text-ember-500 border border-ember-200 dark:border-ember-800 rounded px-1.5 py-0.5">
                      <AlertTriangle size={10} /> low
                    </span>
                  )}
                  {/* The under-gap, as STATE not a question: this many are
                      counted but have no serial on file yet. Shown the whole
                      time an intake is in progress (the prompt is what waits
                      for quiet), and never red — nothing is wrong here.
                      See one-record-substrate.md. */}
                  {(p.units_count ?? 0) > 0 && Number(p.qty) > (p.units_count ?? 0) && (
                    <span className="inline-flex items-center gap-1 text-[10px] text-muted dark:text-slate-400 border border-line dark:border-slate-700 rounded px-1.5 py-0.5">
                      {Number(p.qty) - (p.units_count ?? 0)} not yet scanned
                    </span>
                  )}
                  {warrantyChip(p.warranty_days_until, p.lifetime_warranty)}
                  {p.insured && (
                    <span className="inline-flex items-center gap-1 text-[10px] text-accent border border-cobble-200 dark:border-cobble-800 rounded px-1.5 py-0.5">
                      <ShieldCheck size={10} /> ins
                    </span>
                  )}
                  {p.archived && (
                    <span className="inline-flex items-center gap-1 text-[10px] text-muted border border-line dark:border-slate-600 rounded px-1.5 py-0.5">
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

      {/* Mobile stacked cards (D7) */}
      <div className="md:hidden space-y-2">
        {items.map((p) => (
          <div
            key={p.id}
            onClick={() => navigate(`${basePath}/parts/${p.id}`)}
            className="group/row rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-3 cursor-pointer hover:border-cobble-300 dark:hover:border-cobble-700 transition"
          >
            <div className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={selected.has(p.id)}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => onToggle(p.id, e.target.checked)}
                className="accent-cobble-600 mt-1 shrink-0"
                aria-label={`Select ${p.name}`}
              />
              <EntityThumb
                src={p.image_path}
                alt={p.name}
                size={48}
                color={(p.metadata as Record<string, unknown> | null)?.color as string | undefined}
                values={p.metadata as Record<string, unknown> | null}
              />
              <div className="flex-1 min-w-0">
                <EditableCell
                  def={nativeDef("name", "Name", "text", true)}
                  value={p.name}
                  onCommit={(v) => setCol(p, "name", v)}
                >
                  <Link
                    to={`${basePath}/parts/${p.id}`}
                    className="font-medium text-content dark:text-mortar-100 hover:text-accent truncate"
                  >
                    {p.name}
                  </Link>
                </EditableCell>
                {p.manufacturer && !hide("manufacturer") && (
                  <span className="ml-2 text-[11px] text-faint dark:text-slate-500">
                    {p.manufacturer}
                  </span>
                )}
                {/* Same edits as the desktop table — a phone is where "just
                    change the number" matters most, so the card isn't a
                    read-only summary you have to open the record to act on. */}
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-mono text-muted dark:text-slate-400">
                  {showQty && (
                    <span className="inline-flex items-center gap-1">
                      {isAssorted(p) ? (
                        <span className="text-accent" title="Estimated, not counted">
                          {assortedQty(p)}
                        </span>
                      ) : (
                        <>
                          qty <QtyStepper partId={p.id} qty={Number(p.qty)} size="sm" />
                        </>
                      )}{" "}
                      {p.unit}
                    </span>
                  )}
                  {showQty && !isAssorted(p) && (
                    <span title="Derived from qty minus what's allocated">
                      avail {fmt(p.available_qty)}
                    </span>
                  )}
                  {showMin && (
                    <span className="inline-flex items-center gap-1">
                      min
                      <span className="w-14">
                        <EditableCell
                          def={nativeDef("min_qty", fp.label("min_qty", "Min"), "number")}
                          value={p.min_qty}
                          onCommit={(v) => setCol(p, "min_qty", v)}
                        />
                      </span>
                    </span>
                  )}
                  {showCategory && (
                    <span className="min-w-[5rem]">
                      <EditableCell
                        def={nativeDef("category_id", fp.label("category", "Category"), "text")}
                        value={p.category_id}
                        options={catOptions}
                        fallbackLabel={p.category_name}
                        onCommit={(v) => setCol(p, "category_id", v)}
                      />
                    </span>
                  )}
                  {showLocation && (
                    <span className="inline-flex items-center gap-1 min-w-[5rem]">
                      @
                      <EditableCell
                        def={nativeDef("location_id", fp.label("location", "Location"), "text")}
                        value={p.location_id}
                        options={locOptions}
                        fallbackLabel={p.location_name}
                        onCommit={(v) => setCol(p, "location_id", v)}
                      />
                    </span>
                  )}
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {p.low_stock && (
                    <span className="inline-flex items-center gap-1 text-[10px] text-ember-500 border border-ember-200 dark:border-ember-800 rounded px-1.5 py-0.5">
                      <AlertTriangle size={10} /> low
                    </span>
                  )}
                  {warrantyChip(p.warranty_days_until, p.lifetime_warranty)}
                  {p.insured && (
                    <span className="inline-flex items-center gap-1 text-[10px] text-accent border border-cobble-200 dark:border-cobble-800 rounded px-1.5 py-0.5">
                      <ShieldCheck size={10} /> ins
                    </span>
                  )}
                  {p.archived && (
                    <span className="inline-flex items-center gap-1 text-[10px] text-muted border border-line dark:border-slate-600 rounded px-1.5 py-0.5">
                      <Archive size={10} /> arch
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function Th({ children, className = "" }: { children?: React.ReactNode; className?: string }) {
  return <th className={`px-3 py-2 font-medium text-left ${className}`}>{children}</th>;
}

function ViewChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "text-xs font-medium px-3 py-1 rounded-full border transition " +
        (active
          ? "border-cobble-400 dark:border-cobble-600 bg-cobble-50 dark:bg-cobble-950/30 text-accent"
          : "border-line dark:border-slate-700 text-content dark:text-mortar-200 hover:border-cobble-300 dark:hover:border-cobble-700")
      }
    >
      {children}
    </button>
  );
}

/** Partition parts by a metadata field (e.g. weight_class), into ordered
 *  sections. Blank/missing values fall into a trailing "—" group. */
function groupItems(
  items: PartListItem[],
  key: string,
  areaOf: (locationId: string | null | undefined) => string | null,
): { key: string; rows: PartListItem[] }[] {
  const map = new Map<string, PartListItem[]>();
  for (const p of items) {
    // `location` is the reserved group key: roll the row's location up to its
    // room (area). Every other key is an ordinary metadata field.
    let v: string;
    if (key === LOCATION_GROUP_KEY) {
      v = areaOf(p.location_id) ?? "—";
    } else {
      const raw = (p.metadata as Record<string, unknown> | null)?.[key];
      v = raw == null || String(raw).trim() === "" ? "—" : String(raw).trim();
    }
    if (!map.has(v)) map.set(v, []);
    map.get(v)!.push(p);
  }
  return [...map.entries()]
    .sort((a, b) => (a[0] === "—" ? 1 : b[0] === "—" ? -1 : a[0].localeCompare(b[0])))
    .map(([k, rows]) => ({ key: k, rows }));
}

function PartsTileGrid({ items, basePath }: { items: PartListItem[]; basePath: string }) {
  // A lean catalog tile shows no qty badge — it's a record, not stock.
  const disclosure = useDisclosure();
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
      {items.map((p) => (
        <Link key={p.id} to={`${basePath}/parts/${p.id}`} className="block">
          <EntityTile
            src={p.image_path}
            color={(p.metadata as Record<string, unknown> | null)?.color as string | undefined}
            values={p.metadata as Record<string, unknown> | null}
            title={p.name}
            subtitle={p.manufacturer || p.category_name || null}
            badge={
              !disclosure.stock ? undefined : isAssorted(p) ? (
                `${assortedQty(p)} ${p.unit}`
              ) : p.low_stock ? (
                <span className="text-ember-600 dark:text-ember-500">
                  {fmt(p.qty)} / {p.min_qty == null ? "—" : fmt(p.min_qty)}
                </span>
              ) : (
                `${fmt(p.qty)} ${p.unit}`
              )
            }
            attention={!disclosure.stock ? false : p.low_stock}
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
      <span className="inline-flex items-center gap-1 text-[10px] text-muted border border-line dark:border-slate-600 rounded px-1.5 py-0.5">
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

// Spoolman connect + sync. When Spoolman is present it's the tracker; Cobblr
// pulls each spool's remaining weight in (parts in this instance, marked
// tracked_by="spoolman" so adjust-stock skips them — no double-count).
function SpoolmanModal({
  instance,
  onClose,
  onSynced,
}: {
  instance?: string;
  onClose: () => void;
  onSynced: () => void;
}) {
  const { api } = useInventory();
  const qc = useQueryClient();
  const toast = useToast();
  const [label, setLabel] = useState("Spoolman");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const conns = useQuery({ queryKey: ["spoolman-connections"], queryFn: () => api.listSpoolman() });
  const items = conns.data?.items ?? [];
  const invalidate = () => void qc.invalidateQueries({ queryKey: ["spoolman-connections"] });

  const create = useMutation({
    mutationFn: () => api.createSpoolman({ label: label.trim(), base_url: baseUrl.trim(), api_key: apiKey.trim() || undefined }),
    onSuccess: () => {
      setBaseUrl("");
      setApiKey("");
      toast.success("Spoolman connected");
      invalidate();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const sync = useMutation({
    mutationFn: (id: string) => api.syncSpoolman(id, instance),
    onSuccess: (r) => {
      toast.success(`Synced ${r.synced} spool${r.synced === 1 ? "" : "s"} — ${r.created} new, ${r.updated} updated`);
      onSynced();
      invalidate();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const del = useMutation({
    mutationFn: (id: string) => api.deleteSpoolman(id),
    onSuccess: () => {
      toast.success("Removed");
      invalidate();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const field = "w-full px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900";
  return (
    <Modal open onClose={onClose} title="Spoolman" size="sm">
      <div className="space-y-3">
        <p className="text-[13px] text-muted dark:text-slate-400">
          Link Cobblr to your Spoolman. Spoolman stays the source of truth - Cobblr pulls each spool's remaining weight in (as an item here) and won't deduct it itself.
        </p>
        {items.map((c) => (
          <div key={c.id} className="flex items-center gap-2 rounded border border-line dark:border-slate-700 p-2">
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-content dark:text-mortar-100 truncate">{c.label}</div>
              <div className="text-[11px] font-mono text-faint truncate">{c.base_url}</div>
            </div>
            <button
              onClick={() => sync.mutate(c.id)}
              disabled={sync.isPending}
              className="rounded bg-cobble-600 hover:bg-cobble-700 text-white text-xs px-2.5 py-1 disabled:opacity-50"
            >
              {sync.isPending ? "syncing…" : "Sync now"}
            </button>
            <button onClick={() => del.mutate(c.id)} className="text-[11px] text-faint hover:text-ember-500 px-1">
              Remove
            </button>
          </div>
        ))}
        {items.length === 0 && !conns.isLoading && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (baseUrl.trim()) create.mutate();
            }}
            className="space-y-2"
          >
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label" className={field} />
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://spoolman.local:7912" className={field} />
            <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="API key (optional)" className={field} />
            <button
              type="submit"
              disabled={!baseUrl.trim() || create.isPending}
              className="w-full rounded bg-cobble-600 hover:bg-cobble-700 text-white text-sm px-3 py-2 disabled:opacity-50"
            >
              {create.isPending ? "Connecting…" : "Connect"}
            </button>
          </form>
        )}
      </div>
    </Modal>
  );
}
