// The floor plan — a location's children drawn where they physically stand.
// Third lens on the same hierarchy the tree and the scanner use; every rect
// IS a location record. Spec: docs/design-decisions/location-floor-plan.md.
//
// Day-to-day view: a clean map — no numbers, no units, no grid. Edit mode:
// snap grid, drag/resize, wall + opening editing, dims (in the user's own
// unit), the unplaced tray, and the describe-to-seed flow. Zones (child
// areas) are invisible regions with faint toggleable labels; dropping a
// container inside one reparents it there (the plan is the filing UI).

import { useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Flame, Loader2, Pencil, Plus, Printer, ScanLine, Sparkles, Tag, X } from "lucide-react";
import { Modal, useImageSrc, useToast } from "@cobblr/platform-web";
import { ApiError, api, type Location } from "../lib/api";
import { totalUsage, useLocationUsage } from "../lib/useLocationUsage";
import {
  SNAP_MM,
  clampRect,
  planOwnerOf,
  readBound,
  readRect,
  rebaseRect,
  snap,
  wallSegments,
  zoneAt,
  type FpBound,
  type FpRect,
  type FpWall,
} from "../lib/floorplanGeometry";
import { formatLength, parseLength, type LengthUnit } from "../lib/lengthUnits";
import { gridNames, gridRects, type GridNameScheme } from "../lib/gridFill";
import { OUTLINE_PRESETS, byAreaDesc, pointsAttr, readFill, readOutline } from "../lib/planDecor";
import { useDetailRoute } from "../lib/useDetailRoute";

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
  image_path: string | null;
  location_id: string | null;
  metadata: Record<string, unknown>;
}

/** Rows a declared listEndpoint returns (the manifest's row-shape contract). */
interface ListedRow {
  id: string;
  name?: string;
  title?: string;
  image_path?: string | null;
  location_id?: string | null;
  metadata?: Record<string, unknown>;
}

function traitAxis(t: unknown): string | null {
  if (t == null) return null;
  if (typeof t === "string") return t;
  const v = (t as { trait?: unknown }).trait;
  return typeof v === "string" ? v : null;
}

const pct = (v: number, total: number) => `${(v / total) * 100}%`;

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

