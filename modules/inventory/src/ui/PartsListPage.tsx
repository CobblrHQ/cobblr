import { dayHere } from "@cobblr/platform-contract/day";
import { SpoolmanModal } from "./SpoolmanModal";
import { FilamentCatalog } from "./FilamentCatalog";
import { NewItemMenu, useCloseToOrigin, workspaceFetch } from "@cobblr/platform-web";
// Parts list — filterable table. Search, category, location, state,
// low-stock toggle. Clicking a row opens the part detail page.

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { WhatsStillHereButton, WhatsStillHereSheet } from "./WhatsStillHere";
import { RecountButton } from "./RecountPage";
import { AlertTriangle, Archive, ArrowRightLeft, ClipboardCheck, Download, ExternalLink, FileDown, FileUp, Plus, Printer, ScanLine, ShieldCheck, MoreHorizontal } from "lucide-react";
import { BulkActionBar, BulkSetField, BulkGiveTo, BulkTagAction, EditableCell, EntityThumb, EntityTile, suggestedSrcFor, usePhotoSuggestions, MoveToInstanceModal, ViewModeToggle, useToast, useConfirm, usePageTitle, usePageWidth, useViewMode, usePlatformWeb, usePublishChatContext, makeAreaResolver, LOCATION_GROUP_KEY, type EditableCellDef, useAskCobbAboutSelection, useTickedRows, useUnits, TILE_GRID, InboxWaitingStrip, SearchInput, QueryError, noteWorkspaceWrite } from "@cobblr/platform-web";
import { useInventory } from "./context";
import { LowStockAlerts } from "./LowStockAlerts.js";
import { nothingToFilter, offeredFilters, type ListFilter } from "./list-filters";
import { AddToListButton } from "./AddToListButton";
import { QtyStepper } from "./QtyStepper";
import { availableOnHand } from "../stock-derived";
import { listStockReading } from "../stock-shapes";
import { HoldingRows, RollupLine } from "./HoldingRows";
import { CombineSuggestionsBanner } from "./CombineSuggestions";
import { openUnitsLabel } from "./consumption/perUnit";
import { assortedQty, isAssorted } from "./assorted";
import { noteOf, TableConnectorImport, useCreateDoor, viewCardFields } from "@cobblr/platform-web";
import { useFieldPresentation } from "./useFieldPresentation";
import { CARD_NATIVE_FIELDS } from "./card-native-fields";
import { useDisclosure } from "./useDisclosure";
import { NewPartDialog } from "./NewPartDialog";
import { BulkMoveToPlace } from "./BulkMoveToPlace";
import { ImportDialog } from "./ImportDialog";
import { PartDetailModal } from "./PartDetailPage";
import type { PartListItem, InvFieldDef } from "./api";
import { countOf, viewQuery } from "@cobblr/platform-contract";
import { strayRecords } from "@cobblr/platform-contract/instance-for-category";
import { withArticle } from "@cobblr/platform-contract/plural";
import { PART_FIELD_LABELS } from "../part-field-labels";

/** One of this module's lists, as `GET /instances?module=inventory` describes it. */
interface SiblingList {
  instance_name: string;
  display_name: string;
  is_default?: boolean;
  movable?: boolean;
}

type StateFilter = "active" | "draft" | "needs_review" | "all";

type SavedViewLite = {
  id: string;
  name: string;
  view_type: string;
  pinned?: boolean;
  is_default?: boolean;
  config?: { group_by?: string; visible_fields?: string[] } & Record<string, unknown>;
};

