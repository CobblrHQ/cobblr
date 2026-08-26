// /locations — the workspace-wide tree of physical places.
// core-locations is foundational, so this page always exists when an
// org is loaded. The tree below is rendered as boxed nested list
// cards: each location's own card, with indented child cards inside.
//
// This is a place you BROWSE, not a setting, so it lives in the
// workspace nav and owns the bare /locations URL. It used to be
// /configuration/locations, which meant clicking any row from the
// navbar entry bounced you into the settings shell.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { readBound } from "../lib/floorplanGeometry";
import { LocationFloorPlanTab } from "../components/LocationFloorPlanTab";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Printer, Trash2, Pencil, Box as BoxIcon, MapPin as AreaIcon, Upload, Download, GripVertical, CheckSquare, ChevronRight, Search, ChevronsDownUp, ChevronsUpDown, Layers } from "lucide-react";
import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  BulkActionBar,
  Modal,
  useToast,
  useConfirm,
  usePageTitle,
  useAskCobbAboutSelection,
  RecordRow,
  useSelectionResolver,
  buildLocationForest,
  type LocationNode as SharedLocationNode,
} from "@cobblr/platform-web";
import { ApiError, api, fetchAuthBlobUrl, type Location } from "../lib/api";
import { totalUsage, useLocationUsage, type UsageCounts } from "../lib/useLocationUsage";
import { queueLabelsBulk } from "../lib/queue-label";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { ImportLocationsDialog } from "../components/ImportLocationsDialog";
import { LocationTreePicker } from "../components/LocationTreePicker";
import {
  filterForest,
  foldAll,
  isOpen,
  subtreeSize,
  toggleFold,
  useFoldOverrides,
  groupRuns,
  isRunOpen,
  toggleRun,
  plural,
  type FoldOverrides,
  type Run,
} from "../lib/tree-fold";
import { bottomUpDisplayOrder, isStackedNoun } from "../lib/stacking";

// The tree model + (position, then natural name) sort live in the shared
// buildLocationForest — the SAME viewer the Labels browser uses, so the two
// surfaces can never disagree on structure or order ("Bin 2" before "Bin 10").
type LocationNode = SharedLocationNode<Location>;

/** Direct children a closed row shows as chips before it says "+N more". */
const CHIP_CAP = 8;

const LOCATION_ACCESSORS = {
  id: (l: Location) => l.id,
  parentId: (l: Location) => l.parent_id ?? null,
  position: (l: Location) => l.position,
  name: (l: Location) => l.name,
  isContainer: (l: Location) => l.kind === "container",
};

