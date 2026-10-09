// Room to move on a floor plan: what a door sweeps when it opens, what stands
// in front of a window, how much floor is left between things, a rack turned
// a quarter, and the walls of a closet. Pure and shared, so the plan, the
// planner, the print and the assistant's plan-read say the same thing.
// See docs/design-decisions/location-floor-plan.md, "Tetris a room".
//
// Coordinates are the plan's: mm, from the room's top-left corner, x to the
// right and y down. "Up" on a plan is toward y = 0.

/** A quarter turn clockwise, or more; no turn is no `rot` at all. */
export type Rotation = 90 | 180 | 270;
export type Edge = "top" | "bottom" | "left" | "right";

export interface PlanBox {
  x_mm: number;
  y_mm: number;
  w_mm: number;
  d_mm: number;
  /** A quarter turn from how it was drawn, clockwise. w × d are always as it
   *  stands on the plan; its own width and depth are swapped at 90 and 270. */
  rot?: Rotation;
}

export interface PlanOpening {
  at_mm: number;
  w_mm: number;
  kind?: "door" | "window" | "opening";
  /** A door's leaf, when it is not the opening's width. */
  leaf_mm?: number;
  /** The side its hinge is on, as the plan is drawn: left or right on a wall
   *  that runs across, top or bottom on one that runs down. */
  hinge?: Edge;
  /** Which way it opens, toward that side of the plan: top or bottom on a
   *  wall that runs across, left or right on one that runs down. A door
   *  without one is drawn as an opening. */
  swing?: Edge;
  /** A window's sill, above the floor. */
  sill_mm?: number;
}

export interface PlanWall {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  openings?: PlanOpening[];
  /** The closet (a place id) this wall belongs to: moving the closet moves it. */
  closet?: string;
}

export interface PlanRoom {
  w_mm: number;
  d_mm: number;
  walls?: PlanWall[];
}

/** Under this, a window has a sill at the height windows usually do. */
export const DEFAULT_SILL_MM = 900;
/** The aisle a person with a box needs, unless the room says otherwise. */
export const DEFAULT_AISLE_MM = 900;
/** Closer than this, two things stand against each other: no way through. */
export const TOUCHING_MM = 150;
/** How far in front of a window a thing stands before it. */
export const WINDOW_REACH_MM = 600;

const ROTATIONS: readonly Rotation[] = [90, 180, 270];
export const isRotation = (v: unknown): v is Rotation => ROTATIONS.includes(v as Rotation);
const EDGES: readonly Edge[] = ["top", "bottom", "left", "right"];
export const isEdge = (v: unknown): v is Edge => EDGES.includes(v as Edge);

const isVertical = (w: PlanWall) => w.x1 === w.x2;

/** Can this hinge and swing go on this wall? A wall across takes a hinge at
 *  its left or right and swings up or down; a wall down the reverse. */
export function doorFitsWall(wall: PlanWall, o: Pick<PlanOpening, "hinge" | "swing">): boolean {
  const across: Edge[] = ["left", "right"];
  const down: Edge[] = ["top", "bottom"];
  const [hinges, swings] = isVertical(wall) ? [down, across] : [across, down];
  return (!o.hinge || hinges.includes(o.hinge)) && (!o.swing || swings.includes(o.swing));
}

/** Where an opening is along its wall, in room mm: from `a` to `b` on the
 *  wall's line `c` (x for a wall down, y for one across). */
export function openingSpan(wall: PlanWall, o: PlanOpening): { vertical: boolean; c: number; a: number; b: number } {
  const vertical = isVertical(wall);
  const start = vertical ? Math.min(wall.y1, wall.y2) : Math.min(wall.x1, wall.x2);
  const end = vertical ? Math.max(wall.y1, wall.y2) : Math.max(wall.x1, wall.x2);
  const a = Math.max(start, Math.min(end, start + o.at_mm));
  const b = Math.max(a, Math.min(end, a + o.w_mm));
  return { vertical, c: vertical ? wall.x1 : wall.y1, a, b };
}

/** A wall drawn minus its openings: the visible stretches, in order.
 *  Openings are clamped to the wall and merged where they overlap. */
