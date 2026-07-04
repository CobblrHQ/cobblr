// /configuration/locations — the workspace-wide tree of physical
// places. core-locations is foundational, so this page always exists
// when an org is loaded. The tree below is rendered as boxed nested
// list cards: each location's own card, with indented child cards
// inside.

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Plus,
  Printer,
  Trash2,
  Pencil,
  Box as BoxIcon,
  MapPin as AreaIcon,
  Upload,
  Download,
  GripVertical,
  CheckSquare,
} from "lucide-react";
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
  buildLocationForest,
  type LocationNode as SharedLocationNode,
} from "@cobblr/platform-web";
import { ApiError, api, fetchAuthBlobUrl, type Location } from "../lib/api";
import { queueLabelsBulk } from "../lib/queue-label";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { ImportLocationsDialog } from "../components/ImportLocationsDialog";

// The tree model + (position, then natural name) sort live in the shared
// buildLocationForest — the SAME viewer the Labels browser uses, so the two
// surfaces can never disagree on structure or order ("Bin 2" before "Bin 10").
type LocationNode = SharedLocationNode<Location>;

const LOCATION_ACCESSORS = {
  id: (l: Location) => l.id,
  parentId: (l: Location) => l.parent_id ?? null,
  position: (l: Location) => l.position,
  name: (l: Location) => l.name,
  isContainer: (l: Location) => l.kind === "container",
};

interface UsageCounts {
  machines: number;
  assets: number;
  parts: number;
}

function emptyCounts(): UsageCounts {
  return { machines: 0, assets: 0, parts: 0 };
}