export function LocationsPage() {
  usePageTitle("Locations");
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [createOpen, setCreateOpen] = useState(false);
  const [createParentId, setCreateParentId] = useState<string | null>(null);
  const [editTarget, setEditTarget] = useState<Location | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [importOpen, setImportOpen] = useState(false);
  // Fold + filter (lib/tree-fold.ts). Filtering wins: while a query is typed
  // every surviving node is open and fold memory is left alone.
  const [q, setQ] = useState("");
  const [fold, setFold] = useFoldOverrides(activeSlug);
  const filtering = q.trim().length > 0;
  const exportCsv = async () => {
    const url = await fetchAuthBlobUrl(api.exportLocationsPath(activeSlug));
    if (!url) { toast.error("Couldn't export"); return; }
    const a = document.createElement("a");
    a.href = url; a.download = "locations.csv";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const [printing, setPrinting] = useState(false);

  function toggle(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function bulkPrint() {
    if (selected.size === 0) return;
    setPrinting(true);
    const all = list.data?.items ?? [];
    const inputs = Array.from(selected)
      .map((id) => all.find((l) => l.id === id))
      .filter((l): l is NonNullable<typeof l> => !!l)
      .map((loc) => ({
        slug: activeSlug,
        entityKind: "core-locations:location",
        entityId: loc.id,
        description: loc.short_name ?? loc.name,
      }));
    const { ok, fail } = await queueLabelsBulk(inputs);
    setPrinting(false);
    if (fail === 0) {
      toast.success(
        `Queued ${ok} label${ok === 1 ? "" : "s"} — open Labels → Queue to print.`,
      );
    } else {
      toast.error(`Queued ${ok}; ${fail} failed.`);
    }
    setSelected(new Set());
  }

  async function bulkDelete() {
    const count = selected.size;
    if (count === 0) return;
    const all = list.data?.items ?? [];
    const byId = new Map(all.map((l) => [l.id, l] as const));
    // Delete only the top-most selected nodes — delete cascades to children,
    // so we don't fire redundant (already-gone) deletes for selected descendants.
    const tops = Array.from(selected).filter((id) => {
      let p = byId.get(id)?.parent_id ?? null;
      while (p) {
        if (selected.has(p)) return false;
        p = byId.get(p)?.parent_id ?? null;
      }
      return true;
    });
    const ok = await confirm({
      title: `Delete ${count} location${count === 1 ? "" : "s"}?`,
      message: `The selected location${count === 1 ? "" : "s"} (and any child locations under them) will be removed. Items pointing at them become location-less. This can't be undone.`,
      confirmLabel: `Delete ${count}`,
      destructive: true,
    });
    if (!ok) return;
    let failed = 0;
    for (const id of tops) {
      try {
        await api.deleteLocation(activeSlug, id);
      } catch {
        failed++;
      }
    }
    setSelected(new Set());
    void qc.invalidateQueries({ queryKey: ["core-locations", activeSlug] });
    if (failed === 0) toast.success(`Deleted ${count} location${count === 1 ? "" : "s"}.`);
    else toast.error(`Deleted some; ${failed} failed — refresh and retry.`);
  }

  const list = useQuery({
    queryKey: ["core-locations", activeSlug],
    queryFn: () => api.listLocations(activeSlug),
    enabled: !!activeSlug,
  });

  // Per-location usage counts — extracted to useLocationUsage (shared with
  // the floor plan's heat view); query keys unchanged so caches dedupe.
  const usageByLocation = useLocationUsage(activeSlug);

  const items = useMemo(() => list.data?.items ?? [], [list.data]);

  // Highlighting "Rack 1" should mean the rack, not the words. Exact match, and
  // only when exactly one place answers to that name: a guess that resolves to
  // the wrong record is worse than sending the text.
  const resolveSelection = useCallback(
    (text: string) => {
      const wanted = text.trim().toLowerCase();
      if (!wanted) return null;
      const hits = items.filter((l) => l.name.trim().toLowerCase() === wanted);
      const one = hits.length === 1 ? hits[0] : undefined;
      return one ? { kind: "core-locations:location", id: one.id, label: one.name } : null;
    },
    [items],
  );
  useSelectionResolver(resolveSelection);

  // Ticking is for THIS page's bulk actions. Handing the ticked rows to Cobb is
  // a separate instruction, offered beside them rather than done for you.
  const askCobb = useAskCobbAboutSelection(selected, items, "core-locations:location", "location");
  // Shared model → the areas tree + loose-container roots, sorted.
  const forest = useMemo(() => buildLocationForest(items, LOCATION_ACCESSORS), [items]);
  const shown = useMemo(
    () => ({ areas: filterForest(forest.areas, q), containers: filterForest(forest.containers, q) }),
    [forest, q],
  );
  // A CLOSED node's chip has to count everything it hides, so the subtree
  // totals are computed once here rather than re-walked per card.
  const subtreeUsageById = useMemo(() => {
    const m = new Map<string, number>();
    const walk = (n: LocationNode): number => {
      let t = totalUsage(usageByLocation.get(n.id));
      for (const c of n.children) t += walk(c);
      m.set(n.id, t);
      return t;
    };
    for (const r of forest.areas) walk(r);
    for (const r of forest.containers) walk(r);
    return m;
  }, [forest, usageByLocation]);

  // "Floor Plan" is the default surface (that's the whole discoverability fix),
  // but fall back to "List" when nothing has a layout drawn yet, so a fresh
  // workspace lands on the tree rather than an empty canvas. The user's manual
  // tab choice sticks once made.
  const anyPlanDrawn = useMemo(() => items.some((l) => readBound(l.metadata)), [items]);
  const decidedRef = useRef(false);
  const [tab, setTab] = useState<"plan" | "list">("plan");
  useEffect(() => {
    if (!decidedRef.current && !list.isLoading) {
      decidedRef.current = true;
      if (!anyPlanDrawn) setTab("list");
    }
  }, [list.isLoading, anyPlanDrawn]);
  const chooseTab = (t: "plan" | "list") => {
    decidedRef.current = true;
    setTab(t);
  };

  // For the delete confirm — count the subtree's total external refs.
  const reorder = useMutation({
    mutationFn: (ids: string[]) => api.reorderLocations(activeSlug, ids),
    // Optimistic — reflect the new order instantly (the drag feels immediate),
    // roll back on error, reconcile with the server on settle.
    onMutate: async (ids) => {
      await qc.cancelQueries({ queryKey: ["core-locations", activeSlug] });
      const prev = qc.getQueryData<{ items: Location[] }>(["core-locations", activeSlug]);
      if (prev) {
        const pos = new Map(ids.map((id, i) => [id, i] as const));
        qc.setQueryData(["core-locations", activeSlug], {
          items: prev.items.map((l) => (pos.has(l.id) ? { ...l, position: pos.get(l.id)! } : l)),
        });
      }
      return { prev };
    },
    onError: (err, _ids, ctx) => {
      if (ctx?.prev) qc.setQueryData(["core-locations", activeSlug], ctx.prev);
      toast.error(err instanceof ApiError ? err.message : String(err));
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: ["core-locations", activeSlug] }),
  });

  // Drag-to-reorder (one DndContext for the whole tree; each sibling group is
  // its own SortableContext). A node only reorders WITHIN its sibling group —
  // dropping it onto a node with a different parent is ignored (re-parent by
  // editing the parent). Touch-friendly: a small drag threshold via PointerSensor.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const parentOf = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const l of items) m.set(l.id, l.parent_id ?? null);
    return m;
  }, [items]);
  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const aid = String(active.id);
    const bid = String(over.id);
    const aParent = parentOf.get(aid) ?? null;
    if (aParent !== (parentOf.get(bid) ?? null)) return; // different parent group
    const byId = new Map(items.map((l) => [l.id, l] as const));
    const aKind = byId.get(aid)?.kind;
    // The root level is split into two sections (areas vs unsorted containers),
    // so a root-level drag only reorders within its own kind.
    if (aParent === null && byId.get(bid)?.kind !== aKind) return;
    const group = items
      .filter(
        (l) =>
          (l.parent_id ?? null) === aParent &&
          (aParent !== null || l.kind === aKind),
      )
      .sort(
        (x, y) =>
          x.position - y.position ||
          x.name.localeCompare(y.name, undefined, { numeric: true }),
      )
      .map((l) => l.id);
    const from = group.indexOf(aid);
    const to = group.indexOf(bid);
    if (from < 0 || to < 0) return;
    reorder.mutate(arrayMove(group, from, to));
  }

  // Top level splits into the area/room TREE and a bottom bucket of "unsorted"
  // containers (loose bins not placed in any area) — keeps unsorted storage
  // in its own section. The big onDelete handler is shared by
  // both sections via this helper rather than duplicated.
  const rootAreas = shown.areas;
  const looseContainers = shown.containers;
  const foldProps = {
    depth: 0,
    fold,
    filtering,
    subtreeUsageById,
    onToggleFold: (node: LocationNode, depth: number) => setFold(toggleFold(fold, node, depth)),
    onToggleRun: (runId: string) => setFold(toggleRun(fold, runId)),
  };
  const cardHandlers = {
    usageByLocation,
    selected,
    onToggleSelect: toggle,
    onAddChild: (parentId: string) => {
      // You are about to put something in here; make sure you will see it.
      if (fold[parentId] !== true) setFold({ ...fold, [parentId]: true });
      setCreateParentId(parentId);
      setCreateOpen(true);
    },
    onEdit: (loc: Location) => setEditTarget(loc),
  };
  const renderCard = (n: LocationNode) => (
    <LocationCard key={n.id} node={n} {...foldProps} {...cardHandlers} />
  );

  return (
    <div className="space-y-4">
      {/* ONE row on every width. It used to wrap, which kept the page from
          scrolling sideways but spent three of a phone's rows on chrome before
          the first location. The secondary actions keep their icon and drop
          their LABEL below `sm` instead (they are recognisable, and rarely the
          reason you opened this page), and "+ New location" has moved down to
          share the search row. */}
      <div className="flex items-center gap-x-2 sm:gap-x-3 border-b border-line dark:border-slate-700 pb-3">
        <h1 className="text-2xl font-semibold text-content dark:text-mortar-100 shrink-0">
          Locations
        </h1>
        <span className="hidden sm:inline text-sm text-muted dark:text-slate-400 shrink-0">
          {items.length} {items.length === 1 ? "place" : "places"}
        </span>
        {/* Floor Plan / List as a segmented control in the title row. They are
            two views of one page, not two pages, and a tab strip of their own
            cost a full line of the screen for two words. */}
        <div
          role="tablist"
          aria-label="View"
          className="inline-flex shrink-0 self-center rounded-md border border-line dark:border-slate-600 p-0.5 text-xs"
        >
          {(["plan", "list"] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => chooseTab(t)}
              className={
                "px-2 py-0.5 rounded transition " +
                (tab === t
                  ? "bg-cobble-600 text-white"
                  : "text-muted hover:text-content dark:hover:text-mortar-100")
              }
            >
              {t === "plan" ? "Floor Plan" : "List"}
            </button>
          ))}
        </div>
        <div className="flex-1 min-w-0" />
        <button
          onClick={exportCsv}
          title="Download all locations as a CSV"
          className="inline-flex shrink-0 items-center gap-1.5 rounded border border-line dark:border-slate-600 text-content dark:text-mortar-200 hover:bg-subtle dark:hover:bg-slate-800 px-2 sm:px-2.5 py-1.5 text-sm transition"
        >
          <Download size={14} /> <span className="hidden sm:inline">Export</span>
        </button>
        <button
          onClick={() => setImportOpen(true)}
          className="inline-flex shrink-0 items-center gap-1.5 rounded border border-line dark:border-slate-600 text-content dark:text-mortar-200 hover:bg-subtle dark:hover:bg-slate-800 px-2 sm:px-2.5 py-1.5 text-sm transition"
        >
          <Upload size={14} /> <span className="hidden sm:inline">Import</span>
        </button>
      </div>
      {importOpen && <ImportLocationsDialog slug={activeSlug} onClose={() => setImportOpen(false)} />}

      {list.isLoading && (
        <div className="text-sm text-muted">Loading…</div>
      )}

      {tab === "plan" && !list.isLoading && (
        <LocationFloorPlanTab
          items={items}
          slug={activeSlug}
          onCreate={() => {
            setCreateParentId(null);
            setCreateOpen(true);
          }}
        />
      )}

      {tab === "list" && (
        <>
      {items.length === 0 && !list.isLoading && (
        /* The create button shares the search row below, which only renders once
           there IS a location. So the empty state needs its own, or a brand-new
           workspace is told to "add a top-level area" with no button to do it. */
        <div className="flex flex-col items-start gap-3">
          <p className="text-sm italic text-muted dark:text-slate-400">
            No locations yet. Add a top-level area (a room, a workshop, a garage)
            and start nesting bins and shelves inside it.
          </p>
          <button
            onClick={() => {
              setCreateParentId(null);
              setCreateOpen(true);
            }}
            className="inline-flex items-center gap-1.5 rounded bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1.5 text-sm transition"
          >
            <Plus size={14} />
            New location
          </button>
        </div>
      )}

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        {items.length > 0 && (
          /* Search and "+ New location" share a row: the two things you came
             here to do, side by side, instead of a button row above a search
             row. No wrap - the button is shrink-0 and the field takes the
             rest. */
          <div className="flex items-center gap-2 sm:gap-4">
            <label className="relative flex-1 min-w-0 sm:max-w-md">
              <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-faint pointer-events-none" />
              <input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Find a place - Bin 87, shelf, garage…"
                aria-label="Filter locations"
                className="w-full pl-7 pr-2 py-1.5 text-sm rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900"
              />
            </label>
            <button
              onClick={() => {
                setCreateParentId(null);
                setCreateOpen(true);
              }}
              className="shrink-0 inline-flex items-center gap-1.5 rounded bg-cobble-600 hover:bg-cobble-700 text-white px-2.5 sm:px-3 py-1.5 text-sm transition"
            >
              <Plus size={14} />
              New<span className="hidden sm:inline">&nbsp;location</span>
            </button>
            <span className="hidden lg:inline text-xs text-muted dark:text-slate-400 truncate min-w-0">
              {filtering
                ? "Showing matches and the path to them. Drag is off while filtering."
                : "Rooms, shelves, bins. Anything tangible in the workspace can point at a place here."}
            </span>
          </div>
        )}
        {filtering && rootAreas.length === 0 && looseContainers.length === 0 && (
          <div className="text-sm italic text-muted dark:text-slate-400">No place matches "{q.trim()}".</div>
        )}
        {rootAreas.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mb-1">
            {/* At the START of the list's own heading line, above the column of
                row checkboxes it mirrors. It used to sit up in the page chrome
                beside Export and Import, which grouped it with "things you do
                to the file" rather than "things you do to these rows". */}
            <button
              onClick={() =>
                setSelected(
                  selected.size === items.length
                    ? new Set()
                    : new Set(items.map((l) => l.id)),
                )
              }
              title="Select every location (e.g. to bulk-delete)"
              className="inline-flex shrink-0 items-center gap-1 rounded text-muted hover:text-content dark:hover:text-mortar-100 hover:bg-subtle dark:hover:bg-slate-800 px-1.5 py-0.5 text-xs transition"
            >
              <CheckSquare size={13} />
              {selected.size === items.length ? "Deselect all" : "Select all"}
            </button>
            <h2 className="text-xs font-mono uppercase tracking-widest text-faint dark:text-slate-500">
              Areas
            </h2>
            <span className="text-xs text-muted dark:text-slate-400">
              {rootAreas.length}
            </span>
            <span className="hidden sm:inline text-xs text-muted dark:text-slate-400 truncate min-w-0">
               - rooms &amp; regions; containers nest inside. Drag to set your order.
            </span>
            {!filtering && (
              <div className="flex items-center gap-1 ml-auto">
                <button
                  type="button"
                  onClick={() => setFold(foldAll([...forest.areas, ...forest.containers], true))}
                  title="Open every rack and bin"
                  className="inline-flex items-center gap-1 rounded text-muted hover:text-content dark:hover:text-mortar-100 hover:bg-subtle dark:hover:bg-slate-800 px-1.5 py-0.5 text-xs transition"
                >
                  <ChevronsUpDown size={13} /> Expand all
                </button>
                <button
                  type="button"
                  onClick={() => setFold(foldAll([], false))}
                  title="Back to rooms open, everything inside them closed"
                  className="inline-flex items-center gap-1 rounded text-muted hover:text-content dark:hover:text-mortar-100 hover:bg-subtle dark:hover:bg-slate-800 px-1.5 py-0.5 text-xs transition"
                >
                  <ChevronsDownUp size={13} /> Collapse all
                </button>
              </div>
            )}
          </div>
        )}
        <div className="space-y-2">
          <SortableContext items={rootAreas.map((n) => n.id)} strategy={verticalListSortingStrategy}>
            {rootAreas.map(renderCard)}
          </SortableContext>
        </div>

        {looseContainers.length > 0 && (
          <div className="mt-7 pt-4 border-t border-line dark:border-slate-700">
            <div className="flex items-baseline gap-2 mb-1">
              <h2 className="text-xs font-mono uppercase tracking-widest text-faint dark:text-slate-500">
                Unsorted containers
              </h2>
              <span className="text-xs text-muted dark:text-slate-400">
                {looseContainers.length}
              </span>
            </div>
            <p className="text-xs text-muted dark:text-slate-400 mb-2">
              Containers not yet placed in a room or area. Edit one (✎) and set
              its parent to file it into the tree above.
            </p>
            <div className="space-y-2">
              <SortableContext items={looseContainers.map((n) => n.id)} strategy={verticalListSortingStrategy}>
                <SiblingList
                  siblings={looseContainers}
                  parentId={null}
                  {...cardHandlers}
                  {...foldProps}
                />
              </SortableContext>
            </div>
          </div>
        )}
      </DndContext>
        </>
      )}

      {createOpen && (
        <LocationFormModal
          slug={activeSlug}
          parentId={createParentId}
          onClose={() => setCreateOpen(false)}
          onSaved={() => {
            void qc.invalidateQueries({
              queryKey: ["core-locations", activeSlug],
            });
            setCreateOpen(false);
          }}
        />
      )}
      {editTarget && (
        <LocationFormModal
          slug={activeSlug}
          target={editTarget}
          onClose={() => setEditTarget(null)}
          onSaved={() => {
            void qc.invalidateQueries({
              queryKey: ["core-locations", activeSlug],
            });
            setEditTarget(null);
          }}
        />
      )}
      <BulkActionBar
        count={selected.size}
        onClear={() => setSelected(new Set())}
        onAskCobb={askCobb}
        actions={
          <>
            <button
              type="button"
              disabled={printing}
              onClick={() => void bulkPrint()}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded text-accent hover:text-accent disabled:opacity-50"
            >
              <Printer size={12} />
              {printing ? "Queuing…" : "Print labels"}
            </button>
            <button
              type="button"
              onClick={() => void bulkDelete()}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded text-ember-600 dark:text-ember-400 hover:text-ember-500"
            >
              <Trash2 size={12} />
              Delete
            </button>
          </>
        }
      />
    </div>
  );
}