export function wallSegments(wall: PlanWall): Array<{ x1: number; y1: number; x2: number; y2: number }> {
  const vertical = isVertical(wall);
  const start = vertical ? Math.min(wall.y1, wall.y2) : Math.min(wall.x1, wall.x2);
  const end = vertical ? Math.max(wall.y1, wall.y2) : Math.max(wall.x1, wall.x2);
  const len = end - start;
  if (len <= 0) return [];
  const gaps = (wall.openings ?? [])
    .map((o) => ({ from: Math.max(0, o.at_mm), to: Math.min(len, o.at_mm + o.w_mm) }))
    .filter((g) => g.to > g.from)
    .sort((a, b) => a.from - b.from);
  const merged: Array<{ from: number; to: number }> = [];
  for (const g of gaps) {
    const last = merged[merged.length - 1];
    if (last && g.from <= last.to) last.to = Math.max(last.to, g.to);
    else merged.push({ ...g });
  }
  const spans: Array<{ from: number; to: number }> = [];
  let cursor = 0;
  for (const g of merged) {
    if (g.from > cursor) spans.push({ from: cursor, to: g.from });
    cursor = Math.max(cursor, g.to);
  }
  if (cursor < len) spans.push({ from: cursor, to: len });
  return spans.map((s) =>
    vertical
      ? { x1: wall.x1, y1: start + s.from, x2: wall.x1, y2: start + s.to }
      : { x1: start + s.from, y1: wall.y1, x2: start + s.to, y2: wall.y1 },
  );
}

/** Which edge of the room a wall lies on, or null for a wall inside it. */
export function edgeOf(wall: PlanWall, room: { w_mm: number; d_mm: number }): Edge | null {
  if (isVertical(wall)) return wall.x1 <= 0 ? "left" : wall.x1 >= room.w_mm ? "right" : null;
  return wall.y1 <= 0 ? "top" : wall.y1 >= room.d_mm ? "bottom" : null;
}

/** Which way a door in this wall opens to swing into the room: down from the
 *  top wall, left from the right wall. Null for a wall inside the room. */
export function intoRoom(wall: PlanWall, room: { w_mm: number; d_mm: number }): Edge | null {
  const e = edgeOf(wall, room);
  return e === "top" ? "bottom" : e === "bottom" ? "top" : e === "left" ? "right" : e === "right" ? "left" : null;
}

export interface DoorSwing {
  hinge: { x_mm: number; y_mm: number };
  leaf_mm: number;
  /** The leaf shut, along the wall, and open, square to it. */
  shut: { x_mm: number; y_mm: number };
  open: { x_mm: number; y_mm: number };
  /** The square the quarter circle sits in: the floor the door may need. */
  zone: PlanBox;
}

/** The floor a door sweeps as it opens, or null when it is not a door that
 *  says which way it opens (a plain opening, or a door with no swing). */
export function doorSwing(wall: PlanWall, o: PlanOpening): DoorSwing | null {
  if (o.kind !== "door" || !o.swing || !doorFitsWall(wall, o)) return null;
  const { vertical, c, a, b } = openingSpan(wall, o);
  const leaf = Math.max(1, Math.min(o.leaf_mm ?? b - a, 4000));
  if (b <= a) return null;
  const atEnd = vertical ? o.hinge === "bottom" : o.hinge === "right";
  const h = atEnd ? b : a;
  const shutAlong = atEnd ? h - leaf : h + leaf;
  const out = o.swing === "top" || o.swing === "left" ? -1 : 1;
  const openAcross = c + out * leaf;
  const hinge = vertical ? { x_mm: c, y_mm: h } : { x_mm: h, y_mm: c };
  const shut = vertical ? { x_mm: c, y_mm: shutAlong } : { x_mm: shutAlong, y_mm: c };
  const open = vertical ? { x_mm: openAcross, y_mm: h } : { x_mm: h, y_mm: openAcross };
  const xs = [hinge.x_mm, shut.x_mm, open.x_mm];
  const ys = [hinge.y_mm, shut.y_mm, open.y_mm];
  const zone = { x_mm: Math.min(...xs), y_mm: Math.min(...ys), w_mm: Math.max(...xs) - Math.min(...xs), d_mm: Math.max(...ys) - Math.min(...ys) };
  return { hinge, leaf_mm: leaf, shut, open, zone };
}

