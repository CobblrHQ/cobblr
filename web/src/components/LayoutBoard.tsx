// A room under a planning layout, drawn to scale: its floor with the racks,
// and every rack's face with its shelves and the things on them at their real
// size. The planner edits it (drag a rack on the floor, a thing onto any
// shelf), a comparison shows two side by side, and the print draws it on
// paper with a scale bar and the sizes written in. The picture is
// lib/layoutBoard.ts; this only draws it and reports drags.

import { useRef, useState } from "react";
import { RotateCw } from "lucide-react";
import { isShortcut } from "@cobblr/platform-web";
import { frontEdge, ownSize, rotated, type Edge, type PlanFlag } from "@cobblr/platform-contract/plan-clearance";
import { faceWidthPx, labelFor, type Board, type BoardRack, type BoardThing } from "../lib/layoutBoard";
import { nameUnder } from "../lib/planFit";
import type { FpBound, FpRect } from "../lib/floorplanGeometry";
import { GapReadout, PlanFlagList, PlanSymbols } from "./PlanSymbols";

const pct = (v: number, total: number) => `${(v / total) * 100}%`;
const mm = (v: number) => `${Math.round(v).toLocaleString("en-US")} mm`; // count-unit-ok: mm is a length symbol

/** Where a dragged thing was let go: a place (or planned place) and the spot
 *  in it, in that place's own mm. */
export interface ThingDrop {
  key: string;
  into: string;
  x_mm: number;
  y_mm: number;
}

/** The attribute a drop target carries: the place a thing dropped on it goes
 *  into, and the size in mm of the box it is drawn as. */
const DROP = "data-drop-into";

/** Follow a pointer from a thing to where it is let go; the thing moves with
 *  it (a transform, so nothing floats over the page). Used by the board's
 *  things and by the planner's tray. */
export function startThingDrag(e: React.PointerEvent, key: string, el: HTMLElement, onDrop: (d: ThingDrop) => void): void {
  e.preventDefault();
  e.stopPropagation();
  const startX = e.clientX;
  const startY = e.clientY;
  let over: HTMLElement | null = null;
  el.style.zIndex = "30";
  const targetAt = (x: number, y: number): HTMLElement | null => {
    el.style.pointerEvents = "none";
    const hit = document.elementFromPoint(x, y)?.closest(`[${DROP}]`) as HTMLElement | null;
    el.style.pointerEvents = "";
    return hit;
  };
  // The page scrolls under a drag held near its top or bottom edge, so a
  // thing can be carried to a shelf that was off the screen.
  let scrolled = 0;
  const move = (ev: PointerEvent) => {
    const edge = ev.clientY > window.innerHeight - 60 ? 24 : ev.clientY < 60 ? -24 : 0;
    if (edge) {
      window.scrollBy(0, edge);
      scrolled += edge;
    }
    el.style.transform = `translate(${ev.clientX - startX}px, ${ev.clientY - startY + scrolled}px)`;
    const t = targetAt(ev.clientX, ev.clientY);
    if (t !== over) {
      over?.removeAttribute("data-drop-over");
      t?.setAttribute("data-drop-over", "true");
      over = t;
    }
  };
  const up = (ev: PointerEvent) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    el.style.transform = "";
    el.style.zIndex = "";
    over?.removeAttribute("data-drop-over");
    if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < 6) return;
    const t = targetAt(ev.clientX, ev.clientY);
    if (!t) return;
    const into = t.getAttribute(DROP)!;
    const [w, d] = (t.getAttribute("data-drop-mm") ?? "0x0").split("x").map(Number) as [number, number];
    const r = t.getBoundingClientRect();
    onDrop({ key, into, x_mm: ((ev.clientX - r.left) / r.width) * w, y_mm: ((ev.clientY - r.top) / r.height) * d });
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

/** About how wide a line of 10 px text is, per character. */
const CHAR_PX = 5.6;

