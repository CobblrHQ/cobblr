// The planner's picture of a room under a draft: its floor with the racks
// where the draft puts them, and each rack's face with its shelves and the
// things on them at their real size, with the fit of every shelf. Pure, so
// the page, the comparison and the print draw the same thing.
// See docs/design-decisions/location-floor-plan.md, "Planning a layout".

import { fieldKindOf } from "@cobblr/platform-contract/kind-label";
import { PLANNED_PREFIX, placesUnderDraft, type PlanDraftBody } from "@cobblr/platform-contract/plan-draft";
import type { OuterSize } from "@cobblr/platform-contract/outer-size";
import { ownSize, planFlags, readCloset, roomWalls, type PlanFlag, type PlanWall } from "@cobblr/platform-contract/plan-clearance";
import { hasOwnLayout, readBound, readRect, type FpBound, type FpRect } from "./floorplanGeometry";
import { footprintAt, shelfFitLine, shelfRow, type ShelfRow } from "./planFit";

export interface BoardPlace {
  id: string;
  name: string;
  parent_id: string | null;
  kind: string;
  metadata: Record<string, unknown>;
  planned?: true;
}

export interface BoardRecord {
  kind: string;
  id: string;
  name: string;
  /** Its own short name, when it has one. */
  shortName?: string | null;
  /** Where it is kept now (a place id), or null. */
  at: string | null;
  collection: string;
}

export interface BoardThing {
  key: string;
  kind: string;
  id: string;
  name: string;
  /** What a box too small for the name says: the record's short name, else
   *  the name without its first word ("Bambu P1S" is "P1S"). */
  short: string;
  size: OuterSize | null;
  rect: FpRect | null;
  overhang?: boolean;
  tooTall?: boolean;
  /** Moved by the draft. */
  moved: boolean;
}

export interface BoardShelf {
  id: string;
  name: string;
  rect: FpRect;
  planned: boolean;
  things: BoardThing[];
  unsized: BoardThing[];
  row: ShelfRow | null;
  line: string | null;
}

export interface BoardRack {
  id: string;
  name: string;
  /** Its footprint on the room's floor, or null when it is not drawn there. */
  rect: FpRect | null;
  /** Its face (width × height), when it has one. */
  face: FpBound | null;
  /** How tall it stands: its face's height, when it has one. */
  h_mm: number | null;
  planned: boolean;
  moved: boolean;
  shelves: BoardShelf[];
}

export interface Board {
  /** The room, with every wall drawn on it: its own and its closets'. */
  room: { id: string; name: string; bound: FpBound | null; walls: PlanWall[]; closets: Array<{ id: string; name: string; rect: FpRect }> };
  racks: BoardRack[];
  /** Things standing on the room's own floor. */
  floor: BoardThing[];
  /** Where each thing is under the draft: a place id or planned key. */
  where: Map<string, string | null>;
  /** What stands in a door's swing or before a window, and (when the room
   *  checks aisles) each gap narrower than its aisle. */
  flags: PlanFlag[];
}

/** How wide a rack's face is drawn, in px, when its height is capped at
 *  `maxHeight`: the board draws it this wide, and the shelves' label bands
 *  are sized from it. */
export function faceWidthPx(face: { w_mm: number; d_mm: number }, maxHeight: number): number {
  return Math.min(360, (maxHeight * face.w_mm) / face.d_mm);
}

/** What a box too small for a thing's name shows instead: its own short
 *  name, else its model when the model stands alone after the brand ("Bambu
 *  P1S" is "P1S", "Prusa MK4" is "MK4"), else the whole name ("Ender 3 V3":
 *  "3 V3" would mean nothing). */
export function shortLabel(name: string, shortName?: string | null): string {
  if (shortName?.trim()) return shortName.trim();
  const words = name.trim().split(/\s+/);
  return words.length === 2 && /\d/.test(words[1]!) ? words[1]! : name;
}

/** Does `text` fit in `cols` characters by `rows` lines, wrapped at spaces
 *  (a word longer than a line never fits)? */