export function PartsListPage() {
  usePageTitle("Inventory");
  // A wide table, so it gets the screen. Nine columns in a 6xl column meant a
  // real product title either lost its tail to an ellipsis or pushed the last
  // column off the edge, while a wide monitor kept 900px of margin either side.
  usePageWidth("wide");
  const { api, orgSlug, getToken, entityKind, itemNoun, itemNounPlural, nounWords, basePath, instance, connectorImport } = useInventory();
  const { appMode } = usePlatformWeb();
  const qc = useQueryClient();
  // /inventory/parts/:id keeps this list mounted and opens the detail
  // modal (D4). Closing returns to where it was opened from: this list, or a
  // floor plan's drawer (#6266); a record opened by its link closes to the list.
  const { id: detailId } = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const closeDetail = useCloseToOrigin(basePath);
  const [search, setSearch] = useState("");
  const [categoryId, setCategoryId] = useState<string>("");
  const [locationId, setLocationId] = useState<string>("");
  const [state, setState] = useState<StateFilter>("active");
  const [lowOnly, setLowOnly] = useState(false);
  const [archivedFilter, setArchivedFilter] = useState<"hide" | "include" | "only">("hide");
  const [warrantyFilter, setWarrantyFilter] = useState<"all" | "expiring30" | "expiring90">("all");
  const [insuredOnly, setInsuredOnly] = useState(false);
  // Records a create left without a required value (capture first): counted
  // beside the list, and one press shows just them.
  const [needsOnly, setNeedsOnly] = useState(false);
  // Records holding a value capture kept that does not fit its field.
  const [misfitOnly, setMisfitOnly] = useState(false);
  const [lifecycle, setLifecycle] = useState<"" | "bulk" | "kit" | "parted-out">("");
  // Only the filters these records can answer, plus any already set
  // (list-filters.ts). On a phone they sit behind one Filter button.
  const facets = useQuery({ queryKey: ["inventory-facets", orgSlug, instance ?? "inventory"], queryFn: () => api.getPartFacets(), staleTime: 30_000 });
  const activeFilters = new Set<ListFilter>([
    ...(categoryId ? (["category"] as const) : []),
    ...(locationId ? (["location"] as const) : []),
    ...(state !== "active" ? (["state"] as const) : []),
    ...(lifecycle ? (["lifecycle"] as const) : []),
    ...(lowOnly ? (["low_stock"] as const) : []),
    ...(archivedFilter !== "hide" ? (["archived"] as const) : []),
    ...(warrantyFilter !== "all" ? (["warranty"] as const) : []),
    ...(insuredOnly ? (["insured"] as const) : []),
  ]);
  const offered = new Set(offeredFilters(facets.data, activeFilters));
  const noFilterBar = nothingToFilter(facets.data, activeFilters, !!search);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  // `?new=1` (a view's empty state, a card) opens the form on arrival.
  const closeCreateDoor = useCreateDoor(useCallback(() => setAdding(true), []));
  const [importing, setImporting] = useState(false);
  const [connectorOpen, setConnectorOpen] = useState(false);
  const [spoolmanOpen, setSpoolmanOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [viewMode, setViewMode] = useViewMode("parts", "list");
  // One card per thing with its places nested, or one line per place (the
  // spreadsheet view). Remembered per collection.
  const [byPlace, setByPlace] = useByPlace(entityKind);
  const [bulkMoveOpen, setBulkMoveOpen] = useState(false);
  // A stocktake of this table's things that sit in no place: there is no place page to start it from.
  const [unplacedStocktake, setUnplacedStocktake] = useState(false);
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
  const allCustomCols = (fieldDefs.data?.items ?? []).sort((a, b) => a.position - b.position);
  // Computed fields stay out of the DEFAULT six. They are derived, they cost a
  // resolve, and a table that silently fills with them is not what anyone asked
  // for. But a saved view that NAMES one is asking for it explicitly, and until
  // now the exclusion applied to both — so the Tea and Spices tables shipped a
  // "How often you re-buy" view whose two columns could never render. (The
  // exclusion was correct when the list route did not resolve computed values at
  // all; that changed, and this did not.)
  const defaultCols = allCustomCols.filter((d) => d.type !== "computed");

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
      const res = await workspaceFetch(
        `/api/v1/orgs/${orgSlug}/modules/core-views/views?kind=${encodeURIComponent(entityKind)}`,
        { headers: token ? { Authorization: `Bearer ${token}` } : {} },
      );
      if (!res.ok) return { items: [] };
      return res.json();
    },
    staleTime: 60_000,
  });
  const views = savedViews.data?.items ?? [];
  const chipViews = instance ? views.filter((v) => !v.pinned) : views;
  const activeView = viewId ? views.find((v) => v.id === viewId) ?? null : null;
  // Leave out rows with nothing on hand. Off by default: an installed part's
  // row still says what you own, what you paid and where it went.
  const [hideUnavailable, setHideUnavailable] = useHideUnavailable(entityKind, activeView?.id ?? null);
  const groupBy = typeof activeView?.config?.group_by === "string" ? activeView.config.group_by : undefined;
  useEffect(() => {
    if (activeView?.view_type === "table" && activeView.config?.group_by) navigate(`/views/${activeView.id}`, { replace: true });
  }, [activeView, navigate]);
  const viewFields = activeView?.config?.visible_fields;
  // The view's own query (filter / where / sort), read the one way every
  // surface reads it, and sent to the server so it holds across pages.
  // Only group_by and visible_fields used to reach this page, so "Use it or
  // lose it" stayed alphabetical and a Built chip filtered nothing.
  const viewQ = activeView ? viewQuery(activeView.config, dayHere()) : {};
  // When a view is active, restrict the custom columns to its visible_fields;
  // otherwise show the first 6 (the prior behaviour).
  const customCols = viewFields
    ? allCustomCols.filter((c) => viewFields.includes(c.name))
    : defaultCols.slice(0, 6);
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
  // Under the list's own key, so whatever refreshes the list refreshes this.
  const needsValue = useQuery({
    queryKey: ["inventory-parts", entityKind, "needs-value"],
    queryFn: () => api.partsNeedsValue(),
    staleTime: 30_000,
  });
  const doesntFit = useQuery({
    queryKey: ["inventory-parts", entityKind, "doesnt-fit"],
    queryFn: () => api.partsDoesntFit(),
    staleTime: 30_000,
  });
  const parts = useInfiniteQuery({
    // entityKind (`<instance>:item`, or `inventory:part` for the default) MUST
    // be in the key — yarn + hooks are both inventory instances and the API is
    // instance-scoped, so without it they collide on one cache entry and show
    // each other's items / blank on re-click (beta report: "weird all over").
    queryKey: [
      "inventory-parts",
      entityKind,
      { search, categoryId, locationId, state, lowOnly, hideUnavailable, archivedFilter, warrantyFilter, insuredOnly, needsOnly, misfitOnly, lifecycle, byPlace, view: activeView?.id ?? null },
    ],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.listParts({
        search: search.trim() || undefined,
        category_id: categoryId || undefined,
        location_id: locationId || undefined,
        state: state === "all" ? undefined : state,
        low_stock: lowOnly || undefined,
        hide_unavailable: hideUnavailable || undefined,
        show_archived: archivedFilter === "include" || undefined,
        archived_only: archivedFilter === "only" || undefined,
        warranty_expires_within_days: warrantyWithin,
        insured_only: insuredOnly || undefined,
        needs_value: needsOnly || undefined,
        doesnt_fit: misfitOnly || undefined,
        lifecycle: lifecycle || undefined,
        rows: byPlace ? "flat" : undefined,
        cursor: pageParam,
        ...viewQ,
      }),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
  // The records changed (one added, archived, a field filled), so which
  // filters apply may have too.
  const refetchFacets = facets.refetch;
  useEffect(() => {
    if (parts.dataUpdatedAt) void refetchFacets();
  }, [parts.dataUpdatedAt, refetchFacets]);

  async function exportCsv() {
    setExporting(true);
    try {
      const got = await api.partsExportCsv({
        search: search.trim() || undefined,
        state: state === "all" ? undefined : state,
        show_archived: archivedFilter === "include" || undefined,
        archived_only: archivedFilter === "only" || undefined,
        insured_only: insuredOnly || undefined,
      });
      if (got.secretsOmitted) toast.info("Secret fields were left out.");
      toast.success("CSV downloaded.");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setExporting(false);
    }
  }


  // The server orders by anything stored. A COMPUTED field has no stored value
  // to order by, so a view sorted on one ("Re-buy soonest" by runs_out_in) is
  // ordered here, over the rows loaded so far, by the value the row carries.
  // Same grammar as the server (`-field` for descending), so the two never
  // disagree about what a spec means.
  const computedNames = new Set(allCustomCols.filter((d) => d.type === "computed").map((d) => d.name));
  const clientSort = (viewQ.sort ?? []).filter((s) => computedNames.has(s.replace(/^-/, "")));
  // A card kept in several places shows wherever one of its places matched, so
  // two pages can both carry it: keep the first.
  const fetched = dedupeById(parts.data?.pages.flatMap((p) => p.items) ?? []);
  const partItems = clientSort.length === 0
    ? fetched
    : [...fetched].sort((a, b) => {
        for (const spec of clientSort) {
          const key = spec.replace(/^-/, "");
          const dir = spec.startsWith("-") ? -1 : 1;
          const va = (a as unknown as Record<string, unknown>)[key] ?? (a.metadata as Record<string, unknown> | null)?.[key];
          const vb = (b as unknown as Record<string, unknown>)[key] ?? (b.metadata as Record<string, unknown> | null)?.[key];
          // No value sorts last in either direction: an unknown is not the
          // smallest or the largest answer.
          if (va == null && vb == null) continue;
          if (va == null) return 1;
          if (vb == null) return -1;
          const c = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb));
          if (c !== 0) return c * dir;
        }
        return 0;
      });
  // Ticked rows survive a reload of this list and its filters (#4587).
  const [selected, setSelected, clearTicks] = useTickedRows(parts.data ? partItems.map((p) => p.id) : null);
  // Things filed in the catch-all wearing a category that NAMES one of this
  // module's own lists ("Teas" on a base-Inventory row, in a workspace with a
  // Teas list) belong in that list; nobody looks for tea under Inventory. The
  // scan router now sends new ones there; the ones already here are offered
  // the same move, in bulk, from the top of the list.
  const siblingLists = useQuery({
    queryKey: ["inventory-sibling-lists", orgSlug],
    staleTime: 60_000,
    queryFn: async (): Promise<{ items: SiblingList[] }> => {
      const token = getToken();
      const res = await workspaceFetch(`/api/v1/orgs/${orgSlug}/instances?module=inventory`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) return { items: [] };
      return res.json();
    },
  });
  // Another list these could move to, offered from the bar's Move popover.
  const otherLists = (siblingLists.data?.items ?? []).some((s) => s.instance_name !== (instance ?? "inventory") && s.movable !== false);
  const strays = useMemo(() => {
    if (instance) return [];
    const options = (siblingLists.data?.items ?? [])
      .filter((s) => !s.is_default && s.movable !== false)
      .map((s) => ({ instance: s.instance_name, label: s.display_name }));
    return strayRecords(
      partItems.map((p) => ({ id: p.id, category: p.category_name })),
      options,
    );
  }, [instance, siblingLists.data, partItems]);
  // What is ticked IS context: with the panel open, "order more of these"
  // means the parts on screen a person pointed at, and Cobb gets their ids
  // rather than a count he has to go and re-find.
  const askCobb = useAskCobbAboutSelection(selected, partItems, "inventory:part", "part");
  // Tell Ask Cobb what's on this screen — `low_stock` is the module's own flag.
  const lowStock = partItems.filter((p) => (p.rollup ? p.rollup.low : p.low_stock)).length;
  usePublishChatContext({
    kind: entityKind,
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
  const [toolsOpen, setToolsOpen] = useState(false);
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
      title: `Delete ${countOf(selected.size, nounWords)}?`,
      message: "This removes them from the workspace permanently.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    try {
      for (const id of Array.from(selected)) {
        await api.deletePart(id);
      }
      toast.success(`Deleted ${countOf(selected.size, nounWords)}`);
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
    let lastFailure: string | null = null;
    try {
      for (const id of Array.from(selected)) {
        const p = partItems.find((x) => x.id === id);
        const assetId = (p as { asset_id?: number } | undefined)?.asset_id;
        const desc =
          assetId != null
            ? `#${String(assetId).padStart(3, "0")} ${p?.name ?? ""}`.trim()
            : (p?.name ?? itemNoun.charAt(0).toUpperCase() + itemNoun.slice(1));
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
        } catch (e) {
          // Keep going with the rest; the summary says how many did not queue.
          lastFailure = e instanceof Error ? e.message : "";
        }
      }
      toast.success(`Queued ${queued} label${queued === 1 ? "" : "s"}. Open Labels → Queue to print.`);
      const missed = selected.size - queued;
      if (missed > 0) toast.error(`${missed} label${missed === 1 ? "" : "s"} did not queue${lastFailure ? `: ${lastFailure}` : ""}.`);
      setSelected(new Set());
    } finally {
      setBulkLabelBusy(false);
    }
  }

  // Bulk-tag: POST core-tags/attachments per selected id. The inventory
  // module doesn't have a typed client for core-tags so we fetch the
  // platform endpoint directly with the same Bearer.
  async function bulkTag(tagName: string) {
    const token = getToken();
    for (const id of Array.from(selected)) {
      const res = await workspaceFetch(
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
    noteWorkspaceWrite(`/api/v1/orgs/${orgSlug}/modules/core-tags/attachments`);
    toast.success(`Tagged ${countOf(selected.size, nounWords)}`);
    setSelected(new Set());
    void qc.invalidateQueries({ queryKey: ["inventory-parts"] });
  }

  return (
    <div className="space-y-4">
      <LowStockAlerts />
      {strays.length > 0 && (
        <div className="rounded-xl border border-cobble-300 dark:border-cobble-700 bg-cobble-50 dark:bg-cobble-950/40 px-4 py-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          <span className="text-content dark:text-mortar-100">
            Some of these look like they belong in one of your lists:
          </span>
          {strays.map((g) => (
            <button
              key={g.to.instance}
              type="button"
              onClick={() => {
                setSelected(new Set(g.ids));
                setBulkMoveOpen(true);
              }}
              className="inline-flex items-center gap-1 rounded-full border border-cobble-400 dark:border-cobble-600 px-3 py-1 text-xs font-medium text-accent hover:bg-cobble-100 dark:hover:bg-cobble-900"
            >
              <ArrowRightLeft size={12} /> {countOf(g.ids.length, itemNoun)} → {g.to.label}
            </button>
          ))}
        </div>
      )}
      <div className="flex items-center gap-3 flex-wrap">
        {!noFilterBar && <SearchInput value={search} onChange={setSearch} placeholder={`search ${itemNounPlural.toLowerCase()}…`} wrapperClassName="flex-1 min-w-[200px]" />}
        {/* The generic inventory filters (category / location / state /
            lifecycle / low-stock / archived / warranty / insured) are
            base-inventory concepts — noise on a skinned instance (Yarn). Hide
            them when scoped; search + the saved-view chips are the navigation. */}
        {!instance && !noFilterBar && offered.size > 0 && (
        <>
        <button
          type="button"
          onClick={() => setFiltersOpen((o) => !o)}
          aria-expanded={filtersOpen}
          className="sm:hidden rounded-md border border-line dark:border-slate-600 px-3 py-2 text-sm font-medium text-content dark:text-mortar-100 inline-flex items-center gap-1.5"
        >
          Filter{activeFilters.size > 0 ? ` (${activeFilters.size})` : ""}
        </button>
        <div data-testid="list-filters" className={filtersOpen ? "w-full flex flex-wrap items-center gap-3 sm:contents" : "hidden sm:contents"}>
        {offered.has("category") && (
        <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="input !w-auto" aria-label="Category">
          <option value="">All categories</option>
          {cats.data?.items.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        )}
        {offered.has("location") && (
        <select value={locationId} onChange={(e) => setLocationId(e.target.value)} className="input !w-auto" aria-label="Location">
          <option value="">All locations</option>
          {locs.data?.items.map((l) => (
            <option key={l.id} value={l.id}>
              {"  ".repeat(l.depth)}
              {l.name}
            </option>
          ))}
        </select>
        )}
        {offered.has("state") && (
        <select value={state} onChange={(e) => setState(e.target.value as StateFilter)} className="input !w-auto" aria-label="State">
          <option value="active">Active</option>
          <option value="draft">Draft</option>
          <option value="needs_review">Needs review</option>
          <option value="all">All</option>
        </select>
        )}
        {offered.has("lifecycle") && (
        <select
          value={lifecycle}
          onChange={(e) => setLifecycle(e.target.value as typeof lifecycle)}
          className="input !w-auto"
          title="Lifecycle - kits vs bulk vs parted-out (Lego-style)"
          aria-label="Lifecycle"
        >
          <option value="">All lifecycle</option>
          <option value="bulk">Bulk only</option>
          <option value="kit">Kits only</option>
          <option value="parted-out">Parted-out</option>
        </select>
        )}
        {(hideUnavailable || partItems.some((p) => (p.installed_qty ?? 0) > 0 || p.spare_qty === 0)) && (
        <label className="flex items-center gap-1.5 text-xs text-content dark:text-mortar-200 cursor-pointer" title="Leave out what has nothing on hand: everything of it installed in something, or none left">
          <input
            type="checkbox"
            checked={hideUnavailable}
            onChange={(e) => setHideUnavailable(e.target.checked)}
            className="accent-cobble-500"
          />
          Hide unavailable
        </label>
        )}
        {offered.has("low_stock") && (
        <label className="flex items-center gap-1.5 text-xs text-content dark:text-mortar-200 cursor-pointer">
          <input
            type="checkbox"
            checked={lowOnly}
            onChange={(e) => setLowOnly(e.target.checked)}
            className="accent-cobble-500"
          />
          low-stock only
        </label>
        )}
        {offered.has("archived") && (
        <select
          value={archivedFilter}
          onChange={(e) => setArchivedFilter(e.target.value as typeof archivedFilter)}
          className="input !w-auto"
          title="Archive filter"
          aria-label="Archived"
        >
          <option value="hide">Hide archived</option>
          <option value="include">Include archived</option>
          <option value="only">Archived only</option>
        </select>
        )}
        {offered.has("warranty") && (
        <select
          value={warrantyFilter}
          onChange={(e) => setWarrantyFilter(e.target.value as typeof warrantyFilter)}
          className="input !w-auto"
          title="Warranty filter"
          aria-label="Warranty"
        >
          <option value="all">Any warranty</option>
          <option value="expiring30">Warranty in 30d</option>
          <option value="expiring90">Warranty in 90d</option>
        </select>
        )}
        {offered.has("insured") && (
        <label className="flex items-center gap-1.5 text-xs text-content dark:text-mortar-200 cursor-pointer">
          <input
            type="checkbox"
            checked={insuredOnly}
            onChange={(e) => setInsuredOnly(e.target.checked)}
            className="accent-cobble-500"
          />
          insured only
        </label>
        )}
        </div>
        </>
        )}
        {(needsValue.data?.count ?? 0) > 0 && (
          <button
            type="button"
            onClick={() => setNeedsOnly((v) => !v)}
            aria-pressed={needsOnly}
            title={`Still empty: ${needsValue.data!.fields.join(", ")}`}
            className={
              "rounded-full border px-2.5 py-1 text-xs font-medium transition " +
              (needsOnly
                ? "border-amber-400 bg-amber-100 text-amber-900 dark:border-amber-700 dark:bg-amber-900/40 dark:text-amber-200"
                : "border-amber-300 text-amber-800 hover:bg-amber-50 dark:border-amber-800 dark:text-amber-300 dark:hover:bg-amber-950/40")
            }
          >
            {needsValue.data!.count} need{needsValue.data!.count === 1 ? "s" : ""} a value
          </button>
        )}
        {(doesntFit.data?.count ?? 0) > 0 && (
          <button
            type="button"
            onClick={() => setMisfitOnly((v) => !v)}
            aria-pressed={misfitOnly}
            title={doesntFit.data!.fields.map((f) => `${f.label}: ${f.count}`).join(", ")}
            className={
              "rounded-full border px-2.5 py-1 text-xs font-medium transition " +
              (misfitOnly
                ? "border-amber-400 bg-amber-100 text-amber-900 dark:border-amber-700 dark:bg-amber-900/40 dark:text-amber-200"
                : "border-amber-300 text-amber-800 hover:bg-amber-50 dark:border-amber-800 dark:text-amber-300 dark:hover:bg-amber-950/40")
            }
          >
            {doesntFit.data!.count} {doesntFit.data!.count === 1 ? "doesn't fit its field" : "don't fit their field"}
          </button>
        )}
        <div className="ml-auto" />
        {(byPlace || partItems.some((p) => p.holdings)) && <ByPlaceToggle byPlace={byPlace} onChange={setByPlace} />}
        <ViewModeToggle mode={viewMode} onChange={setViewMode} />
        {/* On a skinned table (an app's Yarn, a pantry) the data tools sit
            behind one button: five bordered buttons stacked above the first
            row on a phone before any yarn was visible (2026-09-02). The base
            inventory list keeps them inline; it is a workbench, not an app. */}
        {instance ? (
          <div className="relative">
            <button
              type="button"
              onClick={() => setToolsOpen((o) => !o)}
              aria-expanded={toolsOpen}
              data-testid="list-tools"
              className="rounded-md border border-line dark:border-slate-700 text-content dark:text-mortar-200 hover:bg-subtle dark:hover:bg-slate-800/70 text-sm font-medium px-3 py-2 transition flex items-center gap-1.5"
              aria-label="Import / export"
              title="Import and export"
            >
              <MoreHorizontal size={14} /> <span className="hidden sm:inline">Import / export</span>
            </button>
            {toolsOpen && (
              <div
                className="absolute right-0 z-20 mt-1 flex min-w-[200px] flex-col gap-1 rounded-md border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-1 shadow-lg"
                onClick={() => setToolsOpen(false)}
              >
            <button
              type="button"
              onClick={() => setUnplacedStocktake(true)}
              className="rounded-md border border-line dark:border-slate-700 text-content dark:text-mortar-200 hover:bg-subtle dark:hover:bg-slate-800/70 text-sm font-medium px-3 py-2 transition flex items-center gap-1.5"
            >
              <ClipboardCheck size={14} /> What's still here? (no place)
            </button>
            <RecountButton
              categoryId={categoryId || null}
              className="rounded-md border border-line dark:border-slate-700 text-content dark:text-mortar-200 hover:bg-subtle dark:hover:bg-slate-800/70 text-sm font-medium px-3 py-2 transition flex items-center gap-1.5 disabled:opacity-50"
            />
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
            {connectorImport && (
              <button
                onClick={() => setConnectorOpen(true)}
                data-testid="connector-import-open"
                className="rounded-md border border-line dark:border-slate-700 text-content dark:text-mortar-200 hover:bg-subtle dark:hover:bg-slate-800/70 text-sm font-medium px-3 py-2 transition flex items-center gap-1.5"
              >
                <Download size={14} /> {connectorImport.label ?? "Import"}
              </button>
            )}
            {/* Spoolman syncs 3D-printing FILAMENT spool weights — irrelevant on a
                food pantry / medications / generic inventory, where it was just
                clutter. Gate it to the filament spools instance. */}
            {instance === "filament" && (
              <button
                onClick={() => setSpoolmanOpen(true)}
                className="rounded-md border border-line dark:border-slate-700 text-content dark:text-mortar-200 hover:bg-subtle dark:hover:bg-slate-800/70 text-sm font-medium px-3 py-2 transition flex items-center gap-1.5"
                title="Sync remaining weight from Spoolman"
              >
                <Download size={14} /> Spoolman
              </button>
            )}
              </div>
            )}
          </div>
        ) : (
          <>
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
        <RecountButton
          categoryId={categoryId || null}
          className="rounded-md border border-line dark:border-slate-700 text-content dark:text-mortar-200 hover:bg-subtle dark:hover:bg-slate-800/70 text-sm font-medium px-3 py-2 transition flex items-center gap-1.5 disabled:opacity-50"
        />
        {connectorImport && (
          <button
            onClick={() => setConnectorOpen(true)}
            data-testid="connector-import-open"
            className="rounded-md border border-line dark:border-slate-700 text-content dark:text-mortar-200 hover:bg-subtle dark:hover:bg-slate-800/70 text-sm font-medium px-3 py-2 transition flex items-center gap-1.5"
          >
            <Download size={14} /> {connectorImport.label ?? "Import"}
          </button>
        )}
        {/* Spoolman syncs 3D-printing FILAMENT spool weights — irrelevant on a
            food pantry / medications / generic inventory, where it was just
            clutter. Gate it to the filament spools instance. */}
        {instance === "filament" && (
          <button
            onClick={() => setSpoolmanOpen(true)}
            className="rounded-md border border-line dark:border-slate-700 text-content dark:text-mortar-200 hover:bg-subtle dark:hover:bg-slate-800/70 text-sm font-medium px-3 py-2 transition flex items-center gap-1.5"
            title="Sync remaining weight from Spoolman"
          >
            <Download size={14} /> Spoolman
          </button>
        )}
          </>
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
        <NewItemMenu kind="inventory:part" instance={instance}>
          <button
            onClick={() => setAdding(true)}
            className="rounded-md bg-cobble-600 hover:bg-cobble-700 text-white text-sm font-medium px-3 py-2 transition flex items-center gap-1.5"
          >
            <Plus size={14} /> New {itemNoun}
          </button>
        </NewItemMenu>
      </div>

      {instance === "filament-types" && <FilamentCatalog />}

      {/* Saved-view chips — bundles ship pinned ones; the wizard lands here.
          On an instance page the PINNED views are already the tabs above the
          table (InstancePage), so the chips carry only the unpinned ones: a
          Yarn table showed "By weight" twice, once as a tab and once as a
          chip (2026-09-02). */}
      {chipViews.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <ViewChip active={!activeView} onClick={() => selectView(null)}>
            All {itemNounPlural}
          </ViewChip>
          {chipViews.map((v) => (
            <ViewChip key={v.id} active={activeView?.id === v.id} onClick={() => selectView(v.id)}>
              {v.name}
            </ViewChip>
          ))}
        </div>
      )}

      {/* A view filter the collection could not run used to vanish, and the
          unfiltered rows read as the filtered set. */}
      {(parts.data?.pages[0]?.unapplied?.length ?? 0) > 0 && (
        <p data-testid="view-unapplied" className="rounded border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 px-2 py-1 text-xs text-amber-900 dark:text-amber-200">
          {parts.data!.pages[0]!.unapplied!.length === 1 ? "One filter" : `${parts.data!.pages[0]!.unapplied!.length} filters`} in this view could not run, so these are not narrowed by{" "}
          {parts.data!.pages[0]!.unapplied!.map((p) => `${p.col} ${p.op} ${p.ref_col ?? String(p.value ?? "")}`).join(", ")}.
        </p>
      )}
      {parts.isLoading && <div className="text-sm text-faint dark:text-slate-500">loading…</div>}
      {parts.isError && !parts.data && <QueryError what={itemNounPlural.toLowerCase()} onRetry={() => void parts.refetch()} />}
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
                  ? "No matches. Try widening the filter."
                  : welcome
                    ? `Tap below to add ${withArticle(noun)} by hand, or use Scan in the top bar to add one from a label.`
                    : `No ${plural} here yet. Add your first ${noun} to get started.`}
            </p>
            {!hasFilters && (
              <button
                onClick={() => setAdding(true)}
                className="inline-flex items-center gap-1.5 rounded-md bg-cobble-600 hover:bg-cobble-700 text-white text-sm font-medium px-4 py-2 transition"
              >
                <Plus size={15} /> {welcome ? `Add ${withArticle(itemNoun)}` : `New ${itemNoun}`}
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
                  viewFields={viewFields}
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
            {/* The same thing entered once per place: offered as one item. */}
            {partItems.length > 1 && <CombineSuggestionsBanner />}
            {partItems.length > 0 && viewMode === "tiles" && <PartsTileGrid items={partItems} basePath={basePath} />}
            {partItems.length > 0 && viewMode === "list" && (
              <PartsTable
                items={partItems}
                basePath={basePath}
                customCols={shownCols}
                viewFields={viewFields}
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
      {/* What is waiting in the scan inbox to come here, under the filed
          results: a thing just scanned is in no table until it is filed. */}
      <InboxWaitingStrip destination={instance ?? "inventory"} q={search} />

      {adding && (
        <NewPartDialog
          onClose={(created) => {
            setAdding(false);
            closeCreateDoor();
            if (created) {
              void parts.refetch();
              void needsValue.refetch();
              void doesntFit.refetch();
            }
          }}
        />
      )}
      {connectorImport && (
        <TableConnectorImport
          orgSlug={orgSlug}
          getToken={getToken}
          decl={connectorImport}
          open={connectorOpen}
          onClose={() => setConnectorOpen(false)}
          onDone={() => void qc.invalidateQueries({ queryKey: ["inventory-parts"] })}
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
          onClose={closeDetail}
        />
      )}
      {spoolmanOpen && (
        <SpoolmanModal
          instance={instance}
          onClose={() => setSpoolmanOpen(false)}
          onSynced={() => void qc.invalidateQueries({ queryKey: ["inventory-parts"] })}
        />
      )}
      {unplacedStocktake && instance && (
        <WhatsStillHereSheet api={api} slug={orgSlug} scope={{ unplaced: true, instance }} label="the things with no place" onClose={() => setUnplacedStocktake(false)} />
      )}
      <BulkActionBar
        records={{ kind: instance && instance !== "inventory" ? `${instance}:item` : "inventory:part", ids: Array.from(selected) }}
        onAskCobb={askCobb}
        count={selected.size}
        onClear={() => setSelected(new Set())}
        actions={
          <>
            <BulkSetField records={Array.from(selected).map((id) => ({ kind: instance && instance !== "inventory" ? `${instance}:item` : "inventory:part", id }))} onDone={() => setSelected(new Set())} />
            <WhatsStillHereButton api={api} slug={orgSlug} scope={{ ids: Array.from(selected) }} label="the things you picked" className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded text-accent hover:text-accent">
              <ClipboardCheck size={12} /> What's still here?
            </WhatsStillHereButton>
            <button
              type="button"
              disabled={bulkLabelBusy}
              onClick={() => void bulkPrintLabels()}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded text-accent hover:text-accent disabled:opacity-50"
            >
              <Printer size={12} /> {bulkLabelBusy ? "Queuing…" : "Print labels"}
            </button>
            <BulkTagAction count={selected.size} placeholder="e.g. urgent, archive, low-stock" onTag={bulkTag} />
            <BulkGiveTo kind={instance && instance !== "inventory" ? `${instance}:item` : "inventory:part"} ids={Array.from(selected)} onDone={clearTicks} />
            <BulkMoveToPlace
              rows={partItems.filter((p) => selected.has(p.id))}
              onMoved={clearTicks}
              listMove={otherLists ? { fromInstance: instance ?? "inventory" } : undefined}
            />
            <button
              type="button"
              onClick={() => void bulkDelete()}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded text-ember-600 dark:text-ember-400 hover:text-ember-700"
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
        onMoved={(n, where, undo) => {
          const tickAgain = clearTicks();
          toast.action(`Moved ${countOf(n, itemNoun)} to ${where}.`, {
            actionLabel: "Undo",
            duration: 10_000,
            onAction: async () => {
              await undo();
              void qc.invalidateQueries();
              tickAgain();
            },
          });
          void qc.invalidateQueries();
        }}
      />

    </div>
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
type PartsPage = { items: PartListItem[]; next_cursor?: string | null; unapplied?: Array<{ col: string; op: string; value?: unknown; ref_col?: string }> };
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
  viewFields,
  selected,
  allChecked,
  onToggle,
  onSelectAll,
}: {
  items: PartListItem[];
  basePath: string;
  customCols: InvFieldDef[];
  /** The selected view's declared fields, in its order; the phone card shows
   *  them as the desktop table does (#3626). */
  viewFields?: string[];
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
  // The workspace vocabulary decides which units are worth showing beside a
  // quantity: a measured one is part of the value, a countable one is noise.
  const units = useUnits();
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
  // Pictures offered to records made without one (#3818).
  const suggestions = usePhotoSuggestions(entityKind, items.map((p) => p.id));
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
  // Every column the header draws, so a card's places can span the row.
  const tableCols =
    4 + (showCategory ? 1 : 0) + (showLocation ? 1 : 0) + customCols.length + (showQty ? 2 : 0) + (showMin ? 1 : 0) + (anySupplier ? 1 : 0);
  // What the selected view is FOR, on a phone too: its declared fields in its
  // own order, the first few on the card and the rest one tap away. The card's
  // own line already carries the name, qty, category and location.
  const cardFields = viewCardFields(
    viewFields,
    customCols,
    (c) => c.name,
    CARD_NATIVE_FIELDS,
  );
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
            {showQty && <Th className="text-right">{fp.label("qty", PART_FIELD_LABELS.qty)}</Th>}
            {showQty && <Th className="text-right">Available</Th>}
            {showMin && <Th className="text-right">{fp.label("min_qty", PART_FIELD_LABELS.min_qty)}</Th>}
            {anySupplier && <Th>Supplier</Th>}
            <Th />
          </tr>
        </thead>
        <tbody>
          {items.map((p) => (
            <Fragment key={p.id}>
            <tr
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
              {/* A ceiling, or the cell has nothing to wrap against: a table
                  cell sizes to its content, so "max width" is what turns a long
                  name into two lines instead of a wider table. */}
              <td className="px-3 py-2 max-w-[32rem]">
                <div className="flex items-center gap-3">
                  <EntityThumb
                    src={p.image_path}
                    suggestedSrc={suggestedSrcFor(suggestions, p.id, p.image_path)}
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
                      {/* Wraps, up to two lines. `truncate` is nowrap, so the
                          column stretched to the longest title and pushed the
                          last column past the edge; the ellipsis never even
                          appeared, because nothing was constraining the width.
                          Two lines is enough for a real product name and stops
                          one pathological title owning the row height. */}
                      <Link
                        to={`${basePath}/parts/${p.id}`}
                        className="font-medium text-content dark:text-mortar-100 hover:text-accent line-clamp-2 break-words"
                      >
                        {/* The served title (a titled work in the person's
                            format, #3061) is what reads; the cell edits the
                            stored name, which is what a commit writes. */}
                        {p.title ?? p.name}
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
                  {/* Kept in several places: the places are the rows below,
                      and one location here would be only the first of them. */}
                  {p.rollup ? (
                    <span className="font-mono text-[11px]">{p.rollup.places} places</span>
                  ) : (
                    // Inside something (a computer, a backpack), it has no
                    // place of its own: the cell says what it is in and where.
                    p.location_id == null && p.location_name ? (
                      <span data-testid="held-in" title="Inside something: move it from its page">{p.location_name}</span>
                    ) : (
                      <EditableCell
                        def={nativeDef("location_id", fp.label("location", "Location"), "text")}
                        value={p.location_id}
                        options={locOptions}
                        fallbackLabel={p.location_name}
                        onCommit={(v) => setCol(p, "location_id", v)}
                      />
                    )
                  )}
                </td>
              )}
              {customCols.map((c) => (
                <td key={c.id} className="px-3 py-2 text-muted dark:text-slate-400">
                  <EditableCell
                    def={c}
                    value={(p.metadata as Record<string, unknown> | null)?.[c.name]}
                    metadata={p.metadata}
                    onCurrencyChange={(currency) => setMeta(p, `money_currency_${c.name}`, currency)}
                    note={noteOf(p.metadata as Record<string, unknown> | null, c.name)}
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
                    {isAssorted(p) || p.rollup ? (
                      <>
                        {isAssorted(p) ? (
                          <span className="text-accent" title="Estimated, not counted">
                            {assortedQty(p)}
                          </span>
                        ) : (
                          // Everything held, across its places; each place's own
                          // stepper is on its row below.
                          <span className="font-semibold" title="Across every place">{fmt(p.rollup!.qty)}</span>
                        )}
                        {units.suffix(p.unit) && (
                          <span className="text-faint dark:text-slate-500">{units.suffix(p.unit)}</span>
                        )}
                      </>
                    ) : (
                      <RowAmount p={p} />
                    )}
                    {/* A model tracked unit by unit: the count is the unopened
                        spares, and an open one with something left is stock
                        too. Without this the row read Qty 0 over 160 m on the
                        needles (#2848). */}
                    {openUnitsLabel(p.open_units, fmt) && (
                      <span className="text-[11px] text-accent whitespace-nowrap" title="Open, with what is left in each">
                        + {openUnitsLabel(p.open_units, fmt)}
                      </span>
                    )}
                  </span>
                </td>
              )}
              {showQty && (
                <td
                  className="px-3 py-2 text-right font-mono"
                  title="Derived from what is on hand (open units included) minus what's allocated"
                >
                  {/* Available derives from a count. An estimate has none, and
                      printing 0 here would contradict the ~50 beside it. */}
                  {isAssorted(p) || p.rollup || listStockReading(p.stock) ? (
                    <span className="text-faint dark:text-slate-500">—</span>
                  ) : (
                    fmt(availableOnHand(p))
                  )}
                </td>
              )}
              {showMin && (
                <td className="px-3 py-2 text-right font-mono text-faint dark:text-slate-500">
                  {/* Each place keeps its own minimum, on its row. */}
                  {p.rollup ? (
                    <span className="text-[11px]">per place</span>
                  ) : (
                    <EditableCell
                      def={nativeDef("min_qty", fp.label("min_qty", PART_FIELD_LABELS.min_qty), "number")}
                      value={p.min_qty}
                      align="right"
                      onCommit={(v) => setCol(p, "min_qty", v)}
                    />
                  )}
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
                  <InstalledChip p={p} />
                  {(p.rollup ? p.rollup.low : p.low_stock) && (
                    <>
                      <span className="inline-flex items-center gap-1 text-[10px] text-ember-500 border border-ember-200 dark:border-ember-800 rounded px-1.5 py-0.5">
                        <AlertTriangle size={10} /> low
                      </span>
                      <AddToListButton kind={entityKind} id={p.id} />
                    </>
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
            {p.holdings && p.rollup && (
              <tr className="border-t-0" data-testid="holdings-subrow">
                <td />
                <td colSpan={tableCols - 1} className="px-3 pb-2 pt-0">
                  <RollupLine rollup={p.rollup} unit={units.suffix(p.unit) || undefined} />
                  <HoldingRows rows={p.holdings} unit={p.unit} />
                </td>
              </tr>
            )}
            </Fragment>
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
                suggestedSrc={suggestedSrcFor(suggestions, p.id, p.image_path)}
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
                  {/* Wraps to two lines rather than truncating: on a yarn the
                      distinguishing part of the name is its END ("- Country
                      Blue"), which an ellipsis would hide. */}
                  <Link
                    to={`${basePath}/parts/${p.id}`}
                    className="font-medium text-content dark:text-mortar-100 hover:text-accent min-w-0 break-words line-clamp-2"
                  >
                    {/* The served title reads; the cell edits the stored name (#3061). */}
                    {p.title ?? p.name}
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
                {/* Kept in several places: the top line and a row per place,
                    each with its own stepper and minimum. */}
                {p.holdings && p.rollup && (
                  <div className="mt-1" onClick={(e) => e.stopPropagation()}>
                    <RollupLine rollup={p.rollup} unit={units.suffix(p.unit) || undefined} />
                    <HoldingRows rows={p.holdings} unit={p.unit} />
                  </div>
                )}
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-mono text-muted dark:text-slate-400">
                  {showQty && !p.rollup && (
                    <span className="inline-flex items-center gap-1">
                      {isAssorted(p) ? (
                        <span className="text-accent" title="Estimated, not counted">
                          {assortedQty(p)}
                          {units.suffix(p.unit) ? ` ${units.suffix(p.unit)}` : ""}
                        </span>
                      ) : (
                        <>
                          {!listStockReading(p.stock) && "qty "}<RowAmount p={p} />
                        </>
                      )}
                      {openUnitsLabel(p.open_units, fmt) ? ` + ${openUnitsLabel(p.open_units, fmt)}` : ""}
                    </span>
                  )}
                  {showQty && !isAssorted(p) && !p.rollup && !listStockReading(p.stock) && (
                    <span title="Derived from what is on hand (open units included) minus what's allocated">
                      avail {fmt(availableOnHand(p))}
                    </span>
                  )}
                  {showMin && !p.rollup && (
                    <span className="inline-flex items-center gap-1">
                      min
                      <span className="w-14">
                        <EditableCell
                          def={nativeDef("min_qty", fp.label("min_qty", PART_FIELD_LABELS.min_qty), "number")}
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
                  {showLocation && !p.rollup && (
                    <span className="inline-flex items-center gap-1 min-w-[5rem]">
                      @
                      {p.location_id == null && p.location_name ? (
                        <span data-testid="held-in">{p.location_name}</span>
                      ) : (
                        <EditableCell
                          def={nativeDef("location_id", fp.label("location", "Location"), "text")}
                          value={p.location_id}
                          options={locOptions}
                          fallbackLabel={p.location_name}
                          onCommit={(v) => setCol(p, "location_id", v)}
                        />
                      )}
                    </span>
                  )}
                </div>
                {cardFields.onCard.length > 0 && (
                  <div data-testid="card-view-fields" onClick={(e) => e.stopPropagation()}>
                    <CardFieldRows fields={cardFields.onCard} part={p} onCommit={(name, v) => setMeta(p, name, v)} />
                    {cardFields.more.length > 0 && (
                      <details className="mt-0.5">
                        <summary className="cursor-pointer text-[11px] text-accent select-none">
                          {cardFields.more.length} more
                        </summary>
                        <CardFieldRows fields={cardFields.more} part={p} onCommit={(name, v) => setMeta(p, name, v)} />
                      </details>
                    )}
                  </div>
                )}
                <div className="mt-1 flex flex-wrap gap-1">
                  <InstalledChip p={p} />
                  {!p.rollup && p.low_stock && (
                    <>
                      <span className="inline-flex items-center gap-1 text-[10px] text-ember-500 border border-ember-200 dark:border-ember-800 rounded px-1.5 py-0.5">
                        <AlertTriangle size={10} /> low
                      </span>
                      <AddToListButton kind={entityKind} id={p.id} />
                    </>
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

/** A phone card's view fields: label and value, each value the same editable
 *  cell the desktop column draws. */
function CardFieldRows({
  fields,
  part,
  onCommit,
}: {
  fields: InvFieldDef[];
  part: PartListItem;
  onCommit: (name: string, v: unknown) => void;
}) {
  const meta = part.metadata as Record<string, unknown> | null;
  return (
    <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-[11px]">
      {fields.map((c) => (
        <Fragment key={c.id}>
          <dt className="text-faint dark:text-slate-500">{c.display_label}</dt>
          <dd className="text-content dark:text-mortar-200 min-w-0">
            <EditableCell def={c} value={meta?.[c.name]} metadata={meta} onCurrencyChange={(currency) => onCommit(`money_currency_${c.name}`, currency)} note={noteOf(meta, c.name)} onCommit={(v) => onCommit(c.name, v)} />
          </dd>
        </Fragment>
      ))}
    </dl>
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
  const { entityKind } = useInventory();
  const suggestions = usePhotoSuggestions(entityKind, items.map((p) => p.id));
  const units = useUnits();
  return (
    <div className={TILE_GRID}>
      {items.map((p) => (
        <Link key={p.id} to={`${basePath}/parts/${p.id}`} className="block">
          <EntityTile
            src={p.image_path}
            suggestedSrc={suggestedSrcFor(suggestions, p.id, p.image_path)}
            color={(p.metadata as Record<string, unknown> | null)?.color as string | undefined}
            values={p.metadata as Record<string, unknown> | null}
            title={p.name}
            subtitle={p.manufacturer || p.category_name || null}
            badge={
              !disclosure.stock ? undefined : isAssorted(p) ? (
                [assortedQty(p), units.suffix(p.unit)].filter(Boolean).join(" ")
              ) : p.rollup ? (
                // Kept in several places: everything held, and where it is short.
                <span className={p.rollup.low ? "text-ember-600 dark:text-ember-500" : undefined}>
                  {[fmt(p.rollup.qty), units.suffix(p.unit)].filter(Boolean).join(" ")} · {p.rollup.places} places
                  {p.rollup.low ? ` · low in ${p.rollup.low_count}` : ""}
                </span>
              ) : p.low_stock ? (
                // On hand against the minimum, an open unit counted: the tile
                // read "0 / 1" over a skein with 160 m left (#2848).
                <span className="text-ember-600 dark:text-ember-500">
                  {fmt(onHandOf(p))} / {p.min_qty == null ? "—" : fmt(p.min_qty)}
                  {openUnitsLabel(p.open_units, fmt) ? ` · ${openUnitsLabel(p.open_units, fmt)}` : ""}
                </span>
              ) : (
                listStockReading(p.stock) ?? [fmt(p.qty), units.suffix(p.unit), openUnitsLabel(p.open_units, fmt) ? `+ ${openUnitsLabel(p.open_units, fmt)}` : ""].filter(Boolean).join(" ")
              )
            }
            attention={!disclosure.stock ? false : p.rollup ? p.rollup.low : p.low_stock}
            // The table's rule, on the tile: a counted thing in one place
            // steps; an estimate or a thing held in several places does not
            // (each place steps on its own row). The tile keeps the tap from
            // opening the item behind it.
            status={
              disclosure.stock && !isAssorted(p) && !p.rollup && !listStockReading(p.stock) ? (
                <span className="flex justify-end">
                  <QtyStepper partId={p.id} qty={Number(p.qty)} unit={p.unit} label={p.name} size="sm" />
                </span>
              ) : undefined
            }
          />
        </Link>
      ))}
    </div>
  );
}


/** A row's amount in one place. A sheet or a wearing tool reads what is left
 *  of it (its count is one sheet, one cutter); anything else is the stepper,
 *  which prints its own unit, so nothing beside it adds another (#5296: "830 g
 *  [Use some] g"). */
function RowAmount({ p }: { p: PartListItem }) {
  const reading = listStockReading(p.stock);
  if (reading) {
    return (
      <span className="whitespace-nowrap" data-testid="stock-reading">
        {reading}
      </span>
    );
  }
  return <QtyStepper partId={p.id} qty={Number(p.qty)} unit={p.unit} label={p.name} size="sm" />;
}

/** On hand, or the count face itself on an older api. */
function onHandOf(p: { qty: number | string; on_hand?: number }): number {
  return typeof p.on_hand === "number" ? p.on_hand : Number(p.qty);
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

function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((it) => (seen.has(it.id) ? false : (seen.add(it.id), true)));
}

/** "0 spare · 1 installed in Gaming PC": what of a thing is installed in an
 *  asset or machine, beside what is on hand. Nothing when none is installed. */
function InstalledChip({ p }: { p: { installed_qty?: number; spare_qty?: number; installed_in?: Array<{ id: string; name: string; qty: number }> } }) {
  if (!p.installed_qty) return null;
  const where = (p.installed_in ?? []).map((h) => (p.installed_in!.length > 1 ? `${h.name} (${h.qty})` : h.name)).join(", ");
  return (
    <span data-testid="installed-chip" className="inline-flex items-center gap-1 text-[10px] text-muted dark:text-slate-400 border border-line dark:border-slate-700 rounded px-1.5 py-0.5">
      {p.spare_qty ?? 0} spare · {p.installed_qty} installed in {where}
    </span>
  );
}

const HIDE_UNAVAILABLE_KEY = "cobblr.inventory.hide-unavailable.";

/** Hide unavailable, remembered per person (this browser) and per view. Off
 *  until turned on; a storage that throws reads as off. */
function useHideUnavailable(kind: string, viewId: string | null): [boolean, (v: boolean) => void] {
  const key = `${HIDE_UNAVAILABLE_KEY}${kind}.${viewId ?? "all"}`;
  const read = () => {
    try {
      return window.localStorage.getItem(key) === "1";
    } catch {
      return false;
    }
  };
  const [on, setOn] = useState<boolean>(read);
  // A different view (or collection) reads its own choice.
  useEffect(() => setOn(read()), [key]);
  const set = useCallback(
    (v: boolean) => {
      setOn(v);
      try {
        window.localStorage.setItem(key, v ? "1" : "0");
      } catch {
        /* the choice lasts this visit */
      }
    },
    [key],
  );
  return [on, set];
}

const BY_PLACE_KEY = "cobblr.inventory.by-place.";

/** Whether this collection lists a line per place rather than a card per
 *  thing. A per-browser convenience; a storage that throws reads as "by item". */
function useByPlace(kind: string): [boolean, (v: boolean) => void] {
  const [on, setOn] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(BY_PLACE_KEY + kind) === "1";
    } catch {
      return false;
    }
  });
  const set = useCallback(
    (v: boolean) => {
      setOn(v);
      try {
        window.localStorage.setItem(BY_PLACE_KEY + kind, v ? "1" : "0");
      } catch {
        /* the choice lasts this visit */
      }
    },
    [kind],
  );
  return [on, set];
}

/** "By item" (a card per thing, its places nested) or "By place" (a line per
 *  place). Shown once something is kept in more than one place. */
function ByPlaceToggle({ byPlace, onChange }: { byPlace: boolean; onChange: (v: boolean) => void }) {
  const btn = (active: boolean) =>
    "px-2 py-1 text-[11px] transition " +
    (active ? "bg-cobble-600 text-white" : "text-muted dark:text-slate-400 hover:bg-subtle dark:hover:bg-slate-800");
  return (
    <div className="inline-flex items-center rounded border border-line dark:border-slate-700 overflow-hidden shrink-0" role="group" aria-label="Group by">
      <button type="button" aria-pressed={!byPlace} onClick={() => onChange(false)} className={btn(!byPlace)}>
        By item
      </button>
      <button type="button" aria-pressed={byPlace} onClick={() => onChange(true)} className={btn(byPlace)}>
        By place
      </button>
    </div>
  );
}