function ThingBox({ t, bound, editable, onDrop, print, pxPerMm }: { t: BoardThing; bound: FpBound; editable: boolean; onDrop: (d: ThingDrop) => void; print: boolean; pxPerMm: number | null }) {
  const ref = useRef<HTMLDivElement>(null);
  // A finger's tap shows the whole name (there is no hover to read it by).
  const [peek, setPeek] = useState(false);
  const r = t.rect!;
  const bad = t.overhang || t.tooTall;
  const why = [t.overhang ? "hangs off the front" : null, t.tooTall ? "taller than the space" : null].filter(Boolean).join(", ");
  return (
    <div
      ref={ref}
      data-layout-thing={t.id}
      data-moved={t.moved ? "true" : undefined}
      title={why ? `${t.name}: ${why}` : t.name}
      onPointerDown={editable ? (e) => startThingDrag(e, t.key, ref.current!, onDrop) : undefined}
      onClick={(e) => {
        if (editable) return;
        e.stopPropagation();
        setPeek((p) => !p);
      }}
      aria-label={why ? `${t.name}: ${why}` : t.name}
      className={`absolute ${peek ? "overflow-visible z-20" : "overflow-hidden"} rounded-[3px] border text-[10px] leading-tight px-0.5 ${
        print
          ? "border-black bg-white text-black"
          : `${bad ? "border-ember-500 bg-ember-50 dark:bg-ember-950" : t.moved ? "border-accent bg-cobble-100 dark:bg-cobble-900" : "border-cobble-500/80 bg-cobble-100 dark:bg-cobble-900"} text-content dark:text-slate-100`
      } ${editable ? "cursor-grab touch-none select-none" : ""}`}
      style={{ left: pct(r.x_mm, bound.w_mm), top: pct(r.y_mm, bound.d_mm), width: pct(r.w_mm, bound.w_mm), height: pct(r.d_mm, bound.d_mm) }}
    >
      {/* The whole name where it fits on one line, else the short one,
          never a name cut in the middle. */}
      <span data-thing-name="" className="block max-h-full overflow-hidden break-words leading-[12px]">
        {pxPerMm === null ? t.name : labelFor(t.name, t.short, r.w_mm * pxPerMm, r.d_mm * pxPerMm, CHAR_PX)}
      </span>
      {print && !!t.size && <span className="block text-[8px]">{Math.round(t.size.w_mm)} wide</span>}
      {peek && (
        <span className="absolute left-0 top-0 z-30 w-max max-w-[14rem] whitespace-normal rounded bg-surface dark:bg-slate-800 px-1.5 py-1 text-[11px] text-content dark:text-slate-100 shadow-md">
          {t.name}
        </span>
      )}
    </div>
  );
}

function RackFace({ rack, editable, onDrop, print, maxHeight, faceWidth }: { rack: BoardRack; editable: boolean; onDrop: (d: ThingDrop) => void; print: boolean; maxHeight: number; faceWidth?: number }) {
  const face = rack.face!;
  const width = faceWidth ?? faceWidthPx(face, maxHeight);
  return (
    <figure data-layout-rack={rack.id} className="m-0 flex flex-col gap-1" style={{ width }}>
      <figcaption className={`text-xs font-medium ${print ? "text-black" : "text-content dark:text-slate-200"}`}>
        {rack.name}
        {rack.planned && <span className={`ml-1 font-normal ${print ? "" : "text-accent"}`}>(planned)</span>}
        {print && <span className="ml-1 font-normal">{mm(face.w_mm)} × {mm(face.d_mm)}</span>}
      </figcaption>
      <div
        className={`relative w-full border-2 ${print ? "border-black bg-white" : `${rack.planned ? "border-dashed border-accent" : "border-slate-500 dark:border-slate-400"} bg-surface dark:bg-slate-900`}`}
        style={{ aspectRatio: `${face.w_mm} / ${face.d_mm}` }}
      >
        {rack.shelves.map((s) => (
          <div
            key={s.id}
            {...{ [DROP]: s.id }}
            data-drop-mm={`${s.rect.w_mm}x${s.rect.d_mm}`}
            data-layout-shelf={s.id}
            data-fits={s.row ? (s.row.fits ? "true" : "false") : undefined}
            className={`absolute border-b-2 ${print ? "border-black" : "border-slate-500 dark:border-slate-400 data-[drop-over=true]:bg-cobble-500/15"}`}
            style={{ left: pct(s.rect.x_mm, face.w_mm), top: pct(s.rect.y_mm, face.d_mm), width: pct(s.rect.w_mm, face.w_mm), height: pct(s.rect.d_mm, face.d_mm) }}
          >
            {/* The shelf's label band: its name, then its fit, whole, above
                the things on it (buildBoard keeps them below the band). */}
            <span data-face-text="" className={`absolute left-0.5 right-0.5 top-0 truncate text-[9px] leading-[11px] ${print ? "text-black" : "text-faint dark:text-slate-500"}`}>
              {nameUnder(s.name, rack.name)}
            </span>
            {s.row && (
              <span
                data-face-text=""
                data-shelf-fit={s.id}
                className={`absolute left-0.5 top-[12px] max-w-[calc(100%-0.25rem)] overflow-hidden whitespace-nowrap text-[9px] leading-[11px] ${s.row.fits ? (print ? "text-black" : "text-muted dark:text-slate-400") : "font-semibold text-ember-700 dark:text-ember-300"}`}
              >
                {/* A narrow face (two options side by side) gives the verdict
                    alone; the list under the drawing has the numbers. */}
                {width < 220
                  ? s.row.fits
                    ? `${(s.rect.w_mm - s.row.used_mm).toLocaleString("en-US")} mm free`
                    : `${(s.row.used_mm - s.rect.w_mm).toLocaleString("en-US")} mm too wide`
                  : `${s.row.used_mm.toLocaleString("en-US")} of ${s.rect.w_mm.toLocaleString("en-US")} mm: ${s.row.fits ? `${(s.rect.w_mm - s.row.used_mm).toLocaleString("en-US")} mm free` : `${(s.row.used_mm - s.rect.w_mm).toLocaleString("en-US")} mm too wide`}`}
              </span>
            )}
          </div>
        ))}
        {rack.shelves.flatMap((s) => s.things.map((t) => <ThingBox key={t.key} t={t} bound={face} editable={editable} onDrop={onDrop} print={print} pxPerMm={width / face.w_mm} />))}
      </div>
    </figure>
  );
}

