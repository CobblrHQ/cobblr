// Which of the things someone owns can serve what a pattern needs.
//
// A pattern names its yarn the way the ball band does: a brand, a yarn line,
// a colour and its number ("Red Heart Super Saver O'Go, Cherry 7190"), and
// sometimes only a weight and fibre ("worsted acrylic"). Stash records hold
// the same facts in their name, brand, colourway and weight fields. The match
// reads all of them, so the Cherry a person owns is found by its colour and
// yarn line even when the pattern never says "worsted" (the previous match
// compared weight and fibre only, and on a real pattern found nothing).
//
// Two kinds of fit, said plainly:
//   the same yarn    colour (by name or number) and the yarn itself agree
//   a stand-in       the weight agrees, a different yarn or colour
// A weight that disagrees rules a yarn out; nothing else does.
//
// Enough is said in the pattern's own terms: the metres it needs against the
// metres the stash holds free (free unopened balls x metres a ball, plus open
// partials), or balls against balls when the pattern gives no length.
//
// Pure: data in, verdicts out. The stash is read by pattern-stash.ts.

import { countOf } from "@cobblr/platform-contract";
import { weightFromWords } from "./pattern-materials.js";

export interface StashYarn {
  id: string;
  name: string;
  brand: string | null;
  colorway: string | null;
  color: string | null;
  weight: string | null;
  fiber: string | null;
  /** Unopened units free (on hand less reserved). */
  free_units: number;
  unit: string | null;
  /** Metres in one unit, when the record says. */
  unit_length_m: number | null;
  /** Open, unbound partials: metres left in each. */
  partials_m: number[];
}

export interface StashTool {
  id: string;
  name: string;
  size_mm: number | null;
  qty: number;
}

/** A notion in the stash: what it is (the Notions table's name for it), its
 *  size when it has one (6 mm safety eyes), and how many are free. */
export interface StashNotion {
  id: string;
  name: string;
  notion: string;
  size_mm: number | null;
  qty: number;
}

/** The notions of the kind (and size, when the pattern gives one) a pattern
 *  wants, and whether there are enough of them. */
export function notionFits(kind: string, sizeMm: number | null, want: number | null, stash: readonly StashNotion[]): { fits: StashNotion[]; short: number | null } {
  const fits = stash.filter(
    (n) => n.notion.toLowerCase() === kind.toLowerCase() && (sizeMm == null || n.size_mm == null || Math.abs(n.size_mm - sizeMm) < 0.05) && n.qty > 0,
  );
  const have = fits.reduce((a, b) => a + b.qty, 0);
  return { fits, short: want != null ? Math.max(0, want - have) : fits.length ? 0 : null };
}

export interface YarnReq {
  brand: string | null;
  product: string | null;
  color: string | null;
  color_code: string | null;
  weight: string | null;
  fiber: string | null;
  quantity: number | null;
  length_m: number | null;
}

export type FitKind = "same" | "stand-in";

export interface YarnFit {
  yarn: StashYarn;
  fit: FitKind;
  /** The pattern's own yarn line (another colour, when a stand-in). */
  same_line: boolean;
  /** Metres free for this need, when both sides give lengths. */
  free_m: number | null;
  /** Enough to make it, in metres when both sides give them, else in balls. */
  enough: boolean | null;
  short_m: number | null;
  short_units: number | null;
}

