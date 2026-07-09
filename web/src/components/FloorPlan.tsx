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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Flame, Loader2, Pencil, Plus, Printer, ScanLine, Sparkles, Tag, X } from "lucide-react";
import { Modal, useToast } from "@cobblr/platform-web";
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

type Sel = { type: "item"; id: string } | { type: "wall"; idx: number } | null;

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
  const tray = useMemo(
    () => items.filter((l) => l.parent_id === room.id && !readRect(l.metadata)),
    [items, room.id],
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
    if (rect) meta.floorplan = rect;
    else delete meta.floorplan;
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
      const next =
        mode === "move"
          ? { ...orig, x_mm: snap(orig.x_mm + dx), y_mm: snap(orig.y_mm + dy) }
          : { ...orig, w_mm: snap(Math.max(SNAP_MM, orig.w_mm + dx)), d_mm: snap(Math.max(SNAP_MM, orig.d_mm + dy)) };
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
        className={`relative w-full border-2 border-slate-400 dark:border-slate-500 rounded bg-subtle/40 dark:bg-[#0d1526] select-none ${edit ? "bg-[radial-gradient(circle,rgba(100,116,139,.25)_1px,transparent_1px)] [background-size:26px_26px]" : ""}`}
        style={{ aspectRatio: `${bound.w_mm} / ${bound.d_mm}` }}
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

        {/* placed containers */}
        {placed
          .filter((p) => p.loc.kind !== "area")
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
                  } else navigate(`/configuration/locations/${loc.id}`);
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
                <span
                  className="absolute inset-0 pointer-events-none rounded"
                  style={{ ...(heatStyle(loc.id) ?? {}), ...(rotate ? { writingMode: "horizontal-tb" as const } : {}) }}
                />
                {pxW < 30 && pxH < 30 ? (loc.short_name || "·") : (loc.short_name && pxW < 90 && !rotate ? loc.short_name : loc.name)}
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
      </div>

      {/* ── edit panel ── */}
      {edit && (
        <EditPanel
          bound={bound}
          unit={unit}
          view={view}
          sel={sel}
          byId={byId}
          onBound={saveBound}
          onRect={(loc, r) => saveRect(loc, r)}
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
                to={`/configuration/locations/${peekLoc.id}`}
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
  sel,
  byId,
  onBound,
  onRect,
  onDeleteWall,
}: {
  bound: FpBound;
  unit: LengthUnit;
  view: "plan" | "front";
  sel: Sel;
  byId: Map<string, Location>;
  onBound: (b: FpBound) => void;
  onRect: (loc: Location, r: FpRect | null) => void;
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
        <Link to={`/configuration/locations/${loc.id}`} className="text-xs font-medium text-content dark:text-slate-200 hover:text-accent">
          {loc.name}
        </Link>
        <span className="font-mono text-[10px] uppercase tracking-widest text-faint">{loc.kind}</span>
        <DimInput label="wide" mm={rect.w_mm} unit={unit} onCommit={(v) => onRect(loc, { ...rect, w_mm: v })} />
        <DimInput label={secondAxis} mm={rect.d_mm} unit={unit} onCommit={(v) => onRect(loc, { ...rect, d_mm: v })} />
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
      <span className="text-[11px] text-faint italic">
        numbers live here in edit mode only — the plan itself stays clean
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
          Say it like you'd say it to a person — dimensions in whatever unit you think in,
          walls, doorways, named zones. The AI drafts the plan; you drag it true afterward.
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
          Size sets the floor's outline — rooms and walls draw onto it next.
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
