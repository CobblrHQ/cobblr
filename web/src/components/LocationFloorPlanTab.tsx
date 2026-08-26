// The Locations page "Floor Plan" tab: pick a space up front and see its layout,
// instead of hunting into each location's detail page. Areas draw as a top-down
// floor plan; containers draw as a front elevation (drawers/shelves at true
// scale). Reuses the same <FloorPlan> editor the detail page mounts.

import { useMemo, useState } from "react";
import { Boxes, MapPin, Plus } from "lucide-react";
import type { Location } from "../lib/api";
import { readBound } from "../lib/floorplanGeometry";
import { FloorPlan } from "./FloorPlan";

/** Spaces worth a chip: every root AREA (a room/region), plus every CONTAINER
 *  that is either standalone (no parent) or already has a layout drawn — so a
 *  shelving unit or tool chest is reachable up front without listing every nested
 *  bin. Areas first, then containers; each group sorted by the user's sort_order
 *  then name. */
function viewableSpaces(items: Location[]): { areas: Location[]; containers: Location[] } {
  const order = (a: Location, b: Location) =>
    (a.position ?? 0) - (b.position ?? 0) || a.name.localeCompare(b.name);
  const areas = items.filter((l) => l.kind === "area" && !l.parent_id).sort(order);
  const containers = items
    .filter((l) => l.kind === "container" && (!l.parent_id || !!readBound(l.metadata)))
    .sort(order);
  return { areas, containers };
}

export function LocationFloorPlanTab({
  items,
  slug,
  onCreate,
}: {
  items: Location[];
  slug: string;
  onCreate?: () => void;
}) {
  const { areas, containers } = useMemo(() => viewableSpaces(items), [items]);
  const first = areas[0]?.id ?? containers[0]?.id ?? null;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Default to the first space, and heal if the selected one is deleted/renamed.
  const activeId = selectedId && items.some((l) => l.id === selectedId) ? selectedId : first;
  const active = items.find((l) => l.id === activeId) ?? null;

  if (!active) {
    return (
      <div className="rounded-xl border border-dashed border-line dark:border-slate-700 p-6 text-sm text-muted dark:text-slate-400">
        <p>
          No rooms or containers to lay out yet. Add a top-level area (a room, a
          garage) or a container (a tool chest, a shelving unit), then draw or
          describe its layout here.
        </p>
        {onCreate && (
          <button
            onClick={onCreate}
            className="mt-3 inline-flex items-center gap-1.5 rounded bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1.5 text-sm transition"
          >
            <Plus size={14} />
            New location
          </button>
        )}
      </div>
    );
  }

  const chip = (l: Location) => (
    <button
      key={l.id}
      type="button"
      onClick={() => setSelectedId(l.id)}
      className={
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm transition " +
        (l.id === activeId
          ? "border-accent text-accent bg-cobble-50 dark:bg-cobble-900/30"
          : "border-line dark:border-slate-600 text-content dark:text-mortar-100 hover:border-accent hover:text-accent")
      }
    >
      {l.kind === "container" ? <Boxes size={13} /> : <MapPin size={13} />}
      {l.name}
    </button>
  );

  return (
    <div className="space-y-3">
      {(areas.length + containers.length > 1) && (
        <div className="flex flex-wrap items-center gap-2">
          {areas.length > 0 && (
            <>
              <span className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500">area</span>
              {areas.map(chip)}
            </>
          )}
          {containers.length > 0 && (
            <>
              <span className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 ml-1">container</span>
              {containers.map(chip)}
            </>
          )}
        </div>
      )}
      {/* key resets the editor's per-space state when you switch chips. */}
      <FloorPlan key={active.id} room={active} slug={slug} />
    </div>
  );
}
