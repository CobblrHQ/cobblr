// A plan's grid: off until someone turns it on, then drawn in every mode and
// what boxes and pins snap to (#4564).
//
// "What about the floor plan and drawer having a grid, like to put the
// sockets on?" A grid is a guide to place by, not a divider: it never says a
// socket fits. Its pitch follows the plan's own units, 1 in, 2 in, 6 in or 1 ft
// on an imperial plan and 1 cm, 5 cm, 10 cm or 1 m on a metric one, picked so a cell
// stays big enough to see at the size the plan is drawn; a drawer of
// Gridfinity bins takes the 42 mm preset. A pitch somebody chose is kept.
//
// Pure, so the choice is asserted without a browser.

export interface GridPitch {
  mm: number;
  label: string;
}

const IMPERIAL: GridPitch[] = [
  { mm: 25.4, label: "1 in" },
  { mm: 50.8, label: "2 in" },
  { mm: 152.4, label: "6 in" },
  { mm: 304.8, label: "1 ft" },
];
const METRIC: GridPitch[] = [
  { mm: 10, label: "1 cm" },
  { mm: 50, label: "5 cm" },
  { mm: 100, label: "10 cm" },
  { mm: 1000, label: "1 m" },
];
export const GRIDFINITY: GridPitch = { mm: 42, label: "Gridfinity 42 mm" };

/** A cell narrower than this on screen is noise, not a guide. */
export const MIN_CELL_PX = 14;

export function isImperial(unit: string | null | undefined): boolean {
  return unit === "in" || unit === "ft";
}

/** The pitches a plan in this unit offers, smallest first, then Gridfinity. */
export function gridPitches(unit: string | null | undefined): GridPitch[] {
  return [...(isImperial(unit) ? IMPERIAL : METRIC), GRIDFINITY];
}

/** The pitch picked for a plan `w_mm` wide drawn `planPx` across: the finest
 *  of its unit's steps whose cells stay legible. Unmeasured, the middle one. */
export function autoPitch(unit: string | null | undefined, w_mm: number, planPx: number): GridPitch {
  const steps = isImperial(unit) ? IMPERIAL : METRIC;
  if (!(planPx > 0) || !(w_mm > 0)) return steps[2]!;
  const pxPerMm = planPx / w_mm;
  return steps.find((p) => p.mm * pxPerMm >= MIN_CELL_PX) ?? steps[steps.length - 1]!;
}

/** The plan's pitch: the one somebody chose, else the auto one. */
export function planPitch(bound: { grid_mm?: number; unit?: string; w_mm: number }, planPx: number): GridPitch {
  if (bound.grid_mm) {
    const named = gridPitches(bound.unit).find((p) => Math.abs(p.mm - bound.grid_mm!) < 0.01);
    return named ?? { mm: bound.grid_mm, label: `${Math.round(bound.grid_mm * 10) / 10} mm` };
  }
  return autoPitch(bound.unit, bound.w_mm, planPx);
}

/** A spot moved to the middle of the grid cell it is in, kept on the plan. */
export function snapToCell(v: number, pitch: number, max: number): number {
  if (!(pitch > 0)) return v;
  const cell = Math.min(Math.floor(v / pitch), Math.max(0, Math.ceil(max / pitch) - 1));
  return Math.min(max, Math.round(cell * pitch + pitch / 2));
}
