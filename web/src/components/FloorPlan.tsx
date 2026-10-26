import { RecordFormModal, Modal, editOf, isShortcut, stillAsking, useImageSrc, useToast } from "@cobblr/platform-web";
// The floor plan — a location's children drawn where they physically stand.
// Third lens on the same hierarchy the tree and the scanner use; every rect
// IS a location record. Spec: docs/design-decisions/location-floor-plan.md.
//
// Day-to-day view: a clean map — no numbers, no units, no grid. Edit mode:
// snap grid, drag/resize, wall + opening editing, dims (in the user's own
// unit), the unplaced tray, and the describe-to-seed flow. Zones (child
// areas) are invisible regions with faint toggleable labels; dropping a
// container inside one reparents it there (the plan is the filing UI).

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Flame, Grid3x3, LayoutGrid, Loader2, MapPin, Pencil, Plus, Printer, Redo2, RotateCw, ScanLine, Sparkles, Tag, Undo2, X, ZoomIn, ZoomOut } from "lucide-react";
import { diffPlaces, historyKey, planHistoryFor, type PlanChange, type PlanStep } from "../lib/planHistory";
import { ApiError, api, type Location, type TagAttachment, type TagRecord } from "../lib/api";
import { totalUsage, useLocationUsage } from "../lib/useLocationUsage";
import {
  gridCellsNote,
  SNAP_MM,
  clampRect,
  collidingIds,
  freeSpot,
  hasOwnLayout,
  newChildRect,
  partitionPlanRecords,
  planOwnerOf,
  readBound,
  readRect,
  rebaseRect,
  snap,
  wallSegments,
  withBound,
  withDecor,
  withRect,
  zoneAt,
  type FpBound,
  type FpOpening,
  type FpRect,
  type FpWall,
} from "../lib/floorplanGeometry";
import { fitsIn, labelFor, shortLabel } from "../lib/layoutBoard";
import { formatLength, parseLength, type LengthUnit } from "../lib/lengthUnits";
import { gridNames, gridRects } from "../lib/gridFill";
import { OUTLINE_PRESETS, byAreaDesc, pointsAttr, readFill, readOutline } from "../lib/planDecor";
import { useDetailRoute } from "../lib/useDetailRoute";
import { parseRange } from "../lib/nameRange";
import { LOCATION_KIND } from "../lib/placeItems";
import { usePlaceableRecords } from "../lib/placeableRecords";
import { PLACE_PLAN, PLACE_TARGET, pinAt, placePlanValue, usePlacing } from "./placeItems/placing";
import { gridPitches, planPitch } from "../lib/planGrid";
import { usePlanHeightCap } from "./plan-fits-the-screen";
import { layoutPinLabels } from "../lib/pinLabels";
import { PinPeek } from "./PinPeek";
import { AddSizesDialog, ShelfFitLabel, ShelfFitList, SizedThingBox, useSizedThings } from "./PlanSizedThings";
import { nameUnder } from "../lib/planFit";
import { PLAN_COLOURS, isPlanColour, planColourOf } from "@cobblr/platform-contract/plan-colours";
import { GROUP_COLOURS, PLAN_COLOUR_STYLE } from "../lib/planColourStyles";
import { groupPins, groupableFields, shortFor } from "../lib/pinGroups";
import { fieldKindOf } from "@cobblr/platform-contract/kind-label";
import { jsonbPatchBetween } from "@cobblr/platform-contract/jsonb-merge";
import { withArticle } from "@cobblr/platform-contract/plural";
import { DEFAULT_SILL_MM, closetWalls, doorFitsWall, edgeOf, flagIsRed, frontEdge, intoRoom, planFlags, readCloset, roomWalls, rotated, type ClosetDoor, type Edge, type PlanItem } from "@cobblr/platform-contract/plan-clearance";
import { GapReadout, PlanFlagList, PlanSymbols } from "./PlanSymbols";

import { countOf } from "@cobblr/platform-contract/plural";
type PlaceOutline = { key: string; label: string; colour: string | null; border: string; swatch: string; tagId?: string };

function outlineFor(loc: Location, attachments: TagAttachment[], tags: TagRecord[]): PlaceOutline | null {
  const fp = (loc.metadata?.floorplan ?? {}) as Record<string, unknown>;
  const attached = tags.filter((t) => attachments.some((a) => a.tag_id === t.id)).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const tag = fp.outline_tag_id === "custom" ? undefined
    : typeof fp.outline_tag_id === "string" ? attached.find((t) => t.id === fp.outline_tag_id)
    : attached.find((t) => t.color) ?? attached[0];
  if (tag) return { key: tag.id, label: tag.name, colour: tag.color, border: "border-2 border-slate-400 dark:border-slate-500", swatch: "bg-slate-400 dark:bg-slate-500", tagId: tag.id };
  const colour = planColourOf(loc.metadata);
  // Named by its colour, never "Custom": two custom colours would read the
  // same, and the swatch beside the name is not read aloud.
  return colour ? { key: `custom:${colour}`, label: colour[0]!.toUpperCase() + colour.slice(1), colour: null, border: `border-2 ${PLAN_COLOUR_STYLE[colour].border}`, swatch: PLAN_COLOUR_STYLE[colour].swatch } : null;
}

const [placeModule, placeType] = LOCATION_KIND.split(":") as [string, string];
const placeTagKey = (slug: string, id: string) => ["tag-attachments", slug, placeType, id];
const readPlaceTags = (slug: string, id: string) => api.listTagAttachments(slug, { source_module: placeModule, source_type: placeType, source_id: id });

type Sel =
  | { type: "item"; id: string }
  | { type: "entity"; kind: string; id: string }
  | { type: "wall"; idx: number }
  | null;

/** A location-bearing record that can occupy a cell on its location's plan —
 *  the ratchet in the drawer, not just the drawer. Kinds come from the
 *  entity-kind REGISTRY: placeable = declares endpoints.list + endpoints.update
 *  and is physically tangible. No module is ever named here. */
interface PlanEntity {
  kind: string;
  id: string;
  name: string;
  /** Its own short name, when its kind has one: what a small box says. */
  short_name?: string | null;
  image_path: string | null;
  location_id: string | null;
  metadata: Record<string, unknown>;
}

const pct = (v: number, total: number) => `${(v / total) * 100}%`;
/** How long a finger held still on a rack turns it. */
const LONG_PRESS_MS = 550;
/** The side a rack is reached from, drawn heavier in Edit layout. */
const FRONT_EDGE: Record<Edge, string> = { bottom: "!border-b-4", top: "!border-t-4", left: "!border-l-4", right: "!border-r-4" };

/** Dispatcher: a location with its own bound renders ONE plan (PlanFor). A
 *  location with no bound whose child areas own plans is a BUILDING — floors
 *  are stacked in Z, so each gets its own plan behind a floor tab. Floors are
 *  "invisible levels": the tree already draws them as dashed zones; here they
 *  are just tabs. */
