// Grid-fill math + naming for the floor plan's "fill grid" helper — a parts
// rack's 24 bins (or a cabinet's cubbies) created and placed in one shot
// instead of 24 modals. Pure functions, unit-tested.

import type { FpBound, FpRect } from "./floorplanGeometry";

export type GridNameScheme = "row-letter" | "sequential";

/** Cell rects for rows × cols tiling the bound, top-left → right, row by
 *  row — the reading order of a rack's face. A small margin keeps cells off
 *  the border; a gutter separates them. Integer mm. Returns null when the
 *  bound is too small for the requested grid (cells would be under 40 mm). */
export function gridRects(
  bound: FpBound,
  rows: number,
  cols: number,
): FpRect[] | null {
  if (rows < 1 || cols < 1 || rows > 30 || cols > 30) return null;
  const margin = Math.round(Math.min(bound.w_mm, bound.d_mm) * 0.02);
  const gutter = Math.min(60, Math.round(Math.min(bound.w_mm, bound.d_mm) * 0.015));
  const cellW = Math.floor((bound.w_mm - 2 * margin - (cols - 1) * gutter) / cols);
  const cellD = Math.floor((bound.d_mm - 2 * margin - (rows - 1) * gutter) / rows);
  if (cellW < 40 || cellD < 40) return null;
  const rects: FpRect[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      rects.push({
        x_mm: margin + c * (cellW + gutter),
        y_mm: margin + r * (cellD + gutter),
        w_mm: cellW,
        d_mm: cellD,
      });
    }
  }
  return rects;
}

/** Names in the same reading order as gridRects. "row-letter" → A1…A8, B1…;
 *  "sequential" → `${prefix}1…${prefix}N` ("Bin 1"…"Bin 24"). Row letters run
 *  A–Z then AA, AB… (nobody should need that, but it never breaks). */
export function gridNames(
  rows: number,
  cols: number,
  scheme: GridNameScheme,
  prefix: string,
): string[] {
  const names: string[] = [];
  const rowLetter = (r: number): string => {
    let s = "";
    let n = r;
    do {
      s = String.fromCharCode(65 + (n % 26)) + s;
      n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return s;
  };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      names.push(
        scheme === "row-letter" ? `${rowLetter(r)}${c + 1}` : `${prefix}${r * cols + c + 1}`,
      );
    }
  }
  return names;
}