const norm = (s: string | null | undefined) =>
  (s ?? "")
    .toLowerCase()
    .replace(/[®™'’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const words = (s: string | null | undefined) => norm(s).split(" ").filter((w) => w.length > 1);

/** The Craft Yarn Council number a weight means, so "4 – Worsted", "worsted"
 *  and "Medium 4" compare equal and "4 – Aran" sits beside them. */
function weightNumber(w: string | null | undefined): number | null {
  if (!w) return null;
  const canon = weightFromWords(w) ?? w;
  const m = canon.match(/^([0-7])\b/);
  return m ? Number(m[1]) : null;
}

function hay(y: StashYarn): string {
  return ` ${norm([y.name, y.brand, y.colorway, y.color].filter(Boolean).join(" "))} `;
}

function containsAll(h: string, ws: string[]): boolean {
  return ws.length > 0 && ws.every((w) => h.includes(` ${w} `));
}

/** How a stash yarn fits one requirement, or null when it does not. */
export function fitOf(req: YarnReq, y: StashYarn): { fit: FitKind; score: number; same_line: boolean } | null {
  const h = hay(y);
  const rw = weightNumber(req.weight);
  const yw = weightNumber(y.weight);
  if (rw != null && yw != null && rw !== yw) return null;
  const colourByCode = !!req.color_code && new RegExp(`(^|\\D)${req.color_code}(\\D|$)`).test(`${y.name} ${y.colorway ?? ""} ${y.color ?? ""}`);
  const colourByName = containsAll(h, words(req.color));
  const colour = colourByCode || colourByName;
  const line = containsAll(h, words(req.product));
  const brand = containsAll(h, words(req.brand));
  const weightAgrees = rw != null && yw != null && rw === yw;
  const fiberAgrees = !!req.fiber && !!y.fiber && norm(req.fiber) === norm(y.fiber);
  let score = (colourByCode ? 50 : 0) + (colourByName ? 30 : 0) + (line ? 20 : 0) + (brand ? 10 : 0) + (weightAgrees ? 15 : 0) + (fiberAgrees ? 5 : 0);
  // The same yarn: its colour agrees and so does the yarn itself (its line,
  // or its brand, or its weight). A named colour of an unnamed yarn ("teal
  // worsted") is the same yarn when the weight agrees.
  if (colour && (line || brand || weightAgrees || (!req.product && !req.brand && rw == null))) return { fit: "same", score, same_line: line };
  // A stand-in: same weight, or the same yarn line in another colour. A
  // pattern that names neither colour nor anything else ("worsted acrylic")
  // is served by any yarn of that weight, and that is the same yarn to it.
  if (!req.color && !req.color_code && !req.product && !req.brand && weightAgrees) {
    return { fit: fiberAgrees || !req.fiber ? "same" : "stand-in", score, same_line: false };
  }
  if (weightAgrees || (line && !colour)) {
    score -= 20;
    return { fit: "stand-in", score, same_line: line };
  }
  return null;
}

function freeMetres(y: StashYarn): number | null {
  if (y.unit_length_m == null) return y.partials_m.length ? y.partials_m.reduce((a, b) => a + b, 0) : null;
  return Math.max(0, y.free_units) * y.unit_length_m + y.partials_m.reduce((a, b) => a + b, 0);
}

/** Enough of `y` for `stillNeed` (metres or balls, whichever the pattern gives). */
export function enoughOf(y: StashYarn, stillNeedM: number | null, stillNeedUnits: number | null): Pick<YarnFit, "free_m" | "enough" | "short_m" | "short_units"> {
  const free = freeMetres(y);
  if (stillNeedM != null && free != null) {
    const short = Math.max(0, Math.round(stillNeedM - free));
    return { free_m: Math.round(free), enough: short === 0, short_m: short, short_units: null };
  }
  if (stillNeedUnits != null) {
    const have = Math.max(0, y.free_units) + y.partials_m.length;
    const short = Math.max(0, Math.ceil(stillNeedUnits - have));
    return { free_m: free != null ? Math.round(free) : null, enough: short === 0, short_m: null, short_units: short };
  }
  return { free_m: free != null ? Math.round(free) : null, enough: null, short_m: null, short_units: null };
}

/** Every stash yarn that can serve the requirement, best first. */
export function yarnFits(req: YarnReq, stash: readonly StashYarn[], stillNeedM: number | null = req.length_m, stillNeedUnits: number | null = req.quantity): YarnFit[] {
  const out: (YarnFit & { score: number })[] = [];
  for (const y of stash) {
    const f = fitOf(req, y);
    if (!f) continue;
    out.push({ yarn: y, fit: f.fit, same_line: f.same_line, score: f.score, ...enoughOf(y, stillNeedM, stillNeedUnits) });
  }
  out.sort((a, b) => (a.fit === b.fit ? 0 : a.fit === "same" ? -1 : 1) || Number(b.enough === true) - Number(a.enough === true) || b.score - a.score);
  return out.map(({ score: _score, ...f }) => f);
}

/** "5.5 mm", "5.5mm", "US I-9 (5.5 mm)", "5,5 mm": the millimetres, or null. */
export function millimetres(s: string | null | undefined): number | null {
  const m = (s ?? "").replace(",", ".").match(/(\d+(?:\.\d+)?)\s*mm/i) ?? (s ?? "").match(/^\s*(\d+(?:\.\d+)?)\s*$/);
  return m ? Number(m[1]) : null;
}

/** The hooks or needles of exactly the size a pattern wants. */
export function toolFits(sizeMm: number, tools: readonly StashTool[]): StashTool[] {
  return tools.filter((t) => t.size_mm != null && Math.abs(t.size_mm - sizeMm) < 0.05 && t.qty > 0);
}

/** The line a shopping list gets for what is missing, in the pattern's words. */
export function shoppingLine(req: YarnReq & { quantity_unit?: string | null }, shortM: number | null, shortUnits: number | null): { title: string; qty: string | null } {
  const yarn = [req.brand, req.product].filter(Boolean).join(" ");
  const colour = req.color ? `${req.color}${req.color_code ? ` (${req.color_code})` : ""}` : req.color_code ? `#${req.color_code}` : "";
  const what = [yarn, colour].filter(Boolean).join(", ") || [req.weight, req.fiber, "yarn"].filter(Boolean).join(" ");
  const qty = shortM != null ? `${Math.round(shortM)} m` : shortUnits != null ? countOf(shortUnits, req.quantity_unit || "ball") : null;
  const weight = yarn && req.weight ? ` (${req.weight})` : "";
  return { title: `${what}${weight}`, qty };
}
