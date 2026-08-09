// Cosmetic decoration for floor-plan rects — the Gridfinity-conversation
// contract (reported 2026-07-10): the RECT stays the only thing the math ever
// sees (hit-testing, drop, snap, clamp, rebase); inside it, decoration is
// free country. An `outline` is a silhouette drawn as an SVG polygon in the
// rect's normalized space (per-mille, 0–1000 on both axes) — a trapezoid
// wrench set, a drill profile. `fill: "photo"` renders the record's own
// photo. Overlapping rects are legal; z-order is area-descending so the
// smaller (topmost) one wins clicks, matching zoneAt's smallest-wins.

export type OutlinePoints = Array<[number, number]>;

/** Presets for the common silhouettes; freeform points are the escape
 *  hatch. taper-left/right are the wrench rails: the set fans from big to
 *  small, so the footprint is a trapezoid. */
export const OUTLINE_PRESETS: Record<string, OutlinePoints> = {
  "taper-left": [
    [0, 150],
    [1000, 0],
    [1000, 1000],
    [0, 850],
  ],
  "taper-right": [
    [0, 0],
    [1000, 150],
    [1000, 850],
    [0, 1000],
  ],
  triangle: [
    [500, 0],
    [1000, 1000],
    [0, 1000],
  ],
};

/** The rect's cosmetic outline off its floorplan blob, or null. Defensive:
 *  3–32 points, each a per-mille pair. Junk renders nothing, never breaks. */
export function readOutline(fp: Record<string, unknown> | null | undefined): OutlinePoints | null {
  const raw = fp?.outline;
  if (!Array.isArray(raw) || raw.length < 3 || raw.length > 32) return null;
  const pts: OutlinePoints = [];
  for (const p of raw) {
    if (!Array.isArray(p) || p.length !== 2) return null;
    const [x, y] = p as [unknown, unknown];
    if (typeof x !== "number" || typeof y !== "number") return null;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (x < 0 || x > 1000 || y < 0 || y > 1000) return null;
    pts.push([Math.round(x), Math.round(y)]);
  }
  return pts;
}

/** "photo" → render the record's image as the rect fill. */
export function readFill(fp: Record<string, unknown> | null | undefined): "photo" | null {
  return fp?.fill === "photo" ? "photo" : null;
}

export function pointsAttr(points: OutlinePoints): string {
  return points.map(([x, y]) => `${x},${y}`).join(" ");
}

/** Area-descending: big rects paint first, small ones stack on top — the
 *  interlocked wrench sets overlap and the one under the cursor wins. */
export function byAreaDesc(
  a: { rect: { w_mm: number; d_mm: number } },
  b: { rect: { w_mm: number; d_mm: number } },
): number {
  return b.rect.w_mm * b.rect.d_mm - a.rect.w_mm * a.rect.d_mm;
}