/** Does a box stand in a door's way: inside the quarter circle it sweeps?
 *  Touching its edge does not count. */
export function blocksSwing(box: PlanBox, s: DoorSwing): boolean {
  const z = s.zone;
  const x1 = Math.max(box.x_mm, z.x_mm), x2 = Math.min(box.x_mm + box.w_mm, z.x_mm + z.w_mm);
  const y1 = Math.max(box.y_mm, z.y_mm), y2 = Math.min(box.y_mm + box.d_mm, z.y_mm + z.d_mm);
  if (x1 >= x2 || y1 >= y2) return false;
  // The nearest point of that overlap to the hinge is inside the circle when
  // any of it is (the overlap is a box in the quarter's own square).
  const px = Math.max(x1, Math.min(x2, s.hinge.x_mm));
  const py = Math.max(y1, Math.min(y2, s.hinge.y_mm));
  return (px - s.hinge.x_mm) ** 2 + (py - s.hinge.y_mm) ** 2 < s.leaf_mm ** 2;
}

/** The floor in front of a window, on the room's side of an outer wall and
 *  on both sides of an inside one. */
export function windowZones(wall: PlanWall, o: PlanOpening, room: { w_mm: number; d_mm: number }): PlanBox[] {
  if (o.kind !== "window") return [];
  const { vertical, c, a, b } = openingSpan(wall, o);
  if (b <= a) return [];
  const edge = edgeOf(wall, room);
  const sides = edge === "top" || edge === "left" ? [1] : edge === "bottom" || edge === "right" ? [-1] : [1, -1];
  return sides.map((s) => {
    const from = s > 0 ? c : Math.max(0, c - WINDOW_REACH_MM);
    const to = s > 0 ? Math.min(vertical ? room.w_mm : room.d_mm, c + WINDOW_REACH_MM) : c;
    return vertical ? { x_mm: from, y_mm: a, w_mm: to - from, d_mm: b - a } : { x_mm: a, y_mm: from, w_mm: b - a, d_mm: to - from };
  });
}

const overlaps = (p: PlanBox, q: PlanBox) => p.x_mm < q.x_mm + q.w_mm && q.x_mm < p.x_mm + p.w_mm && p.y_mm < q.y_mm + q.d_mm && q.y_mm < p.y_mm + p.d_mm;

/** Its own width and depth, whichever way it is turned on the plan. */
export function ownSize(b: PlanBox): { w_mm: number; d_mm: number } {
  return b.rot === 90 || b.rot === 270 ? { w_mm: b.d_mm, d_mm: b.w_mm } : { w_mm: b.w_mm, d_mm: b.d_mm };
}

/** Which side of a box is its front on the plan: a rack drawn against the
 *  top wall faces down, into the room; a quarter turn clockwise faces left. */
export function frontEdge(rot: Rotation | undefined): Edge {
  return rot === 90 ? "left" : rot === 180 ? "top" : rot === 270 ? "right" : "bottom";
}

/** The box turned a quarter clockwise about its middle, kept inside the room:
 *  its width and depth on the plan swap, and it is pushed back in from any
 *  wall it would cross. Null when, turned, it is longer than the room. */
export function rotated(b: PlanBox, room: { w_mm: number; d_mm: number }): PlanBox | null {
  const w = b.d_mm, d = b.w_mm;
  if (w > room.w_mm || d > room.d_mm) return null;
  const cx = b.x_mm + b.w_mm / 2, cy = b.y_mm + b.d_mm / 2;
  const x = Math.max(0, Math.min(room.w_mm - w, Math.round(cx - w / 2)));
  const y = Math.max(0, Math.min(room.d_mm - d, Math.round(cy - d / 2)));
  const turn = ((b.rot ?? 0) + 90) % 360;
  const { rot: _was, ...rest } = b;
  return { ...rest, x_mm: x, y_mm: y, w_mm: w, d_mm: d, ...(isRotation(turn) ? { rot: turn } : {}) };
}