/** How long a finger held still on a rack turns it. */
const LONG_PRESS_MS = 550;
/** The side a rack is reached from, drawn heavier while it can be moved. */
const FRONT_EDGE: Record<Edge, string> = { bottom: "border-b-4", top: "border-t-4", left: "border-l-4", right: "border-r-4" };

function FloorRack({
  rack,
  bound,
  editable,
  onMoveRack,
  onLive,
  selected,
  onSelect,
  flags,
  print,
}: {
  rack: BoardRack;
  bound: FpBound;
  editable: boolean;
  onMoveRack: (id: string, rect: FpRect) => void;
  /** Where it is while it is carried (null when let go). */
  onLive: (id: string, rect: FpRect | null) => void;
  selected: boolean;
  onSelect: (id: string) => void;
  flags: readonly PlanFlag[];
  print: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState<FpRect | null>(null);
  const r = live ?? rack.rect!;
  const down = (e: React.PointerEvent) => {
    if (!editable) return;
    e.preventDefault();
    onSelect(rack.id);
    const parent = ref.current!.parentElement!.getBoundingClientRect();
    const perX = bound.w_mm / parent.width, perY = bound.d_mm / parent.height;
    let sx = e.clientX, sy = e.clientY, atX = e.clientX, atY = e.clientY;
    let base = rack.rect!;
    let last = base;
    let still = true;
    const show = (next: FpRect) => {
      last = next;
      setLive(next);
      onLive(rack.id, next);
    };
    // Turned a quarter while it is carried: R on a keyboard, or a finger
    // held still on it. It turns about its middle and stays in the room.
    const turn = () => {
      const t = rotated(last, bound);
      if (!t) return;
      base = t;
      sx = atX;
      sy = atY;
      show(t);
    };
    const key = (ev: KeyboardEvent) => {
      if (!isShortcut(ev, "turn")) return;
      ev.preventDefault();
      turn();
    };
    const hold = e.pointerType === "touch" ? window.setTimeout(() => still && turn(), LONG_PRESS_MS) : null;
    const move = (ev: PointerEvent) => {
      atX = ev.clientX;
      atY = ev.clientY;
      if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 8) still = false;
      const nx = Math.max(0, Math.min(bound.w_mm - base.w_mm, Math.round((base.x_mm + (ev.clientX - sx) * perX) / 10) * 10));
      const ny = Math.max(0, Math.min(bound.d_mm - base.d_mm, Math.round((base.y_mm + (ev.clientY - sy) * perY) / 10) * 10));
      show({ ...base, x_mm: nx, y_mm: ny });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("keydown", key);
      if (hold !== null) window.clearTimeout(hold);
      setLive(null);
      onLive(rack.id, null);
      const was = rack.rect!;
      if (last.x_mm !== was.x_mm || last.y_mm !== was.y_mm || last.rot !== was.rot) onMoveRack(rack.id, last);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("keydown", key);
  };
  const blocksDoor = flags.some((f) => f.kind === "door" || f.kind === "room");
  const said = flags.map((f) => f.text).join("; ");
  return (
    <div
      ref={ref}
      data-layout-floor-rack={rack.id}
      data-moved={rack.moved ? "true" : undefined}
      data-rot={r.rot}
      data-in-the-way={flags.length ? flags.map((f) => f.kind).join(" ") : undefined}
      data-rect-mm={`${r.x_mm},${r.y_mm},${r.w_mm},${r.d_mm}`}
      title={said ? `${rack.name}: ${said}` : rack.name}
      onPointerDown={down}
      className={`absolute flex items-center justify-center overflow-hidden rounded-sm border text-[10px] leading-tight text-center ${
        print
          ? "border-black bg-white text-black"
          : `${blocksDoor ? "border-ember-500 ring-2 ring-ember-500/60" : flags.length ? "ring-2 ring-amber-500/60" : ""} ${rack.planned ? "border-dashed border-accent" : rack.moved ? "border-accent" : "border-slate-500 dark:border-slate-400"} bg-surface dark:bg-slate-800 text-content dark:text-slate-200`
      } ${editable ? `cursor-move touch-none select-none ${FRONT_EDGE[frontEdge(r.rot)]}` : ""} ${selected ? "outline outline-2 outline-accent" : ""}`}
      style={{ left: pct(r.x_mm, bound.w_mm), top: pct(r.y_mm, bound.d_mm), width: pct(r.w_mm, bound.w_mm), height: pct(r.d_mm, bound.d_mm) }}
    >
      <span>
        {rack.name}
        {print && <span className="block text-[8px]">{Math.round(r.w_mm).toLocaleString("en-US")} × {Math.round(r.d_mm).toLocaleString("en-US")}</span>}
      </span>
    </div>
  );
}

/** One room under one draft. `maxFaceHeight` caps each rack's face (px). */
export function LayoutBoard({
  board,
  editable,
  onDrop,
  onMoveRack,
  print = false,
  maxFaceHeight = 320,
  faceWidth,
}: {
  board: Board;
  editable: boolean;
  onDrop: (d: ThingDrop) => void;
  onMoveRack: (id: string, rect: FpRect) => void;
  print?: boolean;
  maxFaceHeight?: number;
  /** Draw every face this wide (px), filling a column; else by maxFaceHeight. */
  faceWidth?: number;
}) {
  const b = board.room.bound;
  const faces = board.racks.filter((r) => r.face && r.shelves.length);
  const [sel, setSel] = useState<string | null>(null);
  const [live, setLive] = useState<{ id: string; rect: FpRect } | null>(null);
  const selRack = editable ? board.racks.find((r) => r.id === sel && r.rect) : undefined;
  const flagsOf = (id: string) => board.flags.filter((f) => f.ids.includes(id));
  // Everything on the floor, as it stands while one is carried.
  const onFloor = [
    ...board.racks.filter((r) => r.rect && !r.rect.wall_mounted).map((r) => ({ id: r.id, name: r.name, box: live?.id === r.id ? live.rect : r.rect! })),
    ...board.floor.filter((t) => t.rect).map((t) => ({ id: t.key, name: t.name, box: t.rect! })),
  ];
  return (
    <div data-layout-board={board.room.id} className="flex flex-col gap-4">
      {b && (
        <section>
          <h3 className={`mb-1 text-xs font-medium ${print ? "text-black" : "text-muted dark:text-slate-400"}`}>
            Floor{print ? `: ${mm(b.w_mm)} × ${mm(b.d_mm)}` : ""}
          </h3>
          {selRack && (
            <div data-testid="layout-rack-tools" className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted dark:text-slate-400">
              <span className="font-medium text-content dark:text-slate-200">{selRack.name}</span>
              <span>
                {mm(ownSize(selRack.rect!).w_mm)} wide, {mm(ownSize(selRack.rect!).d_mm)} deep
              </span>
              <button
                type="button"
                data-testid="layout-turn"
                onClick={() => {
                  const t = rotated(selRack.rect!, b);
                  if (t) onMoveRack(selRack.id, t);
                }}
                disabled={!rotated(selRack.rect!, b)}
                title={rotated(selRack.rect!, b) ? "Turn it a quarter where it stands (or press R while dragging it, or hold a finger on it)" : `${selRack.name} is longer than the room is wide, so it cannot turn here`}
                className="inline-flex items-center gap-1 rounded border border-line dark:border-slate-600 px-2 py-0.5 text-content dark:text-slate-200 hover:border-accent hover:text-accent disabled:opacity-50"
              >
                <RotateCw size={12} /> Turn 90°
              </button>
            </div>
          )}
          {/* The floor pans inside its own box: a planned rack bigger than the
              room is drawn at its true size past the wall (and flagged), and
              never widens the page (#5809). */}
          <div data-floor-frame="" className="max-w-full overflow-x-auto">
          <div
            {...{ [DROP]: board.room.id }}
            data-drop-mm={`${b.w_mm}x${b.d_mm}`}
            className={`relative mx-auto w-full border-2 ${print ? "border-black bg-white" : "border-slate-500 dark:border-slate-400 bg-surface dark:bg-slate-900 data-[drop-over=true]:bg-cobble-500/10"}`}
            // The whole floor on one screen: as wide as half the screen's height allows.
            style={{ aspectRatio: `${b.w_mm} / ${b.d_mm}`, maxWidth: print ? undefined : `min(48rem, calc(50vh * ${b.w_mm / b.d_mm}))` }}
          >
            {!print && <PlanSymbols room={b} walls={board.room.walls} boxes={onFloor.map((o) => o.box)} solid={() => true} />}
            {!print &&
              board.room.closets.map((c) => (
                <span
                  key={c.id}
                  data-layout-closet={c.id}
                  className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 font-mono text-[9px] uppercase tracking-[.15em] text-muted dark:text-slate-500"
                  style={{ left: pct(c.rect.x_mm + c.rect.w_mm / 2, b.w_mm), top: pct(c.rect.y_mm + c.rect.d_mm / 2, b.d_mm) }}
                >
                  {c.name}
                </span>
              ))}
            {board.racks.filter((r) => r.rect).map((r) => (
              <FloorRack
                key={r.id}
                rack={r}
                bound={b}
                editable={editable}
                onMoveRack={onMoveRack}
                onLive={(id, rect) => setLive(rect ? { id, rect } : null)}
                selected={sel === r.id}
                onSelect={setSel}
                flags={flagsOf(r.id)}
                print={print}
              />
            ))}
            {live && editable && <GapReadout room={b} walls={board.room.walls} box={live.rect} others={onFloor.filter((o) => o.id !== live.id)} />}
            {board.floor.filter((t) => t.rect).map((t) => (
              <ThingBox key={t.key} t={t} bound={b} editable={editable} onDrop={onDrop} print={print} pxPerMm={null} />
            ))}
          </div>
          </div>
          {print && <ScaleBar bound={b} />}
          {!print && <PlanFlagList flags={board.flags} />}
        </section>
      )}
      {faces.length > 0 && (
        <section>
          <h3 className={`mb-1 text-xs font-medium ${print ? "text-black" : "text-muted dark:text-slate-400"}`}>Racks, from the front</h3>
          <div className="flex flex-wrap items-end gap-4">
            {faces.map((r) => (
              <RackFace key={r.id} rack={r} editable={editable} onDrop={onDrop} print={print} maxHeight={maxFaceHeight} faceWidth={faceWidth} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/** A bar a round number of metres (or a fraction) long, drawn at the plan's
 *  scale, for measuring the paper with a ruler. */
function ScaleBar({ bound }: { bound: FpBound }) {
  const steps = [100, 250, 500, 1000, 2000, 5000];
  const len = steps.filter((s) => s <= bound.w_mm / 4).pop() ?? 100;
  return (
    <div data-scale-bar className="mt-1 flex items-center gap-2 text-[10px] text-black">
      <span className="block h-1.5 border border-black bg-black" style={{ width: pct(len, bound.w_mm) }} />
      {len >= 1000 ? `${len / 1000} m` : `${len} mm`}
    </div>
  );
}
