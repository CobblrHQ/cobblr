// Length entry/display for the floor plan. Geometry is ALWAYS stored in mm;
// users type whatever unit they think in ("24ft", "6'", '72"', "1.2m",
// "40cm", "915") and the UI echoes values back in the unit they used.
// See docs/design-decisions/location-floor-plan.md (decision #1).

export type LengthUnit = "ft" | "in" | "m" | "cm" | "mm";

export const MM_PER: Record<LengthUnit, number> = {
  ft: 304.8,
  in: 25.4,
  m: 1000,
  cm: 10,
  mm: 1,
};

/** Parse a human length into integer mm. Accepts "24ft", "24 ft", "6'",
 *  '30"', "72in", "1.2m", "40cm", "915mm", or a bare number (treated as
 *  `fallback`, default mm). Also the ft-in compound: 6'3" / 6ft 3in.
 *  Returns null when unparseable or non-positive. */
export function parseLength(input: string, fallback: LengthUnit = "mm"): number | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;
  // compound feet+inches: 6'3", 6' 3", 6ft 3in
  const compound = s.match(/^(\d+(?:\.\d+)?)\s*(?:'|ft|feet)\s*(\d+(?:\.\d+)?)\s*(?:"|in|inch|inches)?$/);
  if (compound) {
    const ft = Number(compound[1]);
    const inch = Number(compound[2]);
    if (!Number.isFinite(ft) || !Number.isFinite(inch)) return null;
    const mm = Math.round(ft * MM_PER.ft + inch * MM_PER.in);
    return mm > 0 ? mm : null;
  }
  const m = s.match(/^(\d+(?:\.\d+)?)\s*('|"|ft|feet|foot|in|inch|inches|mm|cm|m)?$/);
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return null;
  const suffix = m[2];
  const unit: LengthUnit =
    suffix === "'" || suffix === "ft" || suffix === "feet" || suffix === "foot"
      ? "ft"
      : suffix === '"' || suffix === "in" || suffix === "inch" || suffix === "inches"
        ? "in"
        : suffix === "m"
          ? "m"
          : suffix === "cm"
            ? "cm"
            : suffix === "mm"
              ? "mm"
              : fallback;
  const mmv = Math.round(value * MM_PER[unit]);
  return mmv > 0 ? mmv : null;
}

/** Render mm in the given unit, trimmed ("22 ft", "3.5 ft", "915 mm").
 *  One decimal for real units — mm-integer storage means a converted value is
 *  never more precise than that anyway ("72 in", not "72.01 in"). */
export function formatLength(mmv: number, unit: LengthUnit): string {
  const v = mmv / MM_PER[unit];
  const rounded = unit === "mm" ? Math.round(v) : Math.round(v * 10) / 10;
  return `${rounded} ${unit}`;
}