function totalUsage(c: UsageCounts | undefined): number {
  if (!c) return 0;
  return c.machines + c.assets + c.parts;
}

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

  // Per-location usage counts. The web shell asks each module's
  // list endpoint for entities that point at any location and groups
  // by `location_id` client-side. Three independent queries so each
  // can fail / load independently.
  const machinesQ = useQuery({
    queryKey: ["machines-for-locations", activeSlug],
    queryFn: () => api.listMachines(activeSlug),
    enabled: !!activeSlug,
  });
  const assetsQ = useQuery({
    queryKey: ["assets-for-locations", activeSlug],
    queryFn: () => api.listAssets(activeSlug),
    enabled: !!activeSlug,
  });
  const partsQ = useQuery({
    queryKey: ["parts-for-locations", activeSlug],
    queryFn: () => api.listInventoryParts(activeSlug),
    enabled: !!activeSlug,
  });

  const items = useMemo(() => list.data?.items ?? [], [list.data]);
  // Shared model → the areas tree + loose-container roots, sorted.
  const forest = useMemo(() => buildLocationForest(items, LOCATION_ACCESSORS), [items]);

  const usageByLocation = useMemo(() => {
    const m = new Map<string, UsageCounts>();
    const bump = (locId: string | null, key: keyof UsageCounts) => {
      if (!locId) return;
      const c = m.get(locId) ?? emptyCounts();
      c[key]++;
      m.set(locId, c);
    };
    for (const x of machinesQ.data?.items ?? []) bump(x.location_id, "machines");
    for (const x of assetsQ.data?.items ?? []) bump(x.location_id, "assets");
    for (const x of partsQ.data?.items ?? []) bump(x.location_id, "parts");
    return m;
  }, [machinesQ.data, assetsQ.data, partsQ.data]);

  // For the delete confirm — count the subtree's total external refs.
  function subtreeUsage(node: LocationNode): UsageCounts {
    const acc = emptyCounts();
    const walk = (n: LocationNode) => {
      const c = usageByLocation.get(n.id);
      if (c) {
        acc.machines += c.machines;
        acc.assets += c.assets;
        acc.parts += c.parts;
      }
      for (const child of n.children) walk(child);
    };
    walk(node);
    return acc;
  }

  const del = useMutation({
    mutationFn: (id: string) => api.deleteLocation(activeSlug, id),
    onSuccess: () => {
      toast.success("Location deleted");
      void qc.invalidateQueries({ queryKey: ["core-locations", activeSlug] });
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : String(err));
    },
  });

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
  // containers (loose bins not placed in any area) — mirrors how companion app kept
  // unsorted storage in its own section. The big onDelete handler is shared by
  // both sections via this helper rather than duplicated.
  const rootAreas = forest.areas;
  const looseContainers = forest.containers;
  const renderCard = (n: LocationNode) => (
    <LocationCard
      key={n.id}
      node={n}
      usageByLocation={usageByLocation}
      selected={selected}
      onToggleSelect={toggle}
      onAddChild={(parentId) => {
        setCreateParentId(parentId);
        setCreateOpen(true);
      }}
      onEdit={(loc) => setEditTarget(loc)}
      onDelete={async (loc) => {
        const subtree = subtreeUsage(loc);
        const subtreeTotal = subtree.machines + subtree.assets + subtree.parts;
        const childPart =
          loc.children.length > 0
            ? ` and its ${loc.children.length} child location(s)`
            : "";
        const usagePart =
          subtreeTotal > 0
            ? ` ${subtreeTotal} item(s) currently point at ${
                loc.children.length > 0 ? "this subtree" : "this location"
              } (${subtree.machines} machine(s), ${subtree.assets} asset(s), ${subtree.parts} part(s)) and will end up location-less.`
            : "";
        const ok = await confirm({
          title: "Delete location?",
          message: `${loc.name}${childPart} will be removed (cascade).${usagePart}`,
          confirmLabel: "Delete",
          destructive: true,
        });
        if (ok) del.mutate(loc.id);
      }}
    />
  );

  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-3 border-b border-line dark:border-slate-700 pb-3">
        <h1 className="text-2xl font-semibold text-content dark:text-mortar-100">
          Locations
        </h1>
        <span className="text-sm text-muted dark:text-slate-400">
          {items.length} {items.length === 1 ? "place" : "places"}
        </span>
        <div className="flex-1" />
        {items.length > 0 && (
          <button
            onClick={() =>
              setSelected(
                selected.size === items.length
                  ? new Set()
                  : new Set(items.map((l) => l.id)),
              )
            }
            title="Select every location (e.g. to bulk-delete)"
            className="inline-flex items-center gap-1.5 rounded border border-line dark:border-slate-600 text-content dark:text-mortar-200 hover:bg-subtle dark:hover:bg-slate-800 px-2.5 py-1.5 text-sm transition"
          >
            <CheckSquare size={14} />
            {selected.size === items.length ? "Deselect all" : "Select all"}
          </button>
        )}
        <button
          onClick={exportCsv}
          title="Download all locations as a CSV"
          className="inline-flex items-center gap-1.5 rounded border border-line dark:border-slate-600 text-content dark:text-mortar-200 hover:bg-subtle dark:hover:bg-slate-800 px-2.5 py-1.5 text-sm transition"
        >
          <Download size={14} /> Export
        </button>
        <button
          onClick={() => setImportOpen(true)}
          className="inline-flex items-center gap-1.5 rounded border border-line dark:border-slate-600 text-content dark:text-mortar-200 hover:bg-subtle dark:hover:bg-slate-800 px-2.5 py-1.5 text-sm transition"
        >
          <Upload size={14} /> Import
        </button>
        <button
          onClick={() => {
            setCreateParentId(null);
            setCreateOpen(true);
          }}
          className="inline-flex items-center gap-2 rounded bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1.5 text-sm transition"
        >
          <Plus size={14} /> New location
        </button>
      </div>
      {importOpen && <ImportLocationsDialog slug={activeSlug} onClose={() => setImportOpen(false)} />}

      <p className="text-sm text-content dark:text-mortar-200">
        Hierarchical tree of physical places — rooms, shelves, bins. Anything
        tangible in the workspace (machines, assets, parts) can point at a row
        here via its <code>location_id</code> field.
      </p>

      {list.isLoading && (
        <div className="text-sm text-muted">Loading…</div>
      )}
      {items.length === 0 && !list.isLoading && (
        <div className="text-sm italic text-muted dark:text-slate-400">
          No locations yet. Add a top-level area (a room, a workshop, a garage)
          and start nesting bins and shelves inside it.
        </div>
      )}

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        {rootAreas.length > 0 && (
          <div className="flex items-baseline gap-2 mb-1">
            <h2 className="text-xs font-mono uppercase tracking-widest text-faint dark:text-slate-500">
              Areas
            </h2>
            <span className="text-xs text-muted dark:text-slate-400">
              {rootAreas.length}
            </span>
            <span className="text-xs text-muted dark:text-slate-400">
              — rooms &amp; regions; containers nest inside. Drag to set your order.
            </span>
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
                {looseContainers.map(renderCard)}
              </SortableContext>
            </div>
          </div>
        )}
      </DndContext>

      {createOpen && (
        <LocationFormModal
          slug={activeSlug}
          parentId={createParentId}
          parents={items}
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
          parents={items}
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
              className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded text-ember-600 hover:text-ember-500"
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
  usageByLocation,
  selected,
  onToggleSelect,
  onAddChild,
  onEdit,
  onDelete,
}: {
  node: LocationNode;
  usageByLocation: Map<string, UsageCounts>;
  selected: Set<string>;
  onToggleSelect: (id: string) => void;
  onAddChild: (parentId: string) => void;
  onEdit: (loc: Location) => void;
  onDelete: (loc: LocationNode) => void;
}) {
  const KindIcon = node.kind === "container" ? BoxIcon : AreaIcon;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: node.id });
  const style = { transform: CSS.Transform.toString(transform), transition };
  const usage = usageByLocation.get(node.id);
  const usageTotal = totalUsage(usage);
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 overflow-hidden ${isDragging ? "opacity-60 shadow-lg ring-1 ring-accent/40" : ""}`}
    >
      <div className="px-4 py-2.5 bg-subtle dark:bg-slate-800/50 border-b border-line dark:border-slate-700 flex items-center gap-2">
        <button
          type="button"
          {...attributes}
          {...listeners}
          title="Drag to reorder (within its group)"
          aria-label={`Drag ${node.name} to reorder`}
          className="cursor-grab touch-none text-faint hover:text-muted shrink-0 -ml-1.5 active:cursor-grabbing"
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
        <KindIcon size={16} className="text-accent shrink-0" />
        <div className="flex-1 min-w-0">
          <Link
            to={`/configuration/locations/${node.id}`}
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
        {usageTotal > 0 && (
          <span
            className="text-[10px] font-mono text-accent dark:text-cobble-400"
            title={`${usage?.machines ?? 0} machine(s) · ${usage?.assets ?? 0} asset(s) · ${usage?.parts ?? 0} part(s) point here`}
          >
            {usageTotal} item{usageTotal === 1 ? "" : "s"}
          </span>
        )}
        <span className="text-[10px] uppercase font-mono tracking-widest text-faint dark:text-slate-500">
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
        <button
          type="button"
          onClick={() => onDelete(node)}
          title="Delete"
          className="text-faint hover:text-ember-500 transition p-1"
        >
          <Trash2 size={14} />
        </button>
      </div>
      {node.children.length > 0 && (
        <div className="p-3 pl-6 space-y-2 bg-subtle/50 dark:bg-slate-900/40">
          <SortableContext items={node.children.map((c) => c.id)} strategy={verticalListSortingStrategy}>
            {node.children.map((c) => (
              <LocationCard
                key={c.id}
                node={c}
                usageByLocation={usageByLocation}
                selected={selected}
                onToggleSelect={onToggleSelect}
                onAddChild={onAddChild}
                onEdit={onEdit}
                onDelete={onDelete}
              />
            ))}
          </SortableContext>
        </div>
      )}
    </div>
  );
}

function LocationFormModal({
  slug,
  parents,
  parentId: parentIdInitial,
  target,
  onClose,
  onSaved,
}: {
  slug: string;
  parents: Location[];
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

  // Editing: exclude self + descendants from the parent picker (no
  // cycles). For create, all rows are valid parents.
  const selectableParents = useMemo(() => {
    if (!target) return parents;
    const banned = new Set<string>([target.id]);
    let added = true;
    while (added) {
      added = false;
      for (const p of parents) {
        if (p.parent_id && banned.has(p.parent_id) && !banned.has(p.id)) {
          banned.add(p.id);
          added = true;
        }
      }
    }
    return parents.filter((p) => !banned.has(p.id));
  }, [parents, target]);

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
              let made = 0;
              for (const n of expansion.names) {
                await api.createLocation(slug, {
                  name: n,
                  kind,
                  parent_id: parentId || null,
                });
                made++;
              }
              toast.success(`Created ${made} locations: ${expansion.names.join(", ")}`);
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
            placeholder="e.g. Garage / Shelf 3 / Bin 17 — or Drawer 1-3 to bulk-create"
            className="w-full px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
            autoFocus
          />
          {expansion && expansion.names.length > 1 && (
            <div className="text-[11px] text-accent dark:text-cobble-300 mt-1">
              → will create {expansion.names.length} locations: {expansion.preview}
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
              { k: "area", title: "area", desc: "a region — room, corner, workshop" },
              { k: "container", title: "container", desc: "things go INTO it — bin, drawer, shelf" },
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
              Auto-selected <span className="font-mono">{kindGuess}</span> from the name — tap the other if that's wrong.
            </div>
          )}
        </div>
        <label className="block">
          <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
            Parent (optional — leave blank for top-level)
          </span>
          <select
            value={parentId}
            onChange={(e) => setParentId(e.target.value)}
            className="w-full px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
          >
            <option value="">(top-level)</option>
            {selectableParents.map((p) => (
              <option key={p.id} value={p.id}>
                {"  ".repeat(p.depth)}
                {p.name}
              </option>
            ))}
          </select>
        </label>
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

function parseRange(raw: string): { names: string[]; preview: string } | null {
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
  return { names, preview };
}