function LocationCard({
  node,
  depth,
  fold,
  filtering,
  subtreeUsageById,
  onToggleFold,
  onToggleRun,
  usageByLocation,
  selected,
  onToggleSelect,
  onAddChild,
  onEdit,
}: {
  node: LocationNode;
  depth: number;
  fold: FoldOverrides;
  filtering: boolean;
  subtreeUsageById: Map<string, number>;
  onToggleFold: (node: LocationNode, depth: number) => void;
  onToggleRun: (runId: string) => void;
  usageByLocation: Map<string, UsageCounts>;
  selected: Set<string>;
  onToggleSelect: (id: string) => void;
  onAddChild: (parentId: string) => void;
  onEdit: (loc: Location) => void;
}) {
  const KindIcon = node.kind === "container" ? BoxIcon : AreaIcon;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: node.id, disabled: filtering });
  const style = { transform: CSS.Transform.toString(transform), transition };
  const usage = usageByLocation.get(node.id);
  const usageTotal = totalUsage(usage);
  const hasChildren = node.children.length > 0;
  // Filtering shows the path to a match, so everything on it is open.
  const open = filtering || isOpen(fold, node, depth);
  const hidden = hasChildren && !open ? subtreeSize(node).nodes : 0;
  const hiddenItems = hasChildren && !open ? (subtreeUsageById.get(node.id) ?? 0) : 0;
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 overflow-hidden ${isDragging ? "opacity-60 shadow-lg ring-1 ring-accent/40" : ""}`}
    >
      <div
        className={
          "px-3 sm:px-4 py-2.5 bg-subtle dark:bg-slate-800/50 border-b border-line dark:border-slate-700 flex items-center gap-1.5 sm:gap-2 " +
          // A room card's right edge IS the page's edge, while everything nested
          // inside it sits one gutter in. Matching that here is what puts the
          // room's own controls on the same column as its contents' — without
          // it the header row would be the one thing sticking out.
          (depth === 0 ? "pr-6 sm:pr-8" : "")
        }
      >
        <button
          type="button"
          {...attributes}
          {...listeners}
          title="Drag to reorder (within its group)"
          aria-label={`Drag ${node.name} to reorder`}
          className="hidden sm:block cursor-grab touch-none text-faint hover:text-muted shrink-0 -ml-1.5 active:cursor-grabbing"
        >
          <GripVertical size={15} />
        </button>
        <input
          type="checkbox"
          checked={selected.has(node.id)}
          onChange={() => onToggleSelect(node.id)}
          className="accent-cobble-600 shrink-0"
          aria-label={`Select ${node.name}`}
          title="Select for bulk actions"
        />
        {/* The fold control. A leaf keeps the slot so names line up, but has
            nothing to open, so it draws nothing clickable. */}
        {hasChildren ? (
          <button
            type="button"
            onClick={() => onToggleFold(node, depth)}
            disabled={filtering}
            aria-expanded={open}
            aria-label={open ? `Collapse ${node.name}` : `Expand ${node.name}`}
            title={filtering ? "Clear the search to fold" : open ? "Collapse" : "Expand"}
            className="shrink-0 -ml-1 p-0.5 rounded text-muted hover:text-content dark:hover:text-mortar-100 hover:bg-subtle dark:hover:bg-slate-800 disabled:opacity-40 transition"
          >
            <ChevronRight size={15} className={"transition-transform " + (open ? "rotate-90" : "")} />
          </button>
        ) : (
          <span className="hidden sm:block w-4 shrink-0" aria-hidden />
        )}
        <KindIcon size={16} className="text-accent shrink-0" />
        {/* The name sizes to itself (min-w-0 so a long one still truncates)
            rather than claiming the free width. What matters next — what is
            inside this place — then reads immediately after it, and the spacer
            below pushes the meta and actions to the right edge. */}
        <div className="min-w-0 shrink">
          <Link
            to={`/locations/${node.id}`}
            className="font-medium text-content dark:text-mortar-100 hover:text-accent truncate block"
          >
            {node.name}
          </Link>
          {node.short_name && node.short_name !== node.name && (
            <div className="text-xs text-muted dark:text-slate-400 font-mono truncate">
              {node.short_name}
            </div>
          )}
        </div>
        {/* What is inside, right after the name: the second most important
            thing on the row, so it reads with the name instead of across a gap
            at the far edge. Each chip opens that place; a chip with contents of
            its own carries a small count. Capped so a bin with forty drawers
            does not become a paragraph; the overflow opens the node. Phones
            keep the count in the trailing cluster, since chips would wrap
            under the name. */}
        {hidden > 0 && (
          <span className="hidden sm:flex flex-wrap items-center gap-1 min-w-0">
            {node.children.slice(0, CHIP_CAP).map((c) => (
              <Link
                key={c.id}
                to={`/locations/${c.id}`}
                title={c.children.length > 0 ? `${c.name} · ${c.children.length} inside` : c.name}
                className="rounded-full border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-2 py-0.5 text-[11px] text-muted hover:text-accent hover:border-cobble-400 dark:text-slate-300 transition whitespace-nowrap"
              >
                {c.short_name ?? c.name}
                {c.children.length > 0 && (
                  <span className="ml-1 text-faint dark:text-slate-500">{c.children.length}</span>
                )}
              </Link>
            ))}
            {node.children.length > CHIP_CAP && (
              <button
                type="button"
                onClick={() => onToggleFold(node, depth)}
                className="rounded-full px-2 py-0.5 text-[11px] text-muted hover:text-accent dark:text-slate-300 transition whitespace-nowrap"
                title="Expand"
              >
                +{node.children.length - CHIP_CAP} more
              </button>
            )}
          </span>
        )}
        <div className="flex-1 min-w-[0.5rem]" />
        {/* Trailing meta + actions. ONE line, never wrapped.
            This used to wrap so a narrow card could not push the page sideways,
            and the cost was that on a phone EVERY row became two: the name, then
            a second line holding the count and four icons. A list where each
            entry is two rows is half a list. The name truncates instead, which
            is the thing that should give — you can read "Rack 1" from six
            characters, and the row is still one row. */}
        <RecordRow
          kind="core-locations:location"
          id={node.id}
          label={node.name}
          className="flex items-center gap-1.5 sm:gap-2 shrink-0"
        >
          {/* Closed: what is hidden, as a button that opens it, so a summary is
              never a dead end. Open: the node's own count as before. */}
          {hidden > 0 ? (
            <button
              type="button"
              onClick={() => onToggleFold(node, depth)}
              className="text-[10px] font-mono text-muted hover:text-accent dark:text-slate-400 transition whitespace-nowrap"
              title="Expand"
            >
              <span className="sm:hidden">{hidden} inside{hiddenItems > 0 ? ` · ` : ""}</span>
              {hiddenItems > 0 ? `${hiddenItems} item${hiddenItems === 1 ? "" : "s"}` : ""}
            </button>
          ) : (
            usageTotal > 0 && (
              <span
                className="text-[10px] font-mono text-accent dark:text-cobble-400"
                title={`${usage?.machines ?? 0} machine(s) · ${usage?.assets ?? 0} asset(s) · ${usage?.parts ?? 0} part(s) point here`}
              >
                {usageTotal} item{usageTotal === 1 ? "" : "s"}
              </span>
            )
          )}
          {/* Hidden on a phone: the name is what you are looking for, and the
              KindIcon to its left already distinguishes area from container.
              Keeping the word cost ~9 characters of the name on every row. */}
          <span className="hidden sm:inline text-[10px] uppercase font-mono tracking-widest text-faint dark:text-slate-500">
            {node.kind}
          </span>
          <button
            type="button"
            onClick={() => onAddChild(node.id)}
            title="Add child"
            className="text-faint hover:text-accent transition p-1"
          >
            <Plus size={14} />
          </button>
          <button
            type="button"
            onClick={() => onEdit(node)}
            title="Edit"
            className="text-faint hover:text-accent transition p-1"
          >
            <Pencil size={14} />
          </button>
          {/* No per-row delete. Deleting a location cascades to everything
              under it, so it is the one action here you cannot take back — and
              it was a 14px target beside two harmless ones. Tick the row and
              use Delete in the selection bar, which names what will go and asks
              first. The same reasoning as the Cobb head: the checkbox already
              says which rows you mean. */}
        </RecordRow>
      </div>
      {/* Padding on the LEFT only in the child wrapper below. The indent is
          what shows the nesting; the matching RIGHT padding was never a
          decision, and it moved every row's trailing controls 13px inward per
          level, so four levels put them 39px apart and the eye had no column
          to run down. Left-only keeps the indent and lands every Cobb head,
          pencil and kind label on one vertical line. The cost is a nested
          card's right border meeting its parent's: a faint doubled line and a
          small stair-step of corners, invisible at 1x. */}
      {hasChildren && open && (
        <div
          className={
            "py-2 pl-3 sm:py-3 sm:pl-6 space-y-2 bg-subtle/50 dark:bg-slate-900/40 " +
            // The right gutter is opened ONCE, by the outermost card, and every
            // level below inherits it. Per-level right padding is what made the
            // trailing controls drift 13px inward each time you nested — four
            // levels put them 39px apart. Opening it once means every card from
            // depth 1 down shares a single right edge, so the controls line up,
            // AND there is still visible air between a nested card and the room
            // that holds it. The room's own controls are pulled in by the same
            // amount (see the header above) so they join the column too.
            (depth === 0 ? "pr-3 sm:pr-4" : "pr-0")
          }
        >
          {/* Child AREAS are zones — subdivisions of this space, not things
              inside it — so they render as dashed annotations (ZoneCard), never
              as nested boxes; containers keep the boxed card. Zones first, so
              the space's structure reads before its loose contents. */}
          <SortableContext
            items={[...node.children.filter((c) => c.kind === "area"), ...node.children.filter((c) => c.kind !== "area")].map((c) => c.id)}
            strategy={verticalListSortingStrategy}
          >
            {node.children.filter((c) => c.kind === "area").map((c) => (
              <ZoneCard
                key={c.id}
                node={c}
                depth={depth + 1}
                fold={fold}
                filtering={filtering}
                subtreeUsageById={subtreeUsageById}
                onToggleFold={onToggleFold}
                onToggleRun={onToggleRun}
                usageByLocation={usageByLocation}
                selected={selected}
                onToggleSelect={onToggleSelect}
                onAddChild={onAddChild}
                onEdit={onEdit}
              />
            ))}
            <SiblingList
              siblings={node.children.filter((c) => c.kind !== "area")}
              parentId={node.id}
              depth={depth + 1}
              fold={fold}
              filtering={filtering}
              subtreeUsageById={subtreeUsageById}
              onToggleFold={onToggleFold}
              onToggleRun={onToggleRun}
              usageByLocation={usageByLocation}
              selected={selected}
              onToggleSelect={onToggleSelect}
              onAddChild={onAddChild}
              onEdit={onEdit}
            />
          </SortableContext>
        </div>
      )}
    </div>
  );
}

/** A nested AREA drawn as a zone ANNOTATION, not a surface. Bay 1/2/3 divide
 *  the garage — they aren't rooms inside it — so instead of the nested box
 *  (which claims containment) a zone is a thin DASHED outline with its name
 *  pinned to the border line, and its contents render at full width in the
 *  parent's own flow. The border style carries the kind: dashed = zone,
 *  solid = container. Same data, same reorder/scan/breadcrumb semantics as
 *  before — this is purely a different drawing of `kind === "area"` children. */
function ZoneCard({
  node,
  depth,
  fold,
  filtering,
  subtreeUsageById,
  onToggleFold,
  onToggleRun,
  usageByLocation,
  selected,
  onToggleSelect,
  onAddChild,
  onEdit,
}: {
  node: LocationNode;
  depth: number;
  fold: FoldOverrides;
  filtering: boolean;
  subtreeUsageById: Map<string, number>;
  onToggleFold: (node: LocationNode, depth: number) => void;
  onToggleRun: (runId: string) => void;
  usageByLocation: Map<string, UsageCounts>;
  selected: Set<string>;
  onToggleSelect: (id: string) => void;
  onAddChild: (parentId: string) => void;
  onEdit: (loc: Location) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: node.id, disabled: filtering });
  const style = { transform: CSS.Transform.toString(transform), transition };
  const usage = usageByLocation.get(node.id);
  const usageTotal = totalUsage(usage);
  return (
    // The pt-2 spacer keeps the name chip (which sits ON the border line)
    // from overlapping the previous sibling.
    <div ref={setNodeRef} style={style} className={`pt-2 ${isDragging ? "opacity-60" : ""}`}>
      <div
        className={`relative rounded-xl border border-dashed border-slate-400/70 dark:border-slate-500/60 p-2 pt-4 sm:p-3 sm:pt-4 space-y-2 ${isDragging ? "ring-1 ring-accent/40" : ""}`}
      >
        <div className="absolute -top-3 left-3 inline-flex items-center gap-1.5 rounded-full border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-2 py-0.5">
          <button
            type="button"
            {...attributes}
            {...listeners}
            title="Drag to reorder (within its group)"
            aria-label={`Drag ${node.name} to reorder`}
            className="cursor-grab touch-none text-faint hover:text-muted active:cursor-grabbing"
          >
            <GripVertical size={12} />
          </button>
          <input
            type="checkbox"
            checked={selected.has(node.id)}
            onChange={() => onToggleSelect(node.id)}
            className="accent-cobble-600"
            aria-label={`Select ${node.name}`}
            title="Select for bulk actions"
          />
          <AreaIcon size={12} className="text-accent shrink-0" />
          <Link
            to={`/locations/${node.id}`}
            className="font-mono text-[11px] uppercase tracking-wider font-medium text-content dark:text-mortar-100 hover:text-accent"
          >
            {node.name}
          </Link>
          {usageTotal > 0 && (
            <span
              className="text-[10px] font-mono text-faint"
              title={`${usage?.machines ?? 0} machine(s) · ${usage?.assets ?? 0} asset(s) · ${usage?.parts ?? 0} part(s) point here`}
            >
              · {usageTotal}
            </span>
          )}
        </div>
        <RecordRow
          kind="core-locations:location"
          id={node.id}
          label={node.name}
          className="absolute -top-3 right-3 inline-flex items-center rounded-full border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-1 py-0.5"
        >
          <button
            type="button"
            onClick={() => onAddChild(node.id)}
            title="Add child"
            className="text-faint hover:text-accent transition px-1"
          >
            <Plus size={12} />
          </button>
          <button
            type="button"
            onClick={() => onEdit(node)}
            title="Edit"
            className="text-faint hover:text-accent transition px-1"
          >
            <Pencil size={12} />
          </button>
        </RecordRow>
        {node.children.length === 0 && (
          <div className="text-xs text-faint dark:text-slate-500 italic px-1 py-1">
            empty - scan or file into it
          </div>
        )}
        {node.children.length > 0 && (
          <SortableContext
            items={[...node.children.filter((c) => c.kind === "area"), ...node.children.filter((c) => c.kind !== "area")].map((c) => c.id)}
            strategy={verticalListSortingStrategy}
          >
            {node.children.filter((c) => c.kind === "area").map((c) => (
              <ZoneCard
                key={c.id}
                node={c}
                depth={depth + 1}
                fold={fold}
                filtering={filtering}
                subtreeUsageById={subtreeUsageById}
                onToggleFold={onToggleFold}
                onToggleRun={onToggleRun}
                usageByLocation={usageByLocation}
                selected={selected}
                onToggleSelect={onToggleSelect}
                onAddChild={onAddChild}
                onEdit={onEdit}
              />
            ))}
            <SiblingList
              siblings={node.children.filter((c) => c.kind !== "area")}
              parentId={node.id}
              depth={depth + 1}
              fold={fold}
              filtering={filtering}
              subtreeUsageById={subtreeUsageById}
              onToggleFold={onToggleFold}
              onToggleRun={onToggleRun}
              usageByLocation={usageByLocation}
              selected={selected}
              onToggleSelect={onToggleSelect}
              onAddChild={onAddChild}
              onEdit={onEdit}
            />
          </SortableContext>
        )}
      </div>
    </div>
  );
}

/** One sibling group of containers, drawn with its runs folded. The
 *  SortableContext above still lists every sibling id, run members included,
 *  so drag works across and inside runs unchanged; a run is purely how the rows
 *  are grouped on screen. */
function SiblingList({
  siblings,
  parentId,
  ...card
}: {
  siblings: LocationNode[];
  parentId: string | null;
  depth: number;
  fold: FoldOverrides;
  filtering: boolean;
  subtreeUsageById: Map<string, number>;
  onToggleFold: (node: LocationNode, depth: number) => void;
  onToggleRun: (runId: string) => void;
  usageByLocation: Map<string, UsageCounts>;
  selected: Set<string>;
  onToggleSelect: (id: string) => void;
  onAddChild: (parentId: string) => void;
  onEdit: (loc: Location) => void;
}) {
  // A search shows the matches plainly: a run would hide the very rows you
  // asked for.
  const entries = card.filtering
    ? siblings.map((node) => ({ kind: "node" as const, node }))
    : groupRuns(siblings, parentId);
  return (
    <>
      {entries.map((e) =>
        e.kind === "node" ? (
          <LocationCard key={e.node.id} node={e.node} {...card} />
        ) : (
          <RunCard key={e.run.id} run={e.run} {...card} />
        ),
      )}
    </>
  );
}

/** "Rack 1 – 7 · 7 racks · 35 inside" as one row. Closed by default; opens to
 *  the member cards, which keep their own drag / select / edit / delete. The
 *  checkbox selects or clears every member, so bulk print and bulk delete
 *  still work on a rack you never unfolded. */
function RunCard({
  run,
  ...card
}: {
  run: Run<LocationNode>;
  depth: number;
  fold: FoldOverrides;
  filtering: boolean;
  subtreeUsageById: Map<string, number>;
  onToggleFold: (node: LocationNode, depth: number) => void;
  onToggleRun: (runId: string) => void;
  usageByLocation: Map<string, UsageCounts>;
  selected: Set<string>;
  onToggleSelect: (id: string) => void;
  onAddChild: (parentId: string) => void;
  onEdit: (loc: Location) => void;
}) {
  const open = isRunOpen(card.fold, run.id);
  const count = run.members.length;
  const inside = run.members.reduce((t, m) => t + subtreeSize(m).nodes, 0);
  const items = run.members.reduce((t, m) => t + (card.subtreeUsageById.get(m.id) ?? 0), 0);
  const allSelected = run.members.every((m) => card.selected.has(m.id));
  const someSelected = !allSelected && run.members.some((m) => card.selected.has(m.id));
  const noun = plural(run.prefix.toLowerCase(), count);
  const label = `${run.prefix} ${run.lo} – ${run.hi}`;
  const toggleAll = () => {
    const target = !allSelected;
    for (const m of run.members) if (card.selected.has(m.id) !== target) card.onToggleSelect(m.id);
  };
  return (
    <div className="rounded-xl border border-dashed border-line dark:border-slate-700 overflow-hidden">
      <div className="px-3 sm:px-4 py-2 bg-subtle/70 dark:bg-slate-800/40 flex items-center gap-1.5 sm:gap-2">
        <span className="hidden sm:block w-[15px] shrink-0 -ml-1.5" aria-hidden />
        <input
          type="checkbox"
          checked={allSelected}
          ref={(el) => {
            if (el) el.indeterminate = someSelected;
          }}
          onChange={toggleAll}
          className="accent-cobble-600 shrink-0"
          aria-label={`Select all ${count} ${noun}`}
          title={`Select all ${count} ${noun}`}
        />
        <button
          type="button"
          onClick={() => card.onToggleRun(run.id)}
          aria-expanded={open}
          aria-label={open ? `Collapse ${label}` : `Expand ${label}`}
          className="shrink-0 -ml-1 p-0.5 rounded text-muted hover:text-content dark:hover:text-mortar-100 hover:bg-subtle dark:hover:bg-slate-800 transition"
        >
          <ChevronRight size={15} className={"transition-transform " + (open ? "rotate-90" : "")} />
        </button>
        <Layers size={16} className="text-accent shrink-0" />
        <button
          type="button"
          onClick={() => card.onToggleRun(run.id)}
          className="font-medium text-content dark:text-mortar-100 hover:text-accent truncate text-left"
        >
          {label}
        </button>
        <div className="flex items-center gap-1.5 sm:gap-2 shrink-0 ml-auto">
          <button
            type="button"
            onClick={() => card.onToggleRun(run.id)}
            className="text-[10px] font-mono text-muted hover:text-accent dark:text-slate-400 transition"
            title={open ? "Collapse" : "Expand"}
          >
            {count} {noun}
            {inside > 0 ? ` · ${inside} inside` : ""}
            {items > 0 ? ` · ${items} item${items === 1 ? "" : "s"}` : ""}
          </button>
        </div>
      </div>
      {open && (
        <div className="py-2 pl-2 pr-0 space-y-2 bg-subtle/30 dark:bg-slate-900/30">
          {run.members.map((m) => (
            <LocationCard key={m.id} node={m} {...card} />
          ))}
        </div>
      )}
    </div>
  );
}

function LocationFormModal({
  slug,
  parentId: parentIdInitial,
  target,
  onClose,
  onSaved,
}: {
  slug: string;
  parentId?: string | null;
  target?: Location;
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = !!target;
  const [name, setName] = useState(target?.name ?? "");
  const [shortName, setShortName] = useState(target?.short_name ?? "");
  const [kind, setKind] = useState<"area" | "container">(target?.kind ?? "area");
  // On create, we auto-guess the kind from keywords in the name (e.g.
  // "White Bookshelf" → container) until the user picks one by hand. Once
  // they touch the select we stop overriding their choice.
  const [kindTouched, setKindTouched] = useState(editing);
  const kindGuess = !editing && !kindTouched ? inferKind(name) : null;
  const [parentId, setParentId] = useState<string | "">(
    target?.parent_id ?? parentIdInitial ?? "",
  );
  const toast = useToast();

  // Range expansion: "Drawer 1-3" → ["Drawer 1", "Drawer 2", "Drawer 3"].
  // Only active on create — on edit we never want a rename to silently
  // spawn siblings. Caps at 50 so a typo'd "Drawer 1-9999" doesn't
  // melt the server.
  const expansion = !editing ? parseRange(name) : null;
  // Shelves get the house convention offered, pre-chosen but never imposed
  // (see lib/stacking.ts). Anything else creates in the order you typed.
  const stacked = !!expansion && expansion.names.length > 1 && isStackedNoun(expansion.prefix);
  const [bottomUp, setBottomUp] = useState(true);


  return (
    <Modal open onClose={onClose} title={editing ? "Edit location" : "New location"}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim()) return;
          try {
            if (editing && target) {
              await api.updateLocation(slug, target.id, {
                name: name.trim(),
                short_name: shortName.trim() || null,
                kind,
                parent_id: parentId || null,
              });
              toast.success("Location updated");
            } else if (expansion && expansion.names.length > 1) {
              // Bulk-create N siblings from a "Foo 1-3" range. Sequential
              // (not Promise.all) so the server's auto-numbering / activity
              // log stays clean and a single failure stops the rest.
              // Short_name is intentionally dropped for bulk — it's
              // per-location and wouldn't make sense duplicated.
              const created: string[] = [];
              for (const n of expansion.names) {
                const loc = await api.createLocation(slug, {
                  name: n,
                  kind,
                  parent_id: parentId || null,
                });
                created.push(loc.id);
              }
              // Bottom-up numbering means the list must read the OTHER way, so
              // the group on screen looks like the rack in the room. /reorder is
              // the same door a drag uses, so this is an opening position, not a
              // special case the sort has to know about.
              if (stacked && bottomUp && created.length > 1) {
                await api.reorderLocations(slug, bottomUpDisplayOrder(created));
              }
              toast.success(
                `Created ${created.length} locations: ${expansion.names.join(", ")}` +
                  (stacked && bottomUp ? ` (${expansion.names[0]} at the bottom)` : ""),
              );
            } else {
              await api.createLocation(slug, {
                name: name.trim(),
                short_name: shortName.trim() || null,
                kind,
                parent_id: parentId || null,
              });
              toast.success("Location created");
            }
            onSaved();
          } catch (err) {
            toast.error(err instanceof ApiError ? err.message : String(err));
          }
        }}
        className="space-y-3"
      >
        <label className="block">
          <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
            Name
          </span>
          <input
            type="text"
            value={name}
            onChange={(e) => {
              const next = e.target.value;
              setName(next);
              if (!editing && !kindTouched) {
                const guess = inferKind(next);
                if (guess) setKind(guess);
              }
            }}
            placeholder="e.g. Garage / Shelf 3 / Bin 17 - or Drawer 1-3 to bulk-create"
            className="w-full px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
            autoFocus
          />
          {expansion && expansion.names.length > 1 && (
            <div className="text-[11px] text-accent dark:text-cobble-300 mt-1">
              → will create {expansion.names.length} locations: {expansion.preview}
            </div>
          )}
          {stacked && expansion && (
            <div className="mt-1.5 rounded-md border border-line dark:border-slate-700 bg-subtle/50 dark:bg-slate-800/40 px-2.5 py-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mr-1">
                  Count from
                </span>
                {([
                  { up: true, label: "the bottom", hint: "suggested" },
                  { up: false, label: "the top", hint: "" },
                ] as const).map((opt) => {
                  const on = bottomUp === opt.up;
                  return (
                    <button
                      key={opt.label}
                      type="button"
                      onClick={() => setBottomUp(opt.up)}
                      aria-pressed={on}
                      className={
                        "rounded-full border px-2.5 py-0.5 text-[11px] transition " +
                        (on
                          ? "border-cobble-500 bg-cobble-50 dark:bg-cobble-900/30 text-content dark:text-mortar-100 ring-1 ring-cobble-400"
                          : "border-line dark:border-slate-600 text-muted dark:text-slate-400 hover:bg-surface dark:hover:bg-slate-900")
                      }
                    >
                      {opt.label}
                      {opt.hint && <span className="ml-1 text-faint">· {opt.hint}</span>}
                    </button>
                  );
                })}
              </div>
              <div className="mt-1.5 text-[10px] text-muted dark:text-slate-400 leading-snug">
                {bottomUp ? (
                  <>
                    <span className="font-medium text-content dark:text-mortar-200">
                      {expansion.names[0]}
                    </span>{" "}
                    is the bottom one and{" "}
                    <span className="font-medium text-content dark:text-mortar-200">
                      {expansion.names[expansion.names.length - 1]}
                    </span>{" "}
                    is the top. Counting from the floor means number 1 is at the same height on
                    every rack, and adding one at the top renames nothing.
                  </>
                ) : (
                  <>
                    <span className="font-medium text-content dark:text-mortar-200">
                      {expansion.names[0]}
                    </span>{" "}
                    is the top one. Fine if that is how the rack is already labelled - just note
                    that adding a shelf above it later leaves the numbers out of order.
                  </>
                )}
              </div>
            </div>
          )}
          {!editing && !expansion && (
            <div className="text-[10px] text-faint dark:text-slate-500 mt-1">
              Tip: type a range like <code className="font-mono">Drawer 1-3</code> to create
              three siblings at once.
            </div>
          )}
        </label>
        <label className="block">
          <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
            Short name (optional)
          </span>
          <input
            type="text"
            value={shortName}
            onChange={(e) => setShortName(e.target.value)}
            placeholder="Bin 17"
            className="w-full px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
          />
          <div className="text-[10px] text-muted mt-1">
            Shown on labels when the canonical name is too long.
          </div>
        </label>
        <div className="block">
          <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
            Kind
          </span>
          {/* Two buttons, not a dropdown (the author): the choice is binary and each
              option needs a line of explanation that a <select> hides until you
              open it. The name-based auto-guess just pre-selects one of them;
              tapping either is a manual choice that sticks (kindTouched). */}
          <div className="grid grid-cols-2 gap-2">
            {([
              { k: "area", title: "area", desc: "a region: room, corner, workshop" },
              { k: "container", title: "container", desc: "things go INTO it: bin, drawer, shelf" },
            ] as const).map((opt) => {
              const selected = kind === opt.k;
              return (
                <button
                  key={opt.k}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => {
                    setKindTouched(true);
                    setKind(opt.k);
                  }}
                  className={
                    "text-left rounded border px-2.5 py-2 transition " +
                    (selected
                      ? "border-accent bg-accent/10 dark:bg-accent/15 ring-1 ring-accent/40"
                      : "border-line dark:border-slate-600 bg-surface dark:bg-slate-900 hover:border-accent/60")
                  }
                >
                  <div className="text-sm font-medium text-content dark:text-mortar-100">{opt.title}</div>
                  <div className="text-[11px] text-muted dark:text-slate-400 mt-0.5 leading-snug">{opt.desc}</div>
                </button>
              );
            })}
          </div>
          {kindGuess && (
            <div className="text-[10px] text-faint dark:text-slate-500 mt-1.5">
              Auto-selected <span className="font-mono">{kindGuess}</span> from the name - tap the other if that's wrong.
            </div>
          )}
        </div>
        {/* The same picker every other surface uses. It excludes the node and
            its descendants itself, so this form no longer carries its own copy
            of that closure sitting next to its own dropdown. */}
        <LocationTreePicker
          label="Parent (optional - leave blank for top-level)"
          value={parentId || null}
          onChange={(id) => setParentId(id ?? "")}
          excludeSubtreeOf={target?.id}
          placeholder="(top-level)"
        />
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
            disabled={!name.trim()}
            className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white"
          >
            {editing ? "Save" : "Create"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// Guess a location's kind from keywords in its name, so a fresh "New
// location" form pre-selects the right kind (the user can still override).
// Storage nouns win over region nouns when both appear ("Garage Shelf" is a
// shelf → container), so containers are checked first. Substring match keeps
// it simple and catches compounds like "Bookshelf" (via "shelf"). Returns
// null when nothing matches — the form keeps its default.
const CONTAINER_WORDS = [
  "shelf", "bin", "drawer", "box", "tote", "crate", "tub", "tray", "basket",
  "cabinet", "cubby", "case", "bag", "pouch", "rack", "jar", "bookcase",
  "container", "cart", "caddy", "envelope", "folder", "pocket", "slot",
];
const AREA_WORDS = [
  "room", "corner", "workshop", "area", "zone", "garage", "closet", "office",
  "kitchen", "bedroom", "bathroom", "basement", "attic", "shed", "studio",
  "lab", "hallway", "pantry", "loft", "wall", "floor", "desk", "table", "bench",
];

function inferKind(raw: string): "area" | "container" | null {
  const s = raw.toLowerCase();
  if (CONTAINER_WORDS.some((w) => s.includes(w))) return "container";
  if (AREA_WORDS.some((w) => s.includes(w))) return "area";
  return null;
}

// Parses a name like "Drawer 1-3" → { names: ["Drawer 1","Drawer 2",
// "Drawer 3"], preview: "…" }. Returns null when the input isn't a
// numeric range, when start > end, or when the range exceeds the
// 50-row safety cap. Accepts hyphen and en-dash; tolerates extra
// whitespace.
const RANGE_RE = /^(.*?)\s*(\d+)\s*[-–]\s*(\d+)\s*$/;
const MAX_RANGE = 50;

function parseRange(raw: string): { names: string[]; prefix: string; preview: string } | null {
  const m = raw.match(RANGE_RE);
  if (!m) return null;
  const prefix = (m[1] ?? "").trim();
  const start = Number(m[2]);
  const end = Number(m[3]);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end) return null;
  const count = end - start + 1;
  if (count < 2 || count > MAX_RANGE) return null;
  const names: string[] = [];
  for (let n = start; n <= end; n++) {
    names.push(prefix ? `${prefix} ${n}` : String(n));
  }
  const preview =
    names.length <= 4
      ? names.join(", ")
      : `${names[0]}, ${names[1]}, …, ${names[names.length - 1]}`;
  return { names, prefix, preview };
}