function PlanFor({
  room,
  slug,
  bare = false,
  headTitle,
  onAddFloor,
}: {
  room: Location;
  slug: string;
  /** Render without the outer section chrome (inside floor tabs / the peek modal). */
  bare?: boolean;
  headTitle?: string;
  /** Offered on an empty area's setup row — splits the space into floors. */
  onAddFloor?: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const planRef = useRef<HTMLDivElement | null>(null);

  const locs = useQuery({
    queryKey: ["core-locations", slug],
    queryFn: () => api.listLocations(slug),
    staleTime: 30_000,
  });
  const items = useMemo(() => locs.data?.items ?? [], [locs.data]);
  const byId = useMemo(() => new Map(items.map((l) => [l.id, l] as const)), [items]);

  const bound = readBound(room.metadata);
  const [edit, setEdit] = useState(false);
  const [showZones, setShowZones] = useState(false);
  const [sel, setSel] = useState<Sel>(null);
  // Live rect during a drag/resize — rendered in place of the saved one.
  const [live, setLive] = useState<{ id: string; rect: FpRect } | null>(null);
  const [liveWall, setLiveWall] = useState<{ idx: number; wall: FpWall } | null>(null);
  const [seedOpen, setSeedOpen] = useState(false);
  const [createAt, setCreateAt] = useState<FpRect | null>(null);
  const [gridOpen, setGridOpen] = useState(false);

  // Everything drawn on THIS plan: descendants whose nearest planned ancestor
  // is this room (a rack reparented into Bay 1 stays on the garage's plan).
  const placed = useMemo(
    () =>
      items
        .filter((l) => l.id !== room.id && readRect(l.metadata) && planOwnerOf(l.id, byId) === room.id)
        .map((l) => ({ loc: l, rect: readRect(l.metadata)! })),
    [items, byId, room.id],
  );
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
  // PLACEABLE KINDS come from the entity-kind registry: a kind that declares
  // its own list + update endpoints (the manifest seam) and is physically
  // tangible. Any future module joins with one manifest line; nothing is
  // named here. Kinds whose rows carry no location_id simply never match.
  const kindsQ = useQuery({
    queryKey: ["entity-kinds", slug],
    queryFn: () => api.listEntityKinds(slug),
    enabled: !!slug,
    staleTime: 5 * 60_000,
  });
  const placeableKinds = useMemo(
    () =>
      (kindsQ.data?.items ?? []).filter(
        (k) =>
          k.endpoints?.list &&
          k.endpoints?.update &&
          traitAxis(k.traits?.tangibility) === "physical",
      ),
    [kindsQ.data],
  );
  const kindLists = useQueries({
    queries: placeableKinds.map((k) => ({
      queryKey: ["kind-list", slug, k.id],
      queryFn: () =>
        api.request<{ items: ListedRow[] }>(
          "GET",
          `/orgs/${slug}/${k.instance_name ? `instances/${k.instance_name}` : `modules/${k.module_name}`}${k.endpoints!.list}`,
        ),
      staleTime: 30_000,
    })),
  });
  const routeFor = useDetailRoute(slug);
  const occupants = useMemo(() => {
    const all: PlanEntity[] = [];
    placeableKinds.forEach((k, i) => {
      for (const row of kindLists[i]?.data?.items ?? []) {
        all.push({
          kind: k.id,
          id: row.id,
          name: row.name ?? row.title ?? "(unnamed)",
          image_path: row.image_path ?? null,
          location_id: row.location_id ?? null,
          metadata: row.metadata ?? {},
        });
      }
    });
    // An entity draws on the plan its LOCATION belongs to: the location
    // itself when it owns a plan (a drawer), else that location's plan owner.
    const ownerOfLoc = (locId: string): string | null => {
      const l = byId.get(locId);
      if (!l) return null;
      if (readBound(l.metadata)) return l.id;
      return planOwnerOf(locId, byId);
    };
    return all.filter((e) => e.location_id && ownerOfLoc(e.location_id) === room.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placeableKinds, ...kindLists.map((q) => q.data), byId, room.id]);
  const placedOccupants = useMemo(
    () =>
      occupants
        .filter((e) => readRect(e.metadata))
        .map((e) => ({ ent: e, rect: readRect(e.metadata)! }))
        .sort(byAreaDesc),
    [occupants],
  );
  const unplacedOccupants = useMemo(
    () => occupants.filter((e) => !readRect(e.metadata)),
    [occupants],
  );
  // Peek drill-in: a placed child that owns its own plan opens zoomed in a
  // modal (kept as an id so edits inside the peek see live data).
  const [peekId, setPeekId] = useState<string | null>(null);
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

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["core-locations", slug] });
    void qc.invalidateQueries({ queryKey: ["location", slug, room.id] });
  };

  const saveMeta = useMutation({
    mutationFn: (p: { id: string; metadata: Record<string, unknown> }) =>
      api.updateLocation(slug, p.id, { metadata: p.metadata }),
    onSuccess: invalidate,
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  const saveRect = (loc: Location, rect: FpRect | null) => {
    const meta = { ...(loc.metadata ?? {}) } as Record<string, unknown>;
    // MERGE into the blob — a drag must never strip decoration (fill/outline).
    if (rect) meta.floorplan = { ...((meta.floorplan as Record<string, unknown>) ?? {}), ...rect };
    else delete meta.floorplan;
    saveMeta.mutate({ id: loc.id, metadata: meta });
  };
  /** Patch decoration keys (fill/outline) on a placed location's blob. */
  const patchLocFloorplan = (loc: Location, patch: Record<string, unknown>) => {
    const meta = { ...(loc.metadata ?? {}) } as Record<string, unknown>;
    const fp = { ...((meta.floorplan as Record<string, unknown>) ?? {}), ...patch };
    for (const k of Object.keys(fp)) if (fp[k] === undefined || fp[k] === null) delete fp[k];
    meta.floorplan = fp;
    saveMeta.mutate({ id: loc.id, metadata: meta });
  };
  const saveBound = (next: FpBound) => {
    saveMeta.mutate({
      id: room.id,
      metadata: { ...(room.metadata ?? {}), floorplan: next },
    });
  };

  const reparent = useMutation({
    mutationFn: (p: { id: string; parent_id: string; label: string }) =>
      api.updateLocation(slug, p.id, { parent_id: p.parent_id }),
    onSuccess: (_r, p) => {
      toast.success(`Moved into ${p.label}`);
      invalidate();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  // Entity writes resolve the kind's manifest-declared update endpoint from
  // the registry — never a hardcoded module route (the workspace-tools rule:
  // an undeclared kind is honestly not writable, not guessed at).
  const patchEntity = async (ent: PlanEntity, body: Record<string, unknown>) => {
    const k = placeableKinds.find((pk) => pk.id === ent.kind);
    const tmpl = k?.endpoints?.update;
    if (!k || !tmpl) throw new ApiError(400, "not_writable", `${ent.kind} declares no update endpoint`);
    await api.request(
      "PATCH",
      `/orgs/${slug}/${k.instance_name ? `instances/${k.instance_name}` : `modules/${k.module_name}`}${tmpl.replace("{id}", ent.id)}`,
      body,
    );
  };
  const invalidateEntities = () => {
    void qc.invalidateQueries({ queryKey: ["kind-list", slug] });
  };
  const saveEntity = useMutation({
    mutationFn: (p: { ent: PlanEntity; body: Record<string, unknown>; label?: string }) =>
      patchEntity(p.ent, p.body),
    onSuccess: (_r, p) => {
      if (p.label) toast.success(p.label);
      invalidateEntities();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const saveEntityRect = (ent: PlanEntity, rect: FpRect | null) => {
    const meta = { ...(ent.metadata ?? {}) } as Record<string, unknown>;
    const fp = { ...((meta.floorplan as Record<string, unknown>) ?? {}) };
    if (rect) meta.floorplan = { ...fp, ...rect };
    else delete meta.floorplan;
    saveEntity.mutate({ ent, body: { metadata: meta } });
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
      const g = bound.grid_mm ?? SNAP_MM;
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
        const meta = { ...(ent.metadata ?? {}) } as Record<string, unknown>;
        meta.floorplan = { ...((meta.floorplan as Record<string, unknown>) ?? {}), ...rectToSave };
        const moved = targetLocId !== ent.location_id;
        saveEntity.mutate({
          ent,
          body: { metadata: meta, ...(moved ? { location_id: targetLocId } : {}) },
          label: moved ? `Moved into ${byId.get(targetLocId!)?.name ?? room.name}` : undefined,
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
    const startX = e.clientX;
    const startY = e.clientY;
    const orig = { ...rect };
    let last = rect;
    const onMove = (ev: PointerEvent) => {
      const dx = (ev.clientX - startX) * scale;
      const dy = (ev.clientY - startY) * scale;
      const g = bound.grid_mm ?? SNAP_MM;
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
      setLive(null);
      if (last.x_mm !== rect.x_mm || last.y_mm !== rect.y_mm || last.w_mm !== rect.w_mm || last.d_mm !== rect.d_mm) {
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
            reparent.mutate({ id: loc.id, parent_id: target, label });
          }
        }
        saveRect(loc, rectToSave);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

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
        saveBound({ ...bound, walls });
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
            ? "Lay out this container's face — drawers and compartments drawn at true scale, partial-width ones visibly partial."
            : "Draw this space to scale — walls, zones, and everything standing in it. Dimensions only set the shape; the day-to-day view shows no numbers."}
        </p>
        <div className="flex gap-2 flex-wrap">
          <BoundSetup
            unitDefault="ft"
            view={defaultView}
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
          <SeedModal room={room} slug={slug} onClose={() => setSeedOpen(false)} onApplied={invalidate} />
        )}
      </section>
    );
  }

  const unit: LengthUnit = bound.unit ?? "ft";
  const view = bound.view ?? defaultView;
  const grid = bound.grid_mm ?? SNAP_MM;
  const walls = liveWall
    ? (bound.walls ?? []).map((w, i) => (i === liveWall.idx ? liveWall.wall : w))
    : (bound.walls ?? []);

  const content = (
    <div className="space-y-3">
      <SectionHead room={room} edit={edit} title={headTitle}>
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
                saveBound({ ...bound, walls: [...(bound.walls ?? []), w] });
                setSel({ type: "wall", idx: (bound.walls ?? []).length });
              }}
              className="rounded-md border border-line dark:border-slate-600 px-2 py-1 text-xs text-muted hover:text-content transition"
            >
              + wall
            </button>
            <button
              type="button"
              onClick={() =>
                setCreateAt(
                  clampRect(
                    { x_mm: snap(bound.w_mm / 2 - 600), y_mm: snap(bound.d_mm / 2 - 300), w_mm: 1200, d_mm: 600 },
                    bound,
                  ),
                )
              }
              className="rounded-md border border-line dark:border-slate-600 px-2 py-1 text-xs text-muted hover:text-content transition"
            >
              + location
            </button>
            <button
              type="button"
              onClick={() => setGridOpen(true)}
              title="Create + place a whole grid of bins/cubbies in one shot (a parts rack's 24 bins, a cabinet's drawers)"
              className="rounded-md border border-line dark:border-slate-600 px-2 py-1 text-xs text-muted hover:text-content transition"
            >
              + grid
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
              <Pencil size={12} /> Edit
            </>
          )}
        </button>
      </SectionHead>

      {/* ── the plan ── */}
      <div
        ref={planRef}
        className={`relative w-full border-2 border-slate-400 dark:border-slate-500 rounded bg-subtle/40 dark:bg-[#0d1526] select-none ${edit ? "bg-[radial-gradient(circle,rgba(100,116,139,.25)_1px,transparent_1px)]" : ""}`}
        style={{
          aspectRatio: `${bound.w_mm} / ${bound.d_mm}`,
          // Edit-mode dots sit at the layout's REAL pitch — a 42mm Gridfinity
          // drawer shows its actual cells, not a decorative texture.
          ...(edit
            ? { backgroundSize: `${(grid / bound.w_mm) * 100}% ${(grid / bound.d_mm) * 100}%` }
            : {}),
        }}
        onPointerDown={() => edit && setSel(null)}
      >
        {/* walls, minus their door openings */}
        {walls.map((w, idx) =>
          wallSegments(w).map((s, si) => {
            const vertical = s.x1 === s.x2;
            return (
              <div
                key={`w${idx}-${si}`}
                onPointerDown={(e) => startWallDrag(e, idx)}
                className={`absolute bg-slate-500 dark:bg-slate-400 rounded-sm ${edit ? "cursor-ew-resize" : ""} ${sel?.type === "wall" && sel.idx === idx ? "ring-1 ring-accent" : ""}`}
                style={
                  vertical
                    ? { left: pct(s.x1, bound.w_mm), top: pct(s.y1, bound.d_mm), width: 4, height: pct(s.y2 - s.y1, bound.d_mm), transform: "translateX(-2px)" }
                    : { left: pct(s.x1, bound.w_mm), top: pct(s.y1, bound.d_mm), height: 4, width: pct(s.x2 - s.x1, bound.w_mm), transform: "translateY(-2px)" }
                }
              />
            );
          }),
        )}

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
                } else setPeekId(loc.id);
              }}
              title={`${loc.name} — open its plan`}
              className={`absolute rounded border border-slate-400 dark:border-slate-500 bg-slate-500/10 dark:bg-slate-400/10
                ${edit ? "cursor-move" : "cursor-pointer hover:border-accent"}
                ${selected ? "ring-1 ring-accent border-accent" : ""}`}
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
              {selected && edit && (
                <span
                  onPointerDown={(e) => startDrag(e, loc, r, "resize")}
                  className="absolute -right-1 -bottom-1 w-2.5 h-2.5 bg-accent rounded-sm cursor-nwse-resize"
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
              {edit && (
                <div
                  onPointerDown={(e) => {
                    const loc = byId.get(z.id);
                    if (loc) startDrag(e, loc, r, "move");
                  }}
                  className={`absolute border border-dashed border-slate-400/50 dark:border-slate-500/40 rounded cursor-move ${sel?.type === "item" && sel.id === z.id ? "ring-1 ring-accent/60" : ""}`}
                  style={{ left: pct(r.x_mm, bound.w_mm), top: pct(r.y_mm, bound.d_mm), width: pct(r.w_mm, bound.w_mm), height: pct(r.d_mm, bound.d_mm) }}
                >
                  {sel?.type === "item" && sel.id === z.id && (
                    <span
                      onPointerDown={(e) => {
                        const loc = byId.get(z.id);
                        if (loc) startDrag(e, loc, r, "resize");
                      }}
                      className="absolute -right-1 -bottom-1 w-2.5 h-2.5 bg-accent rounded-sm cursor-nwse-resize"
                    />
                  )}
                </div>
              )}
              {(showZones || edit) && (
                <span
                  className="absolute font-mono text-[10px] uppercase tracking-[.2em] text-cobble-600/40 dark:text-cobble-300/30 pointer-events-none -translate-x-1/2 -translate-y-1/2"
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
            return (
              <div
                key={loc.id}
                onPointerDown={(e) => startDrag(e, loc, r, "move")}
                onClick={(e) => {
                  if (edit) {
                    e.stopPropagation();
                    setSel({ type: "item", id: loc.id });
                  } else if (readBound(loc.metadata)) {
                    // Owns its own layout (a toolbox face) → zoom in place.
                    setPeekId(loc.id);
                  } else navigate(`/locations/${loc.id}`);
                }}
                title={loc.name}
                className={`absolute rounded border overflow-hidden text-[11px] leading-tight px-1 py-0.5
                  ${r.wall_mounted ? "bg-slate-200/80 dark:bg-slate-700/70" : "bg-white dark:bg-slate-800"}
                  border-slate-400 dark:border-slate-500 text-content dark:text-slate-200
                  ${edit ? "cursor-move" : "cursor-pointer hover:border-accent hover:text-accent"}
                  ${selected ? "ring-1 ring-accent border-accent" : ""}`}
                style={{
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
                <span className="relative">
                  {pxW < 30 && pxH < 30 ? (loc.short_name || "·") : (loc.short_name && pxW < 90 && !rotate ? loc.short_name : loc.name)}
                </span>
                {heatBadge(loc.id)}
                {selected && edit && (
                  <span
                    onPointerDown={(e) => startDrag(e, loc, r, "resize")}
                    className="absolute -right-0.5 -bottom-0.5 w-2.5 h-2.5 bg-accent rounded-sm cursor-nwse-resize"
                    style={rotate ? { writingMode: "horizontal-tb" } : undefined}
                  />
                )}
              </div>
            );
          })}

        {/* entity occupants — the THINGS themselves (ratchets, guns, parts),
            placed via their own metadata rect. Cobble-tinted = a thing;
            slate = a place. Area-descending for overlap clicks. */}
        {placedOccupants.map(({ ent, rect }) => {
          const key = `${ent.kind}:${ent.id}`;
          const r = live?.id === key ? live.rect : rect;
          const selected = sel?.type === "entity" && sel.id === ent.id;
          return (
            <div
              key={key}
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
              title={ent.name}
              className={`absolute rounded-md border border-cobble-500/70 dark:border-cobble-400/60 bg-cobble-50/60 dark:bg-cobble-900/30 overflow-hidden text-[10px] leading-tight px-1 py-0.5 text-content dark:text-slate-200
                ${edit ? "cursor-move" : "cursor-pointer hover:border-accent"}
                ${selected ? "ring-1 ring-accent border-accent" : ""}`}
              style={{
                left: pct(r.x_mm, bound.w_mm),
                top: pct(r.y_mm, bound.d_mm),
                width: pct(r.w_mm, bound.w_mm),
                height: pct(r.d_mm, bound.d_mm),
              }}
            >
              <RectDecor imagePath={ent.image_path} fp={ent.metadata?.floorplan as Record<string, unknown> | undefined} />
              <span className="relative">{ent.name}</span>
              {selected && edit && (
                <span
                  onPointerDown={(e) => startEntityDrag(e, ent, r, "resize")}
                  className="absolute -right-0.5 -bottom-0.5 w-2.5 h-2.5 bg-accent rounded-sm cursor-nwse-resize"
                />
              )}
            </div>
          );
        })}
      </div>

      {/* ── edit panel ── */}
      {edit && sel?.type === "entity" && (
        <EntityPanel
          ent={occupants.find((o) => o.id === sel.id && o.kind === sel.kind) ?? null}
          unit={unit}
          grid={bound.grid_mm}
          secondAxis={view === "front" ? "tall" : "deep"}
          onRect={saveEntityRect}
          onDecor={(ent, patch) => {
            const meta = { ...(ent.metadata ?? {}) } as Record<string, unknown>;
            const fp = { ...((meta.floorplan as Record<string, unknown>) ?? {}), ...patch };
            for (const k of Object.keys(fp)) if (fp[k] === undefined || fp[k] === null) delete fp[k];
            meta.floorplan = fp;
            saveEntity.mutate({ ent, body: { metadata: meta } });
          }}
        />
      )}
      {edit && sel?.type !== "entity" && (
        <EditPanel
          bound={bound}
          unit={unit}
          view={view}
          grid={grid}
          sel={sel}
          byId={byId}
          onBound={saveBound}
          onRect={(loc, r) => saveRect(loc, r)}
          onFloorplanPatch={patchLocFloorplan}
          onDeleteWall={(idx) => {
            const next = [...(bound.walls ?? [])];
            next.splice(idx, 1);
            saveBound({ ...bound, walls: next });
            setSel(null);
          }}
        />
      )}

      {/* ── tray: direct children not yet on the plan ── */}
      {tray.length > 0 && (
        <div className="flex items-baseline gap-2 flex-wrap text-xs text-faint dark:text-slate-500">
          <span>not on the plan:</span>
          {tray.map((l) => (
            <button
              key={l.id}
              type="button"
              disabled={!edit}
              title={edit ? `Place ${l.name} at the center` : "Enter edit mode to place"}
              onClick={() =>
                saveRect(
                  l,
                  clampRect(
                    { x_mm: snap(bound.w_mm / 2 - 600), y_mm: snap(bound.d_mm / 2 - 300), w_mm: 1200, d_mm: 600 },
                    bound,
                  ),
                )
              }
              className="rounded-md border border-line dark:border-slate-700 bg-subtle dark:bg-slate-800 px-2 py-0.5 text-content dark:text-slate-300 disabled:opacity-60 hover:border-accent transition"
            >
              {l.name}
            </button>
          ))}
          <span className="italic">placement is optional</span>
        </div>
      )}

      {/* items filed here but not yet on the plan — tap to drop at center */}
      {edit && unplacedOccupants.length > 0 && (
        <div className="flex items-baseline gap-2 flex-wrap text-xs text-faint dark:text-slate-500">
          <span>items here, not placed:</span>
          {unplacedOccupants.slice(0, 24).map((e) => (
            <button
              key={`${e.kind}:${e.id}`}
              type="button"
              onClick={() =>
                saveEntityRect(
                  e,
                  clampRect(
                    {
                      x_mm: snap(bound.w_mm / 2 - grid * 2, grid),
                      y_mm: snap(bound.d_mm / 2 - grid * 1.5, grid),
                      w_mm: grid * 4,
                      d_mm: grid * 3,
                    },
                    bound,
                  ),
                )
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

      {seedOpen && <SeedModal room={room} slug={slug} onClose={() => setSeedOpen(false)} onApplied={invalidate} />}
      {createAt && (
        <CreateOnPlanModal
          slug={slug}
          room={room}
          rect={createAt}
          onClose={() => setCreateAt(null)}
          onCreated={invalidate}
        />
      )}
      {gridOpen && (
        <GridFillModal
          slug={slug}
          room={room}
          bound={bound}
          onClose={() => setGridOpen(false)}
          onCreated={invalidate}
        />
      )}
      {/* Peek drill-in: the child's own plan, zoomed, fully interactive —
          without losing where you were. */}
      {peekLoc && (
        <Modal open onClose={() => setPeekId(null)} title={peekLoc.name} size="lg">
          <div className="space-y-2">
            <PlanFor room={peekLoc} slug={slug} bare headTitle={peekLoc.kind === "container" ? "Layout" : peekLoc.name} />
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
        </Modal>
      )}
    </div>
  );

  return bare ? (
    content
  ) : (
    <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4">
      {content}
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
    <div className="flex items-center gap-2">
      <h2 className="text-sm font-medium text-content dark:text-mortar-100">
        {title ?? (room.kind === "container" ? "Layout" : "Floor plan")}
      </h2>
      {edit && (
        <span className="font-mono text-[10px] uppercase tracking-widest text-accent">editing</span>
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
  const [text, setText] = useState(formatLength(mm, unit));
  const commit = () => {
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
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        className="w-20 rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-1.5 py-0.5 text-xs text-content dark:text-slate-200 font-mono"
      />
    </label>
  );
}

function EditPanel({
  bound,
  unit,
  view,
  grid,
  sel,
  byId,
  onBound,
  onRect,
  onFloorplanPatch,
  onDeleteWall,
}: {
  bound: FpBound;
  unit: LengthUnit;
  view: "plan" | "front";
  grid: number;
  sel: Sel;
  byId: Map<string, Location>;
  onBound: (b: FpBound) => void;
  onRect: (loc: Location, r: FpRect | null) => void;
  onFloorplanPatch: (loc: Location, patch: Record<string, unknown>) => void;
  onDeleteWall: (idx: number) => void;
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
      <div className="flex items-center gap-3 flex-wrap rounded-md border border-line dark:border-slate-700 bg-subtle/60 dark:bg-slate-800/40 px-3 py-2">
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
          <span key={oi} className="inline-flex items-center gap-1.5 rounded border border-line dark:border-slate-600 px-1.5 py-0.5">
            <DimInput label="at" mm={o.at_mm} unit={unit} onCommit={(v) => {
              const openings = [...(wall.openings ?? [])];
              openings[oi] = { ...o, at_mm: v };
              patchWall({ openings });
            }} />
            <DimInput label="w" mm={o.w_mm} unit={unit} onCommit={(v) => {
              const openings = [...(wall.openings ?? [])];
              openings[oi] = { ...o, w_mm: v };
              patchWall({ openings });
            }} />
            <button
              type="button"
              onClick={() => {
                const openings = [...(wall.openings ?? [])];
                openings.splice(oi, 1);
                patchWall({ openings });
              }}
              className="text-faint hover:text-ember-500"
              title="Remove opening"
            >
              <X size={12} />
            </button>
          </span>
        ))}
        <button
          type="button"
          onClick={() => {
            const len = Math.abs(vertical ? wall.y2 - wall.y1 : wall.x2 - wall.x1);
            patchWall({ openings: [...(wall.openings ?? []), { at_mm: snap(len / 2), w_mm: 900 }] });
          }}
          className="inline-flex items-center gap-1 text-xs text-muted hover:text-accent"
        >
          <Plus size={12} /> door
        </button>
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
      <div className="flex items-center gap-3 flex-wrap rounded-md border border-line dark:border-slate-700 bg-subtle/60 dark:bg-slate-800/40 px-3 py-2">
        <Link to={`/locations/${loc.id}`} className="text-xs font-medium text-content dark:text-slate-200 hover:text-accent">
          {loc.name}
        </Link>
        <span className="font-mono text-[10px] uppercase tracking-widest text-faint">{loc.kind}</span>
        <DimInput label="wide" mm={rect.w_mm} unit={unit} onCommit={(v) => onRect(loc, { ...rect, w_mm: v })} />
        <DimInput label={secondAxis} mm={rect.d_mm} unit={unit} onCommit={(v) => onRect(loc, { ...rect, d_mm: v })} />
        {bound.grid_mm && (
          <span className="font-mono text-[10px] text-faint" title={`in ${bound.grid_mm}mm grid units`}>
            {Math.round(rect.w_mm / bound.grid_mm)} × {Math.round(rect.d_mm / bound.grid_mm)} u
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
        <DecorControls
          fp={(loc.metadata?.floorplan as Record<string, unknown>) ?? {}}
          onPatch={(patch) => onFloorplanPatch(loc, patch)}
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
    <div className="flex items-center gap-3 flex-wrap rounded-md border border-line dark:border-slate-700 bg-subtle/60 dark:bg-slate-800/40 px-3 py-2">
      <span className="text-xs font-medium text-content dark:text-slate-200">
        {view === "front" ? "face" : "room"}
      </span>
      <DimInput
        label="wide"
        mm={bound.w_mm}
        unit={unit}
        onCommit={(v, typed) => onBound({ ...bound, w_mm: v, ...(typed ? { unit: typed } : {}) })}
      />
      <DimInput
        label={secondAxis}
        mm={bound.d_mm}
        unit={unit}
        onCommit={(v, typed) => onBound({ ...bound, d_mm: v, ...(typed ? { unit: typed } : {}) })}
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
      {/* Snap pitch: 42mm = exact Gridfinity; anything = "1 square". */}
      <DimInput
        label="grid"
        mm={grid}
        unit="mm"
        onCommit={(v) => onBound({ ...bound, grid_mm: Math.max(5, Math.min(1000, v)) })}
      />
      <span className="text-[11px] text-faint italic">
        numbers live here in edit mode only - the plan itself stays clean
      </span>
    </div>
  );
}

function BoundSetup({
  unitDefault,
  view,
  onSet,
}: {
  unitDefault: LengthUnit;
  view: "plan" | "front";
  onSet: (b: FpBound) => void;
}) {
  const [w, setW] = useState("");
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
    <span className="inline-flex items-center gap-1.5">
      <input
        value={w}
        onChange={(e) => setW(e.target.value)}
        placeholder={view === "front" ? "width (e.g. 44in)" : "width (e.g. 33ft)"}
        className="w-32 rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-2 py-1.5 text-sm text-content dark:text-slate-200"
      />
      <span className="text-faint text-sm">×</span>
      <input
        value={d}
        onChange={(e) => setD(e.target.value)}
        placeholder={view === "front" ? "height (e.g. 40in)" : "depth (e.g. 24ft)"}
        className="w-32 rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-2 py-1.5 text-sm text-content dark:text-slate-200"
      />
      <button
        type="button"
        onClick={commit}
        className="rounded-md bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1.5 text-sm transition"
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
}: {
  room: Location;
  slug: string;
  onClose: () => void;
  onApplied: () => void;
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
    mutationFn: () => api.seedFloorplan(slug, room.id, text),
    onSuccess: (r) => {
      toast.success(
        `Plan drafted — ${r.zones?.length ?? 0} zone${(r.zones?.length ?? 0) === 1 ? "" : "s"}. Drag things to true it up.`,
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
  rect,
  onClose,
  onCreated,
}: {
  slug: string;
  room: Location;
  rect: FpRect;
  onClose: () => void;
  onCreated: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"container" | "area">("container");
  const create = useMutation({
    mutationFn: () =>
      api.createLocation(slug, {
        name: name.trim(),
        parent_id: room.id,
        kind,
        metadata: { floorplan: rect },
      }),
    onSuccess: () => {
      toast.success(`${name.trim()} placed`);
      onCreated();
      onClose();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  return (
    <Modal open onClose={onClose} title="New location on the plan" size="sm">
      <div className="space-y-3">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name (e.g. Workbench)"
          autoFocus
          className="w-full rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-2 py-1.5 text-sm text-content dark:text-slate-200"
        />
        <div className="flex gap-2">
          {(["container", "area"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className={`rounded-md border px-3 py-1 text-xs transition ${kind === k ? "border-accent text-accent" : "border-line dark:border-slate-600 text-muted"}`}
            >
              {k === "container" ? "container (a thing items go into)" : "area (a zone of this space)"}
            </button>
          ))}
        </div>
        <div className="flex justify-end">
          <button
            type="button"
            disabled={!name.trim() || create.isPending}
            onClick={() => create.mutate()}
            className="rounded-md bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1.5 text-sm transition disabled:opacity-50"
          >
            Create + place
          </button>
        </div>
      </div>
    </Modal>
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
        metadata: { floorplan: bound },
      }),
    onSuccess: () => {
      toast.success(`${name.trim()} added`);
      void qc.invalidateQueries({ queryKey: ["core-locations", slug] });
      onClose();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  return (
    <Modal open onClose={onClose} title={`New floor in ${room.name}`} size="sm">
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
    </Modal>
  );
}

/** "Fill grid" — a parts rack's 24 bins (or a cabinet's cubbies) created AND
 *  placed in one shot: rows × columns tiled at true scale across the face,
 *  named A1…C8 or Bin 1…24 in reading order. Adds to the existing layout;
 *  each bin is an ordinary container location afterward (scan, label, heat,
 *  single-SKU qty card — everything). */
function GridFillModal({
  slug,
  room,
  bound,
  onClose,
  onCreated,
}: {
  slug: string;
  room: Location;
  bound: FpBound;
  onClose: () => void;
  onCreated: () => void;
}) {
  const toast = useToast();
  const [rows, setRows] = useState("3");
  const [cols, setCols] = useState("8");
  const [scheme, setScheme] = useState<GridNameScheme>("row-letter");
  const [prefix, setPrefix] = useState("Bin ");
  const [progress, setProgress] = useState<number | null>(null);

  const r = parseInt(rows, 10);
  const c = parseInt(cols, 10);
  const rects = Number.isFinite(r) && Number.isFinite(c) ? gridRects(bound, r, c) : null;
  const preview = rects ? gridNames(r, c, scheme, prefix) : [];

  const run = async () => {
    if (!rects) return;
    setProgress(0);
    try {
      for (let i = 0; i < rects.length; i++) {
        await api.createLocation(slug, {
          name: preview[i]!,
          parent_id: room.id,
          kind: "container",
          metadata: { floorplan: rects[i]! },
        });
        setProgress(i + 1);
      }
      toast.success(`${rects.length} bins placed — print their labels from the Labels page`);
      onCreated();
      onClose();
    } catch (e) {
      toast.error(
        `Stopped after ${progress ?? 0} of ${rects.length}: ${e instanceof ApiError ? e.message : String(e)} — created bins are kept; re-run with fewer.`,
      );
      onCreated();
      setProgress(null);
    }
  };

  const busy = progress !== null;
  return (
    <Modal open onClose={busy ? () => {} : onClose} title={`Fill ${room.name} with a grid`} size="sm">
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <label className="inline-flex items-center gap-1.5 text-xs text-muted dark:text-slate-400">
            rows
            <input
              value={rows}
              onChange={(e) => setRows(e.target.value)}
              inputMode="numeric"
              className="w-12 rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-1.5 py-1 text-sm text-content dark:text-slate-200 text-center"
            />
          </label>
          <span className="text-faint">×</span>
          <label className="inline-flex items-center gap-1.5 text-xs text-muted dark:text-slate-400">
            columns
            <input
              value={cols}
              onChange={(e) => setCols(e.target.value)}
              inputMode="numeric"
              className="w-12 rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-1.5 py-1 text-sm text-content dark:text-slate-200 text-center"
            />
          </label>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {(
            [
              ["row-letter", "A1 … C8"],
              ["sequential", "Bin 1 … 24"],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setScheme(k)}
              className={`rounded-md border px-2.5 py-1 text-xs transition ${scheme === k ? "border-accent text-accent" : "border-line dark:border-slate-600 text-muted"}`}
            >
              {label}
            </button>
          ))}
          {scheme === "sequential" && (
            <input
              value={prefix}
              onChange={(e) => setPrefix(e.target.value)}
              placeholder="prefix"
              className="w-20 rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-1.5 py-1 text-xs text-content dark:text-slate-200"
            />
          )}
        </div>
        {rects ? (
          <p className="text-xs text-muted dark:text-slate-400">
            {rects.length} bins: {preview.slice(0, 3).join(", ")} … {preview[preview.length - 1]}
             - placed at true scale, added to what's already on the layout.
          </p>
        ) : (
          <p className="text-xs text-ember-500">That grid doesn't fit this face - fewer rows or columns.</p>
        )}
        <div className="flex justify-end">
          <button
            type="button"
            disabled={!rects || busy}
            onClick={() => void run()}
            className="rounded-md bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1.5 text-sm transition disabled:opacity-50"
          >
            {busy ? `Creating ${progress}/${rects?.length ?? 0}…` : `Create ${rects?.length ?? 0} bins`}
          </button>
        </div>
      </div>
    </Modal>
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

/** Fill + outline pickers, shared by the location and entity panels. */
function DecorControls({
  fp,
  onPatch,
}: {
  fp: Record<string, unknown>;
  onPatch: (patch: Record<string, unknown>) => void;
}) {
  const currentOutline = readOutline(fp);
  const currentPreset =
    Object.entries(OUTLINE_PRESETS).find(
      ([, pts]) => JSON.stringify(pts) === JSON.stringify(currentOutline),
    )?.[0] ?? (currentOutline ? "custom" : "none");
  return (
    <>
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
  onDecor,
}: {
  ent: PlanEntity | null;
  unit: LengthUnit;
  grid: number | undefined;
  secondAxis: string;
  onRect: (ent: PlanEntity, r: FpRect | null) => void;
  onDecor: (ent: PlanEntity, patch: Record<string, unknown>) => void;
}) {
  if (!ent) return null;
  const rect = readRect(ent.metadata);
  if (!rect) return null;
  const fp = (ent.metadata?.floorplan as Record<string, unknown>) ?? {};
  return (
    <div className="flex items-center gap-3 flex-wrap rounded-md border border-cobble-300/60 dark:border-cobble-700/60 bg-cobble-50/40 dark:bg-cobble-900/20 px-3 py-2">
      <span className="text-xs font-medium text-content dark:text-slate-200">{ent.name}</span>
      <span className="font-mono text-[10px] uppercase tracking-widest text-faint">
        {ent.kind.split(":")[1]}
      </span>
      <DimInput label="wide" mm={rect.w_mm} unit={unit} onCommit={(v) => onRect(ent, { ...rect, w_mm: v })} />
      <DimInput label={secondAxis} mm={rect.d_mm} unit={unit} onCommit={(v) => onRect(ent, { ...rect, d_mm: v })} />
      {grid && (
        <span className="font-mono text-[10px] text-faint" title={`in ${grid}mm grid units`}>
          {Math.round(rect.w_mm / grid)} × {Math.round(rect.d_mm / grid)} u
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
