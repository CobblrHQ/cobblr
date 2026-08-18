// LocationChipPicker — the platform's location picker: a WRAPPED GRID of area
// chips (camera-drawer density), where an area holding containers is a SPLIT
// chip whose chevron half opens that area's containers in a panel below.
//
// The previous accordion stacked one area per line — 18 areas = 18 rows, painful
// scrolling on a phone (the author). Now the areas wrap horizontally like the
// camera's chip drawer (~5 rows for the same 18), and hierarchy stays one tap
// away:
//   • the chip BODY picks the area itself (tap the active one again to clear);
//   • the chevron/count half (only on areas that hold containers) opens ONE
//     panel below the wrap — "In {Area}" — with the area's containers; opening
//     another area swaps the panel instead of stacking, so the drawer never
//     re-grows vertically;
//   • inside the panel, a container holding other containers renders its
//     children INDENTED beneath it (a shelf's bins under the shelf);
//   • containers under no area are the "Loose containers" section below the
//     wrap — open by default (the author);
//   • a pre-filled selection auto-opens its area's panel so it's visible.
//
// "Areas", not "Rooms" — the platform's declared kind (an Outside or a Garage
// zone is an area, not a room). kind="area" (the camera's "assign a room")
// keeps the plain flat chip wrap: nothing to expand when bins never show.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, MapPin, Package, Plus } from "lucide-react";
import {
  buildLocationForest,
  flattenAreaForest,
  ancestorIds,
  type LocationAccessors,
  type LocationNode,
} from "@cobblr/platform-web";
import { api, type Location } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { QuickCreateLocation } from "./QuickCreateLocation";
import { LocationTreePicker } from "./LocationTreePicker";

interface Props {
  value: string | null;
  onChange: (value: string | null) => void;
  /** Restrict to one kind. "area" = areas only (the camera's scan area);
   *  omit for the full picker (areas + their containers). */
  kind?: Location["kind"];
  /** Exclude one id (e.g. don't offer a location as its own parent). */
  excludeId?: string;
  className?: string;
}

const ACC: LocationAccessors<Location> = {
  id: (l) => l.id,
  parentId: (l) => l.parent_id,
  position: (l) => l.position,
  name: (l) => l.name,
  isContainer: (l) => l.kind === "container",
};

