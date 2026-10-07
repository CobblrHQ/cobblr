// The arithmetic of a layout on paper: which scale fits the page, and how far
// each rack stands from the walls. Pure, so the print and its test agree.

/** The scales a drawing is printed at, smallest first (1:N). */
export const PRINT_SCALES = [5, 10, 20, 25, 30, 40, 50, 75, 100, 150, 200, 250, 500] as const;

/** The largest drawing that fits letter AND A4 in landscape, in paper mm:
 *  letter's 259 x 196 inside 10 mm margins, less 28 mm of dimension lines
 *  each way and a title. */
export const PRINT_AREA_MM = { w: 230, h: 145 } as const;

/** The smallest standard scale at which a `w_mm` × `d_mm` room fits `area`. */
export function printScale(w_mm: number, d_mm: number, area: { w: number; h: number } = PRINT_AREA_MM): number {
  const need = Math.max(w_mm / area.w, d_mm / area.h);
  return PRINT_SCALES.find((s) => s >= need) ?? Math.ceil(need / 100) * 100;
}

export interface WallGap {
  /** Which wall: the room's left, right, top or bottom edge. */
  side: "left" | "right" | "top" | "bottom";
  /** The gap, in mm. */
  mm: number;
  /** The dimension line, from the rack's edge to the wall, in room mm. */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** A rack's distance to the nearer of the side walls and the nearer of the
 *  front and back walls: the two numbers a person measures to put it there. */
export function nearestWalls(r: { x_mm: number; y_mm: number; w_mm: number; d_mm: number }, room: { w_mm: number; d_mm: number }): [WallGap, WallGap] {
  const left = r.x_mm, right = room.w_mm - (r.x_mm + r.w_mm);
  const top = r.y_mm, bottom = room.d_mm - (r.y_mm + r.d_mm);
  const cy = r.y_mm + r.d_mm / 2, cx = r.x_mm + r.w_mm / 2;
  const side: WallGap =
    left <= right
      ? { side: "left", mm: Math.round(left), x1: 0, y1: cy, x2: r.x_mm, y2: cy }
      : { side: "right", mm: Math.round(right), x1: r.x_mm + r.w_mm, y1: cy, x2: room.w_mm, y2: cy };
  const end: WallGap =
    top <= bottom
      ? { side: "top", mm: Math.round(top), x1: cx, y1: 0, x2: cx, y2: r.y_mm }
      : { side: "bottom", mm: Math.round(bottom), x1: cx, y1: r.y_mm + r.d_mm, x2: cx, y2: room.d_mm };
  return [side, end];
}

/** A scale bar a round length long that is about a fifth of the drawing. */
export function scaleBarMm(roomWidth_mm: number): number {
  const steps = [100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000];
  return steps.filter((s) => s <= roomWidth_mm / 5).pop() ?? 100;
}