export function FloorPlan({ room, slug }: { room: Location; slug: string }) {
  const locs = useQuery({
    queryKey: ["core-locations", slug],
    queryFn: () => api.listLocations(slug),
    staleTime: 30_000,
  });
  const items = locs.data?.items ?? [];
  const floors = items.filter(
    (l) => l.parent_id === room.id && l.kind === "area" && readBound(l.metadata),
  );
  const bound = readBound(room.metadata);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [newFloor, setNewFloor] = useState(false);

  // Whether this place splits into floors is known from the places: until
  // then neither shape is drawn, or one would replace the other.
  if (locs.isPending) return <p aria-busy="true" className="text-sm text-faint dark:text-slate-500">loading the plan…</p>;
  if (!bound && floors.length > 0) {
    const active = floors.find((f) => f.id === activeId) ?? floors[0]!;
    return (
      <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 space-y-3">
        <div className="flex items-center gap-1.5 flex-wrap">
          <h2 className="text-sm font-medium text-content dark:text-mortar-100 mr-2">
            Floor plans
          </h2>
          {floors.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setActiveId(f.id)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition border ${
                f.id === active.id
                  ? "border-accent text-accent bg-cobble-50 dark:bg-cobble-900/30"
                  : "border-line dark:border-slate-600 text-muted hover:text-content"
              }`}
            >
              {f.name}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setNewFloor(true)}
            className="rounded-md border border-dashed border-line dark:border-slate-600 px-2 py-1 text-xs text-faint hover:text-accent hover:border-accent transition"
          >
            + floor
          </button>
          <button
            type="button"
            onClick={() => window.open(`/print/${slug}/locations/${room.id}`, "_blank", "noopener")}
            className="inline-flex items-center gap-1 rounded-md border border-line dark:border-slate-600 px-2 py-1 text-xs text-muted hover:text-accent hover:border-accent transition"
            title="Print every floor, one page each"
          >
            <Printer size={12} /> print
          </button>
        </div>
        {/* key resets the per-floor editor state on tab switch */}
        <PlanFor key={active.id} room={active} slug={slug} bare headTitle={active.name} />
        {newFloor && (
          <NewFloorModal slug={slug} room={room} onClose={() => setNewFloor(false)} />
        )}
      </section>
    );
  }

  return (
    <>
      <PlanFor
        room={room}
        slug={slug}
        onAddFloor={room.kind === "area" && !bound ? () => setNewFloor(true) : undefined}
      />
      {newFloor && <NewFloorModal slug={slug} room={room} onClose={() => setNewFloor(false)} />}
    </>
  );
}

/** A place's own plan or face, bare: what the place-items chooser shows so a
 *  drawer can be tapped where it is drawn. */
export function FaceFor({ room, slug }: { room: Location; slug: string }) {
  return <PlanFor room={room} slug={slug} bare headTitle={room.name} capVh={40} />;
}

function PlanFor({
  room,
  slug,
  bare = false,
  headTitle,
  onAddFloor,
  startWith,
  capVh = 70,
}: {
  room: Location;
  slug: string;
  /** Render without the outer section chrome (inside floor tabs / the peek modal). */
  bare?: boolean;
  headTitle?: string;
  /** Offered on an empty area's setup row — splits the space into floors. */
  onAddFloor?: () => void;
  /** Open straight into adding drawers (the selection panel's "Add drawers"). */
  startWith?: "drawers";
  /** How much of the screen's height the plan may take. */
  capVh?: number;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const planRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [viewportPx, setViewportPx] = useState(0);
  useEffect(() => {
    setZoom(1);
    viewportRef.current?.scrollTo?.({ left: 0, top: 0 });
  }, [room.id]);

  const locs = useQuery({
    queryKey: ["core-locations", slug],
    queryFn: () => api.listLocations(slug),
    staleTime: 30_000,
  });
  const items = useMemo(() => locs.data?.items ?? [], [locs.data]);
  const byId = useMemo(() => new Map(items.map((l) => [l.id, l] as const)), [items]);

  // A placed container's w × d is its footprint on the room's floor; it has a
  // face of its own only once somebody set one up, or drew drawers in it (a
  // record from before the two were split). Until then the peek asks for the
  // face instead of drawing drawers over the footprint.
  const self = byId.get(room.id) ?? room;
  const ownsLayout =
    room.kind === "area" ||
    !readRect(self.metadata) ||
    hasOwnLayout(self.metadata) ||
    items.some((l) => l.parent_id === room.id && readRect(l.metadata));
  const bound = ownsLayout ? readBound(self.metadata) : null;
  const heightCap = usePlanHeightCap(viewportRef, capVh, !!bound);
  useEffect(() => {
    const el = viewportRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => setViewportPx(el.clientWidth);
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, [bound?.w_mm, bound?.d_mm]);
  // Place mode (a place-items view wraps the plan): every place is a target
  // and the plan itself is not edited.
  const placing = usePlacing();
  const [editing, setEdit] = useState(startWith === "drawers");
  const edit = editing && !placing;
  const [showZones, setShowZones] = useState(false);
  const [sel, setSel] = useState<Sel>(null);
  // Live rect during a drag/resize — rendered in place of the saved one.
  const [live, setLive] = useState<{ id: string; rect: FpRect } | null>(null);
  const [liveWall, setLiveWall] = useState<{ idx: number; wall: FpWall } | null>(null);
  const [seedOpen, setSeedOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [drawersOpen, setDrawersOpen] = useState(startWith === "drawers");

  // Everything drawn on THIS plan: descendants whose nearest planned ancestor
  // is this room (a rack reparented into Bay 1 stays on the garage's plan).
  const placed = useMemo(
    () =>
      items
        .filter((l) => l.id !== room.id && readRect(l.metadata) && planOwnerOf(l.id, byId) === room.id)
        .map((l) => ({ loc: l, rect: readRect(l.metadata)! })),
    [items, byId, room.id],
  );
  const tags = useQuery({ queryKey: ["tags", slug], queryFn: () => api.listTags(slug), staleTime: 30_000 });
  const containers = placed.filter(({ loc }) => loc.kind !== "area");
  const attachedTags = useQueries({ queries: containers.map(({ loc }) => ({
    queryKey: placeTagKey(slug, loc.id), queryFn: () => readPlaceTags(slug, loc.id), staleTime: 30_000,
  })) });
  const outlines = new Map(containers.map(({ loc }, i) => [loc.id, outlineFor(loc, attachedTags[i]?.data?.items ?? [], tags.data?.items ?? [])]));
  // Placed areas split by whether they own a plan of their own:
  //   • zones (no bound)  — invisible regions, faint labels (the garage bays)
  //   • rooms (own bound) — VISIBLE rects that drill into their own plan (the
  //     kitchen on a house floor). Both are drop-targets for reparenting.
  const zones = useMemo(
    () => placed.filter((p) => p.loc.kind === "area").map((p) => ({ id: p.loc.id, rect: p.rect, name: p.loc.name })),
    [placed],
  );
  const zoneRegions = useMemo(
    () => zones.filter((z) => !readBound(byId.get(z.id)?.metadata)),
    [zones, byId],
  );
  const roomsOnPlan = useMemo(
    () => placed.filter((p) => p.loc.kind === "area" && readBound(p.loc.metadata)),
    [placed],
  );
  // Deep render: everything placed on ANY plan, keyed by its plan owner — a
  // big-enough room rect previews its own contents as static minis.
  const placedByOwner = useMemo(() => {
    const m = new Map<string, Array<{ loc: Location; rect: FpRect }>>();
    for (const l of items) {
      const rect = readRect(l.metadata);
      if (!rect) continue;
      const owner = planOwnerOf(l.id, byId);
      if (!owner) continue;
      const arr = m.get(owner) ?? [];
      arr.push({ loc: l, rect });
      m.set(owner, arr);
    }
    return m;
  }, [items, byId]);
  const tray = useMemo(
    () => items.filter((l) => l.parent_id === room.id && !readRect(l.metadata)),
    [items, room.id],
  );

  // ── entity occupants: the ratchet in the drawer, not just the drawer ──
  // Every placeable record, from the one shared read (placeableRecords): the
  // place-items rail and the per-place counts read the same list.
  const { records: placeable, kinds: placeableKinds, isLoading: placeableLoading } = usePlaceableRecords(slug);
  const routeFor = useDetailRoute(slug);
  const occupants = useMemo(() => {
    const all: PlanEntity[] = placeable.map((r) => ({
      kind: r.kind,
      id: r.id,
      name: r.name,
      short_name: r.short_name,
      image_path: r.image_path,
      location_id: r.location_id,
      metadata: r.metadata,
    }));
    // An entity draws on the plan its LOCATION belongs to: the location
    // itself when it owns a plan (a drawer), else that location's plan owner.
    const ownerOfLoc = (locId: string): string | null => {
      const l = byId.get(locId);
      if (!l) return null;
      if (readBound(l.metadata)) return l.id;
      return planOwnerOf(locId, byId);
    };
    return all.filter((e) => e.location_id && ownerOfLoc(e.location_id) === room.id);
  }, [placeable, byId, room.id]);
  const held = useQuery({
    queryKey: ["location-contents", slug, room.id],
    queryFn: () => api.placementContents(slug, LOCATION_KIND, room.id),
    enabled: !!bound,
    staleTime: 30_000,
  });
  const { pins, placedOccupants, unplacedOccupants } = useMemo(() => {
    const result = partitionPlanRecords(occupants, held.data?.items ?? [], bound);
    result.placedOccupants.sort(byAreaDesc);
    return result;
  }, [occupants, held.data, bound]);
  // The drawing's width on screen, so pin labels are laid out where they
  // will actually be drawn (a phone's 358 px drawer is not a desk's 900).
  const [planPx, setPlanPx] = useState(0);
  useEffect(() => {
    const el = planRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setPlanPx(el.clientWidth));
    ro.observe(el);
    setPlanPx(el.clientWidth);
    return () => ro.disconnect();
  }, [bound?.w_mm, bound?.d_mm]);
  // Things with an outer size are drawn at it, and a shelf says whether they
  // fit (PlanSizedThings.tsx).
  const shelvesHere = useMemo(() => placed.filter((p) => p.loc.kind !== "area"), [placed]);
  // Each shelf on a face keeps a band at its top for its name and its fit
  // (two lines of small text), and the things stand below it.
  const bandMm = bound?.view === "front" && planPx > 0 ? Math.round((34 / planPx) * bound.w_mm) : 0;
  const sized = useSizedThings({ slug, bound, room, pins, occupants, shelves: shelvesHere, placeable, placeableKinds, band_mm: bandMm });
  const onFloor = bound?.view !== "front";
  const [addSizes, setAddSizes] = useState(false);
  // Two things in one place is a mistake the plan should SHOW rather than
  // silently accept — a floor plan that quietly stacks records misrepresents
  // the space it exists to describe. Containers and the things placed in them
  // are checked together (an item genuinely held by a bin is containment, not a
  // collision — see collidingIds).
  const colliding = useMemo(() => {
    const items = [
      ...placed.filter((p) => p.loc.kind !== "area").map((p) => ({ id: p.loc.id, rect: p.rect, holds: true })),
      ...placedOccupants.map((p) => ({ id: `${p.ent.kind}:${p.ent.id}`, rect: p.rect })),
      // A thing at its real footprint takes its real room on the floor.
      ...(onFloor ? sized.things.map((t) => ({ id: t.key, rect: t.rect })) : []),
    ];
    return collidingIds(items);
  }, [placed, placedOccupants, onFloor, sized.things]);
  // What already stands here: a new thing goes where none of it is.
  const taken = useMemo(
    () => [
      ...placed.filter((p) => p.loc.kind !== "area").map((p) => p.rect),
      ...placedOccupants.map((p) => p.rect),
      ...(onFloor ? sized.things.map((t) => t.rect) : []),
    ],
    [placed, placedOccupants, onFloor, sized.things],
  );
  // This place's own drawers and bins, drawn or not: what "arrange" lays out.
  const ownContainers = useMemo(
    () => items.filter((l) => l.parent_id === room.id && l.kind !== "area"),
    [items, room.id],
  );
  // A thing on the plan that holds things (a Backpack) says so: what is in it
  // is not drawn, and without this the plan read as if it were nowhere.
  const holders = useQuery({
    queryKey: ["core-placement-holders", slug],
    queryFn: () => api.placementHolders(slug),
    enabled: !!bound,
    staleTime: 30_000,
  });
  const holdsLabel = useMemo(() => {
    const m = new Map((holders.data?.items ?? []).map((h) => [`${h.kind}:${h.id}`, h.holds]));
    return (kind: string, id: string): string | null => {
      const n = m.get(`${kind}:${id}`) ?? 0;
      return n > 0 ? `holds ${n} ${n === 1 ? "thing" : "things"}` : null;
    };
  }, [holders.data]);
  // The grid, when this plan has it on: its pitch follows the plan's units
  // and the size it is drawn at, unless somebody chose one. Off, boxes keep
  // snapping to the plan's own step and pins go exactly where they are put.
  const gridOn = bound?.grid_on === true;
  const pitch = bound ? planPitch(bound, planPx) : null;
  const snapStep = () => (gridOn && pitch ? pitch.mm : (bound?.grid_mm ?? SNAP_MM));
  // Grouping the pinned things by one of their own fields (a drawer by
  // drive): the fields come from the kinds pinned here, never named.
  const pinKinds = useMemo(() => [...new Set(pins.map((t) => fieldKindOf(t)))].sort(), [pins]);
  const { items: kindDefs, pending: kindDefsPending } = useQueries({
    queries: pinKinds.map((k) => ({
      queryKey: ["field-defs", slug, k],
      queryFn: () => api.listFieldDefs(slug, k),
      staleTime: 60_000,
    })),
    combine: (rs) => ({ items: rs.flatMap((r) => r.data?.items ?? []), pending: rs.some(stillAsking) }),
  });
  const groupable = useMemo(() => groupableFields(kindDefs), [kindDefs]);
  const groupField = groupable.find((f) => f.name === bound?.group_by) ?? null;
  const pinGroups = useMemo(
    () => (groupField ? groupPins(pins.map((t) => ({ key: `${t.kind}:${t.id}`, fields: t.fields })), groupField) : []),
    [pins, groupField],
  );
  const pinGroupOf = useMemo(() => {
    const m = new Map<string, number>();
    pinGroups.forEach((g, i) => g.keys.forEach((k) => m.set(k, i)));
    return m;
  }, [pinGroups]);
  const pinLabels = useMemo(() => {
    if (!bound) return new Map<string, { text: string; side: "right" | "left" }>();
    const heightPx = planPx * (bound.d_mm / bound.w_mm);
    return layoutPinLabels(
      pins.map((t) => {
        const holds = holdsLabel(t.kind, t.id);
        return {
          id: `${t.kind}:${t.id}`,
          x: (t.position!.x_mm / bound.w_mm) * planPx,
          y: (t.position!.y_mm / bound.d_mm) * heightPx,
          name: holds ? `${pinName(t, placeable)} · ${holds}` : pinName(t, placeable),
          short: shortFor(t.fields, groupable),
        };
      }),
      planPx,
    );
  }, [pins, bound, planPx, holdsLabel, placeable, groupable]);

  const planLegend = new Map<string, { outline: PlaceOutline; names: string[] }>();
  for (const { loc } of containers) {
    const outline = outlines.get(loc.id);
    if (!outline) continue;
    const group = planLegend.get(outline.key) ?? { outline, names: [] };
    group.names.push(loc.name);
    planLegend.set(outline.key, group);
  }
  // A tap on a pin with a finger opens its card first (a finger has no hover
  // to read a packed drawer by); a mouse click opens the record, as before.
  const [pinPeek, setPinPeek] = useState<string | null>(null);
  const pinPointer = useRef<string>("mouse");
  useEffect(() => {
    if (!pinPeek) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPinPeek(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pinPeek]);
  // Peek drill-in: a placed child that owns its own plan opens zoomed in a
  // modal (kept as an id so edits inside the peek see live data).
  const [peekId, setPeekId] = useState<string | null>(null);
  const [peekStart, setPeekStart] = useState<"drawers" | undefined>(undefined);
  const peekLoc = peekId ? (byId.get(peekId) ?? null) : null;

  // Heat view: shade every placed rect by how much is stored in it (its own
  // count + everything in its subtree — a room's heat is its contents' heat).
  const [heat, setHeat] = useState(false);
  const usage = useLocationUsage(heat ? slug : "");
  const heatCounts = useMemo(() => {
    if (!heat) return null;
    const kids = new Map<string, string[]>();
    for (const l of items) {
      if (!l.parent_id) continue;
      const arr = kids.get(l.parent_id) ?? [];
      arr.push(l.id);
      kids.set(l.parent_id, arr);
    }
    const total = (id: string): number => {
      let acc = totalUsage(usage.get(id));
      for (const c of kids.get(id) ?? []) acc += total(c);
      return acc;
    };
    const m = new Map<string, number>();
    let max = 0;
    for (const p of placed) {
      const t = total(p.loc.id);
      m.set(p.loc.id, t);
      if (t > max) max = t;
    }
    return { m, max: Math.max(max, 1) };
  }, [heat, items, usage, placed]);
  const heatStyle = (id: string): React.CSSProperties | undefined => {
    if (!heatCounts) return undefined;
    const t = heatCounts.m.get(id) ?? 0;
    if (t === 0) return undefined;
    return { backgroundColor: `rgba(245, 158, 11, ${(0.1 + 0.5 * (t / heatCounts.max)).toFixed(3)})` };
  };
  const heatBadge = (id: string) =>
    heatCounts && (heatCounts.m.get(id) ?? 0) > 0 ? (
      <span className="absolute bottom-0 right-0.5 font-mono text-[9px] text-amber-900 dark:text-amber-200 pointer-events-none">
        {heatCounts.m.get(id)}
      </span>
    ) : null;

  // Place mode: how many things each place holds, its sub-places included.
  const placeBadge = (id: string) => {
    const n = placing?.withinAt(id) ?? 0;
    if (!placing || n === 0) return null;
    return (
      <span
        data-place-count={n}
        className="absolute bottom-0.5 right-0.5 min-w-[1.1rem] rounded-full bg-cobble-600 px-1 text-center font-mono text-[9px] leading-4 text-white pointer-events-none"
        style={{ writingMode: "horizontal-tb" }}
        title={`${n} ${n === 1 ? "thing" : "things"} here`}
      >
        {n}
      </span>
    );
  };

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["core-locations", slug] });
    void qc.invalidateQueries({ queryKey: ["location", slug, room.id] });
  };

  // Undo / redo (planHistory.ts): every edit below records what it changed,
  // one history per workspace, so every plan on screen undoes in order.
  const history = planHistoryFor(slug);
  const historyTick = useSyncExternalStore(history.subscribe, () => `${history.nextUndo()?.label ?? ""}|${history.nextRedo()?.label ?? ""}|${history.canUndo()}|${history.canRedo()}`);
  const note = (label: string, changes: PlanChange[]) => history.record({ label, changes });
  const runHistory = async (dir: "undo" | "redo") => {
    try {
      const step: PlanStep | null = await (dir === "undo" ? history.undo() : history.redo());
      if (!step) return;
      void qc.invalidateQueries({ queryKey: ["core-locations", slug] });
      void qc.invalidateQueries({ queryKey: ["location"] });
      void qc.invalidateQueries({ queryKey: ["location-contents", slug] });
      void qc.invalidateQueries({ queryKey: ["kind-list", slug] });
      toast.success(`${dir === "undo" ? "Undone" : "Redone"}: ${step.label}`);
    } catch (e) {
      toast.error(`Could not ${dir} that: ${e instanceof ApiError ? e.message : String(e)}`);
    }
  };
  const runHistoryRef = useRef(runHistory);
  runHistoryRef.current = runHistory;
  useEffect(() => {
    if (!edit) return;
    const onKey = (e: KeyboardEvent) => {
      const dir = historyKey(e);
      // A plan inside a peek and the plan behind it both listen; one press
      // is one undo.
      if (!dir || (e as KeyboardEvent & { planHistoryDone?: boolean }).planHistoryDone) return;
      (e as KeyboardEvent & { planHistoryDone?: boolean }).planHistoryDone = true;
      e.preventDefault();
      void runHistoryRef.current(dir);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [edit]);

  // A layout write shows on the plan the moment it is made. It used to wait
  // for the list to be read again, so a second tap in quick succession
  // ("Pantry", then "Fridge") worked from the list as it was before the first,
  // picked the same free spot, and the tray and the plan disagreed with what
  // was saved until something refetched (#4147). The list is patched in
  // place, the server's answer replaces the guess, and a refused write puts
  // the old metadata back.
  const listKey = ["core-locations", slug] as const;
  type LocList = { items: Location[] } | undefined;
  const patchCached = (id: string, metadata: Record<string, unknown>) =>
    qc.setQueryData<LocList>(listKey, (old) => (old ? { ...old, items: old.items.map((l) => (l.id === id ? { ...l, metadata } : l)) } : old));
  const saveKey = ["floorplan-save", slug] as const;
  const saveMeta = useMutation({
    mutationKey: saveKey,
    // In turn: each layout write is judged against the one before it (#7925),
    // so the second of two quick drags must not reach the server first.
    scope: { id: `floorplan-save:${slug}` },
    // The server MERGES metadata: a key left out is kept, and only null removes
    // one. The geometry helpers return the whole bag they want, deleting
    // `floorplan` when nothing is left in it, so the bag itself would never
    // take a place off the plan; the patch between the two does.
    mutationFn: (p: { id: string; metadata: Record<string, unknown>; before: Record<string, unknown> | null | undefined }) =>
      api.updateLocation(slug, p.id, editOf({ metadata: p.before }, { metadata: jsonbPatchBetween(p.before, p.metadata) })),
    onMutate: async (p) => {
      await qc.cancelQueries({ queryKey: listKey });
      const before = qc.getQueryData<LocList>(listKey)?.items.find((l) => l.id === p.id)?.metadata;
      patchCached(p.id, p.metadata);
      return { before };
    },
    onSuccess: (saved, p) => {
      if (saved && typeof saved === "object" && "metadata" in saved) patchCached(p.id, (saved as Location).metadata ?? p.metadata);
      settleMeta(`place:${p.id}`, p.metadata);
      void qc.invalidateQueries({ queryKey: ["location", slug, room.id] });
    },
    onError: (e, p, ctx) => {
      settleMeta(`place:${p.id}`, p.metadata);
      if (ctx?.before) patchCached(p.id, ctx.before as Record<string, unknown>);
      toast.error(e instanceof ApiError ? e.message : String(e));
    },
    onSettled: () => {
      // Once nothing else is in flight, read the list again for anything
      // this write changed besides the one row (counts, a parent's face).
      if (qc.isMutating({ mutationKey: saveKey }) <= 1) invalidate();
    },
  });

  // The freshest copy of each record's plan data: what the last write sent,
  // until the read it set off brings it back. A width then a depth typed one
  // after the other, faster than a render, built the depth on the record as
  // the plan last READ it and sent the old width back with it (#5950). Every
  // write here starts from this, set in the same call that sends the write,
  // so the next one builds on it however quickly it follows.
  const pendingMeta = useRef(new Map<string, Record<string, unknown>>());
  const freshMeta = (key: string, read: Record<string, unknown> | null | undefined) => pendingMeta.current.get(key) ?? read ?? {};
  const rememberMeta = (key: string, metadata: Record<string, unknown>) => pendingMeta.current.set(key, metadata);
  /** The read caught up: let the record's own copy answer again, unless a
   *  newer write has replaced this one since. */
  const settleMeta = (key: string, metadata: Record<string, unknown>) => {
    if (pendingMeta.current.get(key) === metadata) pendingMeta.current.delete(key);
  };

  // Every write goes through the geometry seam (withRect / withBound /
  // withDecor), which keeps the rest of the blob: a drag never strips
  // decoration, and moving a toolbox on the floor never stretches its face.
  const rectFor = (loc: Location, rect: FpRect | null) => {
    const base = freshMeta(`place:${loc.id}`, loc.metadata);
    const laidOut = hasOwnLayout(base) || (placedByOwner.get(loc.id)?.length ?? 0) > 0;
    return withRect(base, rect, { keepFace: loc.kind !== "area" && laidOut });
  };
  const saveRect = (loc: Location, rect: FpRect | null) => {
    const base = freshMeta(`place:${loc.id}`, loc.metadata);
    const metadata = rectFor(loc, rect);
    const was = readRect(base);
    note(!rect ? `Took ${loc.name} off the plan` : !was ? `Put ${loc.name} on the plan` : was.rot !== rect.rot ? `Turned ${loc.name}` : was.x_mm === rect.x_mm && was.y_mm === rect.y_mm ? `Resized ${loc.name}` : `Moved ${loc.name}`, [
      { kind: "place", id: loc.id, before: { metadata: base }, after: { metadata } },
    ]);
    rememberMeta(`place:${loc.id}`, metadata);
    saveMeta.mutate({ id: loc.id, before: base, metadata });
  };
  /** One size of a placed location, onto its freshest rect. */
  const resizePlace = (loc: Location, patch: Partial<FpRect>) => {
    const rect = readRect(freshMeta(`place:${loc.id}`, loc.metadata));
    if (rect) saveRect(loc, { ...rect, ...patch });
  };
  /** Patch decoration keys (fill/outline) on a placed location's blob. */
  const patchLocFloorplan = (loc: Location, patch: Record<string, unknown>, previousGroup?: string) => {
    const base = freshMeta(`place:${loc.id}`, loc.metadata);
    const metadata = withDecor(base, patch);
    const before = previousGroup === undefined ? base : withDecor(base, { outline_tag_id: previousGroup });
    note(`Changed how ${loc.name} looks`, [{ kind: "place", id: loc.id, before: { metadata: before }, after: { metadata } }]);
    rememberMeta(`place:${loc.id}`, metadata);
    saveMeta.mutate({ id: loc.id, before: base, metadata });
  };
  const saveBound = (next: FpBound, label = `Changed the outline of ${room.name}`) => {
    const self = byId.get(room.id) ?? room;
    const base = freshMeta(`place:${room.id}`, self.metadata);
    const metadata = withBound(base, next, self.kind === "area" ? "area" : "container");
    note(label, [{ kind: "place", id: room.id, before: { metadata: base }, after: { metadata } }]);
    rememberMeta(`place:${room.id}`, metadata);
    saveMeta.mutate({ id: room.id, before: base, metadata });
  };
  /** One size of the room (or face) itself, onto its freshest outline. */
  const resizeBound = (patch: Partial<FpBound>) => {
    const self = byId.get(room.id) ?? room;
    const current = readBound(freshMeta(`place:${room.id}`, self.metadata));
    if (current) saveBound({ ...current, ...patch });
  };

  const rename = useMutation({
    mutationFn: (p: { id: string; name: string; was: string }) => api.updateLocation(slug, p.id, editOf({ name: p.was }, { name: p.name })),
    onSuccess: invalidate,
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  const reparent = useMutation({
    mutationFn: (p: { id: string; parent_id: string; label: string; was: string | null }) =>
      api.updateLocation(slug, p.id, editOf({ parent_id: p.was }, { parent_id: p.parent_id })),
    onSuccess: (_r, p) => {
      toast.success(`Moved into ${p.label}`);
      invalidate();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  // Entity writes resolve the kind's manifest-declared update endpoint from
  // the registry — never a hardcoded module route (the workspace-tools rule:
  // an undeclared kind is honestly not writable, not guessed at).
  const entityPath = (ent: PlanEntity): string | null => {
    const k = placeableKinds.find((pk) => pk.id === ent.kind);
    const tmpl = k?.endpoints?.update;
    if (!k || !tmpl) return null;
    return `/orgs/${slug}/${k.instance_name ? `instances/${k.instance_name}` : `modules/${k.module_name}`}${tmpl.replace("{id}", ent.id)}`;
  };
  const patchEntity = async (ent: PlanEntity, body: Record<string, unknown>) => {
    const path = entityPath(ent);
    if (!path) throw new ApiError(400, "not_writable", `${ent.kind} declares no update endpoint`);
    await api.request("PATCH", path, body);
  };
  /** Record a write to a thing on the plan: the full next value of each field
   *  it sets, and each as it was (undo and redo send the difference between
   *  the two, planHistory.ts). */
  const noteEntity = (label: string, ent: PlanEntity, body: Record<string, unknown>) => {
    const path = entityPath(ent);
    if (!path) return;
    const before: Record<string, unknown> = {};
    for (const k of Object.keys(body)) before[k] = k === "metadata" ? (ent.metadata ?? {}) : k === "location_id" ? ent.location_id : null;
    note(label, [{ kind: "record", path, before, after: body }]);
  };
  /** The listed thing as it is about to be, in the list it was read from, so
   *  the next edit builds on this one rather than on the copy the plan last
   *  read: a width, then a depth, typed one after the other, sent the width
   *  back as it was and kept only the depth (#5950). Places already did this
   *  (saveMeta's patchCached); things on the plan did not. */
  const patchEntityCached = (ent: PlanEntity, next: Record<string, unknown>) =>
    qc.setQueryData<{ items: Array<Record<string, unknown>> }>(["kind-list", slug, ent.kind], (old) =>
      old ? { ...old, items: old.items.map((r) => (r.id === ent.id ? { ...r, ...next } : r)) } : old,
    );
  const saveEntity = useMutation({
    mutationFn: (p: { ent: PlanEntity; body: Record<string, unknown>; label?: string; next?: Record<string, unknown> }) =>
      patchEntity(p.ent, p.body),
    onMutate: async (p) => {
      if (!p.next) return {};
      await qc.cancelQueries({ queryKey: ["kind-list", slug, p.ent.kind] });
      const was = qc.getQueryData<{ items: Array<Record<string, unknown>> }>(["kind-list", slug, p.ent.kind])?.items.find((r) => r.id === p.ent.id);
      patchEntityCached(p.ent, p.next);
      return { was };
    },
    onSuccess: async (_r, p) => {
      if (p.label) toast.success(p.label);
      await qc.invalidateQueries({ queryKey: ["kind-list", slug] });
      const sent = p.next?.metadata;
      if (sent && typeof sent === "object") settleMeta(`${p.ent.kind}:${p.ent.id}`, sent as Record<string, unknown>);
    },
    onError: (e, p, ctx) => {
      const sent = p.next?.metadata;
      if (sent && typeof sent === "object") settleMeta(`${p.ent.kind}:${p.ent.id}`, sent as Record<string, unknown>);
      if (ctx?.was) patchEntityCached(p.ent, ctx.was);
      toast.error(e instanceof ApiError ? e.message : String(e));
    },
  });
  const entKey = (ent: PlanEntity) => `${ent.kind}:${ent.id}`;
  /** A write to a thing's plan data, built on its freshest copy. */
  const saveEntityMeta = (ent: PlanEntity, label: string, change: (base: Record<string, unknown>) => Record<string, unknown>) => {
    const base = freshMeta(entKey(ent), ent.metadata);
    const metadata = change(base);
    noteEntity(label, { ...ent, metadata: base }, { metadata });
    rememberMeta(entKey(ent), metadata);
    saveEntity.mutate({ ent, body: { metadata: jsonbPatchBetween(base, metadata) }, next: { metadata } });
  };
  const saveEntityRect = (ent: PlanEntity, rect: FpRect | null) =>
    saveEntityMeta(ent, rect ? `Put ${ent.name} on the plan` : `Took ${ent.name} off the plan`, (base) => withRect(base, rect));
  /** One size of a thing on the plan, onto its freshest rect. */
  const resizeEntity = (ent: PlanEntity, patch: Partial<FpRect>) => {
    const rect = readRect(freshMeta(entKey(ent), ent.metadata));
    if (rect) saveEntityRect(ent, { ...rect, ...patch });
  };

  function startEntityDrag(e: React.PointerEvent, ent: PlanEntity, rect: FpRect, mode: "move" | "resize") {
    if (!edit || !bound) return;
    e.preventDefault();
    e.stopPropagation();
    setSel({ type: "entity", kind: ent.kind, id: ent.id });
    const scale = mmPerPx();
    const startX = e.clientX;
    const startY = e.clientY;
    const orig = { ...rect };
    let last = rect;
    const onMove = (ev: PointerEvent) => {
      const dx = (ev.clientX - startX) * scale;
      const dy = (ev.clientY - startY) * scale;
      const g = snapStep();
      const next =
        mode === "move"
          ? { ...orig, x_mm: snap(orig.x_mm + dx, g), y_mm: snap(orig.y_mm + dy, g) }
          : { ...orig, w_mm: snap(Math.max(g, orig.w_mm + dx), g), d_mm: snap(Math.max(g, orig.d_mm + dy), g) };
      last = clampRect(next, bound);
      setLive({ id: `${ent.kind}:${ent.id}`, rect: last });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setLive(null);
      if (last.x_mm !== rect.x_mm || last.y_mm !== rect.y_mm || last.w_mm !== rect.w_mm || last.d_mm !== rect.d_mm) {
        let rectToSave = last;
        let targetLocId = ent.location_id;
        if (mode === "move") {
          // Drop = re-file, entity edition: ANY placed location is a target
          // (bay, room, tote), smallest wins; landing in a space that owns
          // its own plan rebases into it.
          const targets = placed.map((pl) => ({ id: pl.loc.id, rect: pl.rect }));
          const cx = last.x_mm + last.w_mm / 2;
          const cy = last.y_mm + last.d_mm / 2;
          const zid = zoneAt(targets, cx, cy);
          targetLocId = zid ?? room.id;
          const tLoc = zid ? byId.get(zid) : null;
          const tBound = tLoc ? readBound(tLoc.metadata) : null;
          if (zid && tBound) {
            const region = targets.find((t) => t.id === zid)!.rect;
            rectToSave = rebaseRect(last, region, tBound);
          }
        }
        const base = freshMeta(entKey(ent), ent.metadata);
        const meta = withRect(base, rectToSave);
        const moved = targetLocId !== ent.location_id;
        const next = { metadata: meta, ...(moved ? { location_id: targetLocId } : {}) };
        noteEntity(moved ? `Moved ${ent.name} into ${byId.get(targetLocId!)?.name ?? room.name}` : mode === "move" ? `Moved ${ent.name}` : `Resized ${ent.name}`, { ...ent, metadata: base }, next);
        rememberMeta(entKey(ent), meta);
        saveEntity.mutate({
          ent,
          body: { metadata: jsonbPatchBetween(base, meta), ...(moved ? { location_id: targetLocId } : {}) },
          label: moved ? `Moved into ${byId.get(targetLocId!)?.name ?? room.name}` : undefined,
          next,
        });
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  // ── pointer plumbing: px ↔ mm ────────────────────────────────────
  const mmPerPx = () => {
    const el = planRef.current;
    if (!el || !bound) return 1;
    return bound.w_mm / el.getBoundingClientRect().width;
  };

  function startDrag(
    e: React.PointerEvent,
    loc: Location,
    rect: FpRect,
    mode: "move" | "resize",
  ) {
    if (!edit || !bound) return;
    e.preventDefault();
    e.stopPropagation();
    setSel({ type: "item", id: loc.id });
    const scale = mmPerPx();
    let startX = e.clientX;
    let startY = e.clientY;
    let atX = e.clientX;
    let atY = e.clientY;
    let orig = { ...rect };
    let last = rect;
    // A rack is turned a quarter while it is carried: R on a keyboard, or a
    // finger held still on it. It turns about its middle and stays inside.
    const canTurn = mode === "move" && loc.kind !== "area" && bound.view !== "front";
    let still = true;
    const turn = () => {
      const r = rotated(last, bound);
      if (!r) {
        toast.error(`${loc.name} is longer than ${room.name} is wide, so it cannot turn here.`);
        return;
      }
      orig = r;
      last = r;
      startX = atX;
      startY = atY;
      setLive({ id: loc.id, rect: r });
    };
    const onKey = (ev: KeyboardEvent) => {
      if (!isShortcut(ev, "turn")) return;
      ev.preventDefault();
      turn();
    };
    const hold = canTurn && e.pointerType === "touch" ? window.setTimeout(() => still && turn(), LONG_PRESS_MS) : null;
    const onMove = (ev: PointerEvent) => {
      atX = ev.clientX;
      atY = ev.clientY;
      if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) > 8) still = false;
      const dx = (ev.clientX - startX) * scale;
      const dy = (ev.clientY - startY) * scale;
      const g = snapStep();
      const next =
        mode === "move"
          ? { ...orig, x_mm: snap(orig.x_mm + dx, g), y_mm: snap(orig.y_mm + dy, g) }
          : { ...orig, w_mm: snap(Math.max(g, orig.w_mm + dx), g), d_mm: snap(Math.max(g, orig.d_mm + dy), g) };
      last = clampRect(next, bound);
      setLive({ id: loc.id, rect: last });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (canTurn) window.removeEventListener("keydown", onKey);
      if (hold !== null) window.clearTimeout(hold);
      setLive(null);
      if (last.x_mm !== rect.x_mm || last.y_mm !== rect.y_mm || last.w_mm !== rect.w_mm || last.d_mm !== rect.d_mm || last.rot !== rect.rot) {
        let rectToSave = last;
        // Drop = reparent: the plan is the filing UI. Containers only —
        // zones/rooms never re-file themselves.
        if (mode === "move" && loc.kind !== "area") {
          const cx = last.x_mm + last.w_mm / 2;
          const cy = last.y_mm + last.d_mm / 2;
          const zid = zoneAt(zones.filter((z) => z.id !== loc.id), cx, cy);
          const target = zid ?? room.id;
          const targetLoc = zid ? byId.get(zid) : null;
          const targetBound = targetLoc ? readBound(targetLoc.metadata) : null;
          if (zid && targetBound) {
            // Dropped into a space that owns its OWN plan (a room): the item
            // moves to that plan, so its coords rebase into the room's local
            // space — same physical spot, now on the room's canvas.
            const region = zones.find((z) => z.id === zid)!.rect;
            rectToSave = rebaseRect(last, region, targetBound);
          }
          if (target !== loc.parent_id) {
            const label = zid ? (targetLoc?.name ?? "zone") : room.name;
            // The move and the re-file are one step: undo puts it back in
            // its old place on its old parent, together.
            const base = freshMeta(`place:${loc.id}`, loc.metadata);
            const metadata = rectFor(loc, rectToSave);
            note(`Moved ${loc.name} into ${label}`, [
              { kind: "place", id: loc.id, before: { parent_id: loc.parent_id, metadata: base }, after: { parent_id: target, metadata } },
            ]);
            reparent.mutate({ id: loc.id, parent_id: target, label, was: loc.parent_id });
            rememberMeta(`place:${loc.id}`, metadata);
            saveMeta.mutate({ id: loc.id, before: base, metadata });
            return;
          }
        }
        saveRect(loc, rectToSave);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    if (canTurn) window.addEventListener("keydown", onKey);
  }

  /** A door or a window on one of the room's own walls (the edge is a wall
   *  of its own once something is in it), or a closet against it. */
  const addOnWall = (side: Edge, what: "door" | "window" | "closet") => {
    if (!bound) return;
    if (what === "closet") {
      void addCloset(side);
      return;
    }
    const across = side === "top" || side === "bottom";
    const along = across ? bound.w_mm : bound.d_mm;
    const list = [...(bound.walls ?? [])];
    let idx = list.findIndex((w) => edgeOf(w, bound) === side && Math.abs(Math.abs(across ? w.x2 - w.x1 : w.y2 - w.y1) - along) < 1);
    if (idx < 0) {
      list.push(
        side === "top" ? { x1: 0, y1: 0, x2: bound.w_mm, y2: 0 }
        : side === "bottom" ? { x1: 0, y1: bound.d_mm, x2: bound.w_mm, y2: bound.d_mm }
        : side === "left" ? { x1: 0, y1: 0, x2: 0, y2: bound.d_mm }
        : { x1: bound.w_mm, y1: 0, x2: bound.w_mm, y2: bound.d_mm },
      );
      idx = list.length - 1;
    }
    const wall = list[idx]!;
    const o = newOpening(wall, bound, what);
    list[idx] = { ...wall, openings: [...(wall.openings ?? []), { ...o, at_mm: Math.max(0, snap((along - o.w_mm) / 2)) }] };
    saveBound({ ...bound, walls: list }, `Added ${withArticle(what)} to the ${side} wall`);
    setSel({ type: "wall", idx });
  };

  /** A closet against one of the room's walls: an ordinary part of the room
   *  (things put in it are filed in it), drawn with its walls and a door. */
  const addCloset = async (side: Edge) => {
    if (!bound) return;
    const across = side === "top" || side === "bottom";
    const along = across ? bound.w_mm : bound.d_mm;
    const deep = across ? bound.d_mm : bound.w_mm;
    const len = Math.max(SNAP_MM, Math.min(1500, snap(along * 0.4)));
    const depth = Math.max(SNAP_MM, Math.min(750, snap(deep / 3)));
    const box: FpRect =
      side === "top" ? { x_mm: snap((bound.w_mm - len) / 2), y_mm: 0, w_mm: len, d_mm: depth }
      : side === "bottom" ? { x_mm: snap((bound.w_mm - len) / 2), y_mm: bound.d_mm - depth, w_mm: len, d_mm: depth }
      : side === "left" ? { x_mm: 0, y_mm: snap((bound.d_mm - len) / 2), w_mm: depth, d_mm: len }
      : { x_mm: bound.w_mm - depth, y_mm: snap((bound.d_mm - len) / 2), w_mm: depth, d_mm: len };
    const taken = new Set(items.filter((l) => l.parent_id === room.id).map((l) => l.name.toLowerCase()));
    let name = "Closet";
    for (let i = 2; taken.has(name.toLowerCase()); i++) name = `Closet ${i}`;
    try {
      const made = await api.createLocation(slug, { name, parent_id: room.id, kind: "area", metadata: withDecor(withRect({}, box), { closet: { door_mm: 760 } }) });
      history.record({ label: `Added ${name}`, changes: [{ kind: "added", id: made.id }] });
      toast.success(`${name} is against the ${side} wall`);
      invalidate();
      setSel({ type: "item", id: made.id });
    } catch (e) {
      toast.error(`Could not add the closet: ${e instanceof ApiError ? e.message : String(e)}`);
    }
  };

  /** The selected rack turned a quarter where it stands (the panel's Turn). */
  const turnPlace = (loc: Location) => {
    const r = readRect(loc.metadata);
    if (!r || !bound) return;
    const next = rotated(r, bound);
    if (!next) toast.error(`${loc.name} is longer than ${room.name} is wide, so it cannot turn here.`);
    else saveRect(loc, next);
  };

  function startWallDrag(e: React.PointerEvent, idx: number) {
    if (!edit || !bound) return;
    e.preventDefault();
    e.stopPropagation();
    setSel({ type: "wall", idx });
    const wall = bound.walls?.[idx];
    if (!wall) return;
    const scale = mmPerPx();
    const startX = e.clientX;
    const startY = e.clientY;
    const vertical = wall.x1 === wall.x2;
    let last = wall;
    const onMove = (ev: PointerEvent) => {
      const d = vertical ? (ev.clientX - startX) * scale : (ev.clientY - startY) * scale;
      const moved = vertical
        ? { ...wall, x1: snap(Math.max(0, Math.min(bound.w_mm, wall.x1 + d))), x2: snap(Math.max(0, Math.min(bound.w_mm, wall.x2 + d))) }
        : { ...wall, y1: snap(Math.max(0, Math.min(bound.d_mm, wall.y1 + d))), y2: snap(Math.max(0, Math.min(bound.d_mm, wall.y2 + d))) };
      last = moved;
      setLiveWall({ idx, wall: moved });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setLiveWall(null);
      if (last !== wall) {
        const walls = [...(bound.walls ?? [])];
        walls[idx] = last;
        saveBound({ ...bound, walls }, "Moved a wall");
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  // ── empty state ──────────────────────────────────────────────────
  const defaultView = room.kind === "container" ? "front" : "plan";
  if (!bound) {
    return (
      <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 space-y-2">
        <SectionHead room={room} edit={false} />
        <p className="text-sm text-muted dark:text-slate-400 max-w-prose">
          {room.kind === "container"
            ? "Lay out this container's face: drawers and compartments drawn at true scale, partial-width ones visibly partial."
            : "Draw this space to scale: walls, zones, and everything standing in it. Dimensions only set the shape; the day-to-day view shows no numbers."}
        </p>
        <div className="flex gap-2 flex-wrap">
          <BoundSetup
            unitDefault={room.kind === "container" ? "in" : "ft"}
            view={defaultView}
            initialW={readRect(room.metadata) ? formatLength(readRect(room.metadata)!.w_mm, room.kind === "container" ? "in" : "ft") : ""}
            onSet={(b) => saveBound(b)}
          />
          {room.kind === "area" && (
            <button
              type="button"
              onClick={() => setSeedOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-md border border-line dark:border-slate-600 px-3 py-1.5 text-sm text-content hover:border-accent hover:text-accent transition"
            >
              <Sparkles size={14} /> Describe it instead
            </button>
          )}
          {onAddFloor && (
            <button
              type="button"
              onClick={onAddFloor}
              title="A house or multi-level building: each floor gets its own plan behind a tab"
              className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-line dark:border-slate-600 px-3 py-1.5 text-sm text-muted hover:border-accent hover:text-accent transition"
            >
              <Plus size={14} /> Split into floors
            </button>
          )}
        </div>
        {seedOpen && (
          <SeedModal room={room} slug={slug} onClose={() => setSeedOpen(false)} onApplied={invalidate} onStep={(step) => history.record(step)} />
        )}
      </section>
    );
  }

  const unit: LengthUnit = bound.unit ?? "ft";
  const view = bound.view ?? defaultView;
  const grid = snapStep();
  const walls = liveWall
    ? (bound.walls ?? []).map((w, i) => (i === liveWall.idx ? liveWall.wall : w))
    : (bound.walls ?? []);
  // A closet's walls are drawn from where the closet stands, so they follow
  // it while it is dragged and go with it when it is taken off the plan.
  const allWalls = roomWalls(
    { ...bound, walls },
    zoneRegions.map((z) => ({ id: z.id, box: live?.id === z.id ? live.rect : z.rect, closet: readCloset(byId.get(z.id)?.metadata?.floorplan) })),
  );
  // What stands on this floor, for what is in a door's way, in front of a
  // window, and the gaps while one is dragged. A rack's height is its face's.
  const floorItems: PlanItem[] = onFloor
    ? [
        ...placed
          .filter((p) => p.loc.kind !== "area" && !p.rect.wall_mounted)
          .map((p) => ({
            id: p.loc.id,
            name: p.loc.name,
            box: live?.id === p.loc.id ? live.rect : p.rect,
            h_mm: hasOwnLayout(p.loc.metadata) ? (readBound(p.loc.metadata)?.d_mm ?? null) : null,
            holds: true,
          })),
        ...sized.things.filter((t) => !t.shelfId).map((t) => ({ id: t.key, name: t.name, box: live?.id === t.key ? live.rect : t.rect, h_mm: t.size.h_mm ?? null })),
      ]
    : [];
  const flags = onFloor ? planFlags({ room: { ...bound, walls: allWalls }, items: floorItems }) : [];
  const flagsOf = (id: string) => flags.filter((f) => f.ids.includes(id));

  const fitWidth = viewportPx > 0
    ? Math.min(viewportPx, bound.view === "front" && sized.fits.length > 0
      ? 512 : heightCap != null ? Math.round(heightCap * bound.w_mm / bound.d_mm) : viewportPx)
    : null;
  const fitPlan = () => {
    setZoom(1);
    viewportRef.current?.scrollTo?.({ left: 0, top: 0 });
  };

  const content = (
    <div className="space-y-3">
      <SectionHead room={room} edit={edit} title={headTitle}>
        <span className="inline-flex items-center gap-1" data-testid="plan-zoom">
          <button
            type="button"
            aria-label="Zoom out"
            title="Zoom out"
            disabled={zoom === 1}
            onClick={() => setZoom((v) => Math.max(1, v / 2))}
            className="min-h-11 min-w-11 inline-flex items-center justify-center rounded-md border border-line text-muted hover:text-content disabled:opacity-40"
          >
            <ZoomOut size={16} />
          </button>
          <button
            type="button"
            aria-label="Zoom in"
            title="Zoom in"
            disabled={zoom === 16}
            onClick={() => setZoom((v) => Math.min(16, v * 2))}
            className="min-h-11 min-w-11 inline-flex items-center justify-center rounded-md border border-line text-muted hover:text-content disabled:opacity-40"
          >
            <ZoomIn size={16} />
          </button>
          <button
            type="button"
            title="Fit the whole plan"
            onClick={fitPlan}
            className="min-h-11 min-w-11 rounded-md border border-line px-2 text-xs text-muted hover:text-content"
          >
            Fit
          </button>
        </span>
        {!placing && (
        <>
        <button
          type="button"
          onClick={() => setShowZones((z) => !z)}
          className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition ${showZones ? "border-accent text-accent" : "border-line dark:border-slate-600 text-muted hover:text-content"}`}
          title="Toggle faint zone labels"
        >
          <Tag size={12} /> zones
        </button>
        <button
          type="button"
          onClick={() => setHeat((h) => !h)}
          className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition ${heat ? "border-amber-500 text-amber-600 dark:text-amber-400" : "border-line dark:border-slate-600 text-muted hover:text-content"}`}
          title="Shade every box by how much is stored in it"
        >
          <Flame size={12} /> heat
        </button>
        <button
          type="button"
          aria-pressed={gridOn}
          onClick={() => saveBound({ ...bound, grid_on: !gridOn }, gridOn ? `Turned the grid off on ${room.name}` : `Turned the grid on on ${room.name}`)}
          className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition ${gridOn ? "border-accent text-accent" : "border-line dark:border-slate-600 text-muted hover:text-content"}`}
          title="A grid to place things by, remembered on this plan"
        >
          <Grid3x3 size={12} /> grid{gridOn && pitch ? ` · ${pitch.label}` : ""}
        </button>
        {groupable.length > 0 && pins.length > 0 && (
          <label className="inline-flex items-center gap-1 rounded-md border border-line dark:border-slate-600 px-2 py-0.5 text-xs text-muted">
            group
            <select
              aria-label="Group pinned things by"
              value={groupField?.name ?? ""}
              onChange={(e) =>
                saveBound({ ...bound, group_by: e.target.value || undefined }, e.target.value ? `Grouped ${room.name} by ${groupable.find((f) => f.name === e.target.value)?.label ?? e.target.value}` : `Stopped grouping ${room.name}`)
              }
              className="bg-transparent text-xs text-content dark:text-slate-200"
            >
              <option value="">none</option>
              {groupable.map((f) => (
                <option key={f.name} value={f.name}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          type="button"
          onClick={() => navigate(`/scan/camera?bin=${room.id}`)}
          className="inline-flex items-center gap-1 rounded-md border border-line dark:border-slate-600 px-2 py-1 text-xs text-muted hover:text-accent hover:border-accent transition"
          title={`Open the scanner filing into ${room.name}`}
        >
          <ScanLine size={12} /> scan into
        </button>
        <button
          type="button"
          onClick={() => window.open(`/print/${slug}/locations/${room.id}`, "_blank", "noopener")}
          className="inline-flex items-center gap-1 rounded-md border border-line dark:border-slate-600 px-2 py-1 text-xs text-muted hover:text-accent hover:border-accent transition"
          title="Print-friendly plan in a new tab"
        >
          <Printer size={12} /> print
        </button>
        {room.kind === "area" && bound.view !== "front" && (
          <Link
            to={`/locations/${room.id}/plan`}
            className="inline-flex items-center gap-1 rounded-md border border-line dark:border-slate-600 px-2 py-1 text-xs text-muted hover:text-accent hover:border-accent transition"
            title="Try a layout as a draft: nothing moves until you apply it"
          >
            <LayoutGrid size={12} /> Plan a layout
          </Link>
        )}
        </>
        )}
        {edit && (
          <>
            <button
              type="button"
              onClick={() => {
                const w: FpWall = {
                  x1: snap(bound.w_mm / 2),
                  y1: 0,
                  x2: snap(bound.w_mm / 2),
                  y2: snap(bound.d_mm * 0.7),
                };
                saveBound({ ...bound, walls: [...(bound.walls ?? []), w] }, "Added a wall");
                setSel({ type: "wall", idx: (bound.walls ?? []).length });
              }}
              className="rounded-md border border-line dark:border-slate-600 px-2 py-1 text-xs text-muted hover:text-content transition"
            >
              + wall
            </button>
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="rounded-md border border-line dark:border-slate-600 px-2 py-1 text-xs text-muted hover:text-content transition"
            >
              + location
            </button>
            <button
              type="button"
              onClick={() => setDrawersOpen(true)}
              title="Arrange the drawers this place has, or make a set of drawers or bins in one go"
              className="rounded-md border border-line dark:border-slate-600 px-2 py-1 text-xs text-muted hover:text-content transition"
            >
              + drawers
            </button>
            <button
              type="button"
              onClick={() => setSeedOpen(true)}
              className="inline-flex items-center gap-1 rounded-md border border-line dark:border-slate-600 px-2 py-1 text-xs text-muted hover:text-accent transition"
            >
              <Sparkles size={12} /> describe
            </button>
          </>
        )}
        {edit && (
          <span className="inline-flex" data-history={historyTick}>
            <button
              type="button"
              aria-label="Undo"
              title={history.nextUndo() ? `Undo: ${history.nextUndo()!.label} (⌘Z)` : "Nothing to undo"}
              disabled={!history.canUndo()}
              onClick={() => void runHistory("undo")}
              className="rounded-l-md border border-line dark:border-slate-600 px-2 py-1 text-muted hover:text-content disabled:opacity-40 transition"
            >
              <Undo2 size={13} />
            </button>
            <button
              type="button"
              aria-label="Redo"
              title={history.nextRedo() ? `Redo: ${history.nextRedo()!.label} (⌘⇧Z)` : "Nothing to redo"}
              disabled={!history.canRedo()}
              onClick={() => void runHistory("redo")}
              className="-ml-px rounded-r-md border border-line dark:border-slate-600 px-2 py-1 text-muted hover:text-content disabled:opacity-40 transition"
            >
              <Redo2 size={13} />
            </button>
          </span>
        )}
        {!placing && (
        // COLOUR-NOT-STATE: the label itself turns to a check and Done while editing.
        <button
          type="button"
          onClick={() => {
            setEdit((v) => !v);
            setSel(null);
          }}
          className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition ${edit ? "bg-cobble-600 hover:bg-cobble-700 text-white" : "border border-line dark:border-slate-600 text-muted hover:text-content"}`}
        >
          {edit ? (
            <>
              <Check size={13} /> Done
            </>
          ) : (
            <>
              <Pencil size={12} /> Edit layout
            </>
          )}
        </button>
        )}
      </SectionHead>

      {/* ── tray: this place's own children not drawn yet, above the plan
          so it is seen before anything is drawn. A tap puts one at the
          first free spot (a drawer: the next row down). ── */}
      {tray.length > 0 && !placing && (
        <div className="flex items-center gap-1.5 flex-wrap text-xs text-muted dark:text-slate-400" data-testid="plan-tray">
          <span>Not drawn yet, tap to put on the plan:</span>
          {tray.map((l) => (
            <button
              key={l.id}
              type="button"
              onClick={() => saveRect(l, newChildRect({ ...bound, view }, taken))}
              className="rounded-md border border-line dark:border-slate-700 bg-subtle dark:bg-slate-800 px-2 py-0.5 text-content dark:text-slate-300 hover:border-accent transition"
            >
              {l.name}
            </button>
          ))}
          {view === "front" && ownContainers.length > 1 && (
            <button
              type="button"
              onClick={() => {
                setEdit(true);
                setDrawersOpen(true);
              }}
              className="rounded-md border border-dashed border-accent text-accent px-2 py-0.5 font-medium"
            >
              Arrange all {ownContainers.length} as drawers
            </button>
          )}
        </div>
      )}

      {/* ── the plan ── */}
      <div
        ref={viewportRef}
        data-testid="plan-viewport"
        className="max-w-full overflow-auto"
        style={zoom > 1 ? { maxHeight: heightCap ?? `${capVh}dvh` } : undefined}
      >
      <div
        ref={planRef}
        data-grid={gridOn && pitch ? pitch.label : undefined}
        // A rack's face with things on its shelves is drawn wide enough to
        // read (a phone's whole width, at most 32rem), and the page scrolls
        // down it: three printers on a shelf stay readable instead of the
        // face shrinking until the whole rack fits the screen.
        className={`relative mx-auto border-2 border-slate-400 dark:border-slate-500 rounded bg-subtle/40 dark:bg-[#0d1526] select-none ${zoom === 1 && bound.view === "front" && sized.fits.length > 0 ? "!w-[min(100%,32rem)]" : ""} ${gridOn ? "bg-[linear-gradient(to_right,rgba(100,116,139,.22)_1px,transparent_1px),linear-gradient(to_bottom,rgba(100,116,139,.22)_1px,transparent_1px)]" : edit ? "bg-[radial-gradient(circle,rgba(100,116,139,.25)_1px,transparent_1px)]" : ""}`}
        style={{
          aspectRatio: `${bound.w_mm} / ${bound.d_mm}`,
          // The whole room on one screen: as wide as it can be while its
          // bottom wall stays above the fold, measured from where it starts.
          width:
            fitWidth != null ? fitWidth * zoom : heightCap != null
              ? `min(100%, ${Math.round(heightCap * (bound.w_mm / bound.d_mm))}px)`
              : `min(100%, calc(${capVh}dvh * ${(bound.w_mm / bound.d_mm).toFixed(4)}))`,
          // Edit-mode dots sit at the layout's REAL pitch — a 42mm Gridfinity
          // drawer shows its actual cells, not a decorative texture.
          ...(edit || gridOn
            ? { backgroundSize: `${(grid / bound.w_mm) * 100}% ${(grid / bound.d_mm) * 100}%` }
            : {}),
        }}
        onPointerDown={() => edit && setSel(null)}
        {...(placing ? { [PLACE_TARGET]: room.id, [PLACE_PLAN]: placePlanValue(bound.w_mm, bound.d_mm, gridOn ? grid : null) } : {})}
        onClick={(e) => {
          // The bare floor: right here, at this spot.
          if (e.target === e.currentTarget) setPinPeek(null);
          if (placing && e.target === e.currentTarget) placing.pick(room.id, placing.armed ? pinAt(e.currentTarget, e.clientX, e.clientY) : null);
        }}
      >
        {/* "Nothing drawn" only when the place holds nothing at all, and only
            once its contents are known: a drawer with sockets pinned in it
            said "Nothing drawn in Sockets drawer yet" over the pins (#4562). */}
        {placed.length === 0 && placedOccupants.length === 0 && !placing && held.isSuccess && (held.data?.items ?? []).length === 0 && (
          <div className="absolute inset-0 grid place-items-center p-4 pointer-events-none" data-testid="plan-empty-hint">
            <p className="max-w-xs text-center text-xs text-muted dark:text-slate-400">
              {edit
                ? view === "front"
                  ? "Nothing on this face yet. + drawers makes a set, or + location adds one."
                  : `Nothing stands in ${room.name} yet. + location adds a shelf, a bench or a toolbox.`
                : `Nothing drawn in ${room.name} yet. Tap Edit to add what is in it.`}
            </p>
          </div>
        )}
        {/* A drawer or bin seen from above has no walls or door to tell its
            front from its back, and a phone held either way reads it upside
            down. The near edge is the front: say so on both edges. */}
        {room.kind === "container" && view === "plan" && (
          <>
            <span data-testid="plan-edge-back" className="pointer-events-none absolute top-0.5 left-1/2 -translate-x-1/2 text-[9px] uppercase tracking-wide text-faint dark:text-slate-500">
              back
            </span>
            <span data-testid="plan-edge-front" className="pointer-events-none absolute bottom-0 left-0 right-0 h-1.5 bg-slate-400/70 dark:bg-slate-500/70" />
            <span className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 text-[9px] uppercase tracking-wide text-faint dark:text-slate-500">
              front
            </span>
          </>
        )}
        {/* walls, minus their door openings */}
        {walls.map((w, idx) =>
          wallSegments(w).map((s, si) => {
            const vertical = s.x1 === s.x2;
            return (
              <div
                key={`w${idx}-${si}`}
                onPointerDown={(e) => startWallDrag(e, idx)}
                className={`absolute bg-slate-500 dark:bg-slate-400 rounded-sm ${edit ? "cursor-ew-resize touch-none" : ""} ${sel?.type === "wall" && sel.idx === idx ? "ring-1 ring-accent" : ""}`}
                style={
                  vertical
                    ? { left: pct(s.x1, bound.w_mm), top: pct(s.y1, bound.d_mm), width: 4, height: pct(s.y2 - s.y1, bound.d_mm), transform: "translateX(-2px)" }
                    : { left: pct(s.x1, bound.w_mm), top: pct(s.y1, bound.d_mm), height: 4, width: pct(s.x2 - s.x1, bound.w_mm), transform: "translateY(-2px)" }
                }
              />
            );
          }),
        )}
        {/* windows, doors with their swing, and a closet's walls */}
        <PlanSymbols room={bound} walls={allWalls} boxes={floorItems.map((i) => i.box)} solid={(w) => !!w.closet} />

        {/* ROOMS — placed areas that own their own plan: visible rects that
            drill into their plan (peek modal) in view mode. Distinct from
            zone annotations (below) and from containers: subtle fill, name
            pinned to the top-left corner, room-y. */}
        {roomsOnPlan.map(({ loc, rect }) => {
          const r = live?.id === loc.id ? live.rect : rect;
          const selected = sel?.type === "item" && sel.id === loc.id;
          return (
            <div
              key={loc.id}
              onPointerDown={(e) => startDrag(e, loc, r, "move")}
              onClick={(e) => {
                if (edit) {
                  e.stopPropagation();
                  setSel({ type: "item", id: loc.id });
                } else if (placing?.armed) {
                  e.stopPropagation();
                  placing.pick(loc.id);
                } else setPeekId(loc.id);
              }}
              {...(placing ? { [PLACE_TARGET]: loc.id } : {})}
              title={`${loc.name}: open its plan`}
              className={`absolute rounded border border-slate-400 dark:border-slate-500 bg-slate-500/10 dark:bg-slate-400/10
                ${edit ? "cursor-move touch-none" : "cursor-pointer hover:border-accent"}
                ${selected ? "ring-1 ring-accent border-accent" : ""}
                ${placing?.over === loc.id ? "ring-2 ring-accent border-accent bg-cobble-500/10" : ""}`}
              style={{
                left: pct(r.x_mm, bound.w_mm),
                top: pct(r.y_mm, bound.d_mm),
                width: pct(r.w_mm, bound.w_mm),
                height: pct(r.d_mm, bound.d_mm),
              }}
            >
              <span className="absolute inset-0 pointer-events-none rounded" style={heatStyle(loc.id)} />
              {/* Big-screen deep render: a room rect wide enough on screen
                  previews its OWN plan's contents as static minis (its
                  children's coords are in the room's space — scale them into
                  this rect). Non-interactive; click still zooms. */}
              {(() => {
                if (edit) return null;
                const el = planRef.current;
                const pxW = el ? (r.w_mm / bound.w_mm) * el.getBoundingClientRect().width : 0;
                const rb = readBound(loc.metadata);
                if (!rb || pxW < 240) return null;
                return (placedByOwner.get(loc.id) ?? []).map((m) => (
                  <span
                    key={m.loc.id}
                    className="absolute border border-slate-400/60 dark:border-slate-500/50 bg-slate-300/25 dark:bg-slate-600/25 rounded-[2px] overflow-hidden text-[8px] leading-none text-muted dark:text-slate-400 pointer-events-none px-0.5"
                    style={{
                      left: pct(m.rect.x_mm, rb.w_mm),
                      top: pct(m.rect.y_mm, rb.d_mm),
                      width: pct(m.rect.w_mm, rb.w_mm),
                      height: pct(m.rect.d_mm, rb.d_mm),
                    }}
                  >
                    {pxW > 380 ? (m.loc.short_name || m.loc.name) : ""}
                  </span>
                ));
              })()}
              <span className="absolute top-0.5 left-1.5 text-[10px] font-medium text-content dark:text-slate-300 truncate max-w-full pr-1">
                {loc.name}
              </span>
              {heatBadge(loc.id)}
              {placeBadge(loc.id)}
              {selected && edit && (
                <span
                  onPointerDown={(e) => startDrag(e, loc, r, "resize")}
                  className="absolute -right-1 -bottom-1 w-2.5 h-2.5 bg-accent rounded-sm cursor-nwse-resize touch-none [@media(pointer:coarse)]:w-5 [@media(pointer:coarse)]:h-5"
                />
              )}
            </div>
          );
        })}

        {/* zone regions (areas with NO plan of their own): faint labels
            (toggle); dashed rects in edit mode */}
        {zoneRegions.map((z) => {
          const r = live?.id === z.id ? live.rect : z.rect;
          return (
            <div key={z.id}>
              {placing && !edit && (
                <div
                  {...{ [PLACE_TARGET]: z.id }}
                  onClick={(e) => {
                    e.stopPropagation();
                    placing.pick(z.id);
                  }}
                  title={z.name}
                  className={`absolute border border-dashed rounded cursor-pointer ${placing.over === z.id ? "ring-2 ring-accent border-accent bg-cobble-500/10" : "border-slate-400/50 dark:border-slate-500/40 hover:border-accent"}`}
                  style={{ left: pct(r.x_mm, bound.w_mm), top: pct(r.y_mm, bound.d_mm), width: pct(r.w_mm, bound.w_mm), height: pct(r.d_mm, bound.d_mm) }}
                >
                  {placeBadge(z.id)}
                </div>
              )}
              {edit && (
                <div
                  onPointerDown={(e) => {
                    const loc = byId.get(z.id);
                    if (loc) startDrag(e, loc, r, "move");
                  }}
                  className={`absolute border border-dashed border-slate-400/50 dark:border-slate-500/40 rounded cursor-move touch-none ${sel?.type === "item" && sel.id === z.id ? "ring-1 ring-accent/60" : ""}`}
                  style={{ left: pct(r.x_mm, bound.w_mm), top: pct(r.y_mm, bound.d_mm), width: pct(r.w_mm, bound.w_mm), height: pct(r.d_mm, bound.d_mm) }}
                >
                  {sel?.type === "item" && sel.id === z.id && (
                    <span
                      onPointerDown={(e) => {
                        const loc = byId.get(z.id);
                        if (loc) startDrag(e, loc, r, "resize");
                      }}
                      className="absolute -right-1 -bottom-1 w-2.5 h-2.5 bg-accent rounded-sm cursor-nwse-resize touch-none [@media(pointer:coarse)]:w-5 [@media(pointer:coarse)]:h-5"
                    />
                  )}
                </div>
              )}
              {(showZones || edit || placing || !!readCloset(byId.get(z.id)?.metadata?.floorplan)) && (
                <span
                  data-zone-label={z.name}
                  className="absolute text-[10px] uppercase tracking-[.2em] text-cobble-600/40 dark:text-cobble-300/30 pointer-events-none -translate-x-1/2 -translate-y-1/2"
                  style={{ left: pct(r.x_mm + r.w_mm / 2, bound.w_mm), top: pct(r.y_mm + r.d_mm / 2, bound.d_mm) }}
                >
                  {z.name}
                </span>
              )}
            </div>
          );
        })}

        {/* placed containers — area-descending so overlapping rects keep
            the smaller one clickable on top (the interlocked wrench sets) */}
        {placed
          .filter((p) => p.loc.kind !== "area")
          .sort(byAreaDesc)
          .map(({ loc, rect }) => {
            const r = live?.id === loc.id ? live.rect : rect;
            const el = planRef.current;
            const pxW = el ? (r.w_mm / bound.w_mm) * el.getBoundingClientRect().width : 100;
            const pxH = el ? (r.d_mm / bound.d_mm) * el.getBoundingClientRect().height : 100;
            // Street-name rule: a narrow vertical box reads along its long axis.
            const rotate = r.wall_mounted ? pxW < 40 : pxW < 56 && pxH > pxW * 1.4;
            const selected = sel?.type === "item" && sel.id === loc.id;
            const inTheWay = flagsOf(loc.id);
            const front = edit && onFloor && !r.wall_mounted ? frontEdge(r.rot) : null;
            return (
              <button
                type="button"
                aria-label={inTheWay.length ? `${loc.name}: ${inTheWay.map((f) => f.text).join("; ")}` : loc.name}
                key={loc.id}
                onPointerDown={(e) => startDrag(e, loc, r, "move")}
                onClick={(e) => {
                  if (edit) {
                    e.stopPropagation();
                    setSel({ type: "item", id: loc.id });
                  } else if (placing && (placing.armed || !readBound(loc.metadata))) {
                    // Put what is picked up here, or show what is in it; a
                    // container with its own layout still opens it to reach
                    // its drawers.
                    e.stopPropagation();
                    placing.pick(loc.id);
                  } else if (readBound(loc.metadata)) {
                    // Owns its own layout (a toolbox face) → zoom in place.
                    setPeekId(loc.id);
                  } else navigate(`/locations/${loc.id}`);
                }}
                title={inTheWay.length ? `${loc.name}: ${inTheWay.map((f) => f.text).join("; ")}` : loc.name}
                {...(placing ? { [PLACE_TARGET]: loc.id } : {})}
                data-collides={colliding.has(loc.id) ? "true" : undefined}
                data-in-the-way={inTheWay.length ? inTheWay.map((f) => f.kind).join(" ") : undefined}
                data-rot={r.rot}
                data-plan-colour={outlines.get(loc.id)?.tagId ? outlines.get(loc.id)?.colour ?? undefined : planColourOf(loc.metadata) ?? undefined}
                data-plan-tag={outlines.get(loc.id)?.tagId}
                className={`absolute rounded overflow-hidden text-left content-start focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent text-[11px] leading-tight px-1 py-0.5
                  ${r.wall_mounted ? "bg-slate-200/80 dark:bg-slate-700/70" : "bg-white dark:bg-slate-800"}
                  ${outlines.get(loc.id)?.border ?? "border border-slate-400 dark:border-slate-500"} text-content dark:text-slate-200
                  ${edit ? "cursor-move touch-none" : "cursor-pointer hover:border-accent hover:text-accent"}
                  ${colliding.has(loc.id) ? "border-dashed !border-ember-500 ring-1 ring-ember-500/60" : ""}
                  ${inTheWay.some(flagIsRed) ? "!border-ember-500 ring-2 ring-ember-500/60" : inTheWay.length ? "ring-2 ring-amber-500/60" : ""}
                  ${front ? FRONT_EDGE[front] : ""}
                  ${selected ? "ring-1 ring-accent border-accent" : ""}
                  ${placing?.over === loc.id ? "ring-2 ring-accent border-accent" : ""}`}
                style={{
                  borderColor: outlines.get(loc.id)?.colour ?? undefined,
                  left: pct(r.x_mm, bound.w_mm),
                  top: pct(r.y_mm, bound.d_mm),
                  width: pct(r.w_mm, bound.w_mm),
                  height: pct(r.d_mm, bound.d_mm),
                  ...(rotate ? { writingMode: "vertical-rl" as const } : {}),
                }}
              >
                <RectDecor imagePath={loc.image_path} fp={loc.metadata?.floorplan as Record<string, unknown> | undefined} />
                <span
                  className="absolute inset-0 pointer-events-none rounded"
                  style={{ ...(heatStyle(loc.id) ?? {}), ...(rotate ? { writingMode: "horizontal-tb" as const } : {}) }}
                />
                {/* On a face, a shelf's name is the first line of its label band
                    (a button would centre it, under the things on the shelf). */}
                <span
                  className={bound.view === "front" ? "absolute left-1 top-0.5 max-w-[calc(100%-0.5rem)] truncate leading-[13px]" : "relative break-words"}
                  data-face-text={bound.view === "front" ? "" : undefined}
                >
                  {pxW < 30 && pxH < 30
                    ? (loc.short_name || "·")
                    : loc.short_name && pxW < 90 && !rotate
                      ? loc.short_name
                      : bound.view === "front"
                        ? nameUnder(loc.name, room.name)
                        : loc.name}
                </span>
                {heatBadge(loc.id)}
                {placeBadge(loc.id)}
                {selected && edit && (
                  <span
                    onPointerDown={(e) => startDrag(e, loc, r, "resize")}
                    className="absolute -right-0.5 -bottom-0.5 w-2.5 h-2.5 bg-accent rounded-sm cursor-nwse-resize touch-none [@media(pointer:coarse)]:w-5 [@media(pointer:coarse)]:h-5"
                    style={rotate ? { writingMode: "horizontal-tb" } : undefined}
                  />
                )}
              </button>
            );
          })}

        {pins.filter((t) => !sized.sizedPinKeys.has(`${t.kind}:${t.id}`)).map((t) => {
          // A pin says what it is, on the plan and not only on hover: a bare
          // pin on the floor was a question nobody could answer (#4147).
          const holds = holdsLabel(t.kind, t.id);
          const name = holds ? `${pinName(t, placeable)} · ${holds}` : pinName(t, placeable);
          // Full name where it fits, else its size, else the pin alone; the
          // full name is always the title and the accessible name (#4560).
          const label = pinLabels.get(`${t.kind}:${t.id}`);
          return (
          <button
            key={`pin:${t.kind}:${t.id}`}
            type="button"
            data-pin={t.id}
            title={name}
            aria-label={`${name}, pinned here`}
            onPointerDown={(e) => {
              pinPointer.current = e.pointerType;
            }}
            onClick={(e) => {
              e.stopPropagation();
              if (placing) return;
              const key = `${t.kind}:${t.id}`;
              if (pinPointer.current === "touch" && pinPeek !== key) {
                setPinPeek(key);
                return;
              }
              const href = routeFor(t.kind, t.id);
              if (href) navigate(href);
            }}
            className={`absolute -translate-y-full flex items-end gap-0.5 text-cobble-600 dark:text-cobble-300 ${label?.side === "left" ? "-translate-x-[calc(100%-0.5rem)] flex-row-reverse" : "-translate-x-2"} ${placing ? "pointer-events-none" : ""}`}
            style={{ left: pct(t.position!.x_mm, bound.w_mm), top: pct(t.position!.y_mm, bound.d_mm) }}
          >
            <MapPin
              size={16}
              data-pin-group={pinGroupOf.has(`${t.kind}:${t.id}`) ? pinGroups[pinGroupOf.get(`${t.kind}:${t.id}`)!]!.label : undefined}
              className={`shrink-0 fill-cobble-100 dark:fill-cobble-900 ${pinGroupOf.has(`${t.kind}:${t.id}`) ? PLAN_COLOUR_STYLE[GROUP_COLOURS[pinGroupOf.get(`${t.kind}:${t.id}`)! % GROUP_COLOURS.length]!].text : ""}`}
            />
            {pins.length <= PIN_LABELS_UP_TO && label && (
              <span data-pin-label="" className="max-w-[9rem] truncate rounded bg-surface/90 dark:bg-slate-900/90 px-1 text-[10px] leading-4 text-content dark:text-mortar-100 shadow-sm">
                {label.text}
              </span>
            )}
          </button>
          );
        })}

        {(() => {
          const t = pinPeek ? pins.find((p) => `${p.kind}:${p.id}` === pinPeek) : null;
          if (!t || placing) return null;
          const href = routeFor(t.kind, t.id);
          return (
            <PinPeek
              thing={{ name: pinName(t, placeable), size: shortFor(t.fields, groupable), qty: t.fields?.qty, unit: t.fields?.unit, holds: holdsLabel(t.kind, t.id) }}
              placeName={room.name}
              at={{ x: t.position!.x_mm / bound.w_mm, y: t.position!.y_mm / bound.d_mm }}
              onOpen={href ? () => navigate(href) : null}
              onClose={() => setPinPeek(null)}
            />
          );
        })()}

        {/* entity occupants — the THINGS themselves (ratchets, guns, parts),
            placed via their own metadata rect. Cobble-tinted = a thing;
            slate = a place. Area-descending for overlap clicks. */}
        {placedOccupants.map(({ ent, rect }) => {
          const key = `${ent.kind}:${ent.id}`;
          const r = live?.id === key ? live.rect : rect;
          const selected = sel?.type === "entity" && sel.id === ent.id;
          const wPx = r.w_mm / bound.w_mm * planPx;
          const hPx = r.d_mm / bound.w_mm * planPx;
          const label = planPx > 0 ? labelFor(ent.name, shortLabel(ent.name, ent.short_name), Math.max(0, wPx - 6), Math.max(0, hPx - 4), 5.6, 12) : ent.name;
          const tight = planPx > 0 && !fitsIn(label, Math.floor((wPx - 10) / 5.6), Math.floor((hPx - 6) / 12));
          return (
            <div
              key={key}
              data-plan-thing={ent.name}
              role="button"
              tabIndex={0}
              aria-label={ent.name}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.currentTarget.click();
                }
              }}
              onPointerDown={(e) => startEntityDrag(e, ent, r, "move")}
              onClick={(e) => {
                if (edit) {
                  e.stopPropagation();
                  setSel({ type: "entity", kind: ent.kind, id: ent.id });
                } else {
                  const href = routeFor(ent.kind, ent.id);
                  if (href) navigate(href);
                }
              }}
              title={holdsLabel(ent.kind, ent.id) ? `${ent.name} · ${holdsLabel(ent.kind, ent.id)}` : ent.name}
              data-collides={colliding.has(key) ? "true" : undefined}
              className={`absolute rounded-md border border-cobble-500/70 dark:border-cobble-400/60 bg-cobble-50/60 dark:bg-cobble-900/30 overflow-hidden text-[10px] leading-tight ${tight ? "p-0" : "px-1 py-0.5"} text-content dark:text-slate-200
                ${edit ? "cursor-move touch-none" : "cursor-pointer hover:border-accent"}
                ${colliding.has(key) ? "border-dashed !border-ember-500 ring-1 ring-ember-500/60" : ""}
                ${selected ? "ring-1 ring-accent border-accent" : ""}`}
              style={{
                left: pct(r.x_mm, bound.w_mm),
                top: pct(r.y_mm, bound.d_mm),
                width: pct(r.w_mm, bound.w_mm),
                height: pct(r.d_mm, bound.d_mm),
              }}
            >
              <RectDecor imagePath={ent.image_path} fp={ent.metadata?.floorplan as Record<string, unknown> | undefined} />
              {/* A compact identifier must fit both axes without HTML wrapping;
                  its padding cannot consume the tiny physical footprint. */}
              <span className={tight ? "absolute -inset-px flex items-center justify-center" : "relative"} data-thing-name="">
                {tight ? (
                  <svg aria-hidden="true" viewBox={`0 0 ${Math.max(1, label.length) * 6} 14`} className="h-full w-full" style={{ maxWidth: Math.max(1, label.length) * 6, maxHeight: 14 }}>
                    <text x="0" y="10" fontSize="10" fill="currentColor" textLength={Math.max(1, label.length) * 6} lengthAdjust="spacingAndGlyphs">{label}</text>
                  </svg>
                ) : label}
              </span>
              {holdsLabel(ent.kind, ent.id) && (
                <span data-holds className="relative block text-[9px] text-faint">{holdsLabel(ent.kind, ent.id)}</span>
              )}
              {selected && edit && (
                <span
                  onPointerDown={(e) => startEntityDrag(e, ent, r, "resize")}
                  className="absolute -right-0.5 -bottom-0.5 w-2.5 h-2.5 bg-accent rounded-sm cursor-nwse-resize touch-none [@media(pointer:coarse)]:w-5 [@media(pointer:coarse)]:h-5"
                />
              )}
            </div>
          );
        })}

        {/* things at their real size: a footprint on a floor, a face on a
            shelf, standing side by side with the shelf's fit above them */}
        {sized.things.map((t) => (
          <SizedThingBox
            key={`sized:${t.key}`}
            slug={slug}
            thing={t}
            bound={bound}
            colliding={colliding.has(t.key)}
            canDrag={edit}
            shelf={t.shelfId ? (sized.fits.find((f) => f.shelfId === t.shelfId) ?? null) : null}
            planEl={planRef.current}
            planPx={planPx}
            onOpen={() => {
              const href = routeFor(t.kind, t.id);
              if (href) navigate(href);
            }}
          />
        ))}
        {sized.fits.map((f) => (
          <ShelfFitLabel key={`fit:${f.shelfId}`} fit={f} bound={bound} />
        ))}
        {/* While something is dragged on a floor: the clear floor to the
            nearest thing or wall on each side. */}
        {live && onFloor && edit && (
          <GapReadout room={bound} walls={allWalls} box={live.rect} others={floorItems.filter((i) => i.id !== live.id)} />
        )}
      </div>
      </div>
      <ShelfFitList fits={sized.fits} names={new Map(shelvesHere.map((s) => [s.loc.id, s.loc.name]))} rack={room.name} />
      <PlanFlagList flags={flags} />
      {sized.unsized.length > 0 && !placing && (
        <p data-testid="plan-unsized" className="mt-2 text-center text-xs text-muted dark:text-slate-400">
          {sized.unsized.length === 1 ? `${sized.unsized[0]!.name} has no size yet.` : `${sized.unsized.length} things here have no size yet.`}{" "}
          <button type="button" onClick={() => setAddSizes(true)} className="text-accent underline-offset-2 hover:underline">
            {sized.unsized.length === 1 ? "Add its size to see if it fits" : "Add their sizes to see if they fit"}
          </button>
        </p>
      )}
      {addSizes && (
        <AddSizesDialog slug={slug} things={sized.unsized} placeable={placeable} placeableKinds={placeableKinds} onClose={() => setAddSizes(false)} />
      )}

      {/* What each colour on the plan means: the places that carry it. A
          colour is the person's own grouping, never the only label. */}
      {groupField && pinGroups.length > 0 && (
        <div data-testid="pin-groups" className="mt-2 flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs text-muted dark:text-slate-400">
          <span className="font-medium text-content dark:text-slate-200">{groupField.label}:</span>
          {pinGroups.map((g, i) => (
            <span key={g.label} className="inline-flex items-center gap-1">
              <MapPin aria-hidden size={12} className={PLAN_COLOUR_STYLE[GROUP_COLOURS[i % GROUP_COLOURS.length]!].text} />
              {g.label} ({g.keys.length})
            </span>
          ))}
        </div>
      )}
      {planLegend.size > 0 && (
        <div data-testid="plan-legend" className="mt-2 flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs text-muted dark:text-slate-400">
          {[...planLegend.values()].map(({ outline, names }) => (
            <span key={outline.key} className="inline-flex items-center gap-1.5">
              <span aria-hidden className={`inline-block h-2.5 w-2.5 rounded-sm ${outline.swatch}`} style={{ backgroundColor: outline.colour ?? undefined }} />
              <span>
                <span className="font-medium text-content dark:text-slate-200">{outline.label}</span>: {names.join(", ")}
              </span>
            </span>
          ))}
        </div>
      )}

      {/* ── edit panel: docked to the bottom of the screen while the plan
          is on it, so selecting something visibly does something. Never
          more than under half the screen, scrolling inside, and not docked
          at all on a screen too short to spare it (a phone on its side): it
          covered the plan's own head and its Done on a small phone, so nobody
          could leave editing. It docks above the home bar, as the corner
          pieces do: on the screen's edge its last line ("remove from plan")
          sat under the home bar, and over a bottom bar it overlapped the bar
          by the same height ── */}
      {edit && (
      <div className="sticky z-10 shadow-lg rounded-md max-h-[45dvh] overflow-y-auto overscroll-contain [@media(max-height:500px)]:static [@media(max-height:500px)]:max-h-none" style={{ bottom: bare ? "var(--inset-bottom)" : "calc(var(--inset-bottom) + var(--bottom-chrome-height, 0px))" }} data-testid="plan-panel">
      {sel?.type === "entity" && (
        <EntityPanel
          ent={occupants.find((o) => o.id === sel.id && o.kind === sel.kind) ?? null}
          unit={unit}
          grid={bound.grid_mm}
          secondAxis={view === "front" ? "tall" : "deep"}
          onRect={saveEntityRect}
          onDecor={(ent, patch) => saveEntityMeta(ent, `Changed how ${ent.name} looks`, (base) => withDecor(base, patch))}
          onResize={resizeEntity}
        />
      )}
      {sel?.type !== "entity" && (
        <EditPanel
          slug={slug}
          bound={bound}
          unit={unit}
          view={view}
          grid={grid}
          sel={sel}
          byId={byId}
          onBound={saveBound}
          onResizeBound={resizeBound}
          onRect={(loc, r) => saveRect(loc, r)}
          onResizePlace={resizePlace}
          onFloorplanPatch={patchLocFloorplan}
          onDeleteWall={(idx) => {
            const next = [...(bound.walls ?? [])];
            next.splice(idx, 1);
            saveBound({ ...bound, walls: next }, "Deleted a wall");
            setSel(null);
          }}
          onRename={(loc, name) => {
            note(`Renamed ${loc.name} to ${name}`, [{ kind: "place", id: loc.id, before: { name: loc.name }, after: { name } }]);
            rename.mutate({ id: loc.id, name, was: loc.name });
          }}
          onOpen={(loc) => setPeekId(loc.id)}
          onTurn={turnPlace}
          onAddOnWall={addOnWall}
          onAddDrawers={(loc) => {
            // No face yet: give it one on the spot (as wide as it stands,
            // three quarters as tall), so adding drawers is one step; its
            // size is in the face's own panel when it is not right.
            const base = freshMeta(`place:${loc.id}`, loc.metadata);
            const r = readRect(base);
            const hasFace = hasOwnLayout(base) || items.some((l) => l.parent_id === loc.id && readRect(l.metadata));
            if (r && !hasFace) {
              const metadata = withBound(base, { w_mm: r.w_mm, d_mm: Math.max(300, snap(r.w_mm * 0.75, 50)), view: "front", unit: unit === "ft" ? "in" : unit }, "container");
              note(`Gave ${loc.name} a front`, [{ kind: "place", id: loc.id, before: { metadata: base }, after: { metadata } }]);
              rememberMeta(`place:${loc.id}`, metadata);
              saveMeta.mutate({ id: loc.id, before: base, metadata });
            }
            setPeekStart("drawers");
            setPeekId(loc.id);
          }}
        />
      )}
      </div>
      )}

      {/* items filed here but not yet on the plan — tap to drop at center */}
      {edit && unplacedOccupants.filter((e) => !sized.drawnOnShelf.has(`${fieldKindOf(e)}:${e.id}`)).length > 0 && (
        <div data-testid="plan-unplaced-records" className="flex items-baseline gap-2 flex-wrap text-xs text-faint dark:text-slate-500">
          <span>items here, not placed:</span>
          {unplacedOccupants.filter((e) => !sized.drawnOnShelf.has(`${fieldKindOf(e)}:${e.id}`)).slice(0, 24).map((e) => (
            <button
              key={`${e.kind}:${e.id}`}
              type="button"
              onClick={() =>
                saveEntityRect(e, freeSpot(bound, taken, grid * 4, grid * 3))
              }
              className="rounded-md border border-cobble-300/60 dark:border-cobble-700/60 bg-cobble-50/50 dark:bg-cobble-900/20 px-2 py-0.5 text-content dark:text-slate-300 hover:border-accent transition"
            >
              {e.name}
            </button>
          ))}
          {unplacedOccupants.length > 24 && (
            <span className="italic">+{unplacedOccupants.length - 24} more</span>
          )}
        </div>
      )}

      {seedOpen && <SeedModal room={room} slug={slug} onClose={() => setSeedOpen(false)} onApplied={invalidate} onStep={(step) => history.record(step)} />}
      {createOpen && (
        <CreateOnPlanModal
          slug={slug}
          room={room}
          bound={{ ...bound, view }}
          taken={taken}
          onClose={() => setCreateOpen(false)}
          onCreated={invalidate}
          onStep={(step) => history.record(step)}
        />
      )}
      {drawersOpen && (
        <DrawersModal
          slug={slug}
          room={room}
          bound={bound}
          children={ownContainers}
          onPlaced={async (loc, rect) => {
            const metadata = withRect(loc.metadata, rect, { keepFace: hasOwnLayout(loc.metadata) || (placedByOwner.get(loc.id)?.length ?? 0) > 0 });
            await api.updateLocation(slug, loc.id, editOf(loc, { metadata: jsonbPatchBetween(loc.metadata, metadata) }));
            return { kind: "place", id: loc.id, before: { metadata: loc.metadata }, after: { metadata } } satisfies PlanChange;
          }}
          onClose={() => setDrawersOpen(false)}
          onCreated={invalidate}
          onStep={(step) => history.record(step)}
        />
      )}
      {/* Peek drill-in: the child's own plan, zoomed, fully interactive —
          without losing where you were. */}
      {peekLoc && (
        <RecordFormModal
          open
          onClose={() => {
            setPeekId(null);
            setPeekStart(undefined);
          }}
          title={peekLoc.name}
        >
          <div className="space-y-2">
            <PlanFor room={peekLoc} slug={slug} bare headTitle={peekLoc.kind === "container" ? "Layout" : peekLoc.name} startWith={peekStart} />
            <div className="flex justify-end gap-4">
              <Link
                to={`/scan/camera?bin=${peekLoc.id}`}
                onClick={() => setPeekId(null)}
                className="inline-flex items-center gap-1 text-sm text-muted hover:text-accent"
              >
                <ScanLine size={14} /> Scan into {peekLoc.name}
              </Link>
              <Link
                to={`/locations/${peekLoc.id}`}
                onClick={() => setPeekId(null)}
                className="text-sm text-accent hover:underline"
              >
                Open {peekLoc.name} →
              </Link>
            </div>
          </div>
        </RecordFormModal>
      )}
    </div>
  );

  // Drawn once everything it draws has answered: drawn from the places
  // alone, the drawers, the things in them and their sizes arrived one by one
  // and moved what is on the plan and below it (#7791).
  const waiting = [locs, tags, held, holders, ...attachedTags].some(stillAsking) || placeableLoading || kindDefsPending || sized.pending || (sized.things.length > 0 && planPx === 0);
  // Laid out all the same, invisible, so the drawing is measured at its real
  // width and shows already laid out.
  const shown = (
    <div className="relative">
      {waiting && <p aria-busy="true" className="absolute inset-x-0 top-0 text-sm text-faint dark:text-slate-500">loading the plan…</p>}
      <div className={waiting ? "invisible" : undefined} aria-hidden={waiting || undefined}>{content}</div>
    </div>
  );
  return bare ? (
    shown
  ) : (
    <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4">
      {shown}
    </section>
  );
}

function SectionHead({
  room,
  edit,
  children,
  title,
}: {
  room: Location;
  edit: boolean;
  children?: React.ReactNode;
  title?: string;
}) {
  return (
    <div className="flex items-center gap-x-2 gap-y-1.5 flex-wrap">
      <h2 className="min-w-0 text-sm font-semibold text-content dark:text-mortar-100">
        {title ?? room.name}
        {!title && (
          <span className="ml-1.5 font-normal text-faint dark:text-slate-500">{room.kind === "container" ? "layout" : "floor plan"}</span>
        )}
      </h2>
      {edit && (
        <span className="text-[10px] uppercase tracking-widest text-accent">editing</span>
      )}
      <div className="flex-1" />
      {children}
    </div>
  );
}

/** One text input that parses "24ft" / "1.2m" / "915" into mm on commit. */
function DimInput({
  label,
  mm,
  unit,
  onCommit,
}: {
  label: string;
  mm: number;
  unit: LengthUnit;
  onCommit: (mm: number, unitTyped: LengthUnit | null) => void;
}) {
  // The field follows the value it shows (another selection, a drag) while it
  // is not being typed in; a blur with nothing typed writes nothing, so a
  // number from a moment ago can never be committed.
  const shown = formatLength(mm, unit);
  const [text, setText] = useState(shown);
  const typing = useRef(false);
  useEffect(() => {
    if (!typing.current) setText(shown);
  }, [shown]);
  const commit = () => {
    typing.current = false;
    if (text.trim() === shown) {
      setText(shown);
      return;
    }
    const parsed = parseLength(text, unit);
    if (parsed === null) {
      setText(formatLength(mm, unit));
      return;
    }
    const suffix = text.trim().match(/(ft|feet|foot|in|inch|inches|mm|cm|m|'|")\s*$/)?.[1] ?? null;
    const typed: LengthUnit | null =
      suffix === "'" || suffix === "ft" || suffix === "feet" || suffix === "foot"
        ? "ft"
        : suffix === '"' || suffix === "in" || suffix === "inch" || suffix === "inches"
          ? "in"
          : suffix === "m" || suffix === "cm" || suffix === "mm"
            ? (suffix as LengthUnit)
            : null;
    onCommit(parsed, typed);
    setText(formatLength(parsed, typed ?? unit));
  };
  return (
    <label className="inline-flex items-center gap-1.5 text-xs text-muted dark:text-slate-400">
      {label}
      <input
        value={text}
        onChange={(e) => {
          typing.current = true;
          setText(e.target.value);
        }}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        className="w-20 rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-1.5 py-0.5 text-xs text-content dark:text-slate-200 font-mono"
      />
    </label>
  );
}

/** A place's name, editable where it is selected: renaming no longer means
 *  leaving the plan. Commits on Enter or blur, only when it changed. */
function NameInput({ name, onCommit }: { name: string; onCommit: (name: string) => void }) {
  const [text, setText] = useState(name);
  const commit = () => {
    const t = text.trim();
    if (t && t !== name) onCommit(t);
    else setText(name);
  };
  return (
    <input
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      aria-label="Name"
      className="w-40 rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-1.5 py-0.5 text-sm font-medium text-content dark:text-slate-200"
    />
  );
}

function EditPanel({
  slug,
  bound,
  unit,
  view,
  grid,
  sel,
  byId,
  onBound,
  onResizeBound,
  onRect,
  onResizePlace,
  onFloorplanPatch,
  onDeleteWall,
  onRename,
  onOpen,
  onAddDrawers,
  onTurn,
  onAddOnWall,
}: {
  slug: string;
  bound: FpBound;
  unit: LengthUnit;
  view: "plan" | "front";
  grid: number;
  sel: Sel;
  byId: Map<string, Location>;
  onBound: (b: FpBound, label?: string) => void;
  /** One size of the room or face: the parent merges it onto the freshest
   *  outline, so two sizes typed one after the other both stay (#5950). */
  onResizeBound: (patch: Partial<FpBound>) => void;
  onRect: (loc: Location, r: FpRect | null) => void;
  /** One size of a placed location, merged onto its freshest rect. */
  onResizePlace: (loc: Location, patch: Partial<FpRect>) => void;
  onFloorplanPatch: (loc: Location, patch: Record<string, unknown>, previousGroup?: string) => void;
  onDeleteWall: (idx: number) => void;
  onRename: (loc: Location, name: string) => void;
  /** Open a place's own plan or face in place. */
  onOpen: (loc: Location) => void;
  onAddDrawers: (loc: Location) => void;
  /** Turn a rack a quarter where it stands. */
  onTurn: (loc: Location) => void;
  /** Put a door, a window or a closet on one of the room's walls. */
  onAddOnWall: (side: Edge, what: "door" | "window" | "closet") => void;
}) {
  const secondAxis = view === "front" ? "tall" : "deep";

  if (sel?.type === "wall") {
    const wall = bound.walls?.[sel.idx];
    if (!wall) return null;
    const vertical = wall.x1 === wall.x2;
    const patchWall = (patch: Partial<FpWall>) => {
      const walls = [...(bound.walls ?? [])];
      walls[sel.idx] = { ...wall, ...patch };
      onBound({ ...bound, walls });
    };
    return (
      <div className="flex items-center gap-3 flex-wrap rounded-md border border-line dark:border-slate-700 bg-surface dark:bg-slate-800 px-3 py-2">
        <span className="text-xs font-medium text-content dark:text-slate-200">
          wall ({vertical ? "vertical" : "horizontal"})
        </span>
        <DimInput
          label="at"
          mm={vertical ? wall.x1 : wall.y1}
          unit={unit}
          onCommit={(v) => patchWall(vertical ? { x1: v, x2: v } : { y1: v, y2: v })}
        />
        <DimInput
          label="from"
          mm={vertical ? Math.min(wall.y1, wall.y2) : Math.min(wall.x1, wall.x2)}
          unit={unit}
          onCommit={(v) =>
            patchWall(
              vertical
                ? { y1: v, y2: Math.max(wall.y1, wall.y2) }
                : { x1: v, x2: Math.max(wall.x1, wall.x2) },
            )
          }
        />
        <DimInput
          label="to"
          mm={vertical ? Math.max(wall.y1, wall.y2) : Math.max(wall.x1, wall.x2)}
          unit={unit}
          onCommit={(v) =>
            patchWall(
              vertical
                ? { y1: Math.min(wall.y1, wall.y2), y2: v }
                : { x1: Math.min(wall.x1, wall.x2), x2: v },
            )
          }
        />
        <span className="text-xs text-faint">openings:</span>
        {(wall.openings ?? []).map((o, oi) => (
          <OpeningEditor
            key={oi}
            wall={wall}
            o={o}
            room={bound}
            unit={unit}
            onChange={(next) => {
              const openings = [...(wall.openings ?? [])];
              openings[oi] = next;
              patchWall({ openings });
            }}
            onRemove={() => {
              const openings = [...(wall.openings ?? [])];
              openings.splice(oi, 1);
              patchWall({ openings });
            }}
          />
        ))}
        {(["door", "window", "opening"] as const).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => {
              const len = Math.abs(vertical ? wall.y2 - wall.y1 : wall.x2 - wall.x1);
              const o = newOpening(wall, bound, k);
              patchWall({ openings: [...(wall.openings ?? []), { ...o, at_mm: Math.max(0, snap((len - o.w_mm) / 2)) }] });
            }}
            className="inline-flex items-center gap-1 text-xs text-muted hover:text-accent"
          >
            <Plus size={12} /> {k}
          </button>
        ))}
        <div className="flex-1" />
        <button type="button" onClick={() => onDeleteWall(sel.idx)} className="text-xs text-faint hover:text-ember-500">
          delete wall
        </button>
      </div>
    );
  }

  if (sel?.type === "item") {
    const loc = byId.get(sel.id);
    const rect = loc ? readRect(loc.metadata) : null;
    if (!loc || !rect) return null;
    return (
      <div className="flex items-center gap-3 flex-wrap rounded-md border border-line dark:border-slate-700 bg-surface dark:bg-slate-800 px-3 py-2">
        <NameInput key={loc.id} name={loc.name} onCommit={(n) => onRename(loc, n)} />
        <button type="button" onClick={() => onOpen(loc)} className="text-xs text-accent hover:underline">
          Open
        </button>
        {loc.kind !== "area" && (
          <button type="button" onClick={() => onAddDrawers(loc)} className="text-xs text-accent hover:underline">
            Add drawers
          </button>
        )}
        <DimInput label="wide" mm={rect.w_mm} unit={unit} onCommit={(v) => onResizePlace(loc, { w_mm: v })} />
        <DimInput label={secondAxis} mm={rect.d_mm} unit={unit} onCommit={(v) => onResizePlace(loc, { d_mm: v })} />
        {loc.kind !== "area" && view === "plan" && !rect.wall_mounted && (
          <button
            type="button"
            data-testid="plan-turn"
            onClick={() => onTurn(loc)}
            title="Turn it a quarter where it stands (or press R while dragging it, or hold a finger on it)"
            className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
          >
            <RotateCw size={12} /> Turn 90°
          </button>
        )}
        {loc.kind === "area" && readCloset(loc.metadata?.floorplan) && (
          <ClosetDoorControls
            closet={readCloset(loc.metadata?.floorplan)!}
            box={rect}
            room={bound}
            unit={unit}
            onChange={(closet) => onFloorplanPatch(loc, { closet })}
          />
        )}
        {bound.grid_mm && (
          <span className="font-mono text-[10px] text-faint" title={gridCellsNote(rect, bound.grid_mm).title} data-testid="plan-grid-cells">
            {gridCellsNote(rect, bound.grid_mm).text}
          </span>
        )}
        {loc.kind !== "area" && (
          <label className="inline-flex items-center gap-1.5 text-xs text-muted dark:text-slate-400">
            <input
              type="checkbox"
              checked={rect.wall_mounted === true}
              onChange={(e) => onRect(loc, { ...rect, wall_mounted: e.target.checked })}
              className="accent-cobble-600"
            />
            wall-mounted
          </label>
        )}
        {loc.kind !== "area" && <PlanOutlineControl slug={slug} loc={loc} onPatch={(patch, previousGroup) => onFloorplanPatch(loc, patch, previousGroup)} />}
        <DecorControls
          fp={(loc.metadata?.floorplan as Record<string, unknown>) ?? {}}
          onPatch={(patch) => onFloorplanPatch(loc, { ...patch, ...("color" in patch ? { outline_tag_id: "custom" } : {}) })}
          withColour={loc.kind !== "area"}
        />
        <div className="flex-1" />
        <button type="button" onClick={() => onRect(loc, null)} className="text-xs text-faint hover:text-ember-500">
          remove from plan
        </button>
      </div>
    );
  }

  // Nothing selected → the bound itself.
  return (
    <div className="flex items-center gap-3 flex-wrap rounded-md border border-line dark:border-slate-700 bg-surface dark:bg-slate-800 px-3 py-2">
      <span className="text-xs font-medium text-content dark:text-slate-200">
        {view === "front" ? "face" : "room"}
      </span>
      <DimInput
        label="wide"
        mm={bound.w_mm}
        unit={unit}
        onCommit={(v, typed) => onResizeBound({ w_mm: v, ...(typed ? { unit: typed } : {}) })}
      />
      <DimInput
        label={secondAxis}
        mm={bound.d_mm}
        unit={unit}
        onCommit={(v, typed) => onResizeBound({ d_mm: v, ...(typed ? { unit: typed } : {}) })}
      />
      <label className="inline-flex items-center gap-1.5 text-xs text-muted dark:text-slate-400">
        view
        <select
          value={view}
          onChange={(e) => onBound({ ...bound, view: e.target.value === "front" ? "front" : "plan" })}
          className="rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-1 py-0.5 text-xs text-content dark:text-slate-200"
        >
          <option value="plan">plan (top-down)</option>
          <option value="front">front (elevation)</option>
        </select>
      </label>
      {/* The grid's size: auto follows the plan's units and zoom; a step of
          its units, Gridfinity's 42 mm, or any size typed beside it. */}
      <label className="inline-flex items-center gap-1.5 text-xs text-muted dark:text-slate-400">
        grid
        <select
          aria-label="Grid size"
          value={bound.grid_mm ? String(bound.grid_mm) : "auto"}
          onChange={(e) => onBound({ ...bound, grid_mm: e.target.value === "auto" ? undefined : Number(e.target.value) })}
          className="rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-1 py-0.5 text-xs text-content dark:text-slate-200"
        >
          <option value="auto">auto</option>
          {gridPitches(bound.unit).map((p) => (
            <option key={p.mm} value={String(p.mm)}>
              {p.label}
            </option>
          ))}
          {bound.grid_mm && !gridPitches(bound.unit).some((p) => Math.abs(p.mm - bound.grid_mm!) < 0.01) && (
            <option value={String(bound.grid_mm)}>{Math.round(bound.grid_mm * 10) / 10} mm</option>
          )}
        </select>
      </label>
      <DimInput
        label="custom grid"
        mm={grid}
        unit="mm"
        onCommit={(v) => onBound({ ...bound, grid_mm: Math.max(5, Math.min(1000, v)) })}
      />
      {view === "plan" && <AddOnWall onAdd={onAddOnWall} />}
      <span className="text-[11px] text-faint italic">
        numbers live here in edit mode only - the plan itself stays clean
      </span>
    </div>
  );
}

/** Put a door, a window or a closet on one of the room's own walls. */
function AddOnWall({ onAdd }: { onAdd: (side: Edge, what: "door" | "window" | "closet") => void }) {
  const [side, setSide] = useState<Edge>("bottom");
  return (
    <span data-testid="plan-add-on-wall" className="inline-flex flex-wrap items-center gap-1.5 text-xs text-muted dark:text-slate-400">
      on the
      <select
        aria-label="Which wall"
        value={side}
        onChange={(e) => setSide(e.target.value as Edge)}
        className="rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-1 py-0.5 text-xs text-content dark:text-slate-200"
      >
        <option value="top">top</option>
        <option value="bottom">bottom</option>
        <option value="left">left</option>
        <option value="right">right</option>
      </select>
      wall:
      {(["door", "window", "closet"] as const).map((k) => (
        <button key={k} type="button" onClick={() => onAdd(side, k)} className="inline-flex items-center gap-0.5 rounded border border-line dark:border-slate-600 px-1.5 py-0.5 text-content dark:text-slate-200 hover:border-accent hover:text-accent">
          <Plus size={11} /> {k}
        </button>
      ))}
    </span>
  );
}

/** A new opening of this kind, as wide as one usually is, a door swinging
 *  into the room (on an inside wall, toward the right or the bottom), a
 *  window with its sill at the usual height. */
function newOpening(wall: FpWall, room: { w_mm: number; d_mm: number }, kind: "door" | "window" | "opening"): FpOpening {
  const vertical = wall.x1 === wall.x2;
  if (kind === "window") return { at_mm: 0, w_mm: 1000, kind, sill_mm: DEFAULT_SILL_MM };
  if (kind === "opening") return { at_mm: 0, w_mm: 900, kind };
  return { at_mm: 0, w_mm: 815, kind, hinge: vertical ? "top" : "left", swing: intoRoom(wall, room) ?? (vertical ? "right" : "bottom") };
}

const SIDE_WORD: Record<Edge, string> = { top: "up", bottom: "down", left: "left", right: "right" };

/** One opening in a wall: what it is, where and how wide, which way a door
 *  opens and where its hinge is, how high a window's sill is. */
function OpeningEditor({ wall, o, room, unit, onChange, onRemove }: { wall: FpWall; o: FpOpening; room: { w_mm: number; d_mm: number }; unit: LengthUnit; onChange: (o: FpOpening) => void; onRemove: () => void }) {
  const vertical = wall.x1 === wall.x2;
  const kind = o.kind ?? "opening";
  const inward = intoRoom(wall, room);
  const swings: Edge[] = vertical ? ["left", "right"] : ["top", "bottom"];
  const hinges: Edge[] = vertical ? ["top", "bottom"] : ["left", "right"];
  const select = "rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-1 py-0.5 text-xs text-content dark:text-slate-200";
  return (
    <span data-opening-editor={kind} className="inline-flex flex-wrap items-center gap-1.5 rounded border border-line dark:border-slate-600 px-1.5 py-0.5">
      <select
        aria-label="What it is"
        value={kind}
        onChange={(e) => {
          const k = e.target.value as "door" | "window" | "opening";
          const fresh = newOpening(wall, room, k);
          onChange({ ...fresh, at_mm: o.at_mm, w_mm: o.w_mm });
        }}
        className={select}
      >
        <option value="door">door</option>
        <option value="window">window</option>
        <option value="opening">opening</option>
      </select>
      <DimInput label="at" mm={o.at_mm} unit={unit} onCommit={(v) => onChange({ ...o, at_mm: v })} />
      <DimInput label="w" mm={o.w_mm} unit={unit} onCommit={(v) => onChange({ ...o, w_mm: v })} />
      {kind === "door" && (
        <>
          <label className="inline-flex items-center gap-1 text-xs text-muted dark:text-slate-400">
            opens
            <select aria-label="Which way it opens" value={o.swing ?? ""} onChange={(e) => onChange({ ...o, swing: (e.target.value || undefined) as Edge | undefined })} className={select}>
              <option value="">not shown</option>
              {swings.map((sw) => (
                <option key={sw} value={sw}>
                  {inward ? (sw === inward ? "into the room" : "out of the room") : SIDE_WORD[sw]}
                </option>
              ))}
            </select>
          </label>
          <label className="inline-flex items-center gap-1 text-xs text-muted dark:text-slate-400">
            hinge
            <select aria-label="Hinge side" value={o.hinge && doorFitsWall(wall, { hinge: o.hinge }) ? o.hinge : hinges[0]} onChange={(e) => onChange({ ...o, hinge: e.target.value as Edge })} className={select}>
              {hinges.map((h) => (
                <option key={h} value={h}>
                  {h}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      {kind === "window" && <DimInput label="sill" mm={o.sill_mm ?? DEFAULT_SILL_MM} unit={unit} onCommit={(v) => onChange({ ...o, sill_mm: v })} />}
      <button aria-label="Remove it" type="button" onClick={onRemove} className="text-faint hover:text-ember-500" title="Remove it">
        <X size={12} />
      </button>
    </span>
  );
}

/** A closet's door: how wide, which side its hinge is on, and whether it
 *  opens out into the room or into the closet. */
function ClosetDoorControls({ closet, box, room, unit, onChange }: { closet: ClosetDoor; box: FpRect; room: { w_mm: number; d_mm: number }; unit: LengthUnit; onChange: (c: ClosetDoor) => void }) {
  const front = closetWalls("", box, room, closet).find((w) => w.openings?.length)!;
  const door = front.openings![0]!;
  const vertical = front.x1 === front.x2;
  const hinges: Edge[] = vertical ? ["top", "bottom"] : ["left", "right"];
  const swings: Edge[] = vertical ? ["left", "right"] : ["top", "bottom"];
  const intoRoomSide = closetWalls("", box, room, {}).find((w) => w.openings?.length)!.openings![0]!.swing!;
  const select = "rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-1 py-0.5 text-xs text-content dark:text-slate-200";
  return (
    <span data-testid="closet-door" className="inline-flex flex-wrap items-center gap-1.5 text-xs text-muted dark:text-slate-400">
      closet door
      <DimInput label="w" mm={door.w_mm} unit={unit} onCommit={(v) => onChange({ ...closet, door_mm: v })} />
      <select aria-label="Which way the closet door opens" value={door.swing === intoRoomSide ? "room" : "closet"} onChange={(e) => onChange({ ...closet, swing: e.target.value === "room" ? intoRoomSide : swings.find((sw) => sw !== intoRoomSide) })} className={select}>
        <option value="room">opens into the room</option>
        <option value="closet">opens into the closet</option>
      </select>
      <select aria-label="Closet door hinge side" value={door.hinge} onChange={(e) => onChange({ ...closet, hinge: e.target.value as Edge })} className={select}>
        {hinges.map((h) => (
          <option key={h} value={h}>
            hinge {h}
          </option>
        ))}
      </select>
    </span>
  );
}

function BoundSetup({
  unitDefault,
  view,
  initialW = "",
  onSet,
}: {
  unitDefault: LengthUnit;
  view: "plan" | "front";
  /** A container's face starts as wide as it stands on the floor. */
  initialW?: string;
  onSet: (b: FpBound) => void;
}) {
  const [w, setW] = useState(initialW);
  const [d, setD] = useState("");
  const commit = () => {
    const wmm = parseLength(w, unitDefault);
    const dmm = parseLength(d, unitDefault);
    if (!wmm || !dmm) return;
    const suffix = (w + d).match(/(ft|in|mm|cm|m|'|")/)?.[1];
    const unit: LengthUnit =
      suffix === "'" || suffix === "ft" ? "ft" : suffix === '"' || suffix === "in" ? "in" : suffix === "m" || suffix === "cm" || suffix === "mm" ? suffix : unitDefault;
    onSet({ w_mm: wmm, d_mm: dmm, unit, view });
  };
  return (
    <span className="flex w-full min-w-0 flex-wrap items-center gap-1.5">
      <input
        value={w}
        onChange={(e) => setW(e.target.value)}
        placeholder={view === "front" ? "width (e.g. 44in)" : "width (e.g. 33ft)"}
        className="min-w-0 flex-1 basis-24 sm:flex-none sm:w-32 rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-2 py-1.5 text-sm text-content dark:text-slate-200"
      />
      <span className="text-faint text-sm">×</span>
      <input
        value={d}
        onChange={(e) => setD(e.target.value)}
        placeholder={view === "front" ? "height (e.g. 40in)" : "depth (e.g. 24ft)"}
        className="min-w-0 flex-1 basis-24 sm:flex-none sm:w-32 rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-2 py-1.5 text-sm text-content dark:text-slate-200"
      />
      <button
        type="button"
        onClick={commit}
        className="shrink-0 whitespace-nowrap rounded-md bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1.5 text-sm transition"
      >
        Create plan
      </button>
    </span>
  );
}

function SeedModal({
  room,
  slug,
  onClose,
  onApplied,
  onStep,
}: {
  room: Location;
  slug: string;
  onClose: () => void;
  onApplied: () => void;
  /** The whole draft as one step Undo can take back. */
  onStep: (step: PlanStep) => void;
}) {
  const toast = useToast();
  const [text, setText] = useState("");
  const [draft, setDraft] = useState<Awaited<ReturnType<typeof api.seedFloorplan>>["draft"] | null>(null);
  const preview = useMutation({
    mutationFn: () => api.seedFloorplan(slug, room.id, text, true),
    onSuccess: (r) => setDraft(r.draft),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const apply = useMutation({
    // The server writes the whole draft in one go, so the step is what the
    // places list looks like before and after it.
    mutationFn: async () => {
      const before = (await api.listLocations(slug)).items;
      const r = await api.seedFloorplan(slug, room.id, text);
      const after = (await api.listLocations(slug)).items;
      onStep({ label: `Drafted the plan of ${room.name}`, changes: diffPlaces(before, after) });
      return r;
    },
    onSuccess: (r) => {
      toast.success(
        `Plan drafted: ${r.zones?.length ?? 0} zone${(r.zones?.length ?? 0) === 1 ? "" : "s"}. Drag things to true it up.`,
      );
      onApplied();
      onClose();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const busy = preview.isPending || apply.isPending;
  return (
    <Modal open onClose={onClose} title={`Describe ${room.name}`} size="md">
      <div className="space-y-3">
        <p className="text-xs text-muted dark:text-slate-400">
          Say it like you'd say it to a person - dimensions in whatever unit you think in,
          walls, doorways, named zones, and the furniture standing in it (named things are
          matched to your existing sub-locations, never invented). The AI drafts the plan;
          you drag it true afterward. A full draft can take a minute or two - leave it be.
        </p>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={5}
          placeholder={'e.g. "The garage is 3 bays wide, 24ft deep. Bays 1+2 are open to each other, 22ft total; a partition wall, then bay 3 is 11ft wide with a doorway near the front."'}
          className="w-full rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-2 py-1.5 text-sm text-content dark:text-slate-200"
        />
        {draft && (
          <div className="rounded-md border border-line dark:border-slate-700 bg-subtle/60 dark:bg-slate-800/40 px-3 py-2 text-xs text-muted dark:text-slate-400">
            Draft: {draft.room.w_mm} × {draft.room.d_mm} mm
            {draft.room.walls?.length ? ` · ${draft.room.walls.length} wall${draft.room.walls.length === 1 ? "" : "s"}` : ""}
            {draft.zones.length ? ` · zones: ${draft.zones.map((z) => z.name).join(", ")}` : " · no zones"}
          </div>
        )}
        <div className="flex items-center gap-2 justify-end">
          <button
            type="button"
            disabled={busy || text.trim().length < 10}
            onClick={() => preview.mutate()}
            className="inline-flex items-center gap-1.5 rounded-md border border-line dark:border-slate-600 px-3 py-1.5 text-sm text-content hover:border-accent hover:text-accent transition disabled:opacity-50"
          >
            {preview.isPending ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} Preview
          </button>
          <button
            type="button"
            disabled={busy || !draft}
            onClick={() => apply.mutate()}
            className="rounded-md bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1.5 text-sm transition disabled:opacity-50"
          >
            {apply.isPending ? "Applying…" : "Apply draft"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function CreateOnPlanModal({
  slug,
  room,
  bound,
  taken,
  onClose,
  onCreated,
  onStep,
}: {
  slug: string;
  room: Location;
  bound: FpBound;
  /** What already stands on this plan: each new one goes where none of it is. */
  taken: FpRect[];
  onClose: () => void;
  onCreated: () => void;
  /** What was made, as one step Undo can take back. */
  onStep: (step: PlanStep) => void;
}) {
  const toast = useToast();
  const face = bound.view === "front";
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"container" | "area">("container");
  // "Drawer 1-3" is three drawers here as it is in the list's form.
  const names = parseRange(name)?.names ?? (name.trim() ? [name.trim()] : []);
  const made = useRef<string[]>([]);
  const noteMade = () => {
    const ids = made.current;
    made.current = [];
    if (ids.length) onStep({ label: ids.length === 1 ? `Added ${names[0]}` : `Added ${ids.length} places`, changes: ids.map((id) => ({ kind: "added", id })) });
  };
  const create = useMutation({
    mutationFn: async () => {
      const placed = [...taken];
      for (const n of names) {
        const rect = newChildRect(bound, placed);
        placed.push(rect);
        made.current.push((await api.createLocation(slug, { name: n, parent_id: room.id, kind, metadata: withRect({}, rect) })).id);
      }
    },
    onSuccess: () => {
      noteMade();
      toast.success(names.length === 1 ? `${names[0]} is on the plan` : `${names.length} places are on the plan`);
      onCreated();
      onClose();
    },
    onError: (e) => {
      // What was made before it stopped is still one step to take back.
      noteMade();
      toast.error(e instanceof ApiError ? e.message : String(e));
      onCreated();
    },
  });
  return (
    <RecordFormModal open onClose={onClose} title={`Add to ${room.name}`}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (names.length && !create.isPending) create.mutate();
        }}
      >
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={face ? "Name (e.g. Drawer 3, or Drawer 1-6)" : "Name (e.g. Workbench, Blue toolbox)"}
          aria-label="Name"
          autoFocus
          className="w-full rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-2 py-1.5 text-sm text-content dark:text-slate-200"
        />
        {names.length > 1 && (
          <p className="text-[11px] text-accent dark:text-cobble-300">
            Makes {names.length}: {parseRange(name)?.preview}
          </p>
        )}
        <div className="flex gap-2 flex-wrap">
          {(["container", "area"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              aria-pressed={kind === k}
              className={`rounded-md border px-3 py-1 text-xs transition ${kind === k ? "border-accent text-accent" : "border-line dark:border-slate-600 text-muted"}`}
            >
              {k === "container" ? "a thing things go in" : "a part of this space"}
            </button>
          ))}
        </div>
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={!names.length || create.isPending}
            className="rounded-md bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1.5 text-sm transition disabled:opacity-50"
          >
            {create.isPending ? "Adding…" : names.length > 1 ? `Add ${names.length}` : "Add"}
          </button>
        </div>
      </form>
    </RecordFormModal>
  );
}

/** Create a FLOOR: an area child that owns its own plan from birth, so it
 *  appears as a tab immediately. Floors are ordinary locations otherwise —
 *  the tree draws them as dashed zones; nothing else changes. */
function NewFloorModal({
  slug,
  room,
  onClose,
}: {
  slug: string;
  room: Location;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: (bound: FpBound) =>
      api.createLocation(slug, {
        name: name.trim(),
        parent_id: room.id,
        kind: "area",
        metadata: withBound({}, bound, "area"),
      }),
    onSuccess: (made) => {
      planHistoryFor(slug).record({ label: `Added the floor ${made.name}`, changes: [{ kind: "added", id: made.id }] });
      toast.success(`${name.trim()} added`);
      void qc.invalidateQueries({ queryKey: ["core-locations", slug] });
      onClose();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  return (
    <RecordFormModal open onClose={onClose} title={`New floor in ${room.name}`}>
      <div className="space-y-3">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder='Name (e.g. "Main floor", "Basement")'
          autoFocus
          className="w-full rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-2 py-1.5 text-sm text-content dark:text-slate-200"
        />
        <p className="text-xs text-muted dark:text-slate-400">
          Size sets the floor's outline - rooms and walls draw onto it next.
        </p>
        <BoundSetup
          unitDefault="ft"
          view="plan"
          onSet={(b) => {
            if (!name.trim()) {
              toast.error("Name the floor first");
              return;
            }
            create.mutate(b);
          }}
        />
      </div>
    </RecordFormModal>
  );
}

/** Drawers and bins on a face, in one go: the ones this place already has,
 *  arranged in rows (existing drawers were otherwise each placed full-face at
 *  the corner, stacked on one another), or new ones made and placed at true
 *  scale, named the way people name them. Each is an ordinary container
 *  afterward (scan, label, heat, a place to put things). */
type DrawerNames = "drawer" | "bin" | "row-letter";

function DrawersModal({
  slug,
  room,
  bound,
  children,
  onPlaced,
  onClose,
  onCreated,
  onStep,
}: {
  slug: string;
  room: Location;
  bound: FpBound;
  /** This place's own children: the drawers it already has. */
  children: Location[];
  /** Put one of them at a rect (or take it off the face); says what changed. */
  onPlaced: (loc: Location, rect: FpRect | null) => Promise<PlanChange>;
  onClose: () => void;
  onCreated: () => void;
  /** Everything one run did, as one step Undo can take back. */
  onStep: (step: PlanStep) => void;
}) {
  const toast = useToast();
  const ordered = useMemo(() => [...children].sort((x, y) => x.name.localeCompare(y.name, undefined, { numeric: true })), [children]);
  const onFace = ordered.filter((c) => readRect(c.metadata));
  const [mode, setMode] = useState<"arrange" | "new">(ordered.length ? "arrange" : "new");
  const [cols, setCols] = useState("1");
  const [rowsNew, setRowsNew] = useState("4");
  const [names, setNames] = useState<DrawerNames>("drawer");
  const [clear, setClear] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);

  const c = Math.max(1, parseInt(cols, 10) || 1);
  const r = mode === "arrange" ? Math.max(1, Math.ceil(ordered.length / c)) : Math.max(1, parseInt(rowsNew, 10) || 0);
  const count = mode === "arrange" ? ordered.length : r * c;
  const rects = gridRects(bound, r, c)?.slice(0, count) ?? null;
  const labels =
    mode === "arrange"
      ? ordered.map((o) => o.short_name || o.name)
      : names === "row-letter"
        ? gridNames(r, c, "row-letter", "")
        : gridNames(r, c, "sequential", names === "drawer" ? "Drawer " : "Bin ");
  const noun = names === "bin" ? "bins" : "drawers";

  const run = async () => {
    if (!rects) return;
    setProgress(0);
    const changes: PlanChange[] = [];
    const label = mode === "arrange" ? `Arranged the drawers in ${room.name}` : `Added ${rects.length} ${noun} to ${room.name}`;
    try {
      if (mode === "arrange") {
        for (let i = 0; i < ordered.length; i++) {
          changes.push(await onPlaced(ordered[i]!, rects[i]!));
          setProgress(i + 1);
        }
        toast.success(`${countOf(ordered.length, "drawer")} arranged in ${room.name}`);
      } else {
        if (clear) for (const o of onFace) changes.push(await onPlaced(o, null));
        for (let i = 0; i < rects.length; i++) {
          const made = await api.createLocation(slug, { name: labels[i]!, parent_id: room.id, kind: "container", metadata: withRect({}, rects[i]!) });
          changes.push({ kind: "added", id: made.id });
          setProgress(i + 1);
        }
        toast.success(`${rects.length} ${noun} in ${room.name}`);
      }
      onStep({ label, changes });
      onCreated();
      onClose();
    } catch (e) {
      onStep({ label, changes });
      toast.error(`Stopped after ${progress ?? 0} of ${rects.length}: ${e instanceof ApiError ? e.message : String(e)}`);
      onCreated();
      setProgress(null);
    }
  };

  const busy = progress !== null;
  const tab = (on: boolean) =>
    `flex-1 rounded-md border px-2.5 py-1.5 text-xs font-medium transition ${on ? "border-accent text-accent bg-cobble-50 dark:bg-cobble-900/30" : "border-line dark:border-slate-600 text-muted"}`;
  const num = "w-14 rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-1.5 py-1 text-sm text-content dark:text-slate-200 text-center";
  return (
    <RecordFormModal open onClose={busy ? () => {} : onClose} title={`Drawers in ${room.name}`}>
      <div className="space-y-3" data-testid="drawers-modal">
        {ordered.length > 0 && (
          <div className="flex gap-2">
            <button type="button" className={tab(mode === "arrange")} aria-pressed={mode === "arrange"} onClick={() => setMode("arrange")}>
              Arrange the {ordered.length} it has
            </button>
            <button type="button" className={tab(mode === "new")} aria-pressed={mode === "new"} onClick={() => setMode("new")}>
              Make new ones
            </button>
          </div>
        )}
        <div className="flex items-center gap-2 flex-wrap text-xs text-muted dark:text-slate-400">
          {mode === "new" && (
            <label className="inline-flex items-center gap-1.5">
              rows
              <input value={rowsNew} onChange={(e) => setRowsNew(e.target.value)} inputMode="numeric" aria-label="Rows" className={num} />
            </label>
          )}
          {mode === "new" && <span className="text-faint">×</span>}
          <label className="inline-flex items-center gap-1.5">
            {mode === "arrange" ? "side by side" : "columns"}
            <input value={cols} onChange={(e) => setCols(e.target.value)} inputMode="numeric" aria-label="Columns" className={num} />
          </label>
        </div>
        {mode === "new" && (
          <div className="flex items-center gap-2 flex-wrap">
            {(
              [
                ["drawer", `Drawer 1 … ${r * c}`],
                ["bin", `Bin 1 … ${r * c}`],
                ["row-letter", `A1 … ${gridNames(r, c, "row-letter", "").at(-1) ?? "A1"}`],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                onClick={() => setNames(k)}
                aria-pressed={names === k}
                className={`rounded-md border px-2.5 py-1 text-xs transition ${names === k ? "border-accent text-accent" : "border-line dark:border-slate-600 text-muted"}`}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        {rects ? (
          <div
            className="relative mx-auto w-full max-w-xs border-2 border-slate-400 dark:border-slate-500 rounded bg-subtle/40 dark:bg-[#0d1526]"
            style={{ aspectRatio: `${bound.w_mm} / ${bound.d_mm}`, maxHeight: "40dvh" }}
            aria-label="Preview"
          >
            {rects.map((rc, i) => (
              <span
                key={i}
                className="absolute rounded-sm border border-slate-400 dark:border-slate-500 bg-white dark:bg-slate-800 text-[10px] leading-tight px-1 overflow-hidden text-content dark:text-slate-200"
                style={{ left: pct(rc.x_mm, bound.w_mm), top: pct(rc.y_mm, bound.d_mm), width: pct(rc.w_mm, bound.w_mm), height: pct(rc.d_mm, bound.d_mm) }}
              >
                {labels[i]}
              </span>
            ))}
          </div>
        ) : (
          <p className="text-xs text-ember-500">That many don't fit this face: fewer rows or columns.</p>
        )}
        {mode === "new" && onFace.length > 0 && (
          <label className="flex items-center gap-2 text-xs text-muted dark:text-slate-400">
            <input type="checkbox" checked={clear} onChange={(e) => setClear(e.target.checked)} className="accent-cobble-600" />
            Take the {onFace.length} already on this face off it first (they are kept, just not drawn)
          </label>
        )}
        <div className="flex justify-end">
          <button
            type="button"
            disabled={!rects || busy || count === 0}
            onClick={() => void run()}
            className="rounded-md bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1.5 text-sm transition disabled:opacity-50"
          >
            {busy
              ? `${mode === "arrange" ? "Arranging" : "Making"} ${progress}/${count}…`
              : mode === "arrange"
                ? `Arrange ${countOf(count, "drawer")}`
                : `Make ${count} ${noun}`}
          </button>
        </div>
      </div>
    </RecordFormModal>
  );
}

/** Decoration inside a rect — the Gridfinity-conversation contract: the RECT
 *  is all the math ever sees; inside it, a photo fill or a silhouette outline
 *  (trapezoid wrench rails, a drill profile) is pure paint. */
function RectDecor({
  imagePath,
  fp,
}: {
  imagePath: string | null;
  fp: Record<string, unknown> | null | undefined;
}) {
  const fill = readFill(fp);
  const outline = readOutline(fp);
  const src = useImageSrc(fill === "photo" ? imagePath : null);
  return (
    <>
      {src && (
        <span
          className="absolute inset-0 rounded bg-cover bg-center opacity-80 pointer-events-none"
          style={{ backgroundImage: `url(${src})` }}
        />
      )}
      {outline && (
        <svg
          viewBox="0 0 1000 1000"
          preserveAspectRatio="none"
          className="absolute inset-0 w-full h-full pointer-events-none text-slate-500 dark:text-slate-300"
        >
          <polygon
            points={pointsAttr(outline)}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      )}
    </>
  );
}

function PlanOutlineControl({ slug, loc, onPatch }: { slug: string; loc: Location; onPatch: (patch: Record<string, unknown>, previousGroup: string) => void }) {
  const qc = useQueryClient();
  const tags = useQuery({ queryKey: ["tags", slug], queryFn: () => api.listTags(slug) });
  const attached = useQuery({ queryKey: placeTagKey(slug, loc.id), queryFn: () => readPlaceTags(slug, loc.id) });
  const outline = outlineFor(loc, attached.data?.items ?? [], tags.data?.items ?? []);
  const choose = useMutation({
    mutationFn: async (tagId: string) => {
      if (tagId !== "custom" && !(attached.data?.items ?? []).some((a) => a.tag_id === tagId)) {
        await api.attachTag(slug, { tag_id: tagId, source_module: placeModule, source_type: placeType, source_id: loc.id });
        await qc.invalidateQueries({ queryKey: ["tag-attachments", slug] });
      }
      onPatch({ outline_tag_id: tagId }, outline?.tagId ?? "custom");
    },
  });
  return <>
    <label className="inline-flex items-center gap-1.5 text-xs text-muted dark:text-slate-400">
      Outline group
      <select aria-label="Outline group" value={outline?.tagId ?? "custom"} disabled={choose.isPending || tags.isPending || attached.isPending}
        onChange={(e) => choose.mutate(e.target.value)} className="max-w-48 rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-1.5 py-1">
        {(tags.data?.items ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        <option value="custom">Custom colour</option>
      </select>
    </label>
    {choose.isError && <span role="alert" className="text-xs text-ember-700 dark:text-ember-300">{choose.error.message}</span>}
  </>;
}

/** Fill + outline pickers, shared by the location and entity panels. */
function DecorControls({
  fp,
  onPatch,
  withColour,
}: {
  fp: Record<string, unknown>;
  onPatch: (patch: Record<string, unknown>) => void;
  /** A place can wear a colour on the plan (its legend says which). */
  withColour?: boolean;
}) {
  const colour = isPlanColour(fp.color) ? fp.color : null;
  const currentOutline = readOutline(fp);
  const currentPreset =
    Object.entries(OUTLINE_PRESETS).find(
      ([, pts]) => JSON.stringify(pts) === JSON.stringify(currentOutline),
    )?.[0] ?? (currentOutline ? "custom" : "none");
  return (
    <>
      {withColour && (
        <span role="group" aria-label="Colour on the plan" className="inline-flex items-center gap-1 text-xs text-muted dark:text-slate-400">
          custom colour
          <button
            type="button"
            aria-label="No colour"
            aria-pressed={!colour}
            onClick={() => onPatch({ color: null })}
            className={`h-6 w-6 rounded-full border border-line dark:border-slate-500 bg-surface dark:bg-slate-900 text-[10px] leading-none ${!colour ? "ring-2 ring-accent" : ""}`}
          >
            ×
          </button>
          {PLAN_COLOURS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={`Colour: ${PLAN_COLOUR_STYLE[c].label}`}
              aria-pressed={colour === c}
              title={`Colour: ${PLAN_COLOUR_STYLE[c].label}`}
              onClick={() => onPatch({ color: c })}
              className={`h-6 w-6 rounded-full ${PLAN_COLOUR_STYLE[c].swatch} ${colour === c ? "ring-2 ring-offset-1 ring-accent dark:ring-offset-slate-800" : ""}`}
            />
          ))}
        </span>
      )}
      <label className="inline-flex items-center gap-1.5 text-xs text-muted dark:text-slate-400">
        <input
          type="checkbox"
          checked={readFill(fp) === "photo"}
          onChange={(e) => onPatch({ fill: e.target.checked ? "photo" : null })}
          className="accent-cobble-600"
        />
        photo fill
      </label>
      <label className="inline-flex items-center gap-1.5 text-xs text-muted dark:text-slate-400">
        outline
        <select
          value={currentPreset}
          onChange={(e) => {
            const v = e.target.value;
            onPatch({ outline: v === "none" ? null : (OUTLINE_PRESETS[v] ?? null) });
          }}
          className="rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-1 py-0.5 text-xs text-content dark:text-slate-200"
        >
          <option value="none">none</option>
          {Object.keys(OUTLINE_PRESETS).map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
          {currentPreset === "custom" && <option value="custom">custom</option>}
        </select>
      </label>
    </>
  );
}

/** Edit panel for a selected ENTITY occupant (a machine/asset/part on the
 *  plan) — dims, decoration, remove-from-plan. */
function EntityPanel({
  ent,
  unit,
  grid,
  secondAxis,
  onRect,
  onResize,
  onDecor,
}: {
  ent: PlanEntity | null;
  unit: LengthUnit;
  grid: number | undefined;
  secondAxis: string;
  onRect: (ent: PlanEntity, r: FpRect | null) => void;
  /** One size, merged onto the thing's freshest rect (#5950). */
  onResize: (ent: PlanEntity, patch: Partial<FpRect>) => void;
  onDecor: (ent: PlanEntity, patch: Record<string, unknown>) => void;
}) {
  if (!ent) return null;
  const rect = readRect(ent.metadata);
  if (!rect) return null;
  const fp = (ent.metadata?.floorplan as Record<string, unknown>) ?? {};
  return (
    <div className="flex items-center gap-3 flex-wrap rounded-md border border-cobble-300/60 dark:border-cobble-700/60 bg-cobble-50 dark:bg-slate-800 px-3 py-2">
      <span className="text-xs font-medium text-content dark:text-slate-200">{ent.name}</span>
      <span className="text-[10px] uppercase tracking-widest text-faint">
        {ent.kind.split(":")[1]}
      </span>
      <DimInput label="wide" mm={rect.w_mm} unit={unit} onCommit={(v) => onResize(ent, { w_mm: v })} />
      <DimInput label={secondAxis} mm={rect.d_mm} unit={unit} onCommit={(v) => onResize(ent, { d_mm: v })} />
      {grid && (
        <span className="font-mono text-[10px] text-faint" title={gridCellsNote(rect, grid).title} data-testid="plan-grid-cells">
          {gridCellsNote(rect, grid).text}
        </span>
      )}
      <DecorControls fp={fp} onPatch={(patch) => onDecor(ent, patch)} />
      <div className="flex-1" />
      <button type="button" onClick={() => onRect(ent, null)} className="text-xs text-faint hover:text-ember-500">
        remove from plan
      </button>
    </div>
  );
}

/** Past this many pins on one plan their names would cover the room, so the
 *  names go to hover and to a screen reader only. */
const PIN_LABELS_UP_TO = 12;

/** A pinned thing's name: its placement's own title, else the record's name
 *  from the placeable list, never an empty label. */
export function pinName(t: { kind: string; id: string; title?: string | null }, placeable: ReadonlyArray<{ kind: string; id: string; name: string }>): string {
  return t.title?.trim() || placeable.find((r) => r.kind === t.kind && r.id === t.id)?.name || "Something pinned here";
}