export function fitsIn(text: string, cols: number, rows: number): boolean {
  if (cols < 1 || rows < 1) return false;
  let lines = 1;
  let used = 0;
  for (const w of text.trim().split(/\s+/)) {
    if (w.length > cols) return false;
    if (used === 0) used = w.length;
    else if (used + 1 + w.length <= cols) used += 1 + w.length;
    else {
      lines++;
      used = w.length;
    }
  }
  return lines <= rows;
}

/** What a box drawn `wPx` by `hPx` says: the whole name when it fits on its
 *  lines, else the short name, and only when neither fits the name without
 *  its first word, which is the last resort. */
export function labelFor(name: string, short: string, wPx: number, hPx: number, charPx = 5.6, linePx = 12): string {
  const cols = Math.floor((wPx - 4) / charPx);
  const rows = Math.floor((hPx - 2) / linePx);
  const words = name.trim().split(/\s+/);
  const tail = words.length > 1 ? words.slice(1).join(" ") : name;
  return [name, short, tail].find((c) => fitsIn(c, cols, rows)) ?? tail;
}

/** Each shelf keeps this many px at its top for its name and its fit. */
export const SHELF_BAND_PX = 26;

/** `positions`: each thing's spot in the place it is kept now, by
 *  `fieldKindOf:id` (shelf order, or a pin on a floor). */
