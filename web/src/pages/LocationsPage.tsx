// /configuration/locations — the workspace-wide tree of physical
// places. core-locations is foundational, so this page always exists
// when an org is loaded. The tree below is rendered as boxed nested
// list cards: each location's own card, with indented child cards
// inside.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Plus,
  Trash2,
  Pencil,
  Box as BoxIcon,
  Square as AreaIcon,
} from "lucide-react";
import { Modal, useToast, useConfirm } from "@cobblr/platform-web";
import { ApiError, api, type Location } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";

interface LocationNode extends Location {
  children: LocationNode[];
}

function buildTree(items: Location[]): LocationNode[] {
  const byId = new Map<string, LocationNode>();
  for (const it of items) byId.set(it.id, { ...it, children: [] });
  const roots: LocationNode[] = [];
  for (const n of byId.values()) {
    if (n.parent_id && byId.has(n.parent_id)) {
      byId.get(n.parent_id)!.children.push(n);
    } else {
      roots.push(n);
    }
  }
  const sort = (arr: LocationNode[]) => {
    arr.sort((a, b) => a.name.localeCompare(b.name));
    for (const c of arr) sort(c.children);
  };
  sort(roots);
  return roots;
}

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
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [createOpen, setCreateOpen] = useState(false);
  const [createParentId, setCreateParentId] = useState<string | null>(null);
  const [editTarget, setEditTarget] = useState<Location | null>(null);

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
  const tree = useMemo(() => buildTree(items), [items]);

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

  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-3 border-b border-slate-200 dark:border-slate-700 pb-3">
        <h1 className="text-2xl font-semibold text-slate-700 dark:text-mortar-100">
          Locations
        </h1>
        <span className="text-sm text-slate-500 dark:text-slate-400">
          {items.length} {items.length === 1 ? "place" : "places"}
        </span>
        <div className="flex-1" />
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

      <p className="text-sm text-slate-600 dark:text-mortar-200">
        Hierarchical tree of physical places — rooms, shelves, bins. Anything
        tangible in the workspace (machines, assets, parts) can point at a row
        here via its <code>location_id</code> field.
      </p>

      {list.isLoading && (
        <div className="text-sm text-slate-500">Loading…</div>
      )}
      {tree.length === 0 && !list.isLoading && (
        <div className="text-sm italic text-slate-500 dark:text-slate-400">
          No locations yet. Add a top-level area (a room, a workshop, a garage)
          and start nesting bins and shelves inside it.
        </div>
      )}

      <div className="space-y-2">
        {tree.map((n) => (
          <LocationCard
            key={n.id}
            node={n}
            usageByLocation={usageByLocation}
            onAddChild={(parentId) => {
              setCreateParentId(parentId);
              setCreateOpen(true);
            }}
            onEdit={(loc) => setEditTarget(loc)}
            onDelete={async (loc) => {
              const subtree = subtreeUsage(loc);
              const subtreeTotal =
                subtree.machines + subtree.assets + subtree.parts;
              const childPart =
                loc.children.length > 0
                  ? ` and its ${loc.children.length} child location(s)`
                  : "";
              const usagePart =
                subtreeTotal > 0
                  ? ` ${subtreeTotal} item(s) currently point at ${
                      loc.children.length > 0
                        ? "this subtree"
                        : "this location"
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
        ))}
      </div>

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
    </div>
  );
}

function LocationCard({
  node,
  usageByLocation,
  onAddChild,
  onEdit,
  onDelete,
}: {
  node: LocationNode;
  usageByLocation: Map<string, UsageCounts>;
  onAddChild: (parentId: string) => void;
  onEdit: (loc: Location) => void;
  onDelete: (loc: LocationNode) => void;
}) {
  const KindIcon = node.kind === "container" ? BoxIcon : AreaIcon;
  const usage = usageByLocation.get(node.id);
  const usageTotal = totalUsage(usage);
  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden">
      <div className="px-4 py-2.5 bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-700 flex items-center gap-2">
        <KindIcon size={16} className="text-cobble-500 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="font-medium text-slate-700 dark:text-mortar-100 truncate">
            {node.name}
          </div>
          {node.short_name && node.short_name !== node.name && (
            <div className="text-xs text-slate-500 dark:text-slate-400 font-mono truncate">
              {node.short_name}
            </div>
          )}
        </div>
        {usageTotal > 0 && (
          <span
            className="text-[10px] font-mono text-cobble-600 dark:text-cobble-400"
            title={`${usage?.machines ?? 0} machine(s) · ${usage?.assets ?? 0} asset(s) · ${usage?.parts ?? 0} part(s) point here`}
          >
            {usageTotal} item{usageTotal === 1 ? "" : "s"}
          </span>
        )}
        <span className="text-[10px] uppercase font-mono tracking-widest text-slate-400 dark:text-slate-500">
          {node.kind}
        </span>
        <button
          type="button"
          onClick={() => onAddChild(node.id)}
          title="Add child"
          className="text-slate-400 hover:text-cobble-600 transition p-1"
        >
          <Plus size={14} />
        </button>
        <button
          type="button"
          onClick={() => onEdit(node)}
          title="Edit"
          className="text-slate-400 hover:text-cobble-600 transition p-1"
        >
          <Pencil size={14} />
        </button>
        <button
          type="button"
          onClick={() => onDelete(node)}
          title="Delete"
          className="text-slate-400 hover:text-ember-500 transition p-1"
        >
          <Trash2 size={14} />
        </button>
      </div>
      {node.children.length > 0 && (
        <div className="p-3 pl-6 space-y-2 bg-slate-50/50 dark:bg-slate-900/40">
          {node.children.map((c) => (
            <LocationCard
              key={c.id}
              node={c}
              usageByLocation={usageByLocation}
              onAddChild={onAddChild}
              onEdit={onEdit}
              onDelete={onDelete}
            />
          ))}
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
  const [parentId, setParentId] = useState<string | "">(
    target?.parent_id ?? parentIdInitial ?? "",
  );
  const toast = useToast();

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
          const body: Partial<Location> = {
            name: name.trim(),
            short_name: shortName.trim() || null,
            kind,
            parent_id: parentId || null,
          };
          try {
            if (editing && target) {
              await api.updateLocation(slug, target.id, body);
              toast.success("Location updated");
            } else {
              await api.createLocation(slug, body);
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
          <span className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-1">
            Name
          </span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Garage / Shelf 3 / Bin 17"
            className="w-full px-2 py-1 text-sm border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-900"
            autoFocus
          />
        </label>
        <label className="block">
          <span className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-1">
            Short name (optional)
          </span>
          <input
            type="text"
            value={shortName}
            onChange={(e) => setShortName(e.target.value)}
            placeholder="Bin 17"
            className="w-full px-2 py-1 text-sm border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-900"
          />
          <div className="text-[10px] text-slate-500 mt-1">
            Shown on labels when the canonical name is too long.
          </div>
        </label>
        <label className="block">
          <span className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-1">
            Kind
          </span>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as "area" | "container")}
            className="w-full px-2 py-1 text-sm border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-900"
          >
            <option value="area">
              area — a region (room, corner, workshop)
            </option>
            <option value="container">
              container — a thing things go INTO (bin, drawer, shelf)
            </option>
          </select>
        </label>
        <label className="block">
          <span className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-1">
            Parent (optional — leave blank for top-level)
          </span>
          <select
            value={parentId}
            onChange={(e) => setParentId(e.target.value)}
            className="w-full px-2 py-1 text-sm border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-900"
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
            className="px-3 py-1.5 text-sm rounded text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800"
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
