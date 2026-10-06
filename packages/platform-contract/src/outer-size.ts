// Lengths and a thing's outer size, read the way people write them.
//
// Geometry is always stored in mm. People type whatever unit they think in
// ("24ft", "6'", '72"', "1.2m", "40cm", "915"), and a size as one line:
// "600 x 550 x 700 mm", "24 × 20 × 28 in", "60x55x70cm". The floor plan, the
// api and the assistant read sizes with these, so the three never disagree
// about how big a thing is.

export type LengthUnit = "ft" | "in" | "m" | "cm" | "mm";

export const MM_PER: Record<LengthUnit, number> = {
  ft: 304.8,
  in: 25.4,
  m: 1000,
  cm: 10,
  mm: 1,
};

function unitOf(suffix: string | undefined, fallback: LengthUnit): LengthUnit {
  if (suffix === "'" || suffix === "ft" || suffix === "feet" || suffix === "foot") return "ft";
  if (suffix === '"' || suffix === "in" || suffix === "inch" || suffix === "inches") return "in";
  if (suffix === "m" || suffix === "cm" || suffix === "mm") return suffix;
  return fallback;
}

/** Parse a human length into integer mm. Accepts "24ft", "24 ft", "6'",
 *  '30"', "72in", "1.2m", "40cm", "915mm", or a bare number (treated as
 *  `fallback`, default mm). Also the ft-in compound: 6'3" / 6ft 3in.
 *  Returns null when unparseable or non-positive. */
export function parseLength(input: string, fallback: LengthUnit = "mm"): number | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;
  const compound = s.match(/^(\d+(?:\.\d+)?)\s*(?:'|ft|feet)\s*(\d+(?:\.\d+)?)\s*(?:"|in|inch|inches)?$/);
  if (compound) {
    const mm = Math.round(Number(compound[1]) * MM_PER.ft + Number(compound[2]) * MM_PER.in);
    return Number.isFinite(mm) && mm > 0 ? mm : null;
  }
  const m = s.match(/^(\d+(?:\.\d+)?)\s*('|"|ft|feet|foot|in|inch|inches|mm|cm|m)?$/);
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return null;
  const mmv = Math.round(value * MM_PER[unitOf(m[2], fallback)]);
  return mmv > 0 ? mmv : null;
}

/** Render mm in the given unit, trimmed ("22 ft", "3.5 ft", "915 mm"). */
export function formatLength(mmv: number, unit: LengthUnit): string {
  const v = mmv / MM_PER[unit];
  const rounded = unit === "mm" ? Math.round(v) : Math.round(v * 10) / 10;
  return `${rounded} ${unit}`; // count-unit-ok: a length symbol (mm, in, ft), which does not inflect
}

/** A thing's outer size: width (left to right, facing it), depth (front to
 *  back) and height, in mm. Height is null when only a footprint was given. */
export interface OuterSize {
  w_mm: number;
  d_mm: number;
  h_mm: number | null;
  unit: LengthUnit;
}

const SIZE_UNIT = /\s*('|"|ft|feet|foot|inches|inch|in|mm|cm|m)\s*$/;

/** "W × D × H" (or "W × D") in any unit, into mm. A unit written once at the
 *  end applies to every part that has none ("60 x 55 x 70 cm"); a part may
 *  carry its own ("2ft x 50cm x 600mm"). Separators: x, ×, *, "by". Null when
 *  it is not two or three positive lengths. A number or an object already in
 *  mm ({ w_mm, d_mm, h_mm }) is read as it is. */
export function parseOuterSize(input: unknown): OuterSize | null {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    const w = Number(o.w_mm), d = Number(o.d_mm), h = o.h_mm == null ? null : Number(o.h_mm);
    if (w > 0 && d > 0 && (h === null || h > 0)) return { w_mm: Math.round(w), d_mm: Math.round(d), h_mm: h === null ? null : Math.round(h), unit: "mm" };
    return null;
  }
  if (typeof input !== "string") return null;
  let s = input.trim().toLowerCase();
  if (!s) return null;
  const tail = s.match(SIZE_UNIT);
  const fallback = unitOf(tail?.[1], "mm");
  if (tail) s = s.slice(0, tail.index).trim();
  const parts = s.split(/\s*(?:x|×|\*|by)\s*/).filter(Boolean);
  if (parts.length < 2 || parts.length > 3) return null;
  const mm = parts.map((p) => parseLength(p, fallback));
  if (mm.some((v) => v === null)) return null;
  return { w_mm: mm[0]!, d_mm: mm[1]!, h_mm: mm[2] ?? null, unit: fallback };
}

/** "600 × 550 × 700 mm", in the unit the size was written in. */
export function formatOuterSize(size: OuterSize): string {
  const f = (v: number) => {
    const n = v / MM_PER[size.unit];
    return String(size.unit === "mm" ? Math.round(n) : Math.round(n * 10) / 10);
  };
  return `${[size.w_mm, size.d_mm, ...(size.h_mm ? [size.h_mm] : [])].map(f).join(" × ")} ${size.unit}`; // count-unit-ok: a length symbol
}

/** The field role a kind's outer-size field carries. */
export const OUTER_SIZE_ROLE = "outer-size";
/** The name a field gets when the plan adds one to a kind that has none. */
export const OUTER_SIZE_FIELD = "outer_size";