export function buildBoard(opts: {
  room: BoardPlace;
  places: readonly BoardPlace[];
  draft: PlanDraftBody;
  records: readonly BoardRecord[];
  positions: Map<string, { x_mm: number; y_mm: number } | null>;
  sizeOf: (r: BoardRecord) => OuterSize | null;
  /** The px height a face is capped at where it will be drawn; sets the
   *  label band (none when absent). */
  faceHeightPx?: number;
  /** The px width every face is drawn at, when the page sets it (two options
   *  side by side): the label band is sized from it. */
  faceWidth?: number;
}): Board {
  const { room, draft, records, positions, sizeOf } = opts;
  const places = placesUnderDraft(opts.places, draft) as BoardPlace[];
  const roomNow = places.find((p) => p.id === room.id) ?? room;
  const bound = readBound(roomNow.metadata);
  const kids = (id: string) => places.filter((p) => p.parent_id === id);

  const where = new Map<string, string | null>();
  const spot = new Map<string, { x_mm: number; y_mm: number } | null>();
  const moved = new Set<string>();
  for (const r of records) {
    const key = `${r.kind}:${r.id}`;
    const d = draft.things[key];
    if (d) {
      where.set(key, d.into);
      spot.set(key, d.x_mm !== undefined ? { x_mm: d.x_mm, y_mm: d.y_mm ?? 0 } : null);
      moved.add(key);
    } else {
      where.set(key, r.at);
      spot.set(key, positions.get(`${fieldKindOf(r)}:${r.id}`) ?? null);
    }
  }
  const thingsIn = (placeId: string) => records.filter((r) => where.get(`${r.kind}:${r.id}`) === placeId);

  const racks: BoardRack[] = kids(roomNow.id)
    .filter((p) => p.kind !== "area")
    .map((rack) => {
      const fp = (rack.metadata.floorplan ?? {}) as Record<string, unknown>;
      const face = fp.face ? readBound(rack.metadata) : hasOwnLayout(rack.metadata) ? readBound(rack.metadata) : null;
      // A shelf's things are measured against the rack's own depth, however
      // it is turned on the floor.
      const at = readRect(rack.metadata);
      const depth = at ? ownSize(at).d_mm : null;
      const drawnPx = opts.faceWidth ?? (opts.faceHeightPx ? faceWidthPx(face ?? { w_mm: 1, d_mm: 1 }, opts.faceHeightPx) : 0);
      const band = face && drawnPx > 0 ? Math.round((SHELF_BAND_PX / drawnPx) * face.w_mm) : 0;
      const shelves: BoardShelf[] = kids(rack.id)
        .map((s) => ({ s, rect: readRect(s.metadata) }))
        .filter((x): x is { s: BoardPlace; rect: FpRect } => !!x.rect)
        .sort((a, b) => a.rect.y_mm - b.rect.y_mm || a.rect.x_mm - b.rect.x_mm)
        .map(({ s, rect }) => {
          const here = thingsIn(s.id).map((r) => {
            const key = `${r.kind}:${r.id}`;
            return { r, key, size: sizeOf(r) };
          });
          const sized = here.filter((h): h is typeof h & { size: OuterSize } => !!h.size);
          const row = sized.length
            ? shelfRow(rect, sized.map((h) => ({ key: h.key, size: h.size, order: spot.get(h.key)?.x_mm ?? null, name: h.r.name })), depth, band)
            : null;
          const collections = new Set(sized.map((h) => h.r.collection.toLowerCase()));
          const one = collections.size === 1 ? [...collections][0]! : "";
          const noun = one ? { one: one.replace(/s$/, ""), many: one } : { one: "thing", many: "things" };
          return {
            id: s.id,
            name: s.name,
            rect,
            planned: !!s.planned,
            row,
            line: row ? shelfFitLine(row, rect.w_mm, noun, sized.length) : null,
            // In the row's own order, left to right.
            things: [...sized].sort((a, b) => row!.order.indexOf(a.key) - row!.order.indexOf(b.key)).map((h) => ({
              key: h.key,
              kind: h.r.kind,
              id: h.r.id,
              name: h.r.name,
              short: shortLabel(h.r.name, h.r.shortName),
              size: h.size,
              rect: row!.rects.get(h.key)!,
              overhang: row!.overhang.has(h.key),
              tooTall: row!.tooTall.has(h.key),
              moved: moved.has(h.key),
            })),
            unsized: here.filter((h) => !h.size).map((h) => ({ key: h.key, kind: h.r.kind, id: h.r.id, name: h.r.name, short: shortLabel(h.r.name, h.r.shortName), size: null, rect: null, moved: moved.has(h.key) })),
          };
        });
      return {
        id: rack.id,
        name: rack.name,
        rect: readRect(rack.metadata),
        face,
        h_mm: face?.d_mm ?? null,
        planned: !!rack.planned,
        moved: !!draft.moves[rack.id],
        shelves,
      };
    });

  const floor: BoardThing[] = thingsIn(roomNow.id).map((r) => {
    const key = `${r.kind}:${r.id}`;
    const size = sizeOf(r);
    const at = spot.get(key);
    return { key, kind: r.kind, id: r.id, name: r.name, short: shortLabel(r.name, r.shortName), size, rect: size && at ? footprintAt(size, at) : null, moved: moved.has(key) };
  });

  const areas = kids(roomNow.id).filter((p) => p.kind === "area");
  const walls = bound
    ? roomWalls(bound, areas.map((a) => ({ id: a.id, box: readRect(a.metadata), closet: readCloset(a.metadata.floorplan) })))
    : [];
  const closets = areas
    .filter((a) => walls.some((w) => w.closet === a.id))
    .map((a) => ({ id: a.id, name: a.name, rect: readRect(a.metadata)! }));
  const flags = bound
    ? planFlags({
        room: { ...bound, walls },
        items: [
          ...racks.filter((r) => r.rect && !r.rect.wall_mounted).map((r) => ({ id: r.id, name: r.name, box: r.rect!, h_mm: r.h_mm })),
          ...floor.filter((t) => t.rect).map((t) => ({ id: t.key, name: t.name, box: t.rect!, h_mm: t.size?.h_mm ?? null })),
        ],
        aisle_mm: bound.aisle_mm ?? null,
      })
    : [];
  return { room: { id: roomNow.id, name: roomNow.name, bound, walls, closets }, racks, floor, where, flags };
}

/** Is this id a planned place (made only on Apply)? */
export const isPlanned = (id: string) => id.startsWith(PLANNED_PREFIX);