export interface PlanItem {
  id: string;
  name: string;
  box: PlanBox;
  /** How tall it stands, when known: a window it stands before matters only
   *  when it is taller than the sill. */
  h_mm?: number | null;
}

/** One obstacle around a box, for gaps: another thing, a wall inside the
 *  room, or the room's own edge. */
interface Obstacle {
  id: string | null;
  name: string;
  box: PlanBox;
}

function wallObstacles(room: PlanRoom): Obstacle[] {
  const out: Obstacle[] = [];
  for (const w of room.walls ?? []) {
    if (edgeOf(w, room)) continue;
    for (const s of wallSegments(w)) {
      out.push({ id: null, name: "the wall", box: { x_mm: Math.min(s.x1, s.x2), y_mm: Math.min(s.y1, s.y2), w_mm: Math.abs(s.x2 - s.x1), d_mm: Math.abs(s.y2 - s.y1) } });
    }
  }
  return out;
}

export interface Gap {
  mm: number;
  /** What is across it: a thing's name, "the wall", or "the left wall". */
  to: string;
  toId: string | null;
  /** The line across the gap, for drawing it. */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** The nearest thing, wall or edge of the room on each side of a box, where
 *  something faces it across clear floor: what a person drags a rack by. */
export function gapsAround(box: PlanBox, others: PlanItem[], room: PlanRoom): Record<Edge, Gap> {
  const obstacles: Obstacle[] = [...others.map((o) => ({ id: o.id, name: o.name, box: o.box })), ...wallObstacles(room)];
  const left = box.x_mm, right = box.x_mm + box.w_mm, top = box.y_mm, bottom = box.y_mm + box.d_mm;
  const cx = (left + right) / 2, cy = (top + bottom) / 2;
  // Facing across a side: the two overlap along that side (an inside wall is
  // a line, so it may be only that wide).
  const facesX = (o: PlanBox) => o.y_mm < bottom && o.y_mm + o.d_mm > top;
  const facesY = (o: PlanBox) => o.x_mm < right && o.x_mm + o.w_mm > left;
  const mid = (a: number, b: number, o: PlanBox, along: "x" | "y") => {
    const lo = Math.max(a, along === "x" ? o.x_mm : o.y_mm);
    const hi = Math.min(b, along === "x" ? o.x_mm + o.w_mm : o.y_mm + o.d_mm);
    return (lo + hi) / 2;
  };
  const pick = (cands: Array<{ mm: number; o: Obstacle | null; at: number }>, fallback: Gap, make: (mm: number, o: Obstacle, at: number) => Gap): Gap => {
    const best = cands.filter((c) => c.mm >= 0).sort((a, b) => a.mm - b.mm)[0];
    return best && best.o && best.mm < fallback.mm ? make(best.mm, best.o, best.at) : fallback;
  };
  const toL = pick(
    obstacles.filter((o) => facesX(o.box) && o.box.x_mm + o.box.w_mm <= left + 1).map((o) => ({ mm: left - (o.box.x_mm + o.box.w_mm), o, at: mid(top, bottom, o.box, "y") })),
    { mm: left, to: "the left wall", toId: null, x1: 0, y1: cy, x2: left, y2: cy },
    (mm, o, at) => ({ mm, to: o.name, toId: o.id, x1: left - mm, y1: at, x2: left, y2: at }),
  );
  const toR = pick(
    obstacles.filter((o) => facesX(o.box) && o.box.x_mm >= right - 1).map((o) => ({ mm: o.box.x_mm - right, o, at: mid(top, bottom, o.box, "y") })),
    { mm: room.w_mm - right, to: "the right wall", toId: null, x1: right, y1: cy, x2: room.w_mm, y2: cy },
    (mm, o, at) => ({ mm, to: o.name, toId: o.id, x1: right, y1: at, x2: right + mm, y2: at }),
  );
  const toT = pick(
    obstacles.filter((o) => facesY(o.box) && o.box.y_mm + o.box.d_mm <= top + 1).map((o) => ({ mm: top - (o.box.y_mm + o.box.d_mm), o, at: mid(left, right, o.box, "x") })),
    { mm: top, to: "the top wall", toId: null, x1: cx, y1: 0, x2: cx, y2: top },
    (mm, o, at) => ({ mm, to: o.name, toId: o.id, x1: at, y1: top - mm, x2: at, y2: top }),
  );
  const toB = pick(
    obstacles.filter((o) => facesY(o.box) && o.box.y_mm >= bottom - 1).map((o) => ({ mm: o.box.y_mm - bottom, o, at: mid(left, right, o.box, "x") })),
    { mm: room.d_mm - bottom, to: "the bottom wall", toId: null, x1: cx, y1: bottom, x2: cx, y2: room.d_mm },
    (mm, o, at) => ({ mm, to: o.name, toId: o.id, x1: at, y1: bottom, x2: at, y2: bottom + mm }),
  );
  const round = (g: Gap): Gap => ({ ...g, mm: Math.max(0, Math.round(g.mm)) });
  return { left: round(toL), right: round(toR), top: round(toT), bottom: round(toB) };
}

export interface PlanFlag {
  kind: "door" | "window" | "aisle";
  /** The things it is about. */
  ids: string[];
  text: string;
}

const n = (v: number) => Math.round(v).toLocaleString("en-US");
const wallWord = (wall: PlanWall, room: PlanRoom) => {
  const e = edgeOf(wall, room);
  return e ? `the ${e} wall` : "the inside wall";
};

/** What is wrong with where things stand: a thing in a door's swing, a thing
 *  taller than a window's sill in front of it, and (when `aisle_mm` is set)
 *  each gap between two things, or a thing and a wall, that a person would
 *  walk down and that is narrower than it. A window never refuses a place; it
 *  only says so. */
export function planFlags(opts: { room: PlanRoom; items: PlanItem[]; aisle_mm?: number | null }): PlanFlag[] {
  const { room, items } = opts;
  const flags: PlanFlag[] = [];
  for (const w of room.walls ?? []) {
    for (const o of w.openings ?? []) {
      const s = doorSwing(w, o);
      if (s) {
        for (const it of items) {
          if (blocksSwing(it.box, s)) flags.push({ kind: "door", ids: [it.id], text: `${it.name} blocks the door in ${wallWord(w, room)}` });
        }
      }
      const zones = windowZones(w, o, room);
      if (zones.length) {
        const sill = o.sill_mm ?? DEFAULT_SILL_MM;
        for (const it of items) {
          if (!it.h_mm || it.h_mm <= sill) continue;
          if (zones.some((z) => overlaps(z, it.box))) {
            flags.push({ kind: "window", ids: [it.id], text: `${it.name} blocks the window in ${wallWord(w, room)} (${n(it.h_mm)} mm tall, the sill is at ${n(sill)} mm)` });
          }
        }
      }
    }
  }
  const aisle = opts.aisle_mm;
  if (aisle && aisle > 0) {
    const seen = new Set<string>();
    for (const it of items) {
      const others = items.filter((o) => o !== it);
      const gaps = gapsAround(it.box, others, room);
      for (const side of ["right", "bottom", "left", "top"] as const) {
        const g = gaps[side];
        if (g.mm <= TOUCHING_MM || g.mm >= aisle) continue;
        const key = g.toId ? [it.id, g.toId].sort().join("|") + (side === "left" || side === "right" ? "x" : "y") : `${it.id}|${g.to}|${side}`;
        if (seen.has(key)) continue;
        seen.add(key);
        flags.push({
          kind: "aisle",
          ids: g.toId ? [it.id, g.toId] : [it.id],
          text: `${n(g.mm)} mm between ${it.name} and ${g.to}, narrower than a ${n(aisle)} mm aisle`,
        });
      }
    }
  }
  return flags;
}

/** The room edge a closet is against: the one its box touches, else the
 *  nearest. */
export function closetEdge(box: PlanBox, room: { w_mm: number; d_mm: number }): Edge {
  const d: Array<[Edge, number]> = [
    ["top", box.y_mm],
    ["bottom", room.d_mm - (box.y_mm + box.d_mm)],
    ["left", box.x_mm],
    ["right", room.w_mm - (box.x_mm + box.w_mm)],
  ];
  return d.sort((a, b) => a[1] - b[1])[0]![0];
}

/** What a closet says about its door, kept on its own place's floorplan
 *  (`closet`): its width, and its hinge and swing when somebody set them. */
export interface ClosetDoor {
  door_mm?: number;
  hinge?: Edge;
  swing?: Edge;
}

/** The closet a place's floorplan says it is, or null. */
export function readCloset(fp: unknown): ClosetDoor | null {
  const c = fp && typeof fp === "object" ? (fp as { closet?: unknown }).closet : undefined;
  if (!c || typeof c !== "object" || Array.isArray(c)) return null;
  const o = c as Record<string, unknown>;
  return {
    ...(typeof o.door_mm === "number" && o.door_mm > 0 ? { door_mm: Math.round(o.door_mm) } : {}),
    ...(isEdge(o.hinge) ? { hinge: o.hinge } : {}),
    ...(isEdge(o.swing) ? { swing: o.swing } : {}),
  };
}

/** The walls of a closet standing in a room against one of its walls: its
 *  two sides and its front, with a door in the middle of the front that
 *  opens out into the room (hinged at its left, or its top). A side that
 *  lies on the room's own edge is not drawn twice. They are drawn from the
 *  closet's own box every time, never stored, so moving or removing the
 *  closet takes its walls with it. */
export function closetWalls(id: string, box: PlanBox, room: { w_mm: number; d_mm: number }, door: ClosetDoor = {}): PlanWall[] {
  const edge = closetEdge(box, room);
  const { x_mm: x, y_mm: y, w_mm: w, d_mm: d } = box;
  const r = Math.round;
  const across = edge === "top" || edge === "bottom";
  // The front: the side facing into the room.
  const front: PlanWall =
    edge === "top" ? { x1: r(x), y1: r(y + d), x2: r(x + w), y2: r(y + d) }
    : edge === "bottom" ? { x1: r(x), y1: r(y), x2: r(x + w), y2: r(y) }
    : edge === "left" ? { x1: r(x + w), y1: r(y), x2: r(x + w), y2: r(y + d) }
    : { x1: r(x), y1: r(y), x2: r(x), y2: r(y + d) };
  const len = across ? w : d;
  const doorW = Math.max(1, Math.min(door.door_mm ?? 760, len));
  const out: Edge = edge === "top" ? "bottom" : edge === "bottom" ? "top" : edge === "left" ? "right" : "left";
  const hinge: Edge = door.hinge && doorFitsWall(front, { hinge: door.hinge }) ? door.hinge : across ? "left" : "top";
  const swing: Edge = door.swing && doorFitsWall(front, { swing: door.swing }) ? door.swing : out;
  front.openings = [{ at_mm: r((len - doorW) / 2), w_mm: r(doorW), kind: "door", hinge, swing }];
  const sides: PlanWall[] = across
    ? [
        { x1: r(x), y1: r(y), x2: r(x), y2: r(y + d) },
        { x1: r(x + w), y1: r(y), x2: r(x + w), y2: r(y + d) },
      ]
    : [
        { x1: r(x), y1: r(y), x2: r(x + w), y2: r(y) },
        { x1: r(x), y1: r(y + d), x2: r(x + w), y2: r(y + d) },
      ];
  return [...sides.filter((s) => !edgeOf(s, room)), front].map((wl) => ({ ...wl, closet: id }));
}

/** Every wall of a room: its own, and its closets' (`places` are the room's
 *  child places with their box on its floor and what readCloset says of
 *  each: null for a place that is not a closet). */
export function roomWalls(room: PlanRoom, places: ReadonlyArray<{ id: string; box: PlanBox | null; closet: ClosetDoor | null }>): PlanWall[] {
  const out = [...(room.walls ?? [])];
  for (const p of places) if (p.closet && p.box) out.push(...closetWalls(p.id, p.box, room, p.closet));
  return out;
}