export function LocationChipPicker({ value, onChange, kind, excludeId, className }: Props) {
  const { activeSlug } = useActiveOrg();
  const [createOpen, setCreateOpen] = useState(false);

  const list = useQuery({
    queryKey: ["core-locations", activeSlug],
    queryFn: () => api.listLocations(activeSlug),
    enabled: !!activeSlug,
    staleTime: 60_000,
  });
  const all = useMemo(
    () => (list.data?.items ?? []).filter((l) => l.id !== excludeId),
    [list.data, excludeId],
  );
  const nameOf = (l: Location) => l.short_name?.trim() || l.name;

  // The shared forest model — same structure + ordering as the Locations page.
  // Areas flatten to ONE wrap (nested areas ride along in pre-order).
  const { areas, containers: looseRoots } = useMemo(() => buildLocationForest(all, ACC), [all]);
  // AREA-only flatten — the generic flatten walks ALL children, which leaked a
  // room's bins into the grid as rooms (the shipped bug this replaces).
  const flatAreas = useMemo(() => flattenAreaForest(areas, ACC), [areas]);

  // ONE area's panel open at a time — opening another swaps it, so the drawer
  // stays the same height instead of accordioning taller and taller.
  const [openAreaId, setOpenAreaId] = useState<string | null>(null);
  // Loose containers are open by default (the author) — still collapsible.
  const [looseOpen, setLooseOpen] = useState(true);

  // The open panel must be SEEN: inside a bounded scroll container (the confirm
  // form's dropdown) it can open below the fold and read as "the chevron does
  // nothing". Scroll it into view whenever it opens/swaps.
  const panelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (openAreaId) panelRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [openAreaId]);

  // The panel opens RIGHT BELOW THE ROW the tapped chip sits on (the author) —
  // not at the bottom of the whole grid. Flex-wrap decides line breaks, so we
  // MEASURE: chips sharing the open chip's offsetTop are its row; the panel (a
  // basis-full flex child, which always starts its own line) is emitted after
  // the row's LAST chip. Re-measured on container resize (rotation, keyboard).
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const chipRefs = useRef(new Map<string, HTMLElement>());
  const [panelAfterId, setPanelAfterId] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (!openAreaId) {
      setPanelAfterId(null);
      return;
    }
    const compute = () => {
      const openEl = chipRefs.current.get(openAreaId);
      if (!openEl) {
        setPanelAfterId(openAreaId);
        return;
      }
      const top = openEl.offsetTop;
      let lastId = openAreaId;
      for (const n of flatAreas) {
        const el = chipRefs.current.get(n.id);
        // ≤1px tolerance — a plain chip and a split chip can differ sub-pixel.
        if (el && Math.abs(el.offsetTop - top) <= 1) lastId = n.id;
      }
      setPanelAfterId(lastId);
    };
    compute();
    const ro = new ResizeObserver(compute);
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, [openAreaId, flatAreas]);

  // A pre-filled selection must be visible: open its area's panel (or re-open
  // the loose section) when the value points inside one.
  useEffect(() => {
    if (!value || all.length === 0) return;
    const kindOf = new Map(all.map((l) => [l.id, l.kind]));
    if (kindOf.get(value) !== "container") return;
    const areaAncestor = ancestorIds(all, ACC, value).find((id) => kindOf.get(id) === "area");
    if (areaAncestor) setOpenAreaId(areaAncestor);
    else setLooseOpen(true);
  }, [value, all]);

  const countContainers = (n: LocationNode<Location>): number =>
    n.children.reduce((sum, c) => (c.kind === "container" ? sum + 1 + countContainers(c) : sum), 0);

  const Chip = ({ l, icon }: { l: Location; icon: "area" | "bin" }) => {
    const active = value === l.id;
    return (
      <button
        type="button"
        // Tapping the active chip clears it — the same toggle a checkbox gives.
        onClick={() => onChange(active ? null : l.id)}
        className={
          // Theme-aware: this renders on the dark camera overlay AND in the inbox,
          // which follows the workspace light/dark theme.
          "text-sm px-2.5 py-1.5 rounded-full inline-flex items-center gap-1.5 transition " +
          (active
            ? "bg-emerald-500/20 text-emerald-700 ring-1 ring-emerald-500 dark:bg-emerald-500/25 dark:text-emerald-100 dark:ring-emerald-400"
            : "bg-subtle text-content hover:bg-cobble-100 dark:bg-slate-700/60 dark:text-slate-100 dark:hover:bg-slate-600")
        }
      >
        {icon === "area" ? <MapPin size={13} className="shrink-0" /> : <Package size={13} className="shrink-0" />}
        {nameOf(l)}
      </button>
    );
  };

  /** A SPLIT area chip: the body picks the area; the chevron+count half (only
   *  when the area holds containers) opens its panel below the wrap. */
  const AreaChip = ({ node }: { node: LocationNode<Location> }) => {
    const active = value === node.id;
    const open = openAreaId === node.id;
    const count = countContainers(node);
    const base = active
      ? "bg-emerald-500/20 text-emerald-700 ring-1 ring-emerald-500 dark:bg-emerald-500/25 dark:text-emerald-100 dark:ring-emerald-400"
      : open
        ? "bg-cobble-100 text-content ring-1 ring-cobble-400 dark:bg-slate-700 dark:text-slate-100 dark:ring-cobble-500"
        : "bg-subtle text-content hover:bg-cobble-100 dark:bg-slate-700/60 dark:text-slate-100 dark:hover:bg-slate-600";
    return (
      <span
        ref={(el) => {
          if (el) chipRefs.current.set(node.id, el);
          else chipRefs.current.delete(node.id);
        }}
        className={`inline-flex items-stretch rounded-full overflow-hidden transition ${base}`}
      >
        <button
          type="button"
          onClick={() => onChange(active ? null : node.id)}
          className="text-sm pl-2.5 pr-2 py-1.5 inline-flex items-center gap-1.5"
        >
          <MapPin size={13} className="shrink-0" />
          {nameOf(node)}
        </button>
        {count > 0 && (
          <button
            type="button"
            onClick={() => setOpenAreaId(open ? null : node.id)}
            aria-expanded={open}
            aria-label={`${open ? "Hide" : "Show"} containers in ${nameOf(node)}`}
            className="pl-1.5 pr-2 inline-flex items-center gap-0.5 border-l border-line/60 dark:border-slate-600/60 text-[11px] font-mono opacity-80 hover:opacity-100"
          >
            {count}
            <ChevronDown size={12} className={`transition ${open ? "rotate-180" : ""}`} />
          </button>
        )}
      </span>
    );
  };

  /** Container subtrees as chips: childless siblings share a wrap row; a
   *  container with children gets its own block with the children indented
   *  beneath it (a shelf's bins under the shelf). */
  const ContainerTree = ({ nodes }: { nodes: LocationNode<Location>[] }) => {
    const blocks: ReactNode[] = [];
    let run: LocationNode<Location>[] = [];
    const flush = () => {
      if (run.length) {
        blocks.push(
          <div key={`run-${run[0]!.id}`} className="flex flex-wrap gap-1.5">
            {run.map((l) => (
              <Chip key={l.id} l={l} icon="bin" />
            ))}
          </div>,
        );
        run = [];
      }
    };
    for (const n of nodes) {
      const kids = n.children.filter((c) => c.kind === "container");
      if (kids.length > 0) {
        flush();
        blocks.push(
          <div key={n.id}>
            <Chip l={n} icon="bin" />
            <div className="ml-3 mt-1.5 pl-2.5 border-l border-line dark:border-slate-700">
              <ContainerTree nodes={kids} />
            </div>
          </div>,
        );
      } else {
        run.push(n);
      }
    }
    flush();
    return <div className="space-y-1.5">{blocks}</div>;
  };

  const newLocationButton = (
    <>
      <div className="pt-1">
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          className="text-sm text-accent hover:underline inline-flex items-center gap-1"
        >
          <Plus size={14} /> New location…
        </button>
      </div>
      {createOpen && (
        <QuickCreateLocation
          slug={activeSlug}
          all={list.data?.items ?? []}
          defaultKind={kind}
          onClose={() => setCreateOpen(false)}
          onCreated={(loc) => {
            onChange(loc.id);
            setCreateOpen(false);
          }}
          // A drill-down, not a second chip grid: the chips are the outer
          // picker's whole surface, and repeating them inside the create form
          // reads as two pickers fighting over one answer.
          parentField={(v, set) => (
            <LocationTreePicker label="Parent" value={v} onChange={set} placeholder="(top-level)" size="sm" />
          )}
        />
      )}
    </>
  );

  // The camera's areas-only mode: a plain flat chip wrap (nothing to expand).
  if (kind === "area") {
    return (
      <div className={"space-y-3 " + (className ?? "")}>
        {flatAreas.length === 0 && <div className="text-sm text-faint">No areas yet.</div>}
        <div className="flex flex-wrap gap-1.5">
          {flatAreas.map((l) => (
            <Chip key={l.id} l={l} icon="area" />
          ))}
        </div>
        {newLocationButton}
      </div>
    );
  }

  const openNode = openAreaId ? flatAreas.find((n) => n.id === openAreaId) ?? null : null;
  const openContainers = openNode ? openNode.children.filter((c) => c.kind === "container") : [];
  const looseCount = looseRoots.reduce((sum, r) => sum + 1 + countContainers(r), 0);

  return (
    <div className={"space-y-2 " + (className ?? "")}>
      {flatAreas.length === 0 && looseRoots.length === 0 && (
        <div className="text-sm text-faint">No locations yet.</div>
      )}

      {/* The area grid — wraps like the camera drawer, so 18 areas is ~5 rows,
          not 18. The ONE open area's panel is a basis-full child emitted right
          after the tapped chip's ROW, so it opens where you tapped. */}
      {flatAreas.length > 0 && (
        <div ref={wrapRef} className="flex flex-wrap items-start gap-1.5">
          {flatAreas.map((n) => (
            <span key={n.id} className="contents">
              <AreaChip node={n} />
              {openNode && openContainers.length > 0 && (panelAfterId ?? openAreaId) === n.id && (
                <div
                  ref={panelRef}
                  className="basis-full min-w-0 rounded-md border border-line dark:border-slate-700 bg-subtle/40 dark:bg-slate-800/40 p-2"
                >
                  <div className="text-[10px] font-mono uppercase tracking-widest text-faint mb-1.5">
                    In {nameOf(openNode)}
                  </div>
                  <ContainerTree nodes={openContainers} />
                </div>
              )}
            </span>
          ))}
        </div>
      )}

      {/* Loose containers — their own section, open by default. */}
      {looseRoots.length > 0 && (
        <div className="pt-0.5">
          <button
            type="button"
            onClick={() => setLooseOpen((o) => !o)}
            aria-expanded={looseOpen}
            className="inline-flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-widest text-faint hover:text-muted transition mb-1.5"
          >
            <ChevronDown size={12} className={`transition ${looseOpen ? "" : "-rotate-90"}`} />
            Loose containers
            <span>{looseCount}</span>
          </button>
          {looseOpen && <ContainerTree nodes={looseRoots} />}
        </div>
      )}

      {newLocationButton}
    </div>
  );
}
